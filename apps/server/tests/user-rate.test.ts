import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { EMPTY_BRIEF, type ProjectDetail, type Provider } from '../../../packages/shared/src/index';

const headers = { host: 'localhost:4317' };
const brief = { ...EMPTY_BRIEF, productName: '限流商品', sellingPoints: '卖点', confirmed: true };

test('per-user task submission rate limit returns 429 beyond the configured window', async (t) => {
  process.env.USER_TASK_RATE_PER_MINUTE = '2';
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-user-rate-'));
  const state = await createApp({ dataDir: dir, worker: false });
  try {
    let r = await state.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: {
        name: '限流渠道',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'rate-limit-key',
        textModel: 'text',
        imageModel: 'image',
        timeoutSeconds: 30,
      },
    });
    const provider = r.json<Provider>();
    r = await state.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '限流验证', brief },
    });
    const project = r.json<ProjectDetail>().project;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks`,
        headers,
        payload: {
          kind: 'copy',
          providerId: provider.id,
          prompt: '图文',
          idempotencyKey: `rate-key-${i}`,
        },
      });
      statuses.push(res.statusCode);
    }
    // 前两次进入窗口，第三次触发限流；第 4 次仍在窗口内继续拒绝。
    assert.deepEqual(statuses.slice(2), [429, 429]);
    assert.ok(statuses[0] === 200 && statuses[1] === 200, statuses.join(','));
  } finally {
    delete process.env.USER_TASK_RATE_PER_MINUTE;
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('quota usage notices fire once at 80% and 100% of the daily window', async (t) => {
  process.env.MAX_DAILY_TASKS = '5';
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-quota-notice-'));
  const state = await createApp({ dataDir: dir, worker: false });
  try {
    let r = await state.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: {
        name: '额度渠道',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'quota-notice-key',
        textModel: 'text',
        imageModel: 'image',
        timeoutSeconds: 30,
      },
    });
    const provider = r.json<Provider>();
    r = await state.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '额度告警验证', brief },
    });
    const project = r.json<ProjectDetail>().project;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks`,
        headers,
        payload: {
          kind: 'copy',
          providerId: provider.id,
          prompt: '图文',
          idempotencyKey: `quota-key-${i}`,
        },
      });
      statuses.push(res.statusCode);
    }
    // 5 次预占成功，第 6 次超限拒绝。
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    const notices = await state.db.query<{ body: { threshold: string } }>(
      `SELECT body FROM quota_events WHERE body->>'action'='notice' ORDER BY body->>'createdAt'`,
    );
    assert.deepEqual(
      notices.map((row) => row.body.threshold),
      ['80', '100'],
    );
  } finally {
    delete process.env.MAX_DAILY_TASKS;
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
