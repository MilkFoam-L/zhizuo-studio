import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApp } from '../src/app';
import { EMPTY_BRIEF, type ProjectDetail } from '../../../packages/shared/src/index';
const host = { host: 'localhost:4317' };
const brief = { ...EMPTY_BRIEF, productName: '棉布包', sellingPoints: '棉布外层', confirmed: true };
const password = 'test-password-only-2026';
function form(bytes: Buffer, name: string) {
  const boundary = 'tenancy-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
test('accounts HTTP resources fail closed across projects, assets, providers, tasks, exports and backups', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-tenant-'));
  const oldLimit = process.env.MAX_DAILY_TASKS;
  process.env.MAX_DAILY_TASKS = '1';
  const s = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: { email: 'admin@example.test', password } },
  });
  if (oldLimit === undefined) delete process.env.MAX_DAILY_TASKS;
  else process.env.MAX_DAILY_TASKS = oldLimit;
  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    cookie?: string,
    payload?: unknown,
  ) {
    return s.app.inject({
      method,
      url,
      headers: { ...host, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  }
  async function login(email: string) {
    const r = await call('POST', '/api/session', undefined, { email, password });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().mode, 'accounts');
    return { cookie: (r.headers['set-cookie'] as string).split(';')[0], user: r.json().user };
  }
  try {
    const legacy = await s.repo.create('旧本地资料');
    const admin = await login('admin@example.test');
    for (const email of ['alice@example.test', 'bob@example.test']) {
      const r = await call('POST', '/api/admin/accounts', admin.cookie, {
        email,
        password,
        displayName: email.split('@')[0],
        role: 'admin',
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().role, 'member');
      assert.ok(!r.body.includes('password'));
    }
    const alice = await login('alice@example.test'),
      bob = await login('bob@example.test');
    assert.notEqual(alice.user.workspace.id, bob.user.workspace.id);
    assert.equal((await call('GET', '/api/admin/accounts', alice.cookie)).statusCode, 403);
    assert.equal((await call('GET', '/%61pi/projects')).statusCode, 401);
    assert.equal((await call('GET', `/api/projects/${legacy.id}`, admin.cookie)).statusCode, 404);
    let r = await call('POST', '/api/projects', alice.cookie, {
      title: 'Alice项目',
      brief,
      workspaceId: bob.user.workspace.id,
    });
    assert.equal(r.statusCode, 200, r.body);
    const a = r.json<ProjectDetail>().project;
    assert.equal(a.workspaceId, alice.user.workspace.id);
    r = await call('POST', '/api/projects', bob.cookie, { title: 'Bob项目', brief });
    const b = r.json<ProjectDetail>().project;
    for (const c of [alice, bob]) {
      r = await call('GET', '/api/projects', c.cookie);
      assert.equal(r.json().length, 1);
      assert.equal(r.json()[0].workspaceId, c.user.workspace.id);
    }
    r = await call('GET', '/api/projects', admin.cookie);
    assert.equal(r.json().length, 0);
    const providerInput = {
      name: '私有渠道',
      kind: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'fake-only-secret',
      textModel: 'text',
      imageModel: 'image',
      timeoutSeconds: 30,
    };
    r = await call('POST', '/api/providers', alice.cookie, {
      ...providerInput,
      workspaceId: bob.user.workspace.id,
    });
    const providerA = r.json();
    assert.equal(r.statusCode, 200, r.body);
    r = await call('POST', '/api/providers', bob.cookie, providerInput);
    const providerB = r.json();
    assert.equal((await call('GET', '/api/providers', bob.cookie)).json().length, 1);
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const upload = form(image, 'product.png');
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${a.id}/assets`,
      ...upload,
      headers: { ...host, ...upload.headers, cookie: alice.cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    const asset = r.json();
    r = await call('POST', `/api/projects/${a.id}/posters`, alice.cookie, {
      templateId: 'xhs-editorial',
      assetId: asset.id,
    });
    assert.equal(r.statusCode, 200, r.body);
    const version = r.json();
    const taskInput = {
      kind: 'copy',
      providerId: providerA.id,
      prompt: '内容草稿',
      idempotencyKey: 'alice-request-key',
    };
    r = await call('POST', `/api/projects/${a.id}/tasks`, alice.cookie, taskInput);
    assert.equal(r.statusCode, 200, r.body);
    const task = r.json();
    r = await call('POST', `/api/projects/${a.id}/tasks`, alice.cookie, {
      ...taskInput,
      idempotencyKey: 'alice-next-key',
    });
    assert.equal(r.statusCode, 429);
    r = await call('POST', `/api/projects/${b.id}/tasks`, bob.cookie, {
      ...taskInput,
      providerId: providerA.id,
      idempotencyKey: 'bob-foreign-key',
    });
    assert.equal(r.statusCode, 404);
    r = await call('POST', `/api/projects/${b.id}/tasks`, bob.cookie, {
      ...taskInput,
      providerId: providerB.id,
      idempotencyKey: 'bob-own-key',
    });
    assert.equal(r.statusCode, 200, r.body);
    const forbidden: [string, string, unknown?][] = [
      ['GET', `/api/projects/${a.id}`],
      ['PATCH', `/api/projects/${a.id}`, { revision: a.revision, title: 'hijacked' }],
      ['GET', `/api/projects/${a.id}/backup`],
      ['GET', `/api/projects/${a.id}/tasks`],
      ['POST', `/api/projects/${a.id}/posters`, { templateId: 'xhs-editorial' }],
      ['GET', `/api/assets/${asset.id}/content`],
      ['GET', `/api/assets/${asset.id}/thumbnail`],
      ['GET', `/api/versions/${version.id}/preview`],
      ['POST', `/api/tasks/${task.id}/cancel`, {}],
      ['PUT', `/api/providers/${providerA.id}`, providerInput],
      ['DELETE', `/api/providers/${providerA.id}`],
      ['POST', `/api/providers/${providerA.id}/test`, {}],
      ['POST', '/api/exports', { projectId: a.id, versionIds: [version.id], acknowledged: true }],
    ];
    for (const [method, url, payload] of forbidden) {
      r = await call(method as any, url, bob.cookie, payload);
      assert.equal(r.statusCode, 404, `${method} ${url}: ${r.body}`);
      assert.ok(!r.body.includes('fake-only-secret'));
    }
    r = await call('GET', `/api/projects/${b.id}`, bob.cookie);
    const bp = r.json<ProjectDetail>().project;
    r = await call('PATCH', `/api/projects/${b.id}`, bob.cookie, {
      revision: bp.revision,
      board: {
        ...bp.board,
        nodes: [
          ...bp.board.nodes,
          {
            id: 'foreign-node',
            type: 'content',
            position: { x: 0, y: 0 },
            data: { kind: 'asset', label: 'foreign', assetId: asset.id },
          },
        ],
      },
    });
    assert.equal(r.statusCode, 400);
    await s.db.put('usage', 'a-usage', { id: 'a-usage', projectId: a.id, cost: null });
    await s.db.put('usage', 'b-usage', { id: 'b-usage', projectId: b.id, cost: null });
    r = await call('GET', '/api/usage', bob.cookie);
    assert.deepEqual(
      r.json().records.map((x: { id: string }) => x.id),
      ['b-usage'],
    );
    // A user-authorized ZIP import creates new resources in the current user's workspace.
    r = await call('GET', `/api/projects/${a.id}/backup`, alice.cookie);
    assert.equal(r.statusCode, 200, r.body);
    const uploadBackup = form(r.rawPayload, 'backup.zip');
    r = await s.app.inject({
      method: 'POST',
      url: '/api/import',
      ...uploadBackup,
      headers: { ...host, ...uploadBackup.headers, cookie: bob.cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    const restored = r.json<ProjectDetail>();
    assert.equal(restored.project.workspaceId, bob.user.workspace.id);
    assert.notEqual(restored.assets[0].id, asset.id);
    r = await call('PATCH', `/api/admin/accounts/${admin.user.id}`, admin.cookie, {
      disabled: true,
    });
    assert.equal(r.statusCode, 409);
    r = await call('PATCH', `/api/admin/accounts/${alice.user.id}`, admin.cookie, {
      disabled: true,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().disabled, true);
    r = await call('GET', '/api/projects', alice.cookie);
    assert.equal(r.statusCode, 401);
    assert.equal((await s.db.get<{ status: string }>('tasks', task.id))?.status, 'cancelled');
    assert.equal((await call('GET', `/api/projects/${a.id}`, admin.cookie)).statusCode, 404);
    r = await call('POST', '/api/session', undefined, { email: 'alice@example.test', password });
    assert.equal(r.statusCode, 401);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('disable and task creation are serialized, and queued requests revalidate revoked sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-race-'));
  const s = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: { email: 'admin@example.test', password } },
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    cookie: string | undefined,
    payload?: any,
  ) => s.app.inject({ method, url, headers: { ...host, ...(cookie ? { cookie } : {}) }, payload });
  const login = async (email: string) => {
    const r = await call('POST', '/api/session', undefined, { email, password });
    assert.equal(r.statusCode, 200, r.body);
    return { cookie: (r.headers['set-cookie'] as string).split(';')[0], user: r.json().user };
  };
  try {
    const admin = await login('admin@example.test');
    for (const email of ['alice@example.test', 'bob@example.test'])
      await call('POST', '/api/admin/accounts', admin.cookie, {
        email,
        password,
        displayName: email,
      });
    const alice = await login('alice@example.test'),
      bob = await login('bob@example.test');
    async function setup(cookie: string) {
      const p = (
        await call('POST', '/api/projects', cookie, { title: '竞态项目', brief })
      ).json<ProjectDetail>().project;
      const provider = (
        await call('POST', '/api/providers', cookie, {
          name: '测试',
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'fake-test-key',
          textModel: 'text',
          imageModel: '',
          timeoutSeconds: 30,
        })
      ).json();
      return { project: p, provider };
    }
    const a = await setup(alice.cookie),
      b = await setup(bob.cookie);
    const original = s.db.query.bind(s.db);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let once = true;
    s.db.query = async (sql, params) => {
      if (once && sql.includes("VALUES('tasks'")) {
        once = false;
        entered();
        await blocked;
      }
      return original(sql, params);
    };
    const create = call('POST', `/api/projects/${b.project.id}/tasks`, bob.cookie, {
      kind: 'copy',
      providerId: b.provider.id,
      prompt: '阻塞一个创建请求',
      idempotencyKey: 'first-blocking-task',
    }).then((r) => r);
    await enteredPromise;
    const disable = call('PATCH', `/api/admin/accounts/${alice.user.id}`, admin.cookie, {
      disabled: true,
    }).then((r) => r);
    // Wait until the already-authenticated disable request has joined the shared queue.
    await new Promise((r) => setTimeout(r, 30));
    const late = call('POST', `/api/projects/${a.project.id}/tasks`, alice.cookie, {
      kind: 'copy',
      providerId: a.provider.id,
      prompt: '会话在等待中撤销',
      idempotencyKey: 'late-revoked-task',
    }).then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    release();
    assert.equal((await create).statusCode, 200);
    assert.equal((await disable).statusCode, 200);
    const lateResult = await late;
    assert.equal(lateResult.statusCode, 401, lateResult.body);
    assert.equal(
      (await s.db.list<{ projectId: string }>('tasks')).filter((t) => t.projectId === a.project.id)
        .length,
      0,
    );
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('changing from local to accounts leaves legacy jobs unexecuted and personal jobs survive a restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-mode-'));
  let calls = 0;
  let s = await createApp({
    dataDir: dir,
    worker: false,
    execution: {
      generateCopy: async () => {
        calls++;
        return {
          titles: ['fixture'],
          body: 'fixture',
          tags: [],
          pages: [{ headline: 'fixture', body: 'fixture' }],
          warnings: [],
        };
      },
    },
  });
  try {
    let r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: host,
      payload: { title: '旧本地项目', brief },
    });
    const p = r.json<ProjectDetail>().project;
    r = await s.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: host,
      payload: {
        name: '旧本地渠道',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'fake-local-test',
        textModel: 'text',
        imageModel: '',
        timeoutSeconds: 30,
      },
    });
    const provider = r.json();
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/tasks`,
      headers: host,
      payload: {
        kind: 'copy',
        providerId: provider.id,
        prompt: '不可见的旧任务',
        idempotencyKey: 'legacy-queued-task',
      },
    });
    const task = r.json();
    assert.equal(task.status, 'queued');
    await s.app.close();
    s = await createApp({
      dataDir: dir,
      worker: false,
      accounts: { bootstrap: { email: 'admin@example.test', password } },
      execution: {
        generateCopy: async () => {
          calls++;
          throw new Error('must not run legacy task');
        },
      },
    });
    await s.runner.tick();
    assert.equal(calls, 0);
    assert.equal((await s.db.get<{ status: string }>('tasks', task.id))?.status, 'cancelled');
    r = await s.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: host,
      payload: { email: 'admin@example.test', password },
    });
    const cookie = (r.headers['set-cookie'] as string).split(';')[0];
    const user = r.json().user;
    assert.equal(
      (
        await s.app.inject({ method: 'GET', url: '/api/projects', headers: { ...host, cookie } })
      ).json().length,
      0,
    );
    r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...host, cookie },
      payload: { title: '个人项目', brief },
    });
    const personal = r.json<ProjectDetail>().project;
    await s.app.close();
    s = await createApp({ dataDir: dir, worker: false, accounts: {} });
    r = await s.app.inject({
      method: 'GET',
      url: `/api/projects/${personal.id}`,
      headers: { ...host, cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().project.workspaceId, user.workspace.id);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
