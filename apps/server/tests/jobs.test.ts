import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { openDatabase, type Database } from '../src/db';
import { Repository } from '../src/repository';
import { JobRunner, publicTask, type JobExecution, type StoredTask } from '../src/jobs';
import { Media } from '../src/media';
import {
  createProviderClient,
  encryptSecret,
  ProviderCancelledError,
  ProviderUncertainError,
} from '../src/providers';
import {
  EMPTY_BRIEF,
  type Asset,
  type AsyncMapping,
  type ContentVersion,
  type CopyDraft,
} from '../../../packages/shared/src/index';

const key = 'ab'.repeat(32);
const copy: CopyDraft = {
  titles: ['已确认商品'],
  body: '来自商品简报的内容',
  tags: [],
  pages: [{ headline: '商品', body: '商品信息' }],
  warnings: [],
};
const mapping: AsyncMapping = {
  submitPath: '/tasks',
  pollPath: '/tasks/{taskId}',
  taskIdPath: 'data.id',
  statusPath: 'data.status',
  successValue: 'done',
  failureValue: 'error',
  resultUrlPath: 'data.output.url',
};
function asyncTask(task: StoredTask): StoredTask {
  return {
    ...task,
    kind: 'image',
    config: { ...task.config, kind: 'async-json', asyncMapping: mapping },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Condition did not settle');
}
async function fixture(
  context: TestContext,
  execution: JobExecution = {},
  wrap?: (db: Database) => Database,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-job-test-'));
  const base = await openDatabase(dir);
  const db = wrap ? wrap(base) : base;
  const repo = new Repository(db);
  const project = await repo.create('任务测试', {
    ...EMPTY_BRIEF,
    productName: '棉布包',
    confirmed: true,
  });
  const task: StoredTask = {
    id: randomUUID(),
    projectId: project.id,
    providerId: randomUUID(),
    kind: 'copy',
    status: 'queued',
    prompt: '生成草稿',
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    brief: project.brief,
    config: {
      name: '测试服务',
      kind: 'openai',
      baseUrl: 'https://api.example.com/v1',
      textModel: 'text',
      imageModel: 'image',
      timeoutSeconds: 30,
    },
    secret: encryptSecret('private-key', key),
  };
  const removed: string[] = [];
  let ingested = 0;
  const media = {
    ingest: async (projectId: string, _bytes: Buffer, name: string): Promise<Asset> => {
      ingested++;
      const id = randomUUID();
      const asset: Asset = {
        id,
        projectId,
        name,
        mime: 'image/png',
        width: 1,
        height: 1,
        size: 1,
        url: `/api/assets/${id}/content`,
        thumbnailUrl: `/api/assets/${id}/thumbnail`,
        createdAt: new Date().toISOString(),
      };
      await db.put('assets', id, asset);
      return asset;
    },
    remove: async (id: string) => {
      removed.push(id);
      await db.remove('assets', id);
    },
  } as unknown as Media;
  const runner = new JobRunner(db, repo, media, key, {
    generateCopy: async () => copy,
    generateImage: async () => ({ bytes: Buffer.from('image'), mime: 'image/png' }),
    ...execution,
  });
  context.after(async () => {
    await runner.stop();
    await base.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.put('tasks', task.id, task);
  return {
    db,
    repo,
    project,
    media,
    task,
    runner,
    removed,
    ingested: () => ingested,
    status: async () => (await db.get<StoredTask>('tasks', task.id))!.status,
  };
}

test('cancellation before supplier completion publishes neither a version nor image asset', async (context) => {
  const started = deferred<void>();
  const result = deferred<{ bytes: Buffer; mime: string }>();
  const f = await fixture(context, {
    generateImage: async () => {
      started.resolve();
      return result.promise;
    },
  });
  f.task.kind = 'image';
  await f.db.put('tasks', f.task.id, f.task);
  await f.runner.tick();
  await started.promise;
  const cancelled = await f.runner.cancel(f.task.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.error!, /供应商可能仍在生成/);
  result.resolve({ bytes: Buffer.from('image'), mime: 'image/png' });
  await f.runner.stop();
  assert.equal(f.ingested(), 0);
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.equal((await f.db.list('assets', f.project.id)).length, 0);
  assert.equal((await f.db.get<{ status: string }>('usage', f.task.id))?.status, 'cancelled');
});

test('cancellation waits for already-started publication and observes committed success', async (context) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(context);
  const version = f.repo.version.bind(f.repo);
  f.repo.version = async (input) => {
    entered.resolve();
    await release.promise;
    return version(input);
  };
  await f.runner.tick();
  await entered.promise;
  let cancelSettled = false;
  const cancel = f.runner.cancel(f.task.id).then((value) => {
    cancelSettled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelSettled, false);
  assert.equal(await f.status(), 'running');
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  release.resolve();
  const result = await cancel;
  await f.runner.stop();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.resultVersionId, f.task.id);
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
  assert.equal(
    (await f.repo.project(f.project.id)).board.nodes.filter((n) => n.id === f.task.id).length,
    1,
  );
});

test('cancelled queued tasks are never submitted and repeated cancellation remains idempotent', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    generateCopy: async () => {
      calls++;
      return copy;
    },
  });
  assert.equal((await f.runner.cancel(f.task.id)).status, 'cancelled');
  const repeated = await f.runner.cancel(f.task.id);
  assert.equal(repeated.status, 'cancelled');
  assert.equal(repeated.error, undefined);
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(calls, 0);
  assert.equal((await f.db.get<StoredTask>('tasks', f.task.id))!.attempts, 0);
});

test('unavailable workspaces cancel queued tasks before claim or supplier submission', async (context) => {
  let calls = 0;
  const checkedProjects: string[] = [];
  const f = await fixture(context, {
    canRunProject: async (projectId) => {
      checkedProjects.push(projectId);
      return false;
    },
    generateCopy: async () => {
      calls++;
      return copy;
    },
  });
  await f.runner.tick();
  await f.runner.stop();
  const last = (await f.db.get<StoredTask>('tasks', f.task.id))!;
  assert.equal(last.status, 'cancelled');
  assert.equal(last.attempts, 0);
  assert.match(last.error!, /所属账号或工作空间已不可用/);
  assert.equal(calls, 0);
  assert.deepEqual(checkedProjects, [f.project.id]);
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
});

test('account disabled between claim and submission never invokes the supplier', async (context) => {
  let checks = 0,
    calls = 0;
  const f = await fixture(context, {
    canRunProject: async () => ++checks === 1,
    generateCopy: async () => {
      calls++;
      return copy;
    },
  });
  await f.runner.tick();
  await until(async () => (await f.status()) === 'cancelled');
  await f.runner.stop();
  const last = (await f.db.get<StoredTask>('tasks', f.task.id))!;
  assert.equal(checks, 2);
  assert.equal(last.attempts, 1);
  assert.equal(calls, 0);
  assert.match(last.error!, /所属账号或工作空间已不可用/);
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.equal((await f.db.get<{ status: string }>('usage', f.task.id))?.status, 'cancelled');
});

test('account is checked after reference loading and before image generation', async (context) => {
  let enabled = true,
    calls = 0;
  const f = await fixture(context, {
    canRunProject: async () => enabled,
    generateImage: async () => {
      calls++;
      return { bytes: Buffer.from('image'), mime: 'image/png' };
    },
  });
  const asset: Asset = {
    id: randomUUID(),
    projectId: f.project.id,
    name: 'reference.png',
    mime: 'image/png',
    width: 1,
    height: 1,
    size: 1,
    url: '',
    thumbnailUrl: '',
    createdAt: new Date().toISOString(),
  };
  f.media.owned = async () => asset;
  f.media.bytes = async () => {
    enabled = false;
    return Buffer.from('reference image');
  };
  await f.db.put('tasks', f.task.id, { ...f.task, kind: 'image', referenceAssetId: asset.id });
  await f.runner.tick();
  await until(async () => (await f.status()) === 'cancelled');
  await f.runner.stop();
  assert.equal(calls, 0);
  assert.equal(f.ingested(), 0);
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
});

test('disabled workspaces stop saved async recovery without querying or losing the upstream ID', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    canRunProject: async () => false,
    generateImage: async () => {
      calls++;
      throw new Error('Must not submit');
    },
    resumeImage: async () => {
      calls++;
      throw new Error('Must not query');
    },
  });
  await f.db.put('tasks', f.task.id, {
    ...asyncTask(f.task),
    status: 'running',
    upstreamTaskId: 'retained-upstream-id',
    nextRecoveryAt: new Date(Date.now() - 1000).toISOString(),
  });
  await f.runner.start();
  await until(async () => (await f.status()) === 'cancelled');
  await f.runner.stop();
  const last = (await f.db.get<StoredTask>('tasks', f.task.id))!;
  assert.equal(last.upstreamTaskId, 'retained-upstream-id');
  assert.equal(last.nextRecoveryAt, undefined);
  assert.equal(last.recoveryStopped, true);
  assert.match(last.error!, /供应商可能仍在生成并计费/);
  await f.runner.start();
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(calls, 0);
  assert.equal(last.attempts, 0);
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
});

test('failed workspace authorization lookup leaves queued work unsubmitted', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    canRunProject: async () => {
      throw new Error('Authorization database unavailable');
    },
    generateCopy: async () => {
      calls++;
      return copy;
    },
  });
  await assert.rejects(f.runner.tick(), /Authorization database unavailable/);
  await f.runner.stop();
  assert.equal(calls, 0);
  assert.equal(await f.status(), 'queued');
  assert.equal((await f.db.get<StoredTask>('tasks', f.task.id))?.attempts, 0);
});

test('stop drains a pending task-list read and forbids subsequent claims', async (context) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const f = await fixture(
    context,
    {
      generateCopy: async () => {
        calls++;
        return copy;
      },
    },
    (db) => ({
      ...db,
      list: async <T>(scope: Parameters<Database['list']>[0], projectId?: string) => {
        if (scope === 'tasks') {
          entered.resolve();
          await release.promise;
        }
        return db.list<T>(scope, projectId);
      },
    }),
  );
  const tick = f.runner.tick();
  await entered.promise;
  let stopped = false;
  const stop = f.runner.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  release.resolve();
  await Promise.all([tick, stop]);
  await f.runner.tick();
  assert.equal(calls, 0);
  assert.equal(await f.status(), 'queued');
});

test('stop returns a just-claimed task to queued without submitting a paid request', async (context) => {
  const claimed = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const f = await fixture(
    context,
    {
      generateCopy: async () => {
        calls++;
        return copy;
      },
    },
    (db) => ({
      ...db,
      query: async <T>(sql: string, params?: unknown[]) => {
        const rows = await db.query<T>(sql, params);
        if (sql.includes("body->>'status'='queued'") && sql.includes('RETURNING body')) {
          claimed.resolve();
          await release.promise;
        }
        return rows;
      },
    }),
  );
  const tick = f.runner.tick();
  await claimed.promise;
  const stop = f.runner.stop();
  release.resolve();
  await Promise.all([tick, stop]);
  assert.equal(calls, 0);
  assert.equal(await f.status(), 'queued');
  assert.equal((await f.db.get<StoredTask>('tasks', f.task.id))!.attempts, 0);
});

test('publication failure removes this task version, board node and unreferenced generated asset', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    generateImage: async () => {
      calls++;
      return { bytes: Buffer.from('image'), mime: 'image/png' };
    },
  });
  f.task.kind = 'image';
  await f.db.put('tasks', f.task.id, f.task);
  const version = f.repo.version.bind(f.repo);
  f.repo.version = async (input) => {
    await version(input);
    throw new Error('Simulated persistence failure after partial publication');
  };
  await f.runner.tick();
  await until(async () => (await f.status()) === 'reconciling');
  await f.runner.stop();
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.equal((await f.db.list('assets', f.project.id)).length, 0);
  assert.equal((await f.repo.project(f.project.id)).board.nodes.length, 1);
  assert.equal(f.removed.length, 1);
  assert.equal(calls, 1);
  assert.match((await f.db.get<StoredTask>('tasks', f.task.id))!.error!, /服务商已返回内容/);
});

test('lost success response preserves the committed version and successful task', async (context) => {
  let threw = false;
  const f = await fixture(context, {}, (db) => ({
    ...db,
    query: async <T>(sql: string, params?: unknown[]) => {
      const rows = await db.query<T>(sql, params);
      if (
        !threw &&
        sql.includes('RETURNING body') &&
        typeof params?.[1] === 'string' &&
        JSON.parse(params[1]).status === 'succeeded'
      ) {
        threw = true;
        throw new Error('Lost database response after commit');
      }
      return rows;
    },
  }));
  await f.runner.tick();
  await until(async () => (await f.status()) === 'succeeded');
  await f.runner.stop();
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
  assert.equal(
    (await f.repo.project(f.project.id)).board.nodes.filter((n) => n.id === f.task.id).length,
    1,
  );
  assert.equal((await f.db.get<{ status: string }>('usage', f.task.id))!.status, 'succeeded');
});

test('cleanup preserves a generated asset referenced by another saved version', async (context) => {
  const f = await fixture(context);
  f.task.kind = 'image';
  await f.db.put('tasks', f.task.id, f.task);
  const version = f.repo.version.bind(f.repo);
  f.repo.version = async (input) => {
    const result = await version(input);
    await version({
      projectId: f.project.id,
      kind: 'image',
      label: '独立保留版本',
      assetId: result.assetId,
    });
    throw new Error('Partial publication');
  };
  await f.runner.tick();
  await until(async () => (await f.status()) === 'reconciling');
  await f.runner.stop();
  const versions = await f.db.list<ContentVersion>('versions', f.project.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].label, '独立保留版本');
  assert.equal((await f.db.list('assets', f.project.id)).length, 1);
  assert.deepEqual(f.removed, []);
});

test('uncertain provider outcomes are not automatically retried and hide stored secrets', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    generateCopy: async () => {
      calls++;
      throw new ProviderUncertainError();
    },
  });
  await f.runner.tick();
  await until(async () => (await f.status()) === 'reconciling');
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(calls, 1);
  const stored = (await f.db.get<StoredTask>('tasks', f.task.id))!;
  const result = publicTask(stored);
  assert.equal('secret' in result, false);
  assert.equal('config' in result, false);
  assert.equal('brief' in result, false);
  assert.ok(!JSON.stringify(result).includes('private-key'));
});

test('worker startup reconciles interrupted tasks and timer query failures are handled', async (context) => {
  let errors = 0;
  const signalled = deferred<void>();
  let failOnce = true;
  const f = await fixture(
    context,
    {
      onWorkerError: () => {
        errors++;
        signalled.resolve();
      },
    },
    (db) => ({
      ...db,
      list: async <T>(scope: Parameters<Database['list']>[0], projectId?: string) => {
        if (scope === 'tasks' && failOnce) {
          failOnce = false;
          throw new Error('database unavailable');
        }
        return db.list<T>(scope, projectId);
      },
    }),
  );
  f.task.status = 'running';
  await f.db.put('tasks', f.task.id, f.task);
  await f.runner.start();
  await signalled.promise;
  assert.equal(errors, 1);
  assert.equal(await f.status(), 'reconciling');
  await f.runner.tick();
  await f.runner.stop();
});

test('async accepted ID survives database reopen and recovery uses only GET before publishing once', async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-job-restart-'));
  let db = await openDatabase(dir);
  let runner: JobRunner | undefined;
  context.after(async () => {
    await runner?.stop();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let repo = new Repository(db);
  const project = await repo.create('恢复测试', {
    ...EMPTY_BRIEF,
    productName: '棉布包',
    confirmed: true,
  });
  const task: StoredTask = {
    id: randomUUID(),
    projectId: project.id,
    providerId: randomUUID(),
    kind: 'image',
    status: 'queued',
    prompt: '商品图',
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    brief: project.brief,
    config: {
      name: '异步服务快照',
      kind: 'async-json',
      baseUrl: 'https://api.example.com/prefix/v1',
      textModel: '',
      imageModel: 'image',
      timeoutSeconds: 30,
      asyncMapping: mapping,
    },
    secret: encryptSecret('private-key', key),
  };
  await db.put('tasks', task.id, task);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#e8efde' } })
    .png()
    .toBuffer();
  const methods: string[] = [];
  let interrupted = true;
  const client = createProviderClient({
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    wait: async () => {},
    send: async (request) => {
      methods.push(request.method);
      const json = (data: unknown) => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify(data)),
      });
      if (request.method === 'POST') return json({ data: { id: 'saved-upstream-id' } });
      if (interrupted) {
        assert.equal(
          (await db.get<StoredTask>('tasks', task.id))?.upstreamTaskId,
          'saved-upstream-id',
        );
        throw new Error('private-key transient connection loss');
      }
      if (request.url.hostname === 'images.example.com') {
        assert.deepEqual(request.headers, {});
        return { status: 200, headers: {}, body: png };
      }
      assert.equal(request.url.pathname, '/prefix/v1/tasks/saved-upstream-id');
      assert.equal(request.headers.Authorization, 'Bearer private-key');
      return json({
        data: { status: 'done', output: { url: 'https://images.example.com/result.png' } },
      });
    },
  });
  runner = new JobRunner(db, repo, new Media(db, dir), key, client);
  await runner.tick();
  await until(async () => (await db.get<StoredTask>('tasks', task.id))?.status === 'reconciling');
  await runner.stop();
  const interruptedTask = (await db.get<StoredTask>('tasks', task.id))!;
  assert.equal(interruptedTask.upstreamTaskId, 'saved-upstream-id');
  assert.equal(interruptedTask.recoveryAttempts, 0);
  assert.ok(Date.parse(interruptedTask.recoveryDeadlineAt!) > Date.now());
  assert.ok(Date.parse(interruptedTask.nextRecoveryAt!) > Date.now());
  assert.ok(!JSON.stringify(publicTask(interruptedTask)).includes('private-key'));
  // Simulate the process disappearing while the saved remote task was being queried.
  await db.put('tasks', task.id, {
    ...interruptedTask,
    status: 'running',
    nextRecoveryAt: undefined,
  });
  await db.close();
  db = await openDatabase(dir);
  repo = new Repository(db);
  interrupted = false;
  assert.equal((await db.get<StoredTask>('tasks', task.id))?.upstreamTaskId, 'saved-upstream-id');
  runner = new JobRunner(db, repo, new Media(db, dir), key, client);
  await runner.start();
  await until(async () => (await db.get<StoredTask>('tasks', task.id))?.status === 'succeeded');
  await runner.stop();
  const result = (await db.get<StoredTask>('tasks', task.id))!;
  assert.equal(result.recoveryAttempts, 1);
  assert.equal(result.error, undefined);
  assert.equal(methods.filter((method) => method === 'POST').length, 1);
  assert.deepEqual(methods, ['POST', 'GET', 'GET', 'GET']);
  assert.equal((await db.list('versions', project.id)).length, 1);
  assert.equal((await db.list('assets', project.id)).length, 1);
  assert.equal(
    (await repo.project(project.id)).board.nodes.filter((node) => node.id === task.id).length,
    1,
  );
  assert.equal((await db.get<{ status: string }>('usage', task.id))?.status, 'succeeded');
  const resultPublic = publicTask(result);
  for (const privateField of [
    'secret',
    'config',
    'brief',
    'recoveryAttempts',
    'recoveryDeadlineAt',
    'nextRecoveryAt',
    'recoveryStopped',
  ])
    assert.equal(privateField in resultPublic, false);
  assert.equal(resultPublic.upstreamTaskId, 'saved-upstream-id');
});

test('reconciling async tasks recover on later ticks within persisted retry limits', async (context) => {
  let submissions = 0,
    resumes = 0;
  const f = await fixture(context, {
    generateImage: async () => {
      submissions++;
      throw new Error('Must not resubmit');
    },
    resumeImage: async () => {
      resumes++;
      throw new ProviderUncertainError();
    },
  });
  await f.db.put('tasks', f.task.id, {
    ...asyncTask(f.task),
    status: 'reconciling',
    upstreamTaskId: 'pending-job',
    recoveryDeadlineAt: new Date(Date.now() + 900000).toISOString(),
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.runner.tick();
    await until(async () => (await f.status()) === 'reconciling');
    // Drain this attempt before directly editing its next retry time.
    await f.runner.stop();
    const task = (await f.db.get<StoredTask>('tasks', f.task.id))!;
    assert.equal(task.recoveryAttempts, attempt);
    if (attempt < 3) {
      assert.ok(Date.parse(task.nextRecoveryAt!) > Date.now());
      await f.db.put('tasks', task.id, {
        ...task,
        nextRecoveryAt: new Date(Date.now() - 1000).toISOString(),
      });
      await f.runner.start();
    } else {
      assert.equal(task.nextRecoveryAt, undefined);
      assert.equal(task.recoveryStopped, true);
      assert.match(task.error!, /自动查询已停止/);
    }
  }
  await f.runner.start();
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(resumes, 3);
  assert.equal(submissions, 0);
  assert.equal(await f.status(), 'reconciling');
});

test('expired recovery and uncertain submissions with no saved ID never trigger supplier calls', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    generateImage: async () => {
      calls++;
      throw new Error('Must not submit');
    },
    resumeImage: async () => {
      calls++;
      throw new Error('Must not query');
    },
  });
  for (const task of [
    {
      ...asyncTask(f.task),
      status: 'running' as const,
      upstreamTaskId: 'old-job',
      recoveryDeadlineAt: new Date(Date.now() - 1).toISOString(),
    },
    { ...asyncTask(f.task), status: 'running' as const },
    { ...f.task, status: 'running' as const, upstreamTaskId: 'foreign-id' },
    {
      ...asyncTask(f.task),
      status: 'reconciling' as const,
      upstreamTaskId: 'job',
      recoveryStopped: true,
    },
  ]) {
    await f.db.put('tasks', task.id, task);
    await f.runner.start();
    await f.runner.tick();
    await f.runner.stop();
    assert.equal(await f.status(), 'reconciling');
  }
  assert.equal(calls, 0);
});

test('upstream failure and cancellation during recovery are terminal', async (context) => {
  let resumes = 0;
  let failure: Error = new Error('服务商报告图片生成失败');
  const f = await fixture(context, {
    resumeImage: async () => {
      resumes++;
      throw failure;
    },
  });
  for (const expected of ['failed', 'cancelled']) {
    if (expected === 'cancelled') failure = new ProviderCancelledError();
    await f.db.put('tasks', f.task.id, {
      ...asyncTask(f.task),
      status: 'running',
      upstreamTaskId: 'job',
    });
    await f.runner.start();
    await until(async () => (await f.status()) === expected);
    await f.runner.stop();
    assert.equal((await f.db.get<StoredTask>('tasks', f.task.id))?.nextRecoveryAt, undefined);
    await f.runner.start();
    await f.runner.tick();
    await f.runner.stop();
  }
  assert.equal(resumes, 2);
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
});

test('cancelled async tasks may save an arriving upstream ID but never resume or publish', async (context) => {
  const submitted = deferred<void>();
  const response = deferred<void>();
  let resumes = 0;
  const f = await fixture(context, {
    generateImage: async (_config, _key, _prompt, _reference, _signal, onSubmitted) => {
      submitted.resolve();
      await response.promise;
      await onSubmitted!('late-task-id');
      throw new ProviderUncertainError();
    },
    resumeImage: async () => {
      resumes++;
      return { bytes: Buffer.from('image'), mime: 'image/png' };
    },
  });
  await f.db.put('tasks', f.task.id, asyncTask(f.task));
  await f.runner.tick();
  await submitted.promise;
  assert.equal((await f.runner.cancel(f.task.id)).status, 'cancelled');
  response.resolve();
  await f.runner.stop();
  assert.equal((await f.db.get<StoredTask>('tasks', f.task.id))?.upstreamTaskId, 'late-task-id');
  assert.equal(await f.status(), 'cancelled');
  await f.runner.start();
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(resumes, 0);
  assert.equal(f.ingested(), 0);
});

test('cancelling reconciling tasks clears their scheduled recovery and survives worker restart', async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    resumeImage: async () => {
      calls++;
      throw new Error('Must not query');
    },
  });
  await f.db.put('tasks', f.task.id, {
    ...asyncTask(f.task),
    status: 'reconciling',
    upstreamTaskId: 'job',
    nextRecoveryAt: new Date(Date.now() + 5000).toISOString(),
  });
  const result = await f.runner.cancel(f.task.id);
  assert.equal(result.status, 'cancelled');
  assert.match(result.error!, /自动查询/);
  assert.equal((await f.db.get<StoredTask>('tasks', f.task.id))?.nextRecoveryAt, undefined);
  await f.runner.start();
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(calls, 0);
});

test('recovery deadline aborts an in-flight query before the channel timeout and stops further polling', async (context) => {
  let resumes = 0;
  const f = await fixture(context, {
    resumeImage: async (_config, _key, _id, signal) => {
      resumes++;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new ProviderUncertainError());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      throw new Error('Unreachable');
    },
  });
  const started = Date.now();
  await f.db.put('tasks', f.task.id, {
    ...asyncTask(f.task),
    status: 'reconciling',
    upstreamTaskId: 'job',
    recoveryDeadlineAt: new Date(started + 200).toISOString(),
  });
  await f.runner.tick();
  await until(async () => (await f.status()) === 'reconciling');
  await f.runner.stop();
  assert.ok(Date.now() - started < 2000);
  const last = (await f.db.get<StoredTask>('tasks', f.task.id))!;
  assert.equal(last.recoveryStopped, true);
  assert.equal(last.nextRecoveryAt, undefined);
  await f.runner.start();
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(resumes, 1);
});

test('failed cleanup after recovered output blocks future recovery to avoid duplicate publication', async (context) => {
  let resumes = 0,
    workerErrors = 0;
  const f = await fixture(context, {
    resumeImage: async () => {
      resumes++;
      return { bytes: Buffer.from('image'), mime: 'image/png' };
    },
    onWorkerError: () => {
      workerErrors++;
    },
  });
  await f.db.put('tasks', f.task.id, {
    ...asyncTask(f.task),
    status: 'reconciling',
    upstreamTaskId: 'job',
  });
  const version = f.repo.version.bind(f.repo),
    project = f.repo.project.bind(f.repo);
  f.repo.version = async (input) => {
    await version(input);
    f.repo.project = async () => {
      throw new Error('Storage temporarily unavailable during cleanup');
    };
    throw new Error('Partial publication');
  };
  await f.runner.tick();
  await until(async () => (await f.status()) === 'reconciling');
  await f.runner.stop();
  f.repo.project = project;
  const last = (await f.db.get<StoredTask>('tasks', f.task.id))!;
  assert.equal(last.recoveryStopped, true);
  assert.equal(last.nextRecoveryAt, undefined);
  assert.equal(workerErrors, 1);
  await f.runner.start();
  await f.runner.tick();
  await f.runner.stop();
  assert.equal(resumes, 1);
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
  assert.match(last.error!, /本地保存未完成/);
});
