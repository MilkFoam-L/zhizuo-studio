import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  EMPTY_BRIEF,
  makePoster,
  type Asset,
  type BrandInput,
  type BrandKit,
  type ProjectDetail,
} from '../../../packages/shared/src/index';
import { createApp } from '../src/app';
import { BrandService } from '../src/brands';
import { openDatabase } from '../src/db';
import { Media } from '../src/media';
import { Conflict, NotFound, Repository } from '../src/repository';
import type { BlobStorage } from '../src/storage';

const input: BrandInput = {
  name: '山间日常',
  primaryColor: '#244b3c',
  secondaryColor: '#e8efde',
  tone: '自然、清晰、有细节',
  bannedTerms: ['绝对有效', '全网最低'],
  fontFamily: 'serif',
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(context: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-brands-'));
  const db = await openDatabase(dir);
  const objects = new Map<string, Buffer>();
  const hooks: { put?: (key: string) => Promise<void>; get?: (key: string) => Promise<void> } = {};
  const storage: BlobStorage = {
    identity: 'brand-test-storage',
    async put(key, bytes) {
      await hooks.put?.(key);
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      await hooks.get?.(key);
      const bytes = objects.get(key);
      if (!bytes) throw new Error('object missing');
      return Buffer.from(bytes);
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  const media = new Media(db, dir, storage);
  const repo = new Repository(db);
  const brands = new BrandService(db, media, repo);
  const png = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#34765c' } })
    .png()
    .toBuffer();
  context.after(async () => {
    await media.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, media, repo, brands, png, hooks, objects };
}

test('brand CRUD is workspace scoped, revision checked, and archived brands can be restored', async (t) => {
  const f = await fixture(t);
  const brand = await f.brands.create('workspace-a', input);
  assert.equal(brand.revision, 1);
  assert.equal((await f.brands.list('workspace-a')).length, 1);
  assert.deepEqual(await f.brands.list('workspace-b', true), []);
  for (const operation of [
    () => f.brands.get(brand.id, 'workspace-b'),
    () => f.brands.update(brand.id, 'workspace-b', 1, input),
    () => f.brands.setArchived(brand.id, 'workspace-b', true),
    () => f.brands.uploadLogo(brand.id, 'workspace-b', f.png, 'logo.png'),
    () => f.brands.logo(brand.id, 'workspace-b'),
  ])
    await assert.rejects(operation, NotFound);
  const edited = await f.brands.update(brand.id, 'workspace-a', 1, {
    ...input,
    name: '山间新名字',
  });
  assert.equal(edited.revision, 2);
  await assert.rejects(f.brands.update(brand.id, 'workspace-a', 1, input), Conflict);
  assert.deepEqual(await f.brands.get(brand.id, 'workspace-a'), edited);
  const archived = await f.brands.setArchived(brand.id, 'workspace-a', true);
  assert.ok(archived.archivedAt);
  assert.deepEqual(await f.brands.list('workspace-a'), []);
  assert.equal((await f.brands.list('workspace-a', true)).length, 1);
  const restored = await f.brands.setArchived(brand.id, 'workspace-a', false);
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.revision, 4);
  assert.equal((await f.brands.list('workspace-a')).length, 1);
});

test('brand validation rejects unsafe colors, excess values, and arbitrary logo bindings', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { name: ' ' },
    { name: '字'.repeat(81) },
    { primaryColor: 'red' },
    { secondaryColor: '#abc' },
    { fontFamily: 'host-font' },
    { tone: '字'.repeat(1001) },
    { bannedTerms: Array(101).fill('词') },
    { bannedTerms: ['字'.repeat(81)] },
    { logoAssetId: 'another-project-logo' },
  ])
    await assert.rejects(f.brands.create('workspace-a', { ...input, ...patch } as BrandInput));
  assert.deepEqual(await f.brands.list('workspace-a'), []);
});

test('logo upload normalizes, limits size, and uses an internal namespace without creating a project', async (t) => {
  const f = await fixture(t);
  const brand = await f.brands.create('workspace-a', input);
  await assert.rejects(f.brands.logo(brand.id, 'workspace-a'), NotFound);
  await assert.rejects(
    f.brands.uploadLogo(
      brand.id,
      'workspace-a',
      Buffer.alloc(4 * 1024 * 1024 + 1),
      'too-large.png',
    ),
    /4 MiB/,
  );
  await assert.rejects(
    f.brands.uploadLogo(brand.id, 'workspace-a', Buffer.from('<svg/>'), 'logo.svg'),
  );
  const large = await sharp({
    create: { width: 2048, height: 1024, channels: 4, background: '#244b3c80' },
  })
    .png()
    .toBuffer();
  const uploaded = await f.brands.uploadLogo(brand.id, 'workspace-a', large, 'logo.png');
  assert.equal(uploaded.revision, 2);
  const asset = await f.db.get<Asset>('assets', uploaded.logoAssetId!);
  assert.equal(asset?.projectId, `brand:${brand.id}`);
  assert.equal(asset?.width, 1024);
  assert.equal(asset?.height, 512);
  assert.equal(
    (await sharp(await f.brands.logo(brand.id, 'workspace-a')).metadata()).format,
    'png',
  );
  assert.deepEqual(await f.db.list('projects'), []);
  assert.equal(
    await f.media.removeIfUnreferenced(uploaded.logoAssetId!, `brand:${brand.id}`),
    false,
  );
});

test('applying a brand copies its logo into each project and preserves previous works after edits or archive', async (t) => {
  const f = await fixture(t);
  const created = await f.brands.create('workspace-a', input);
  const brand = await f.brands.uploadLogo(created.id, 'workspace-a', f.png, 'logo.png');
  const first = await f.repo.create(
    '第一项目',
    { ...EMPTY_BRIEF, productName: '茶杯', confirmed: true },
    'workspace-a',
  );
  const second = await f.repo.create('第二项目', EMPTY_BRIEF, 'workspace-a');
  const foreign = await f.repo.create('其他空间', EMPTY_BRIEF, 'workspace-b');
  await assert.rejects(
    f.brands.apply(brand.id, 'workspace-a', foreign.id, foreign.revision),
    NotFound,
  );
  await assert.rejects(
    f.brands.apply(brand.id, 'workspace-b', second.id, second.revision),
    NotFound,
  );
  const applied = await f.brands.apply(brand.id, 'workspace-a', first.id, first.revision);
  const appliedSecond = await f.brands.apply(brand.id, 'workspace-a', second.id, second.revision);
  assert.equal(applied.revision, first.revision + 1);
  assert.equal(applied.brief.productName, '茶杯');
  assert.equal(applied.brief.confirmed, false);
  assert.equal(applied.brief.brand, input.name);
  assert.equal(applied.brief.brandColor, input.primaryColor);
  assert.equal(applied.brief.fontFamily, 'serif');
  assert.deepEqual(applied.brief.bannedTerms, input.bannedTerms);
  assert.equal(applied.brief.brandKitRevision, brand.revision);
  assert.notEqual(applied.brief.logoAssetId, brand.logoAssetId);
  assert.notEqual(applied.brief.logoAssetId, appliedSecond.brief.logoAssetId);
  assert.equal((await f.media.owned(applied.brief.logoAssetId!, first.id)).projectId, first.id);
  assert.deepEqual(
    await f.media.bytes(applied.brief.logoAssetId!),
    await f.brands.logo(brand.id, 'workspace-a'),
  );
  assert.equal(await f.media.removeIfUnreferenced(applied.brief.logoAssetId!, first.id), false);
  const version = await f.repo.version({
    projectId: first.id,
    kind: 'poster',
    label: '已保存海报',
    poster: makePoster('commerce-product', applied.brief),
  });
  const savedProject = await f.repo.project(first.id);
  const oldCopy = await f.media.bytes(applied.brief.logoAssetId!);
  const changed = await f.brands.update(brand.id, 'workspace-a', brand.revision, {
    ...input,
    name: '新的品牌',
    primaryColor: '#ff3300',
  });
  await f.brands.uploadLogo(
    brand.id,
    'workspace-a',
    await sharp(f.png).negate().png().toBuffer(),
    'new.png',
  );
  await f.brands.setArchived(changed.id, 'workspace-a', true);
  assert.deepEqual(await f.repo.project(first.id), savedProject);
  assert.deepEqual(await f.db.get('versions', version.id), version);
  assert.deepEqual(await f.media.bytes(applied.brief.logoAssetId!), oldCopy);
  assert.equal(await f.db.get('assets', brand.logoAssetId!), undefined);
  await assert.rejects(
    f.brands.apply(brand.id, 'workspace-a', second.id, appliedSecond.revision),
    Conflict,
  );
});

test('a concurrent edit during logo PUT preserves the original logo and cleans only the new upload', async (t) => {
  const f = await fixture(t);
  const created = await f.brands.create('workspace-a', input);
  const brand = await f.brands.uploadLogo(created.id, 'workspace-a', f.png, 'original.png');
  const entered = deferred(),
    release = deferred();
  f.hooks.put = async (key) => {
    if (key.endsWith('.png')) {
      entered.resolve();
      await release.promise;
    }
  };
  const uploading = f.brands.uploadLogo(brand.id, 'workspace-a', f.png, 'replacement.png');
  const rejected = assert.rejects(uploading, Conflict);
  try {
    await entered.promise;
    await f.brands.update(brand.id, 'workspace-a', brand.revision, { ...input, tone: '清楚表达' });
  } finally {
    release.resolve();
  }
  await rejected;
  const current = await f.brands.get(brand.id, 'workspace-a');
  assert.equal(current.logoAssetId, brand.logoAssetId);
  assert.equal(current.tone, '清楚表达');
  assert.equal((await f.db.list('assets')).length, 1);
  assert.equal(f.objects.size, 2);
  assert.deepEqual(
    await f.brands.logo(brand.id, 'workspace-a'),
    await f.media.bytes(brand.logoAssetId!),
  );
});

test('project revision conflict after copying a logo cleans the new copy and retains user updates', async (t) => {
  const f = await fixture(t);
  const created = await f.brands.create('workspace-a', input);
  const brand = await f.brands.uploadLogo(created.id, 'workspace-a', f.png, 'logo.png');
  const project = await f.repo.create('项目原名', EMPTY_BRIEF, 'workspace-a');
  const entered = deferred(),
    release = deferred();
  f.hooks.put = async (key) => {
    if (key.endsWith('.png')) {
      entered.resolve();
      await release.promise;
    }
  };
  const applying = f.brands.apply(brand.id, 'workspace-a', project.id, project.revision);
  const rejected = assert.rejects(applying, Conflict);
  let edited;
  try {
    await entered.promise;
    edited = await f.repo.update(project.id, project.revision, { title: '用户编辑的新名字' });
  } finally {
    release.resolve();
  }
  await rejected;
  assert.deepEqual(await f.repo.project(project.id), edited);
  assert.deepEqual(await f.db.list('assets', project.id), []);
  assert.equal((await f.db.list('assets')).length, 1);
  assert.equal(f.objects.size, 2);
});

test('brand archive during the project copy prevents application and removes the unused copy', async (t) => {
  const f = await fixture(t);
  const created = await f.brands.create('workspace-a', input);
  const brand = await f.brands.uploadLogo(created.id, 'workspace-a', f.png, 'logo.png');
  const project = await f.repo.create('归档竞争', EMPTY_BRIEF, 'workspace-a');
  const entered = deferred(),
    release = deferred();
  f.hooks.put = async (key) => {
    if (key.endsWith('.png')) {
      entered.resolve();
      await release.promise;
    }
  };
  const applying = f.brands.apply(brand.id, 'workspace-a', project.id, project.revision);
  const rejected = assert.rejects(applying, Conflict);
  try {
    await entered.promise;
    await f.brands.setArchived(brand.id, 'workspace-a', true);
  } finally {
    release.resolve();
  }
  await rejected;
  assert.deepEqual(await f.repo.project(project.id), project);
  assert.deepEqual(await f.db.list('assets', project.id), []);
  assert.equal(f.objects.size, 2);
});

test('brand HTTP routes authorize every workspace operation and keep source logos out of project asset routes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-brand-api-'));
  const password = 'brand-api-test-password';
  const state = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: { email: 'owner@example.test', password } },
  });
  t.after(async () => {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    cookie?: string,
    payload?: object,
  ) =>
    state.app.inject({
      method,
      url,
      headers: { host: 'localhost:4317', ...(cookie ? { cookie } : {}) },
      ...(payload ? { payload } : {}),
    });
  async function login(email: string) {
    const response = await call('POST', '/api/session', undefined, { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return (response.headers['set-cookie'] as string).split(';')[0];
  }
  const owner = await login('owner@example.test');
  const account = await call('POST', '/api/admin/accounts', owner, {
    email: 'other@example.test',
    password,
    displayName: '另一个空间',
  });
  assert.equal(account.statusCode, 200, account.body);
  const other = await login('other@example.test');
  const created = await call('POST', '/api/brands', owner, input);
  assert.equal(created.statusCode, 200, created.body);
  let brand = created.json<BrandKit>();
  assert.equal((await call('GET', '/api/brands')).statusCode, 401);
  assert.deepEqual((await call('GET', '/api/brands', other)).json(), []);
  assert.equal((await call('GET', `/api/brands/${brand.id}`, other)).statusCode, 404);
  assert.equal(
    (await call('PUT', `/api/brands/${brand.id}`, other, { ...input, revision: brand.revision }))
      .statusCode,
    404,
  );
  assert.equal(
    (await call('PATCH', `/api/brands/${brand.id}/archive`, other, { archived: true })).statusCode,
    404,
  );
  const png = await sharp({ create: { width: 10, height: 8, channels: 4, background: '#244b3c' } })
    .png()
    .toBuffer();
  const boundary = 'brand-upload-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="brand.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = (cookie: string) =>
    state.app.inject({
      method: 'POST',
      url: `/api/brands/${brand.id}/logo`,
      headers: {
        host: 'localhost:4317',
        cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  assert.equal((await upload(other)).statusCode, 404);
  const uploaded = await upload(owner);
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  brand = uploaded.json<BrandKit>();
  assert.ok(brand.logoAssetId);
  const logo = await call('GET', `/api/brands/${brand.id}/logo`, owner);
  assert.equal(logo.statusCode, 200, logo.body.slice(0, 100));
  assert.match(logo.headers['content-type']!, /^image\/png/);
  assert.equal((await sharp(logo.rawPayload).metadata()).format, 'png');
  assert.equal((await call('GET', `/api/brands/${brand.id}/logo`, other)).statusCode, 404);
  assert.equal(
    (await call('GET', `/api/assets/${brand.logoAssetId}/content`, owner)).statusCode,
    404,
  );
  assert.equal(
    (await call('GET', `/api/assets/${brand.logoAssetId}/thumbnail`, owner)).statusCode,
    404,
  );
  const ownProject = await call('POST', '/api/projects', owner, {
    title: '品牌应用',
    brief: EMPTY_BRIEF,
  });
  const target = ownProject.json<ProjectDetail>().project;
  const foreignProject = await call('POST', '/api/projects', other, {
    title: '其他空间',
    brief: EMPTY_BRIEF,
  });
  const foreign = foreignProject.json<ProjectDetail>().project;
  assert.equal(
    (
      await call('POST', `/api/projects/${foreign.id}/apply-brand`, other, {
        brandId: brand.id,
        revision: foreign.revision,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call('POST', `/api/projects/${target.id}/apply-brand`, other, {
        brandId: brand.id,
        revision: target.revision,
      })
    ).statusCode,
    404,
  );
  const applied = await call('POST', `/api/projects/${target.id}/apply-brand`, owner, {
    brandId: brand.id,
    revision: target.revision,
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.notEqual(applied.json().brief.logoAssetId, brand.logoAssetId);
  assert.equal(
    (await call('GET', `/api/assets/${applied.json().brief.logoAssetId}/content`, owner))
      .statusCode,
    200,
  );
  const updated = await call('PUT', `/api/brands/${brand.id}`, owner, {
    ...input,
    name: '新名称',
    revision: brand.revision,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(
    (await call('PUT', `/api/brands/${brand.id}`, owner, { ...input, revision: brand.revision }))
      .statusCode,
    409,
  );
  assert.equal(
    (await call('PATCH', `/api/brands/${brand.id}/archive`, owner, { archived: true })).statusCode,
    200,
  );
  assert.deepEqual((await call('GET', '/api/brands', owner)).json(), []);
  assert.equal((await call('GET', '/api/brands?archived=true', owner)).json().length, 1);
});
