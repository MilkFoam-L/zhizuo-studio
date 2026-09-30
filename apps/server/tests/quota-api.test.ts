import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { EMPTY_BRIEF, type ProjectDetail } from '../../../packages/shared/src/index';
import type { StoredTask } from '../src/jobs';
const headers = { host: 'localhost:4317' };
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-quota-api-'));
  const s = await createApp({ dataDir: dir, worker: false });
  const p = await s.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: {
      title: '额度验证',
      brief: { ...EMPTY_BRIEF, productName: '商品', sellingPoints: '真实说明', confirmed: true },
    },
  });
  const project = p.json<ProjectDetail>().project;
  const provider = (
    await s.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: {
        name: 'fixture',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'fake-test-secret',
        textModel: 'text',
        imageModel: '',
        timeoutSeconds: 30,
      },
    })
  ).json();
  const submit = (id: string) =>
    s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tasks`,
      headers,
      payload: { kind: 'copy', providerId: provider.id, prompt: '测试', idempotencyKey: id },
    });
  return {
    ...s,
    project,
    submit,
    close: async () => {
      await s.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('API task creation and quota reservation commit together and rollback on task insert failure', async () => {
  const f = await setup();
  try {
    await f.quotas.setLimit('local', 2, '测试限额', 'local-operator');
    const original = f.db.query.bind(f.db);
    let fail = true;
    f.db.query = async (sql, params) => {
      if (fail && sql.includes("VALUES('tasks'")) {
        fail = false;
        throw new Error('fixture insert failed');
      }
      return original(sql, params);
    };
    let r = await f.submit('atomic-failure-key');
    assert.equal(r.statusCode, 400);
    assert.equal((await f.quotas.summary('local')).reserved, 0);
    assert.equal((await f.db.list('tasks')).length, 0);
    r = await f.submit('atomic-success-key');
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id;
    await f.submit('atomic-success-key');
    assert.equal((await f.quotas.summary('local')).reserved, 1);
    assert.equal(
      (await f.quotas.summary('local')).events.filter((e) => e.action === 'reserve').length,
      1,
    );
    r = await f.app.inject({ method: 'POST', url: `/api/tasks/${id}/cancel`, headers });
    assert.equal(r.statusCode, 200);
    const summary = await f.quotas.summary('local');
    assert.equal(summary.reserved, 0);
    assert.equal(summary.available, 2);
    assert.equal(summary.records[0].state, 'released');
    r = await f.app.inject({ method: 'GET', url: '/api/usage', headers });
    assert.equal(r.json().quota.unit, 'task');
    assert.equal(r.json().quota.timeZone, 'Asia/Shanghai');
  } finally {
    await f.close();
  }
});

test('manual quota review is scoped, rejects active leases and stops async recovery before resolution', async () => {
  const f = await setup();
  try {
    let r = await f.submit('manual-review-task');
    const id = r.json().id;
    const t = (await f.db.get<StoredTask>('tasks', id))!;
    const resolve = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/admin/quotas/local/resolve',
        headers,
        payload: { taskId: id, action: 'release', reason: '供应商已核对，无需计入此次任务额度' },
      });
    assert.equal((await resolve()).statusCode, 409);
    await f.db.put('tasks', id, {
      ...t,
      status: 'reconciling',
      submissionStarted: true,
      leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
    });
    await f.quotas.settle({ ...t, status: 'reconciling', submissionStarted: true });
    assert.equal((await resolve()).statusCode, 409);
    await f.db.put('tasks', id, {
      ...t,
      status: 'reconciling',
      submissionStarted: true,
      upstreamTaskId: 'reference-task',
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    r = await f.app.inject({
      method: 'GET',
      url: '/api/admin/quotas/local/reviews?limit=1',
      headers,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().records[0].taskId, id);
    r = await resolve();
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().reserved, 0);
    assert.equal(r.json().reviewCount, 0);
    assert.equal((await f.db.get<StoredTask>('tasks', id))?.status, 'cancelled');
    assert.equal((await f.db.get<StoredTask>('tasks', id))?.recoveryStopped, true);
    assert.equal((await resolve()).statusCode, 200);
    assert.equal(
      (await f.quotas.summary('local')).events.filter((e) => e.action === 'release').length,
      1,
    );
    r = await f.app.inject({
      method: 'GET',
      url: '/api/admin/quotas/00000000-0000-4000-a000-000000000001',
      headers,
    });
    assert.equal(r.statusCode, 404);
  } finally {
    await f.close();
  }
});

test('members can read only their own quota and only administrators can adjust other workspaces', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-quota-owner-'));
  const password = 'quota-password-test-only';
  const f = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: { email: 'admin@example.test', password } },
  });
  const login = async (email: string) => {
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { email, password },
    });
    assert.equal(r.statusCode, 200, r.body);
    return { cookie: (r.headers['set-cookie'] as string).split(';')[0], user: r.json().user };
  };
  try {
    const admin = await login('admin@example.test');
    const member = await f.accounts!.createAccount({
      email: 'member@example.test',
      password,
      displayName: '成员',
    });
    const other = await f.accounts!.createAccount({
      email: 'other@example.test',
      password,
      displayName: '另一成员',
    });
    const m = await login(member.email);
    let r = await f.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { ...headers, cookie: m.cookie },
    });
    assert.equal(r.json().quota.workspaceId, member.workspace.id);
    for (const url of [
      '/api/admin/quota-workspaces',
      `/api/admin/quotas/${other.workspace.id}`,
      `/api/admin/quotas/${member.workspace.id}/reviews`,
    ]) {
      r = await f.app.inject({ method: 'GET', url, headers: { ...headers, cookie: m.cookie } });
      assert.equal(r.statusCode, 403);
    }
    r = await f.app.inject({
      method: 'PATCH',
      url: `/api/admin/quotas/${member.workspace.id}`,
      headers: { ...headers, cookie: admin.cookie },
      payload: { limit: 7, reason: '内测成员任务额度' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().limit, 7);
    assert.equal((await f.quotas.summary(other.workspace.id)).limit, 100);
    r = await f.app.inject({
      method: 'GET',
      url: '/api/admin/quotas/local',
      headers: { ...headers, cookie: admin.cookie },
    });
    assert.equal(r.statusCode, 404);
  } finally {
    await f.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
