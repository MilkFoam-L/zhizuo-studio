import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { EMPTY_BRIEF, makePoster, type Asset } from '../../../packages/shared/src/index.ts';
import { createApp } from '../src/app.ts';
import { backup, restore } from '../src/backup.ts';
import { openDatabase, type Database } from '../src/db.ts';
import { Media, type PendingAsset } from '../src/media.ts';
import { Repository } from '../src/repository.ts';
import {
  LocalStorage,
  S3Storage,
  StorageError,
  type BlobStorage,
  type S3StorageConfig,
  type StorageCommand,
  type StorageSend,
} from '../src/storage.ts';

const brief = {
  ...EMPTY_BRIEF,
  productName: '棉麻收纳包',
  sellingPoints: '棉麻外层\n可折叠收纳',
  brand: '小日常',
  price: '49 元',
  confirmed: true,
};

const remoteConfig: S3StorageConfig = {
  endpoint: 'https://storage.example.com',
  region: 'test-region',
  bucket: 'media-test-bucket',
  accessKeyId: 'test-access-id',
  secretAccessKey: 'test-secret-key',
  prefix: 'integration/assets',
};

function remoteStorage() {
  const objects = new Map<string, Buffer>();
  const calls: StorageCommand[] = [];
  const faults: {
    failPut?: (command: PutObjectCommand) => 'before' | 'after' | undefined;
    failDelete?: (command: DeleteObjectCommand) => boolean;
  } = {};
  const send: StorageSend = async (command) => {
    calls.push(command);
    assert.equal(command.input.Bucket, 'media-test-bucket');
    assert.ok(command.input.Key?.startsWith('integration/assets/'));
    const name = command.input.Key!;
    if (command instanceof PutObjectCommand) {
      const failure = faults.failPut?.(command);
      if (failure === 'before') throw new Error('fixture write failure before persistence');
      assert.ok(Buffer.isBuffer(command.input.Body));
      objects.set(name, Buffer.from(command.input.Body));
      if (failure === 'after') throw new Error('fixture response lost after persistence');
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      if (faults.failDelete?.(command)) throw new Error('fixture delete unavailable');
      objects.delete(name);
      return {};
    }
    assert.ok(command instanceof GetObjectCommand);
    const bytes = objects.get(name);
    if (!bytes) throw Object.assign(new Error('fixture missing'), { name: 'NoSuchKey' });
    return {
      Body: Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]),
      ContentLength: bytes.length,
    };
  };
  const storage = new S3Storage(remoteConfig, { send });
  return { storage, objects, calls, faults };
}

async function harness(t: TestContext, backend: 'local' | 's3') {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-media-storage-test-'));
  let db: Database | undefined;
  const remote = remoteStorage();
  t.after(async () => {
    remote.storage.close();
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  });
  db = await openDatabase(dir);
  const storage = backend === 'local' ? new LocalStorage(dir) : remote.storage;
  const repo = new Repository(db);
  const media = new Media(db, dir, storage);
  return { dir, db, storage, repo, media, remote };
}

async function sourceJpeg() {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: '#ae6853' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

for (const backend of ['local', 's3'] as const) {
  test(`Media normalizes an oriented upload and persists image plus thumbnail through ${backend}`, async (t) => {
    const { dir, db, repo, media, storage, remote } = await harness(t, backend);
    const project = await repo.create('商品素材', brief);
    const asset = await media.ingest(project.id, await sourceJpeg(), 'uploads/product.jpg');
    assert.equal(asset.name, 'product.jpg');
    assert.equal(asset.mime, 'image/png');
    assert.equal(asset.width, 800);
    assert.equal(asset.height, 1200);
    assert.equal(asset.url, `/api/assets/${asset.id}/content`);
    assert.equal(asset.thumbnailUrl, `/api/assets/${asset.id}/thumbnail`);
    assert.deepEqual(await db.get('assets', asset.id), asset);
    const image = await media.bytes(asset.id);
    const metadata = await sharp(image).metadata();
    assert.equal(image.length, asset.size);
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 800);
    assert.equal(metadata.height, 1200);
    assert.equal(metadata.orientation, undefined);
    const thumbnail = await media.thumbnail(asset.id);
    const small = await sharp(thumbnail).metadata();
    assert.equal(small.format, 'webp');
    assert.equal(small.height, 640);
    assert.ok(small.width! <= 640);
    assert.deepEqual(await storage.get(`${asset.id}.png`), image);
    assert.deepEqual(await storage.get(`${asset.id}.thumb.webp`), thumbnail);
    const reopened = new Media(db, dir, backend === 'local' ? new LocalStorage(dir) : storage);
    assert.deepEqual(await reopened.bytes(asset.id), image);
    assert.deepEqual(await reopened.thumbnail(asset.id), thumbnail);
    await assert.rejects(media.owned(asset.id, 'other-project'), /不属于当前项目/);
    if (backend === 'local') {
      assert.equal((await readdir(path.join(dir, 'assets'))).length, 2);
    } else {
      assert.equal(remote.objects.size, 2);
      assert.equal(remote.calls.filter((command) => command instanceof PutObjectCommand).length, 2);
      await assert.rejects(stat(path.join(dir, 'assets')), { code: 'ENOENT' });
    }
    await media.remove(asset.id);
    assert.equal(await db.get('assets', asset.id), undefined);
    await assert.rejects(
      media.bytes(asset.id),
      (error: unknown) => error instanceof StorageError && error.code === 'NOT_FOUND',
    );
    await assert.rejects(
      media.thumbnail(asset.id),
      (error: unknown) => error instanceof StorageError && error.code === 'NOT_FOUND',
    );
  });

  test(`Media renders Chinese posters and moves a complete backup from ${backend} to ${backend === 'local' ? 's3' : 'local'}`, async (t) => {
    const source = await harness(t, backend);
    const target = await harness(t, backend === 'local' ? 's3' : 'local');
    const project = await source.repo.create('存储迁移', brief);
    const asset = await source.media.ingest(project.id, await sourceJpeg(), 'product.jpg');
    await source.repo.append(project.id, {
      id: asset.id,
      type: 'content',
      position: { x: 0, y: 0 },
      data: { kind: 'asset', label: asset.name, assetId: asset.id },
    });
    const imageVersion = await source.repo.version({
      projectId: project.id,
      kind: 'image',
      label: '原图',
      assetId: asset.id,
    });
    const poster = makePoster('xhs-editorial', brief, asset.id);
    const posterVersion = await source.repo.version({
      projectId: project.id,
      kind: 'poster',
      label: '小红书封面',
      poster,
      parentVersionId: imageVersion.id,
      inputSnapshot: { referenceAssetId: asset.id },
    });
    const rendered = await source.media.render(poster, project.id);
    const metadata = await sharp(rendered).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1440);
    const archive = await backup(source.repo, source.media, project.id);
    const files = unzipSync(archive);
    assert.deepEqual(
      Buffer.from(files[`assets/${asset.id}.png`]),
      await source.media.bytes(asset.id),
    );
    assert.ok(files['project.json']);
    const restored = await restore(target.repo, target.media, archive, 'restored-workspace');
    assert.notEqual(restored.project.id, project.id);
    assert.equal(restored.project.workspaceId, 'restored-workspace');
    assert.equal(restored.assets.length, 1);
    assert.equal(restored.versions.length, 2);
    const restoredAsset = restored.assets[0];
    assert.notEqual(restoredAsset.id, asset.id);
    assert.deepEqual(
      await target.media.bytes(restoredAsset.id),
      await source.media.bytes(asset.id),
    );
    assert.deepEqual(
      await target.media.thumbnail(restoredAsset.id),
      await source.media.thumbnail(asset.id),
    );
    const restoredPoster = restored.versions.find((version) => version.kind === 'poster')!;
    const restoredImage = restored.versions.find((version) => version.kind === 'image')!;
    assert.notEqual(restoredPoster.id, posterVersion.id);
    assert.equal(restoredPoster.parentVersionId, restoredImage.id);
    assert.equal(restoredImage.assetId, restoredAsset.id);
    assert.equal(restoredPoster.poster?.assetId, restoredAsset.id);
    assert.deepEqual(restoredPoster.inputSnapshot, { referenceAssetId: restoredAsset.id });
    assert.deepEqual(
      await target.media.render(restoredPoster.poster!, restored.project.id),
      rendered,
    );
    for (const node of restored.project.board.nodes) {
      if (node.data.assetId) assert.equal(node.data.assetId, restoredAsset.id);
      if (node.data.versionId)
        assert.ok(restored.versions.some((version) => version.id === node.data.versionId));
    }
    const remoteSide = backend === 's3' ? source : target;
    assert.equal(remoteSide.remote.objects.size, 2);
    await assert.rejects(stat(path.join(remoteSide.dir, 'assets')), { code: 'ENOENT' });
    assert.ok(remoteSide.remote.calls.some((command) => command instanceof GetObjectCommand));
  });
}

test('Media compensates image and thumbnail writes when a remote write fails before or after persistence', async (t) => {
  const { db, repo, media, remote } = await harness(t, 's3');
  const project = await repo.create('写入补偿', brief);
  const input = await sourceJpeg();
  for (const phase of ['before', 'after'] as const) {
    remote.faults.failPut = (command) =>
      command.input.Key?.endsWith('.thumb.webp') ? phase : undefined;
    await assert.rejects(media.ingest(project.id, input, 'product.jpg'), StorageError);
    assert.equal(remote.objects.size, 0);
    assert.deepEqual(await db.list<Asset>('assets', project.id), []);
  }
  assert.equal(remote.calls.filter((command) => command instanceof DeleteObjectCommand).length, 4);
});

test('Media compensates failed database writes and recovers a committed write with a lost acknowledgement', async (t) => {
  const { dir, db, repo, remote } = await harness(t, 's3');
  const project = await repo.create('记录补偿', brief);
  const input = await sourceJpeg();
  for (const persisted of [false, true]) {
    const failingDatabase: Database = {
      ...db,
      async put(scope, id, body) {
        if (scope !== 'assets') return db.put(scope, id, body);
        if (persisted) await db.put(scope, id, body);
        throw new Error('simulated database acknowledgement failure');
      },
    };
    const media = new Media(failingDatabase, dir, remote.storage);
    if (persisted) {
      const asset = await media.ingest(project.id, input, 'product.jpg');
      assert.deepEqual(await db.get('assets', asset.id), asset);
      assert.equal(remote.objects.size, 2);
      assert.deepEqual(await db.list('pending_assets'), []);
      await media.remove(asset.id);
    } else {
      await assert.rejects(
        media.ingest(project.id, input, 'product.jpg'),
        /database acknowledgement/,
      );
    }
    assert.equal(remote.objects.size, 0);
    assert.deepEqual(await db.list('assets', project.id), []);
  }
});

test('pending upload survives failed write plus failed cleanup and a new Media instance reconciles it', async (t) => {
  const { dir, db, repo, media, remote } = await harness(t, 's3');
  const project = await repo.create('双故障恢复', brief);
  remote.faults.failPut = (command) =>
    command.input.Key?.endsWith('.thumb.webp') ? 'after' : undefined;
  remote.faults.failDelete = (command) => command.input.Key?.endsWith('.png') ?? false;
  await assert.rejects(media.ingest(project.id, await sourceJpeg(), 'product.jpg'), StorageError);
  assert.equal(remote.objects.size, 1);
  assert.deepEqual(await db.list('assets'), []);
  const pending = await db.list<PendingAsset>('pending_assets');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].projectId, project.id);
  assert.equal(pending[0].storageIdentity, remote.storage.identity);
  assert.ok(remote.objects.has(`integration/assets/${pending[0].id}.png`));
  const recovered = new Media(db, dir, remote.storage);
  assert.deepEqual(await recovered.reconcilePending(), {
    cleaned: 0,
    completed: 0,
    deferred: 0,
    failed: 1,
  });
  assert.equal((await db.list('pending_assets')).length, 1);
  remote.faults.failDelete = undefined;
  assert.deepEqual(await recovered.reconcilePending(), {
    cleaned: 1,
    completed: 0,
    deferred: 0,
    failed: 0,
  });
  assert.equal(remote.objects.size, 0);
  assert.deepEqual(await db.list('pending_assets'), []);
});

test('bookkeeping cleanup failure preserves a committed asset and a later sweep only removes its intent', async (t) => {
  const { dir, db, repo, remote } = await harness(t, 's3');
  const project = await repo.create('已提交素材保护', brief);
  let failCleanup = true;
  const wrapped: Database = {
    ...db,
    async remove(scope, id) {
      if (scope === 'pending_assets' && failCleanup) throw new Error('pending cleanup unavailable');
      return db.remove(scope, id);
    },
  };
  const media = new Media(wrapped, dir, remote.storage);
  const asset = await media.ingest(project.id, await sourceJpeg(), 'product.jpg');
  assert.deepEqual(await db.get('assets', asset.id), asset);
  assert.equal(remote.objects.size, 2);
  assert.equal((await db.list('pending_assets')).length, 1);
  assert.deepEqual(await media.reconcilePending(), {
    cleaned: 0,
    completed: 0,
    deferred: 0,
    failed: 1,
  });
  failCleanup = false;
  assert.deepEqual(await new Media(db, dir, remote.storage).reconcilePending(), {
    cleaned: 0,
    completed: 1,
    deferred: 0,
    failed: 0,
  });
  assert.deepEqual(await db.list('pending_assets'), []);
  assert.deepEqual(await db.get('assets', asset.id), asset);
  assert.equal(remote.objects.size, 2);
  assert.ok(remote.calls.every((command) => !(command instanceof DeleteObjectCommand)));
  assert.equal((await sharp(await media.bytes(asset.id)).metadata()).format, 'png');
});

test('uncertain database commit and unavailable reread retain both objects until a safe reconciliation', async (t) => {
  const { dir, db, repo, remote } = await harness(t, 's3');
  const project = await repo.create('未知提交结果', brief);
  const wrapped: Database = {
    ...db,
    async put(scope, id, body) {
      await db.put(scope, id, body);
      if (scope === 'assets') throw new Error('database acknowledgement unavailable');
    },
    async get<T>(scope: Parameters<Database['get']>[0], id: string): Promise<T | undefined> {
      if (scope === 'assets') throw new Error('database reread unavailable');
      return db.get<T>(scope, id);
    },
  };
  const media = new Media(wrapped, dir, remote.storage);
  await assert.rejects(
    media.ingest(project.id, await sourceJpeg(), 'product.jpg'),
    /acknowledgement unavailable/,
  );
  assert.equal(remote.objects.size, 2);
  const assets = await db.list<Asset>('assets');
  assert.equal(assets.length, 1);
  assert.equal((await db.list('pending_assets')).length, 1);
  assert.deepEqual(await new Media(db, dir, remote.storage).reconcilePending(), {
    cleaned: 0,
    completed: 1,
    deferred: 0,
    failed: 0,
  });
  assert.deepEqual(await db.get('assets', assets[0].id), assets[0]);
  assert.equal(remote.objects.size, 2);
  assert.ok(remote.calls.every((command) => !(command instanceof DeleteObjectCommand)));
});

test('storage identities exclude credentials and a switched backend never deletes another backend pending upload', async (t) => {
  const { dir, db, repo, media, remote } = await harness(t, 's3');
  const project = await repo.create('存储切换保护', brief);
  remote.faults.failPut = (command) =>
    command.input.Key?.endsWith('.thumb.webp') ? 'before' : undefined;
  remote.faults.failDelete = () => true;
  await assert.rejects(media.ingest(project.id, await sourceJpeg(), 'product.jpg'), StorageError);
  const [pending] = await db.list<PendingAsset>('pending_assets');
  const local = new LocalStorage(dir);
  await local.put(`${pending.id}.png`, Buffer.from('another backend object'), 'image/png');
  assert.deepEqual(await new Media(db, dir, local).reconcilePending(), {
    cleaned: 0,
    completed: 0,
    deferred: 1,
    failed: 0,
  });
  assert.equal((await local.get(`${pending.id}.png`)).toString(), 'another backend object');
  assert.notEqual(local.identity, new LocalStorage(path.join(dir, 'other-data')).identity);
  for (const changed of [
    { endpoint: 'https://other-storage.example.com' },
    { bucket: 'other-bucket' },
    { prefix: 'other-app/assets' },
  ]) {
    const foreign = new S3Storage(
      { ...remoteConfig, ...changed },
      {
        send: async () => {
          assert.fail('must not send to a different storage');
        },
      },
    );
    assert.deepEqual(await new Media(db, dir, foreign).reconcilePending(), {
      cleaned: 0,
      completed: 0,
      deferred: 1,
      failed: 0,
    });
    assert.notEqual(foreign.identity, remote.storage.identity);
  }
  const rotated = new S3Storage(
    { ...remoteConfig, accessKeyId: 'rotated-id', secretAccessKey: 'rotated-secret' },
    { send: async () => ({}) },
  );
  assert.equal(rotated.identity, remote.storage.identity);
  assert.ok(!rotated.identity.includes('rotated-id'));
  assert.ok(!rotated.identity.includes('rotated-secret'));
  assert.ok(!remote.storage.identity.includes(remoteConfig.secretAccessKey));
  assert.equal((await db.list('pending_assets')).length, 1);
  assert.equal(remote.objects.size, 1);
});

test('a reconciliation skips active uploads and coalesces concurrent sweeps', async (t) => {
  const { dir, db, repo, remote } = await harness(t, 's3');
  const project = await repo.create('上传中保护', brief);
  let imageWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    imageWritten = resolve;
  });
  let release!: () => void;
  const continueUpload = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage: BlobStorage = {
    identity: remote.storage.identity,
    async put(key, bytes, mime) {
      await remote.storage.put(key, bytes, mime);
      if (key.endsWith('.png')) {
        imageWritten();
        await continueUpload;
      }
    },
    get: (key) => remote.storage.get(key),
    remove: (key) => remote.storage.remove(key),
  };
  const media = new Media(db, dir, storage);
  const upload = media.ingest(project.id, await sourceJpeg(), 'product.jpg');
  try {
    await Promise.race([
      written,
      upload.then(() => {
        throw new Error('upload finished without pausing');
      }),
    ]);
    const first = media.reconcilePending();
    const second = media.reconcilePending();
    assert.equal(first, second);
    assert.deepEqual(await first, { cleaned: 0, completed: 0, deferred: 1, failed: 0 });
    assert.equal(remote.objects.size, 1);
    assert.equal((await db.list('pending_assets')).length, 1);
  } finally {
    release();
    await upload;
  }
  assert.equal(remote.objects.size, 2);
  assert.deepEqual(await db.list('pending_assets'), []);
});

test('a durable-intent write failure prevents every blob PUT', async (t) => {
  const { dir, db, repo, remote } = await harness(t, 's3');
  const project = await repo.create('持久化意图保护', brief);
  const wrapped: Database = {
    ...db,
    async put(scope, id, body) {
      if (scope === 'pending_assets') throw new Error('cannot persist upload intent');
      return db.put(scope, id, body);
    },
  };
  await assert.rejects(
    new Media(wrapped, dir, remote.storage).ingest(project.id, await sourceJpeg(), 'product.jpg'),
    /cannot persist upload intent/,
  );
  assert.equal(remote.objects.size, 0);
  assert.ok(remote.calls.every((command) => !(command instanceof PutObjectCommand)));
  assert.deepEqual(await db.list('pending_assets'), []);
  assert.deepEqual(await db.list('assets'), []);
});

test('Media keeps a known asset record after deletion failure so a retry can finish cleanup', async (t) => {
  const { db, repo, media, remote } = await harness(t, 's3');
  const project = await repo.create('删除补偿', brief);
  const asset = await media.ingest(project.id, await sourceJpeg(), 'product.jpg');
  remote.faults.failDelete = (command) => command.input.Key?.endsWith('.png') ?? false;
  await assert.rejects(media.remove(asset.id), StorageError);
  assert.deepEqual(await db.get('assets', asset.id), asset);
  assert.equal(remote.objects.size, 1);
  assert.ok(remote.objects.has(`integration/assets/${asset.id}.png`));
  remote.faults.failDelete = undefined;
  await media.remove(asset.id);
  assert.equal(await db.get('assets', asset.id), undefined);
  assert.equal(remote.objects.size, 0);
});

test('failed cross-storage restore removes already-imported objects, records and its new project', async (t) => {
  const source = await harness(t, 'local');
  const target = await harness(t, 's3');
  const project = await source.repo.create('恢复补偿', brief);
  const input = await sourceJpeg();
  await source.media.ingest(project.id, input, 'first.jpg');
  await source.media.ingest(project.id, input, 'second.jpg');
  const archive = await backup(source.repo, source.media, project.id);
  let thumbnailWrites = 0;
  target.remote.faults.failPut = (command) => {
    if (command.input.Key?.endsWith('.thumb.webp') && ++thumbnailWrites === 2) return 'after';
    return undefined;
  };
  await assert.rejects(restore(target.repo, target.media, archive), StorageError);
  assert.equal(thumbnailWrites, 2);
  assert.equal(target.remote.objects.size, 0);
  assert.deepEqual(await target.db.list('projects'), []);
  assert.deepEqual(await target.db.list('assets'), []);
  assert.deepEqual(await target.db.list('versions'), []);
  assert.equal((await source.repo.detail(project.id)).assets.length, 2);
});

test('HTTP asset and thumbnail endpoints delegate to Media and return decoded image MIME types', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-media-route-test-'));
  const state = await createApp({ dataDir: dir, worker: false });
  t.after(async () => {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = await state.repo.create('缩略图接口', brief);
  const asset = await state.media.ingest(project.id, await sourceJpeg(), 'product.jpg');
  let imageReads = 0;
  let thumbnailReads = 0;
  const original = state.media.bytes.bind(state.media);
  const thumbnail = state.media.thumbnail.bind(state.media);
  state.media.bytes = async (id) => {
    imageReads++;
    return original(id);
  };
  state.media.thumbnail = async (id) => {
    thumbnailReads++;
    return thumbnail(id);
  };
  const headers = { host: 'localhost:4317' };
  const contentResponse = await state.app.inject({ method: 'GET', url: asset.url, headers });
  assert.equal(contentResponse.statusCode, 200, contentResponse.body.slice(0, 200));
  assert.match(contentResponse.headers['content-type']!, /^image\/png/);
  assert.equal((await sharp(contentResponse.rawPayload).metadata()).format, 'png');
  const thumbnailResponse = await state.app.inject({
    method: 'GET',
    url: asset.thumbnailUrl,
    headers,
  });
  assert.equal(thumbnailResponse.statusCode, 200, thumbnailResponse.body.slice(0, 200));
  assert.match(thumbnailResponse.headers['content-type']!, /^image\/webp/);
  assert.equal((await sharp(thumbnailResponse.rawPayload).metadata()).format, 'webp');
  assert.equal(imageReads, 1);
  assert.equal(thumbnailReads, 1);
});
