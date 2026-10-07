import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Database } from '../src/db';
import { Repository } from '../src/repository';
import {
  JobRunner,
  listTaskEvents,
  recordTaskEvent,
  publicTask,
  type JobExecution,
  type StoredTask,
  type TaskEvent,
} from '../src/jobs';
import { Media } from '../src/media';
import { encryptSecret, ProviderUncertainError } from '../src/providers';
import { EMPTY_BRIEF, type Asset, type ContentVersion } from '../../../packages/shared/src/index';

const key = 'ab'.repeat(32);
const copy = {
  titles: ['已确认商品'],
  body: '来自商品简报的内容',
  tags: [],
  pages: [{ headline: '商品', body: '商品信息' }],
  warnings: [],
};

async function fixture(context: TestContext, execution: JobExecution = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-task-events-'));
  const db = await openDatabase(dir);
  const repo = new Repository(db);
  const project = await repo.create('事件测试', {
    ...EMPTY_BRIEF,
    productName: '棉布包',
    confirmed: true,
  });
  const makeTask = (): StoredTask => ({
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
  });
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
      await db.remove('assets', id);
    },
    removeIfUnreferenced: async (id: string, projectId: string) => {
      const versions = await db.list<ContentVersion>('versions', projectId);
      const current = await repo.project(projectId);
      if (
        versions.some((version) => version.assetId === id || version.poster?.assetId === id) ||
        current.board.nodes.some((node) => node.data.assetId === id)
      )
        return false;
      await db.remove('assets', id);
      return true;
    },
  } as unknown as Media;
  const runner = new JobRunner(db, repo, media, key, {
    generateCopy: async () => copy,
    generateImage: async () => ({ bytes: Buffer.from('image'), mime: 'image/png' }),
    ...execution,
  });
  const until = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Condition did not settle');
  };
  context.after(async () => {
    await runner.stop();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, repo, runner, project, makeTask, until };
}

test('a successful copy task records queued, claimed, checkpoint and published events', async (t) => {
  const f = await fixture(t);
  const task = f.makeTask();
  await f.db.put('tasks', task.id, task);
  // 任务创建方（API 事务内）负责 queued 事件。
  await recordTaskEvent(f.db, { taskId: task.id, projectId: task.projectId, kind: 'queued' });
  const done = f.until(
    async () => (await f.db.get<StoredTask>('tasks', task.id))?.status === 'succeeded',
  );
  await f.runner.start();
  await done;
  await f.runner.stop();
  const events = await listTaskEvents(f.db, task.id);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['queued', 'claimed', 'checkpoint', 'published'],
  );
  const published = events.find((e) => e.kind === 'published')!;
  assert.ok(published.detail?.startsWith('结果版本 '));
});

test('uncertain image submissions reach a dead-letter event that demands human review', async (t) => {
  const f = await fixture(t, {
    generateImage: async () => {
      throw new ProviderUncertainError('供应商响应中断，结果未知');
    },
  });
  const task: StoredTask = {
    ...f.makeTask(),
    kind: 'image',
  };
  await f.db.put('tasks', task.id, task);
  await recordTaskEvent(f.db, { taskId: task.id, projectId: task.projectId, kind: 'queued' });
  const settled = f.until(async () => {
    const current = await f.db.get<StoredTask>('tasks', task.id);
    return !!current && ['reconciling', 'failed', 'dead'].includes(current.status);
  });
  await f.runner.start();
  await settled;
  await f.runner.stop();
  const current = (await f.db.get<StoredTask>('tasks', task.id))!;
  assert.equal(current.status, 'reconciling');
  assert.equal(current.recoveryStopped, true);
  assert.equal(publicTask(current).needsAttention, true);
  const events = await listTaskEvents(f.db, task.id);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('checkpoint'));
  assert.ok(kinds.includes('dead'));
  const dead = events.find((e) => e.kind === 'dead')!;
  assert.ok(dead.detail);
});

test('cancelling a queued task records the cancellation and keeps the timeline ordered', async (t) => {
  const f = await fixture(t);
  const task = f.makeTask();
  await f.db.put('tasks', task.id, task);
  await recordTaskEvent(f.db, { taskId: task.id, projectId: task.projectId, kind: 'queued' });
  await f.runner.cancel(task.id);
  const events = await listTaskEvents(f.db, task.id);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['queued', 'cancelled'],
  );
  // 事件接口按时间排序，且不包含提示词或密钥内容。
  for (const event of events as TaskEvent[]) assert.ok(!JSON.stringify(event).includes('生成草稿'));
});
