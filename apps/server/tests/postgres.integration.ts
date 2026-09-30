import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import postgres from 'postgres';
import sharp from 'sharp';
import { Repository } from '../src/repository';
import { openDatabase } from '../src/db';
import { createApp } from '../src/app';
import { QuotaService } from '../src/quotas';
import type { StoredTask } from '../src/jobs';
import { EMPTY_BRIEF, type ProjectDetail } from '../../../packages/shared/src/index';

const configured = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
if (!configured) throw new Error('设置 POSTGRES_TEST_URL 指向独立的本地 zhizuo_validation 数据库');
const adminUrl = new URL(configured);
if (adminUrl.hostname !== '127.0.0.1' || adminUrl.pathname !== '/zhizuo_validation')
  throw new Error('PostgreSQL验证仅允许127.0.0.1的zhizuo_validation专用实例');
async function waitUntil<T>(
  fn: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 12000,
): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do {
    last = await fn();
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < end);
  throw new Error('PostgreSQL集成等待状态超时');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await finished;
  }
}

test(
  'PostgreSQL: transactions, quota races and two independent worker processes',
  { timeout: 50000 },
  async () => {
    const admin = postgres(adminUrl.href, { max: 1 });
    const databaseName = 'zhizuo_workers_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-live-pg-'));
    const children: ChildProcess[] = [];
    let appState: Awaited<ReturnType<typeof createApp>> | undefined;
    let db2: Awaited<ReturnType<typeof openDatabase>> | undefined;
    let created = false;
    try {
      const [{ version }] = await admin`SELECT version()`;
      assert.match(version, /PostgreSQL 18/);
      await admin`CREATE DATABASE ${admin(databaseName)}`;
      created = true;
      const url = new URL(adminUrl);
      url.pathname = '/' + databaseName;
      const key = '42'.repeat(32);
      appState = await createApp({
        dataDir: dir,
        databaseUrl: url.href,
        encryptionKey: key,
        worker: false,
      });
      const { app, db, quotas } = appState;
      db2 = await openDatabase(dir, url.href);
      await db.put('usage', 'jsonb-roundtrip', { marker: '真实JSON对象', nested: { value: 1 } });
      assert.deepEqual(await db2.get('usage', 'jsonb-roundtrip'), {
        marker: '真实JSON对象',
        nested: { value: 1 },
      });
      assert.equal(
        (
          await db.query<{ kind: string }>(
            "SELECT jsonb_typeof(body) AS kind FROM documents WHERE scope='usage' AND id='jsonb-roundtrip'",
          )
        )[0].kind,
        'object',
      );
      await db.put('usage', 'jsonb-scalar', '文本值');
      assert.equal(await db2.get('usage', 'jsonb-scalar'), '文本值');
      await db.query('CREATE TABLE validation_counter(n integer NOT NULL)');
      await db.query('INSERT INTO validation_counter VALUES(0)');
      await Promise.all(
        Array.from({ length: 24 }, (_, i) => {
          const conn = i % 2 ? db : db2!;
          return conn.transaction(async () => {
            const [row] = await conn.query<{ n: number }>(
              'SELECT n FROM validation_counter FOR UPDATE',
            );
            await conn.query('UPDATE validation_counter SET n=$1', [row.n + 1]);
          });
        }),
      );
      assert.equal((await db.query<{ n: number }>('SELECT n FROM validation_counter'))[0].n, 24);
      await assert.rejects(
        db.transaction(async () => {
          await db.query('UPDATE validation_counter SET n=99');
          throw new Error('rollback fixture');
        }),
      );
      assert.equal((await db2.query<{ n: number }>('SELECT n FROM validation_counter'))[0].n, 24);
      const quota2 = new QuotaService(db2, 3);
      await quotas.setLimit('direct-quota-test', 3, '并发验收额度', 'fixture-admin');
      const candidates = Array.from({ length: 10 }, () => randomUUID());
      const reserved = await Promise.allSettled(
        candidates.map((id, i) => (i % 2 ? quotas : quota2).reserve(id, 'direct-quota-test')),
      );
      const fulfilled = reserved.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 3);
      assert.equal(reserved.filter((r) => r.status === 'rejected').length, 7);
      assert.equal((await quota2.summary('direct-quota-test')).reserved, 3);
      for (const r of fulfilled) {
        if (r.status === 'fulfilled')
          await Promise.all(
            Array.from({ length: 4 }, () =>
              quota2.settle({
                id: r.value.taskId,
                status: 'cancelled',
                submissionStarted: false,
                attempts: 0,
              } as any),
            ),
          );
      }
      const released = await quotas.summary('direct-quota-test');
      assert.equal(released.reserved, 0);
      assert.equal(released.available, 3);
      assert.equal(released.events.filter((e) => e.action === 'release').length, 3);
      await db.query(
        'CREATE TABLE validation_calls(id bigserial PRIMARY KEY,worker_id text NOT NULL,prompt text NOT NULL)',
      );
      await quotas.setLimit('local', 4, 'worker验证', 'fixture-admin');
      const headers = { host: 'localhost:4317' };
      let response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: {
          title: '真实PG多进程验证',
          brief: {
            ...EMPTY_BRIEF,
            productName: '测试商品',
            sellingPoints: '已确认测试事实',
            confirmed: true,
          },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const project = response.json<ProjectDetail>().project;
      const picture = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#abcdef' },
      })
        .png()
        .toBuffer();
      const asset = await appState.media.ingest(project.id, picture, 'pg-asset.png');
      const repo2 = new Repository(db2);
      const [reference, cleanup] = await Promise.allSettled([
        repo2.version({
          projectId: project.id,
          kind: 'image',
          label: '并发引用验证',
          assetId: asset.id,
        }),
        appState.media.removeIfUnreferenced(asset.id, project.id),
      ]);
      assert.equal(cleanup.status, 'fulfilled');
      if (reference.status === 'fulfilled') {
        assert.equal((cleanup as PromiseFulfilledResult<boolean>).value, false);
        assert.ok(await db.get('assets', asset.id));
        assert.ok((await appState.media.bytes(asset.id)).length);
      } else {
        assert.equal((cleanup as PromiseFulfilledResult<boolean>).value, true);
        assert.equal(await db.get('assets', asset.id), undefined);
        assert.equal(
          (await db.list<{ assetId?: string }>('versions', project.id)).some(
            (v) => v.assetId === asset.id,
          ),
          false,
        );
      }

      response = await app.inject({
        method: 'POST',
        url: '/api/providers',
        headers,
        payload: {
          name: '离线协议fixture',
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'fake-test-key',
          textModel: 'fixture',
          imageModel: '',
          timeoutSeconds: 30,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const provider = response.json();
      const startWorker = async (id: string) => {
        const child = fork(path.resolve('apps/server/tests/fixtures/worker-process.ts'), [], {
          execArgv: ['--import', 'tsx'],
          env: {
            ...process.env,
            DATABASE_URL: url.href,
            ENCRYPTION_KEY: key,
            DATA_DIR: dir,
            TEST_WORKER_ID: id,
          },
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        children.push(child);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker启动超时')), 10000);
          child.once('message', (message) => {
            clearTimeout(timer);
            assert.equal((message as { ready: boolean }).ready, true);
            resolve();
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('worker提前退出 ' + code));
          });
        });
        return child;
      };
      const a = await startWorker('worker-a');
      const b = await startWorker('worker-b');
      const submit = (prompt: string, idempotencyKey: string) =>
        app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/tasks`,
          headers,
          payload: { kind: 'copy', providerId: provider.id, prompt, idempotencyKey },
        });
      const submitted = await Promise.all([
        submit('parallel-1', 'parallel-id-1'),
        submit('parallel-2', 'parallel-id-2'),
        submit('parallel-3', 'parallel-id-3'),
        submit('parallel-1', 'parallel-id-1'),
      ]);
      assert.ok(
        submitted.every((r) => r.statusCode === 200),
        submitted.map((r) => r.body).join('\n'),
      );
      assert.equal(new Set(submitted.map((r) => r.json().id)).size, 3);
      assert.ok(
        submitted.every((r) => !r.body.includes('leaseToken') && !r.body.includes('secret')),
      );
      await waitUntil(
        () => db.list<StoredTask>('tasks', project.id),
        (tasks) => tasks.length === 3 && tasks.every((t) => t.status === 'succeeded'),
      );
      const calls = await db.query<{ prompt: string; n: number }>(
        'SELECT prompt,count(*)::int AS n FROM validation_calls GROUP BY prompt',
      );
      assert.equal(calls.length, 3);
      assert.ok(calls.every((r) => r.n === 1));
      const detail = await appState.repo.detail(project.id);
      assert.equal(detail.versions.filter((v) => v.kind === 'copy').length, 3);
      assert.equal(detail.project.board.nodes.filter((n) => n.data.kind === 'copy').length, 3);
      await waitUntil(
        () => quotas.summary('local'),
        (q) => q.consumed === 3 && q.reserved === 0,
      );
      response = await submit('crash-unknown', 'crash-request-1');
      assert.equal(response.statusCode, 200, response.body);
      const crashId = response.json().id;
      const task = await waitUntil(
        () => db.get<StoredTask>('tasks', crashId),
        (t) => !!t?.submissionStartedAt && !!t.workerId,
      );
      await waitUntil(
        () =>
          db.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM validation_calls WHERE prompt='crash-unknown'",
          ),
        (r) => r[0].n === 1,
      );
      const victim = task!.workerId === 'worker-a' ? a : b;
      victim.kill('SIGKILL');
      await waitUntil(
        () => db.get<StoredTask>('tasks', crashId),
        (t) => t?.status === 'reconciling',
      );
      await startWorker('worker-restarted');
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(
        (
          await db.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM validation_calls WHERE prompt='crash-unknown'",
          )
        )[0].n,
        1,
      );
      const held = await waitUntil(
        () => quotas.summary('local'),
        (q) => q.reviewCount === 1,
      );
      assert.equal(held.reserved, 1);
      response = await app.inject({
        method: 'POST',
        url: '/api/admin/quotas/local/resolve',
        headers,
        payload: {
          taskId: crashId,
          action: 'consume',
          reason: '隔离fixture已记录调用，核对任务额度',
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().consumed, 4);
      assert.equal(response.json().reserved, 0);
    } finally {
      await Promise.all(children.map(stop));
      await db2?.close();
      await appState?.app.close();
      if (created) await admin`DROP DATABASE ${admin(databaseName)}`;
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
