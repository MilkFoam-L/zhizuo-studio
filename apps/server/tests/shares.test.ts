import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDatabase } from '../src/db';
import { Media } from '../src/media';
import { Repository } from '../src/repository';
import { ShareService } from '../src/shares';
import { decryptSecret } from '../src/providers';
import { EMPTY_BRIEF, type Poster, type ShareLink } from '../../../packages/shared/src/index';

const tokenOf = (link: ShareLink) => link.urlPath.split('/').at(-1)!;
const notFound = (error: unknown) =>
  error instanceof Error &&
  'statusCode' in error &&
  error.statusCode === 404 &&
  error.message === '分享链接已失效或不可用';

async function fixture(context: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-shares-'));
  const db = await openDatabase(dir);
  const repo = new Repository(db);
  const media = new Media(db, dir);
  const key = randomBytes(32).toString('hex');
  let allowed = true;
  let accessChecks = 0;
  const service = new ShareService(db, media, key, async () => {
    accessChecks++;
    return allowed;
  });
  const project = await repo.create(
    '内部项目名称',
    { ...EMPTY_BRIEF, productName: '内部商品事实' },
    'workspace-a',
  );
  const asset = await media.ingest(
    project.id,
    await sharp({ create: { width: 32, height: 24, channels: 4, background: '#44775a' } })
      .png()
      .toBuffer(),
    'private-source-name.png',
  );
  const copy = await repo.version({
    projectId: project.id,
    kind: 'copy',
    label: '公开文案',
    taskId: 'private-task',
    inputSnapshot: {
      prompt: 'private-prompt',
      providerId: 'private-provider',
      apiKey: 'private-secret',
    },
    copy: {
      titles: ['公开标题'],
      body: '公开正文',
      tags: ['生活'],
      pages: [{ headline: '公开页标题', body: '公开页正文' }],
      warnings: ['内部校验结果'],
    },
  });
  const image = await repo.version({
    projectId: project.id,
    kind: 'image',
    label: '公开图片',
    assetId: asset.id,
    parentVersionId: copy.id,
    inputSnapshot: { referenceAssetId: asset.id, prompt: 'private-image-prompt' },
  });
  const poster: Poster = {
    width: 300,
    height: 300,
    background: '#ffffff',
    accent: '#244b3c',
    assetId: asset.id,
    imageBox: { x: 20, y: 80, width: 260, height: 190 },
    texts: [
      {
        id: 'headline',
        text: '公开海报',
        x: 20,
        y: 45,
        width: 260,
        fontSize: 20,
        fontWeight: 500,
        color: '#244b3c',
        align: 'left',
      },
    ],
    templateId: 'test-poster',
  };
  const posterVersion = await repo.version({
    projectId: project.id,
    kind: 'poster',
    label: '公开海报',
    poster,
    inputSnapshot: { prompt: 'private-poster-prompt' },
  });
  context.after(async () => {
    await media.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const create = (versionIds = [copy.id, image.id, posterVersion.id]) =>
    service.create(project.id, 'workspace-a', { title: '对外方案', versionIds, expiresHours: 24 });
  return {
    db,
    repo,
    media,
    key,
    project,
    asset,
    copy,
    image,
    posterVersion,
    service,
    create,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    checks: () => accessChecks,
  };
}

test('shares persist explicit immutable snapshots and expose only the public whitelist', async (context) => {
  const f = await fixture(context);
  // Unknown nested properties must not leak even if old/imported records contain them.
  await f.db.put('versions', f.copy.id, {
    ...f.copy,
    prompt: 'top-level-private',
    copy: {
      ...f.copy.copy,
      apiKey: 'nested-private',
      pages: [{ headline: '公开页标题', body: '公开页正文', prompt: 'page-private' }],
    },
  });
  const link = await f.create();
  const token = tokenOf(link);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(link.urlPath, `/#/share/${token}`);
  const shared = await f.service.read(token);
  assert.deepEqual(Object.keys(shared).sort(), ['expiresAt', 'title', 'versions']);
  assert.equal(shared.title, '对外方案');
  assert.deepEqual(
    shared.versions.map((version) => version.id),
    [f.copy.id, f.image.id, f.posterVersion.id],
  );
  assert.deepEqual(Object.keys(shared.versions[0]).sort(), [
    'copy',
    'createdAt',
    'id',
    'kind',
    'label',
  ]);
  assert.deepEqual(Object.keys(shared.versions[0].copy!).sort(), [
    'body',
    'pages',
    'tags',
    'titles',
  ]);
  assert.deepEqual(Object.keys(shared.versions[0].copy!.pages[0]).sort(), ['body', 'headline']);
  assert.deepEqual(Object.keys(shared.versions[1]).sort(), [
    'createdAt',
    'height',
    'id',
    'kind',
    'label',
    'width',
  ]);
  assert.deepEqual(Object.keys(shared.versions[2]).sort(), [
    'createdAt',
    'height',
    'id',
    'kind',
    'label',
    'width',
  ]);
  for (const hidden of [
    'projectId',
    'workspaceId',
    'brief',
    'prompt',
    'inputSnapshot',
    'parentVersionId',
    'taskId',
    'providerId',
    'apiKey',
    'assetId',
    'poster',
    'warnings',
    'url',
    'thumbnailUrl',
  ]) {
    assert.ok(!JSON.stringify(shared).includes(`"${hidden}":`), hidden);
  }
  for (const secret of [
    '内部项目名称',
    '内部商品事实',
    'private-',
    'nested-private',
    'page-private',
    '内部校验结果',
  ])
    assert.ok(!JSON.stringify(shared).includes(secret), secret);
  const before = structuredClone(shared);
  const previewBefore = await f.service.preview(token, f.posterVersion.id);
  await f.db.put('versions', f.copy.id, {
    ...f.copy,
    label: '修改后的标签',
    copy: { ...f.copy.copy!, body: '后来修改的内容' },
  });
  await f.db.put('versions', f.posterVersion.id, {
    ...f.posterVersion,
    poster: { ...f.posterVersion.poster!, background: '#ff0000' },
  });
  const later = await f.repo.version({
    projectId: f.project.id,
    kind: 'copy',
    label: '新版本',
    copy: f.copy.copy,
  });
  assert.deepEqual(await f.service.read(token), before);
  assert.deepEqual(await f.service.preview(token, f.posterVersion.id), previewBefore);
  await assert.rejects(f.service.preview(token, later.id), notFound);
  shared.versions[0].copy!.titles[0] = '调用者修改';
  assert.deepEqual(await f.service.read(token), before);
});

test('share ownership rejects cross-project and cross-workspace create/list/revoke', async (context) => {
  const f = await fixture(context);
  const otherProject = await f.repo.create('另一个项目', EMPTY_BRIEF, 'workspace-a');
  const otherSpace = await f.repo.create('另一空间', EMPTY_BRIEF, 'workspace-b');
  const otherVersion = await f.repo.version({
    projectId: otherProject.id,
    kind: 'copy',
    label: '其他文案',
    copy: f.copy.copy,
  });
  const input = { title: '对外方案', versionIds: [f.copy.id], expiresHours: 24 };
  await assert.rejects(f.service.create(f.project.id, 'workspace-b', input), notFound);
  await assert.rejects(f.service.create(otherSpace.id, 'workspace-a', input), notFound);
  await assert.rejects(f.service.create(otherProject.id, 'workspace-a', input), notFound);
  await assert.rejects(
    f.service.create(f.project.id, 'workspace-a', { ...input, versionIds: [otherVersion.id] }),
    notFound,
  );
  await assert.rejects(
    f.service.create(f.project.id, 'workspace-a', { ...input, versionIds: [randomUUID()] }),
    notFound,
  );
  assert.deepEqual(await f.db.list('shares'), []);
  const link = await f.create();
  await assert.rejects(f.service.list(f.project.id, 'workspace-b'), notFound);
  assert.deepEqual(await f.service.list(otherProject.id, 'workspace-a'), []);
  await assert.rejects(f.service.revoke(f.project.id, 'workspace-b', link.id), notFound);
  await assert.rejects(f.service.revoke(otherProject.id, 'workspace-a', link.id), notFound);
  assert.equal((await f.service.read(tokenOf(link))).title, '对外方案');
});

test('share credentials are hashed for lookup, encrypted for owner copy, and domain bound', async (context) => {
  const f = await fixture(context);
  const first = await f.create([f.copy.id]);
  const second = await f.create([f.copy.id]);
  const token = tokenOf(first);
  assert.notEqual(token, tokenOf(second));
  const record = await f.db.get<Record<string, unknown>>('shares', first.id);
  assert.equal(record!.tokenHash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(record).includes(token));
  assert.ok(!JSON.stringify(record).includes('private-'));
  assert.throws(() => decryptSecret(String(record!.encryptedToken), f.key));
  const reloaded = new ShareService(f.db, f.media, f.key);
  assert.equal(
    (await reloaded.list(f.project.id, 'workspace-a')).find((link) => link.id === first.id)
      ?.urlPath,
    first.urlPath,
  );
  const otherRecord = await f.db.get<Record<string, unknown>>('shares', second.id);
  await f.db.put('shares', second.id, { ...otherRecord, encryptedToken: record!.encryptedToken });
  await assert.rejects(f.service.list(f.project.id, 'workspace-a'));
});

test('guessed, missing, expired, revoked, disabled and orphaned shares return the same 404', async (context) => {
  const f = await fixture(context);
  for (const token of ['', 'invalid-token', randomBytes(32).toString('base64url')]) {
    await assert.rejects(f.service.read(token), notFound);
    await assert.rejects(f.service.preview(token, f.image.id), notFound);
  }
  const link = await f.create();
  const token = tokenOf(link);
  const record = await f.db.get<Record<string, unknown>>('shares', link.id);
  const assetBytes = await f.media.bytes(f.asset.id);
  await f.db.put('shares', link.id, {
    ...record,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await assert.rejects(f.service.read(token), notFound);
  await assert.rejects(f.service.preview(token, f.image.id), notFound);
  await f.db.put('shares', link.id, record);
  f.setAllowed(false);
  await assert.rejects(f.service.read(token), notFound);
  await assert.rejects(f.service.preview(token, f.image.id), notFound);
  assert.equal(f.checks(), 2);
  f.setAllowed(true);
  const revoked = await f.service.revoke(f.project.id, 'workspace-a', link.id);
  assert.ok(revoked.revokedAt);
  assert.equal(
    (await f.service.revoke(f.project.id, 'workspace-a', link.id)).revokedAt,
    revoked.revokedAt,
  );
  await assert.rejects(f.service.read(token), notFound);
  await assert.rejects(f.service.preview(token, f.image.id), notFound);
  assert.ok(await f.db.get('assets', f.asset.id));
  assert.deepEqual(await f.media.bytes(f.asset.id), assetBytes);
  const active = await f.create();
  await f.db.put('projects', f.project.id, { ...f.project, workspaceId: 'moved-space' });
  await assert.rejects(f.service.read(tokenOf(active)), notFound);
  await f.db.remove('projects', f.project.id);
  await assert.rejects(f.service.read(tokenOf(active)), notFound);
  await assert.rejects(f.service.preview(tokenOf(active), f.image.id), notFound);
});

test('preview renders only selected versions and validates every image and poster asset', async (context) => {
  const f = await fixture(context);
  const link = await f.create([f.image.id, f.posterVersion.id]);
  const token = tokenOf(link);
  const image = await sharp(await f.service.preview(token, f.image.id)).metadata();
  assert.equal(image.format, 'png');
  assert.equal(image.width, 32);
  const poster = await sharp(await f.service.preview(token, f.posterVersion.id)).metadata();
  assert.equal(poster.format, 'png');
  assert.equal(poster.width, 300);
  assert.equal(poster.height, 300);
  await assert.rejects(f.service.preview(token, f.copy.id), notFound);
  await assert.rejects(f.service.preview(token, f.asset.id), notFound);
  await assert.rejects(f.service.preview(token, randomUUID()), notFound);
  const copyLink = await f.create([f.copy.id]);
  await assert.rejects(f.service.preview(tokenOf(copyLink), f.copy.id), notFound);
  const other = await f.repo.create('另一个项目', EMPTY_BRIEF, 'workspace-b');
  await f.db.put('assets', f.asset.id, { ...f.asset, projectId: other.id });
  await assert.rejects(f.service.preview(token, f.image.id), notFound);
  await assert.rejects(f.service.preview(token, f.posterVersion.id), notFound);
  await assert.rejects(f.create([f.image.id]), notFound);
  await f.db.remove('assets', f.asset.id);
  await assert.rejects(f.create([f.posterVersion.id]), notFound);
});

test('share creation validates explicit title, version count, uniqueness and expiration', async (context) => {
  const f = await fixture(context);
  const valid = { title: '对外标题', versionIds: [f.copy.id], expiresHours: 24 };
  const invalid = [
    null,
    {},
    { ...valid, title: '' },
    { ...valid, title: ' '.repeat(5) },
    { ...valid, title: 'a'.repeat(121) },
    { ...valid, title: '标题\n' },
    { ...valid, versionIds: [] },
    { ...valid, versionIds: [f.copy.id, f.copy.id] },
    { ...valid, versionIds: Array.from({ length: 21 }, () => randomUUID()) },
    { ...valid, expiresHours: 0 },
    { ...valid, expiresHours: 169 },
    { ...valid, expiresHours: 1.5 },
    { ...valid, expiresHours: '24' },
  ];
  for (const input of invalid)
    await assert.rejects(f.service.create(f.project.id, 'workspace-a', input));
  assert.deepEqual(await f.db.list('shares'), []);
  const link = await f.service.create(f.project.id, 'workspace-a', {
    ...valid,
    title: '  公开标题  ',
    expiresHours: 1,
  });
  assert.equal(link.title, '公开标题');
  assert.ok(Date.parse(link.expiresAt) - Date.parse(link.createdAt) >= 3_600_000);
});

test('share creation and preview hold referenced asset locks within their transactions', async (context) => {
  const f = await fixture(context);
  let depth = 0;
  const locked: string[] = [];
  const service = new ShareService(
    {
      ...f.db,
      transaction: (work) =>
        f.db.transaction(async () => {
          depth++;
          try {
            return await work();
          } finally {
            depth--;
          }
        }),
      query: async (sql, params) => {
        if (sql.includes("scope='assets'")) {
          assert.ok(depth > 0);
          assert.match(sql, /FOR SHARE/);
          locked.push(String(params?.[0]));
        }
        return f.db.query(sql, params);
      },
    },
    f.media,
    f.key,
  );
  const link = await service.create(f.project.id, 'workspace-a', {
    title: '锁定快照',
    versionIds: [f.image.id, f.posterVersion.id],
    expiresHours: 1,
  });
  assert.deepEqual(locked, [f.asset.id]);
  const originalRender = f.media.render.bind(f.media);
  f.media.render = async (...args) => {
    assert.ok(depth > 0);
    return originalRender(...args);
  };
  await service.preview(tokenOf(link), f.posterVersion.id);
  assert.deepEqual(locked, [f.asset.id, f.asset.id]);
});
