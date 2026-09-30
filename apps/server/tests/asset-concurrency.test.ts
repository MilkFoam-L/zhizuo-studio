import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { openDatabase, type Database } from '../src/db';
import { Media, type MediaExecution, type PendingAsset } from '../src/media';
import { Repository } from '../src/repository';
import { S3Storage } from '../src/storage';
import { EMPTY_BRIEF, makePoster, type Project } from '../../../packages/shared/src/index';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
async function fixture(context: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-assets-concurrency-'));
  const db = await openDatabase(dir);
  const objects = new Map<string, Buffer>();
  const fault: {
    beforePut?: (key: string) => Promise<void>;
    beforeDelete?: (key: string) => Promise<void>;
  } = {};
  const storage = new S3Storage(
    {
      endpoint: 'https://objects.example.com',
      region: 'test',
      bucket: 'test-assets',
      accessKeyId: 'test-id',
      secretAccessKey: 'test-key',
    },
    {
      send: async (command) => {
        const key = command.input.Key!;
        if (command instanceof PutObjectCommand) {
          await fault.beforePut?.(key);
          objects.set(key, Buffer.from(command.input.Body as Buffer));
        } else if (command instanceof DeleteObjectCommand) {
          await fault.beforeDelete?.(key);
          objects.delete(key);
        } else {
          return { Body: objects.get(key), ContentLength: objects.get(key)?.length };
        }
        return {};
      },
    },
  );
  const media: Media[] = [];
  const createMedia = (execution: MediaExecution = {}, connection = db) => {
    const instance = new Media(connection, dir, storage, execution);
    media.push(instance);
    return instance;
  };
  const repo = new Repository(db);
  const project = await repo.create('并发素材', {
    ...EMPTY_BRIEF,
    productName: '收纳袋',
    confirmed: true,
  });
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#b4c5aa' } })
    .png()
    .toBuffer();
  context.after(async () => {
    await Promise.all(media.map((m) => m.close()));
    storage.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, repo, project, png, objects, fault, createMedia, storage };
}

test('another Media instance never removes a live remote upload and heartbeat extends its lease', async (context) => {
  const f = await fixture(context);
  const entered = deferred<void>(),
    release = deferred<void>();
  f.fault.beforePut = async (key) => {
    if (key.endsWith('.png')) {
      entered.resolve();
      await release.promise;
    }
  };
  const writer = f.createMedia({ leaseDurationMs: 1000, heartbeatMs: 80 });
  const cleaner = f.createMedia();
  const upload = writer.ingest(f.project.id, f.png, 'upload.png');
  try {
    await entered.promise;
    const [initial] = await f.db.list<PendingAsset>('pending_assets');
    assert.ok(initial.uploadOwner && initial.uploadToken);
    assert.deepEqual(await cleaner.reconcilePending(), {
      cleaned: 0,
      completed: 0,
      deferred: 1,
      failed: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 1150));
    const [renewed] = await f.db.list<PendingAsset>('pending_assets');
    assert.ok(Date.parse(renewed.leaseExpiresAt!) > Date.parse(initial.leaseExpiresAt!));
    assert.deepEqual(await cleaner.reconcilePending(), {
      cleaned: 0,
      completed: 0,
      deferred: 1,
      failed: 0,
    });
  } finally {
    release.resolve();
  }
  const asset = await upload;
  assert.ok(await f.db.get('assets', asset.id));
  assert.equal(f.objects.size, 2);
  assert.equal((await f.db.list('pending_assets')).length, 0);
});

test('expired upload is fenced and a late remote PUT is cleaned without publishing asset metadata', async (context) => {
  const f = await fixture(context);
  const entered = deferred<void>(),
    release = deferred<void>();
  f.fault.beforePut = async (key) => {
    if (key.endsWith('.png')) {
      entered.resolve();
      await release.promise;
    }
  };
  const writer = f.createMedia(),
    cleaner = f.createMedia();
  const upload = writer.ingest(f.project.id, f.png, 'upload.png');
  const rejected = assert.rejects(upload, /上传租约已失效/);
  try {
    await entered.promise;
    const [pending] = await f.db.list<PendingAsset>('pending_assets');
    await f.db.put('pending_assets', pending.id, {
      ...pending,
      leaseExpiresAt: new Date(0).toISOString(),
    });
    assert.deepEqual(await cleaner.reconcilePending(), {
      cleaned: 1,
      completed: 0,
      deferred: 0,
      failed: 0,
    });
    const [tombstone] = await f.db.list<PendingAsset>('pending_assets');
    assert.equal(tombstone.phase, 'cleaning');
    assert.equal(tombstone.uploadStopped, undefined);
    assert.equal((await f.db.list('assets')).length, 0);
  } finally {
    release.resolve();
  }
  await rejected;
  assert.equal(f.objects.size, 0);
  assert.equal((await f.db.list('assets')).length, 0);
  assert.equal((await f.db.list('pending_assets')).length, 0);
});

test('lease expiry during the metadata transaction rolls back the asset and cleans both objects', async (context) => {
  const f = await fixture(context);
  const wrapped: Database = {
    ...f.db,
    put: async (scope, id, body) => {
      await f.db.put(scope, id, body);
      if (scope === 'assets') await new Promise((resolve) => setTimeout(resolve, 550));
    },
  };
  const writer = f.createMedia({ leaseDurationMs: 400, heartbeatMs: 75 }, wrapped);
  await assert.rejects(writer.ingest(f.project.id, f.png, 'upload.png'), /上传租约已失效/);
  assert.equal((await f.db.list('assets')).length, 0);
  assert.equal(f.objects.size, 0);
});

test('legacy pending records get a grace period and ready assets retain their objects', async (context) => {
  const f = await fixture(context);
  const cleaner = f.createMedia();
  const id = randomUUID();
  const pending: PendingAsset = {
    id,
    projectId: f.project.id,
    storageIdentity: f.storage.identity,
    createdAt: new Date().toISOString(),
  };
  await f.db.put('pending_assets', id, pending);
  await f.storage.put(`${id}.png`, f.png, 'image/png');
  assert.deepEqual(await cleaner.reconcilePending(), {
    cleaned: 0,
    completed: 0,
    deferred: 1,
    failed: 0,
  });
  await f.db.put('pending_assets', id, {
    ...pending,
    createdAt: new Date(Date.now() - 180001).toISOString(),
  });
  assert.deepEqual(await cleaner.reconcilePending(), {
    cleaned: 1,
    completed: 0,
    deferred: 0,
    failed: 0,
  });
  const asset = await cleaner.ingest(f.project.id, f.png, 'ready.png');
  await f.db.put('pending_assets', asset.id, {
    ...pending,
    id: asset.id,
    phase: 'cleaning',
    leaseExpiresAt: new Date(0).toISOString(),
  });
  assert.deepEqual(await f.createMedia().reconcilePending(), {
    cleaned: 0,
    completed: 1,
    deferred: 0,
    failed: 0,
  });
  assert.equal(f.objects.size, 2);
  assert.ok(await f.db.get('assets', asset.id));
});

test('Media.close drains active uploads and their heartbeats before database shutdown', async (context) => {
  const f = await fixture(context);
  const entered = deferred<void>(),
    release = deferred<void>();
  let renewals = 0;
  const wrapped: Database = {
    ...f.db,
    query: async <T>(sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE documents') && sql.includes("'leaseExpiresAt'")) renewals++;
      return f.db.query<T>(sql, params);
    },
  };
  f.fault.beforePut = async (key) => {
    if (key.endsWith('.png')) {
      entered.resolve();
      await release.promise;
    }
  };
  const writer = f.createMedia({ leaseDurationMs: 1000, heartbeatMs: 75 }, wrapped);
  const upload = writer.ingest(f.project.id, f.png, 'upload.png');
  await entered.promise;
  let closed = false;
  const close = writer.close().then(() => {
    closed = true;
  });
  await assert.rejects(writer.ingest(f.project.id, f.png, 'new.png'), /正在关闭/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, false);
  release.resolve();
  await upload;
  await close;
  const lastRenewals = renewals;
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(renewals, lastRenewals);
});

test('cleanup holds an exclusive asset lock so a later version cannot reference a removed image', async (context) => {
  const f = await fixture(context),
    media = f.createMedia();
  const asset = await media.ingest(f.project.id, f.png, 'image.png');
  const entered = deferred<void>(),
    release = deferred<void>();
  let paused = false;
  const wrapped: Database = {
    ...f.db,
    list: async <T>(scope: Parameters<Database['list']>[0], projectId?: string) => {
      const rows = await f.db.list<T>(scope, projectId);
      if (scope === 'versions' && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return rows;
    },
  };
  const cleaner = f.createMedia({}, wrapped);
  const deleting = cleaner.removeIfUnreferenced(asset.id, f.project.id);
  await entered.promise;
  const publishing = assert.rejects(
    f.repo.version({
      projectId: f.project.id,
      kind: 'image',
      label: 'late version',
      assetId: asset.id,
    }),
    /素材不存在/,
  );
  release.resolve();
  assert.equal(await deleting, true);
  await publishing;
  assert.equal((await f.db.list('versions')).length, 0);
  assert.equal((await f.repo.project(f.project.id)).board.nodes.length, 1);
  assert.equal(f.objects.size, 0);
});

test('version publication takes a shared asset lock so a simultaneous cleanup preserves its image', async (context) => {
  const f = await fixture(context),
    media = f.createMedia();
  const asset = await media.ingest(f.project.id, f.png, 'image.png');
  const entered = deferred<void>(),
    release = deferred<void>();
  const wrapped: Database = {
    ...f.db,
    put: async (scope, id, body) => {
      if (scope === 'versions') {
        entered.resolve();
        await release.promise;
      }
      return f.db.put(scope, id, body);
    },
  };
  const repo = new Repository(wrapped);
  const publishing = repo.version({
    projectId: f.project.id,
    kind: 'image',
    label: 'retained',
    assetId: asset.id,
  });
  await entered.promise;
  const deleting = media.removeIfUnreferenced(asset.id, f.project.id);
  release.resolve();
  await publishing;
  assert.equal(await deleting, false);
  assert.ok(await f.db.get('assets', asset.id));
  assert.equal(f.objects.size, 2);
});

test('board updates reject deleted or foreign assets and protect retained assets from cleanup', async (context) => {
  const f = await fixture(context),
    media = f.createMedia();
  const asset = await media.ingest(f.project.id, f.png, 'image.png');
  const board: Project['board'] = {
    ...f.project.board,
    nodes: [
      ...f.project.board.nodes,
      {
        id: 'asset-node',
        type: 'content',
        position: { x: 1, y: 1 },
        data: { kind: 'asset', label: '商品图', assetId: asset.id },
      },
    ],
  };
  await f.repo.update(f.project.id, f.project.revision, { board });
  assert.equal(await media.removeIfUnreferenced(asset.id, f.project.id), false);
  const foreign = await f.repo.create('另一项目');
  await assert.rejects(f.repo.update(foreign.id, foreign.revision, { board }), /不属于当前项目/);
  const unreferenced = await media.ingest(f.project.id, f.png, 'remove.png');
  await media.removeIfUnreferenced(unreferenced.id, f.project.id);
  const project = await f.repo.project(f.project.id);
  await assert.rejects(
    f.repo.update(project.id, project.revision, {
      board: {
        ...project.board,
        nodes: [{ ...board.nodes[1], data: { ...board.nodes[1].data, assetId: unreferenced.id } }],
      },
    }),
    /素材不存在/,
  );
  assert.ok(await f.db.get('assets', asset.id));
});

test('poster and source-snapshot references prevent cleanup without needing a direct board asset node', async (context) => {
  const f = await fixture(context),
    media = f.createMedia();
  for (const source of ['poster', 'snapshot'] as const) {
    const asset = await media.ingest(f.project.id, f.png, `${source}.png`);
    await f.repo.version({
      projectId: f.project.id,
      kind: source === 'poster' ? 'poster' : 'copy',
      label: source,
      ...(source === 'poster'
        ? { poster: makePoster('xhs-editorial', f.project.brief, asset.id) }
        : { inputSnapshot: { referenceAssetId: asset.id } }),
    });
    assert.equal(await media.removeIfUnreferenced(asset.id, f.project.id), false);
    assert.ok(await f.db.get('assets', asset.id));
  }
});

test('failed unreferenced blob deletion leaves a durable cleanup intent and no dangling reference', async (context) => {
  const f = await fixture(context),
    media = f.createMedia();
  const asset = await media.ingest(f.project.id, f.png, 'remove.png');
  f.fault.beforeDelete = async () => {
    throw new Error('object storage unavailable');
  };
  await assert.rejects(media.removeIfUnreferenced(asset.id, f.project.id));
  assert.equal(await f.db.get('assets', asset.id), undefined);
  assert.equal((await f.db.list('pending_assets')).length, 1);
  await assert.rejects(
    f.repo.version({ projectId: f.project.id, kind: 'image', label: 'invalid', assetId: asset.id }),
    /素材不存在/,
  );
  f.fault.beforeDelete = undefined;
  assert.deepEqual(await f.createMedia().reconcilePending(), {
    cleaned: 1,
    completed: 0,
    deferred: 0,
    failed: 0,
  });
  assert.equal((await f.db.list('pending_assets')).length, 0);
  assert.equal(f.objects.size, 0);
});
