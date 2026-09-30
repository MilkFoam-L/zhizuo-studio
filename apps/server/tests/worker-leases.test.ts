import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db';
import { Repository } from '../src/repository';
import { JobRunner, publicTask, type JobExecution, type StoredTask } from '../src/jobs';
import type { Media } from '../src/media';
import { encryptSecret, ProviderUncertainError } from '../src/providers';
import {
  EMPTY_BRIEF,
  type Asset,
  type ContentVersion,
  type CopyDraft,
} from '../../../packages/shared/src/index';

const key = 'ab'.repeat(32);
const copy: CopyDraft = {
  titles: ['商品草稿'],
  body: '已确认的商品事实',
  tags: [],
  pages: [],
  warnings: [],
};
const image = { bytes: Buffer.from('test image'), mime: 'image/png' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ProviderUncertainError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Worker did not settle');
}
async function fixture(context: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-leases-'));
  const db = await openDatabase(dir);
  const repo = new Repository(db);
  const project = await repo.create('租约测试', {
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
    prompt: '草稿',
    attempts: 0,
    submissionStarted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    brief: project.brief,
    config: {
      name: '测试',
      kind: 'openai',
      baseUrl: 'https://example.com/v1',
      textModel: 'text',
      imageModel: 'image',
      timeoutSeconds: 30,
    },
    secret: encryptSecret('test-secret', key),
  };
  const removed: string[] = [];
  const media = {
    ingest: async (projectId: string, _bytes: Buffer, name: string): Promise<Asset> => {
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
    removeIfUnreferenced: async (id: string, projectId: string) => {
      const versions = await db.list<ContentVersion>('versions', projectId);
      const project = await repo.project(projectId);
      if (
        versions.some((version) => version.assetId === id || version.poster?.assetId === id) ||
        project.board.nodes.some((node) => node.data.assetId === id)
      )
        return false;
      removed.push(id);
      await db.remove('assets', id);
      return true;
    },
  } as unknown as Media;
  const runners: JobRunner[] = [];
  const runner = (execution: JobExecution = {}) => {
    const result = new JobRunner(db, repo, media, key, {
      generateCopy: async () => copy,
      generateImage: async () => image,
      ...execution,
    });
    runners.push(result);
    return result;
  };
  context.after(async () => {
    await Promise.all(runners.map((r) => r.stop()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.put('tasks', task.id, task);
  return {
    db,
    repo,
    project,
    task,
    media,
    removed,
    runner,
    current: async () => (await db.get<StoredTask>('tasks', task.id))!,
  };
}

function asyncTask(task: StoredTask): StoredTask {
  return {
    ...task,
    kind: 'image',
    config: {
      ...task.config,
      kind: 'async-json',
      asyncMapping: {
        submitPath: '/tasks',
        pollPath: '/tasks/{taskId}',
        taskIdPath: 'id',
        statusPath: 'status',
        successValue: 'done',
        failureValue: 'error',
        resultUrlPath: 'url',
      },
    },
  };
}

test('two runners claim atomically and commit the paid-request checkpoint before one supplier call', async (context) => {
  const f = await fixture(context);
  const ready = deferred<void>(),
    result = deferred<CopyDraft>();
  let calls = 0;
  const execution: JobExecution = {
    generateCopy: async (_c, _k, _b, _p, signal) => {
      calls++;
      const current = await f.current();
      assert.equal(current.submissionStarted, true);
      assert.ok(current.submissionStartedAt);
      assert.ok(current.workerId && current.leaseToken && current.leaseExpiresAt);
      ready.resolve();
      return abortable(result.promise, signal);
    },
  };
  const a = f.runner(execution),
    b = f.runner(execution);
  await Promise.all([a.tick(), b.tick()]);
  await ready.promise;
  assert.equal(calls, 1);
  assert.equal((await f.current()).attempts, 1);
  result.resolve(copy);
  await until(async () => (await f.current()).status === 'succeeded');
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
  for (const field of [
    'workerId',
    'leaseToken',
    'leaseExpiresAt',
    'submissionStartedAt',
    'submissionStarted',
    'secret',
    'config',
  ])
    assert.equal(field in publicTask(await f.current()), false);
});

test('starting another worker preserves a live running lease', async (context) => {
  const f = await fixture(context);
  const ready = deferred<void>(),
    result = deferred<CopyDraft>();
  let calls = 0;
  const execution: JobExecution = {
    generateCopy: async (_c, _k, _b, _p, signal) => {
      calls++;
      ready.resolve();
      return abortable(result.promise, signal);
    },
  };
  const a = f.runner(execution),
    b = f.runner(execution);
  await a.tick();
  await ready.promise;
  const original = await f.current();
  await b.start();
  await b.tick();
  assert.equal((await f.current()).status, 'running');
  assert.equal((await f.current()).leaseToken, original.leaseToken);
  assert.equal(calls, 1);
  result.resolve(copy);
  await until(async () => (await f.current()).status === 'succeeded');
});

test('heartbeat extends ownership and an API-only runner cancellation aborts the remote worker wait', async (context) => {
  const f = await fixture(context);
  const ready = deferred<void>(),
    aborted = deferred<void>();
  const worker = f.runner({
    leaseDurationMs: 1200,
    heartbeatMs: 100,
    generateCopy: async (_c, _k, _b, _p, signal) => {
      ready.resolve();
      return new Promise<CopyDraft>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            reject(new ProviderUncertainError());
          },
          { once: true },
        );
      });
    },
  });
  const api = f.runner();
  await worker.tick();
  await ready.promise;
  const originalExpiry = (await f.current()).leaseExpiresAt!;
  await new Promise((resolve) => setTimeout(resolve, 1400));
  await api.tick();
  const running = await f.current();
  assert.equal(running.status, 'running');
  assert.ok(Date.parse(running.leaseExpiresAt!) > Date.parse(originalExpiry));
  const cancelled = await api.cancel(f.task.id);
  assert.equal(cancelled.status, 'cancelled');
  await aborted.promise;
  await worker.stop();
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.equal((await f.db.get<{ status: string }>('usage', f.task.id))?.status, 'cancelled');
  const stoppedExpiry = (await f.current()).leaseExpiresAt;
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal((await f.current()).leaseExpiresAt, stoppedExpiry);
});

test('expired submitted leases without an upstream ID become uncertain and never submit again', async (context) => {
  const f = await fixture(context);
  let calls = 0;
  const worker = f.runner({
    generateCopy: async () => {
      calls++;
      return copy;
    },
  });
  await f.db.put('tasks', f.task.id, {
    ...f.task,
    status: 'running',
    attempts: 1,
    submissionStarted: true,
    submissionStartedAt: new Date().toISOString(),
    workerId: 'lost-worker',
    leaseToken: 'lost-token',
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await worker.start();
  await worker.tick();
  await worker.stop();
  await worker.start();
  await worker.tick();
  assert.equal((await f.current()).status, 'reconciling');
  assert.equal(calls, 0);
  assert.equal((await f.current()).attempts, 1);
});

test('a queued record with a previous paid-request checkpoint cannot be resubmitted', async (context) => {
  const f = await fixture(context);
  let calls = 0;
  await f.db.put('tasks', f.task.id, {
    ...f.task,
    submissionStarted: true,
    submissionStartedAt: new Date().toISOString(),
  });
  await f
    .runner({
      generateCopy: async () => {
        calls++;
        return copy;
      },
    })
    .tick();
  assert.equal((await f.current()).status, 'reconciling');
  assert.equal(calls, 0);
});

test('expired async leases recover by the saved ID and publish one result without POST', async (context) => {
  const f = await fixture(context);
  let submits = 0,
    gets = 0;
  await f.db.put('tasks', f.task.id, {
    ...asyncTask(f.task),
    status: 'running',
    attempts: 1,
    upstreamTaskId: 'saved-job',
    submissionStarted: true,
    workerId: 'crashed',
    leaseToken: 'old-token',
    leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
  });
  const execution: JobExecution = {
    generateImage: async () => {
      submits++;
      return image;
    },
    resumeImage: async (_config, _key, taskId) => {
      gets++;
      assert.equal(taskId, 'saved-job');
      return image;
    },
  };
  await Promise.all([f.runner(execution).tick(), f.runner(execution).tick()]);
  await until(async () => (await f.current()).status === 'succeeded');
  assert.equal(submits, 0);
  assert.equal(gets, 1);
  assert.equal((await f.current()).recoveryAttempts, 1);
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
});

test('stale token cannot publish or overwrite the next worker task state', async (context) => {
  const f = await fixture(context);
  const ready = deferred<void>(),
    result = deferred<CopyDraft>();
  const worker = f.runner({
    generateCopy: async () => {
      ready.resolve();
      return result.promise;
    },
  });
  await worker.tick();
  await ready.promise;
  await f.db.put('tasks', f.task.id, {
    ...(await f.current()),
    workerId: 'replacement',
    leaseToken: 'replacement-token',
  });
  result.resolve(copy);
  await worker.stop();
  assert.equal((await f.current()).status, 'running');
  assert.equal((await f.current()).leaseToken, 'replacement-token');
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
});

test('a stale image worker cleans its own asset and preserves a replacement published version', async (context) => {
  const f = await fixture(context);
  await f.db.put('tasks', f.task.id, { ...f.task, kind: 'image' });
  const ready = deferred<Asset>(),
    release = deferred<void>();
  const ingest = f.media.ingest.bind(f.media);
  f.media.ingest = async (...args) => {
    const asset = await ingest(...args);
    ready.resolve(asset);
    await release.promise;
    return asset;
  };
  const worker = f.runner();
  await worker.tick();
  const oldAsset = await ready.promise;
  const retained = await ingest(f.project.id, image.bytes, 'replacement.png');
  await f.repo.version({
    id: f.task.id,
    projectId: f.project.id,
    kind: 'image',
    label: '新执行器结果',
    assetId: retained.id,
    taskId: f.task.id,
  });
  await f.db.put('tasks', f.task.id, {
    ...(await f.current()),
    workerId: 'replacement',
    leaseToken: 'replacement-token',
    status: 'succeeded',
    resultVersionId: f.task.id,
  });
  release.resolve();
  await worker.stop();
  const version = await f.db.get<ContentVersion>('versions', f.task.id);
  assert.equal(version?.assetId, retained.id);
  assert.equal((await f.db.list('assets', f.project.id)).length, 1);
  assert.deepEqual(f.removed, [oldAsset.id]);
  assert.equal(
    (await f.repo.project(f.project.id)).board.nodes.filter((node) => node.id === f.task.id).length,
    1,
  );
});

test('an arriving upstream receipt from a superseded token cannot overwrite the current receipt', async (context) => {
  const f = await fixture(context);
  await f.db.put('tasks', f.task.id, asyncTask(f.task));
  const ready = deferred<void>(),
    release = deferred<void>();
  const worker = f.runner({
    generateImage: async (_c, _k, _p, _r, _s, onSubmitted) => {
      ready.resolve();
      await release.promise;
      await onSubmitted!('old-upstream-id');
      return image;
    },
  });
  await worker.tick();
  await ready.promise;
  await f.db.put('tasks', f.task.id, {
    ...(await f.current()),
    leaseToken: 'replacement-token',
    upstreamTaskId: 'current-id',
  });
  release.resolve();
  await worker.stop();
  assert.equal((await f.current()).upstreamTaskId, 'current-id');
  assert.equal((await f.current()).status, 'running');
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
});

test('a separate API runner waits for atomic publication before reporting cancellation result', async (context) => {
  const f = await fixture(context);
  const entered = deferred<void>(),
    release = deferred<void>();
  const version = f.repo.version.bind(f.repo);
  f.repo.version = async (input) => {
    const value = await version(input);
    entered.resolve();
    await release.promise;
    return value;
  };
  const worker = f.runner(),
    api = f.runner();
  await worker.tick();
  await entered.promise;
  let cancelled = false;
  const pending = api.cancel(f.task.id).then((value) => {
    cancelled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(cancelled, false);
  release.resolve();
  assert.equal((await pending).status, 'succeeded');
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
});

test('account disabled after submission prevents publication and settles only committed state', async (context) => {
  const f = await fixture(context);
  const ready = deferred<void>(),
    result = deferred<CopyDraft>();
  let enabled = true;
  const settled: string[] = [];
  const worker = f.runner({
    canRunProject: async () => enabled,
    generateCopy: async () => {
      ready.resolve();
      return result.promise;
    },
    onTaskSettled: async (task) => {
      assert.equal((await f.current()).status, task.status);
      settled.push(task.status);
    },
  });
  await worker.tick();
  await ready.promise;
  enabled = false;
  result.resolve(copy);
  await until(async () => (await f.current()).status === 'cancelled');
  await worker.stop();
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.ok(settled.includes('cancelled'));
});

test('a lease that expires during publication rolls back the version and board mutation', async (context) => {
  const f = await fixture(context);
  const version = f.repo.version.bind(f.repo);
  f.repo.version = async (input) => {
    const saved = await version(input);
    await new Promise((resolve) => setTimeout(resolve, 550));
    return saved;
  };
  const worker = f.runner({ leaseDurationMs: 400, heartbeatMs: 75 });
  await worker.tick();
  await until(async () => (await f.current()).status === 'reconciling');
  await worker.stop();
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.equal((await f.repo.project(f.project.id)).board.nodes.length, 1);
  assert.equal((await f.current()).attempts, 1);
});

test('API cancellation proceeds during blob ingest and prevents result publication', async (context) => {
  const f = await fixture(context);
  await f.db.put('tasks', f.task.id, { ...f.task, kind: 'image' });
  const entered = deferred<void>(),
    release = deferred<void>();
  const ingest = f.media.ingest.bind(f.media);
  f.media.ingest = async (...args) => {
    const asset = await ingest(...args);
    entered.resolve();
    await release.promise;
    return asset;
  };
  const worker = f.runner(),
    api = f.runner();
  await worker.tick();
  await entered.promise;
  assert.equal((await api.cancel(f.task.id)).status, 'cancelled');
  release.resolve();
  await worker.stop();
  assert.equal((await f.db.list('versions', f.project.id)).length, 0);
  assert.equal((await f.db.list('assets', f.project.id)).length, 0);
  assert.equal(f.removed.length, 1);
});

test('expired pre-submit claim is safely requeued and the old worker cannot submit after replacement', async (context) => {
  const f = await fixture(context);
  const reference = await f.media.ingest(f.project.id, image.bytes, 'reference.png');
  await f.db.put('tasks', f.task.id, { ...f.task, kind: 'image', referenceAssetId: reference.id });
  const entered = deferred<void>(),
    release = deferred<void>();
  let reads = 0,
    posts = 0;
  f.media.owned = async () => reference;
  f.media.bytes = async () => {
    if (++reads === 1) {
      entered.resolve();
      await release.promise;
    }
    return image.bytes;
  };
  const execution: JobExecution = {
    generateImage: async () => {
      posts++;
      return image;
    },
  };
  const old = f.runner(execution),
    replacement = f.runner(execution);
  await old.tick();
  await entered.promise;
  const claimed = await f.current();
  assert.equal(claimed.submissionStarted, false);
  assert.equal(claimed.submissionStartedAt, undefined);
  await f.db.put('tasks', f.task.id, { ...claimed, leaseExpiresAt: new Date(0).toISOString() });
  await replacement.tick();
  await until(async () => (await f.current()).status === 'succeeded');
  release.resolve();
  await old.stop();
  assert.equal(posts, 1);
  assert.notEqual((await f.current()).leaseToken, claimed.leaseToken);
  assert.equal((await f.current()).attempts, 2);
  assert.equal((await f.db.list('versions', f.project.id)).length, 1);
});
