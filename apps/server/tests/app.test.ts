import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { createApp } from '../src/app';
import { EMPTY_BRIEF, type ProjectDetail, type Provider } from '../../../packages/shared/src/index';
const headers = { host: 'localhost:4317' };
const brief = {
  ...EMPTY_BRIEF,
  productName: '棉麻收纳包',
  sellingPoints: '棉麻外层\n可折叠收纳',
  brand: '小日常',
  price: '49 元',
  confirmed: true,
};
function multipart(bytes: Buffer, filename: string, type = 'image/png') {
  const boundary = 'test-boundary-abcdef';
  return {
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test('real persistence, upload, canvas versions, Chinese PNG export and self-contained restore', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-test-'));
  let state = await createApp({ dataDir: dir, worker: false });
  try {
    let r = await state.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '夏日商品图', brief, templateId: 'xhs-editorial' },
    });
    assert.equal(r.statusCode, 200, r.body);
    let d = r.json<ProjectDetail>();
    const id = d.project.id;
    assert.equal(d.versions.length, 1);
    assert.equal(d.project.revision, 2);
    r = await state.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers,
      payload: { revision: 1, title: '过期写入' },
    });
    assert.equal(r.statusCode, 409);
    const picture = await sharp({
      create: { width: 420, height: 300, channels: 3, background: '#c6bcaa' },
    })
      .png()
      .toBuffer();
    r = await state.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/assets`,
      ...multipart(picture, 'product.png'),
    });
    assert.equal(r.statusCode, 200, r.body);
    const asset = r.json();
    r = await state.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/posters`,
      headers,
      payload: { templateId: 'xhs-editorial', assetId: asset.id },
    });
    assert.equal(r.statusCode, 200, r.body);
    const poster = r.json();
    r = await state.app.inject({
      method: 'GET',
      url: `/api/versions/${poster.id}/preview`,
      headers,
    });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const preview = await sharp(r.rawPayload).metadata();
    assert.equal(preview.width, 1080);
    assert.equal(preview.height, 1440);
    const copy = {
      titles: ['把小物收好'],
      body: '棉麻外层，可折叠收纳。',
      tags: ['日常收纳'],
      pages: [{ headline: '轻松收纳', body: '了解商品细节' }],
      warnings: [],
    };
    r = await state.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/versions`,
      headers,
      payload: { kind: 'copy', label: '人工编辑文案', copy },
    });
    assert.equal(r.statusCode, 200, r.body);
    const version = r.json();
    r = await state.app.inject({
      method: 'POST',
      url: '/api/exports',
      headers,
      payload: { projectId: id, versionIds: [poster.id, version.id], acknowledged: false },
    });
    assert.equal(r.statusCode, 400);
    r = await state.app.inject({
      method: 'POST',
      url: '/api/exports',
      headers,
      payload: { projectId: id, versionIds: [poster.id, version.id], acknowledged: true },
    });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const pack = unzipSync(r.rawPayload);
    assert.ok(pack['01-poster.png']);
    assert.match(strFromU8(pack['02-copy.md']), /棉麻外层/);
    r = await state.app.inject({ method: 'GET', url: `/api/projects/${id}/backup`, headers });
    assert.equal(r.statusCode, 200);
    const backupBytes = r.rawPayload;
    await state.app.close();
    state = await createApp({ dataDir: dir, worker: false });
    r = await state.app.inject({ method: 'GET', url: `/api/projects/${id}`, headers });
    assert.equal(r.statusCode, 200);
    d = r.json();
    assert.equal(d.assets.length, 1);
    assert.equal(d.versions.length, 3);
    r = await state.app.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart(backupBytes, 'backup.zip', 'application/zip'),
    });
    assert.equal(r.statusCode, 200, r.body);
    const restored = r.json<ProjectDetail>();
    assert.notEqual(restored.project.id, id);
    assert.equal(restored.versions.length, 3);
    assert.notEqual(restored.assets[0].id, asset.id);
    for (const v of restored.versions) {
      if (v.poster?.assetId) assert.equal(v.poster.assetId, restored.assets[0].id);
    }
    const invalid = zipSync({
      'project.json': strToU8(JSON.stringify({ format: 'zhizuo', schemaVersion: 999 })),
    });
    r = await state.app.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart(Buffer.from(invalid), 'bad.zip', 'application/zip'),
    });
    assert.equal(r.statusCode, 400);
  } finally {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('credentials remain encrypted and omitted; tasks are idempotent and snapshot inputs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-test-'));
  const s = await createApp({ dataDir: dir, worker: false });
  try {
    let r = await s.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: {
        name: '渠道 A',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'private-test-key',
        textModel: 'test-text',
        imageModel: 'test-image',
        timeoutSeconds: 30,
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(!r.body.includes('private-test-key'));
    const p = r.json<Provider>();
    const stored = await s.db.get<{ secret: string }>('providers', p.id);
    assert.ok(stored!.secret.startsWith('v1.'));
    assert.ok(!stored!.secret.includes('private-test-key'));
    r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '队列验证', brief },
    });
    const project = r.json<ProjectDetail>().project;
    const payload = {
      kind: 'copy',
      providerId: p.id,
      prompt: '生成三页图文',
      idempotencyKey: 'same-key-abcdef',
    };
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        s.app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/tasks`,
          headers,
          payload,
        }),
      ),
    );
    assert.ok(
      rs.every((r) => r.statusCode === 200),
      rs.map((r) => r.body).join(),
    );
    assert.equal(new Set(rs.map((r) => r.json().id)).size, 1);
    assert.equal((await s.db.list('tasks')).length, 1);
    const task = rs[0].json();
    assert.equal(task.status, 'queued');
    assert.ok(!JSON.stringify(task).includes('secret'));
    assert.ok(!JSON.stringify(task).includes('config'));
    r = await s.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers });
    assert.ok(!r.body.includes('private-test-key'));
    assert.ok(!r.body.includes('"secret"'));
    // Task creation appends the generation node in the same transaction as the task.
    const detail = r.json<ProjectDetail>();
    const genNode = detail.project.board.nodes.find((n) => n.data.kind === 'generation');
    assert.equal(genNode?.data.taskId, task.id);
    assert.ok(detail.project.board.edges.some((e) => e.target === genNode!.id));
    r = await s.app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers,
      payload: {
        revision: detail.project.revision,
        board: {
          ...detail.project.board,
          nodes: [
            ...detail.project.board.nodes,
            {
              id: 'foreign-task-node',
              type: 'content',
              position: { x: 0, y: 0 },
              data: {
                kind: 'generation',
                label: '外部任务',
                taskId: '00000000-0000-4000-a000-000000000000',
              },
            },
          ],
        },
      },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /不属于当前项目的生成任务/);
    r = await s.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel`, headers });
    assert.equal(r.json().status, 'cancelled');
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tasks`,
      headers,
      payload,
    });
    assert.equal(r.json().status, 'cancelled');
    r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '未确认简报' },
    });
    const unconfirmed = r.json<ProjectDetail>();
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${unconfirmed.project.id}/tasks`,
      headers,
      payload: { ...payload, idempotencyKey: 'another-key' },
    });
    assert.equal(r.statusCode, 400);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('private deployment requires a session; origin and local DNS-rebinding checks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-test-'));
  const s = await createApp({
    dataDir: dir,
    worker: false,
    password: 'private-test-password',
    origin: 'https://studio.example.com',
  });
  try {
    let r = await s.app.inject({ method: 'GET', url: '/api/projects', headers });
    assert.equal(r.statusCode, 401);
    r = await s.app.inject({ method: 'GET', url: '/%61pi/projects', headers });
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers['cache-control'], 'no-store');
    r = await s.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...headers, origin: 'https://attacker.example' },
      payload: { password: 'private-test-password' },
    });
    assert.equal(r.statusCode, 403);
    r = await s.app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { password: 'wrong' },
    });
    assert.equal(r.statusCode, 401);
    r = await s.app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { password: 'private-test-password' },
    });
    assert.equal(r.statusCode, 200);
    const cookie = r.headers['set-cookie'] as string;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    r = await s.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { ...headers, cookie: cookie.split(';')[0] },
    });
    assert.equal(r.statusCode, 200);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
  const localDir = await mkdtemp(path.join(tmpdir(), 'zhizuo-test-'));
  const local = await createApp({ dataDir: localDir, worker: false });
  try {
    const r = await local.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { host: 'evil.example' },
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await local.app.close();
    await rm(localDir, { recursive: true, force: true });
  }
});

test('page outline becomes editable poster versions with provenance and backup rejects ambiguous IDs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-test-'));
  const s = await createApp({ dataDir: dir, worker: false });
  try {
    let r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '小红书组图', brief },
    });
    const project = r.json<ProjectDetail>().project;
    const copy = {
      titles: ['收纳好物'],
      body: '棉麻外层，可折叠收纳。',
      tags: ['居家收纳'],
      pages: [
        { headline: '收好随身小物', body: '使用已确认商品信息' },
        { headline: '查看材质细节', body: '棉麻外层，可折叠收纳' },
      ],
      warnings: [],
    };
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/versions`,
      headers,
      payload: { kind: 'copy', label: '两页大纲', copy },
    });
    assert.equal(r.statusCode, 200, r.body);
    const source = r.json();
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/storyboards`,
      headers,
      payload: { copyVersionId: source.id, templateId: 'xhs-editorial' },
    });
    assert.equal(r.statusCode, 200, r.body);
    const versions = r.json();
    assert.equal(versions.length, 2);
    assert.ok(versions.every((v: { parentVersionId: string }) => v.parentVersionId === source.id));
    assert.equal(versions[1].poster.texts[1].text, '查看材质细节');
    r = await s.app.inject({ method: 'GET', url: `/api/projects/${project.id}/backup`, headers });
    assert.equal(r.statusCode, 200, r.body.slice(0, 100));
    const files = unzipSync(r.rawPayload);
    const manifest = JSON.parse(strFromU8(files['project.json']));
    manifest.versions.push(manifest.versions[0]);
    files['project.json'] = strToU8(JSON.stringify(manifest));
    r = await s.app.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart(Buffer.from(zipSync(files)), 'ambiguous.zip', 'application/zip'),
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /重复/);
    assert.equal((await s.db.list('projects')).length, 1);
    manifest.versions.pop();
    manifest.project.board.nodes[0].data.versionId = '00000000-0000-4000-a000-000000000000';
    files['project.json'] = strToU8(JSON.stringify(manifest));
    r = await s.app.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart(Buffer.from(zipSync(files)), 'dangling.zip', 'application/zip'),
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /不存在/);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily task cap holds under concurrent requests in the single-instance deployment', async () => {
  const before = process.env.MAX_DAILY_TASKS;
  process.env.MAX_DAILY_TASKS = '1';
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-test-'));
  const s = await createApp({ dataDir: dir, worker: false });
  if (before === undefined) delete process.env.MAX_DAILY_TASKS;
  else process.env.MAX_DAILY_TASKS = before;
  try {
    let r = await s.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: {
        name: '限额测试',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'fake-test-only',
        textModel: 'text',
        imageModel: '',
        timeoutSeconds: 30,
      },
    });
    const p = r.json();
    r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '单实例限额', brief },
    });
    const project = r.json<ProjectDetail>().project;
    const result = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        s.app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/tasks`,
          headers,
          payload: {
            kind: 'copy',
            providerId: p.id,
            prompt: '图文草稿',
            idempotencyKey: `request-key-${n}`,
          },
        }),
      ),
    );
    assert.equal(result.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(result.filter((r) => r.statusCode === 429).length, 4);
    assert.equal((await s.db.list('tasks')).length, 1);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('backup converts tasks to historical snapshots; restore remaps groups, logos and snapshots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-backup-snap-'));
  const s = await createApp({ dataDir: dir, worker: false });
  try {
    const picture = await sharp({
      create: { width: 300, height: 220, channels: 3, background: '#8a9a8f' },
    })
      .png()
      .toBuffer();
    let r = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '备份快照验证', brief },
    });
    const project = r.json<ProjectDetail>().project;
    let detail: ProjectDetail;
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/assets`,
      ...multipart(picture, 'logo.png'),
    });
    const asset = r.json();
    r = await s.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers });
    detail = r.json<ProjectDetail>();
    r = await s.app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers,
      payload: {
        revision: detail.project.revision,
        brief: {
          ...brief,
          logoAssetId: asset.id,
          brandKitId: '0f0e0d0c-0b0a-4918-8765-fedcba987654',
        },
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/posters`,
      headers,
      payload: { templateId: 'xhs-editorial' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().poster?.logoAssetId);
    r = await s.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: {
        name: '备份渠道',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'backup-secret-key',
        textModel: 'test-text',
        imageModel: 'test-image',
        timeoutSeconds: 30,
      },
    });
    const provider = r.json<Provider>();
    r = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tasks`,
      headers,
      payload: {
        kind: 'copy',
        providerId: provider.id,
        prompt: '写三页图文',
        idempotencyKey: 'backup-snapshot-key',
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    const task = r.json();
    r = await s.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers });
    detail = r.json<ProjectDetail>();
    const genNode = detail.project.board.nodes.find((n) => n.data.kind === 'generation');
    assert.ok(genNode);
    const groupId = 'backup-group';
    const noteId = 'backup-note';
    r = await s.app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers,
      payload: {
        revision: detail.project.revision,
        board: {
          ...detail.project.board,
          nodes: [
            ...detail.project.board.nodes,
            {
              id: groupId,
              type: 'content',
              position: { x: 0, y: 0 },
              width: 900,
              height: 600,
              data: { kind: 'group', label: '备注分组' },
            },
            {
              id: noteId,
              type: 'content',
              parentId: groupId,
              position: { x: 20, y: 20 },
              data: {
                kind: 'annotation',
                label: '备注',
                text: '发布前核对价格',
                color: '#b4552d',
                reviewStatus: 'open',
              },
            },
          ],
        },
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await s.app.inject({ method: 'GET', url: `/api/projects/${project.id}/backup`, headers });
    assert.equal(r.statusCode, 200);
    const backupBytes = r.rawPayload;
    const manifest = JSON.parse(strFromU8(unzipSync(backupBytes)['project.json']));
    const exportGen = manifest.project.board.nodes.find(
      (n: { data: { kind: string } }) => n.data.kind === 'generation',
    );
    assert.ok(exportGen.data.taskSnapshot);
    assert.equal(exportGen.data.taskSnapshot.status, 'queued');
    assert.equal(exportGen.data.taskId, undefined);
    assert.ok(!JSON.stringify(manifest).includes('backup-secret-key'));
    r = await s.app.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart(backupBytes, 'backup.zip', 'application/zip'),
    });
    assert.equal(r.statusCode, 200, r.body);
    const restored = r.json<ProjectDetail>();
    const restoredGen = restored.project.board.nodes.find((n) => n.data.kind === 'generation');
    assert.ok(restoredGen?.data.taskSnapshot);
    assert.equal(restoredGen.data.taskId, undefined);
    assert.ok(!restored.project.brief.brandKitId);
    assert.notEqual(restored.project.brief.logoAssetId, asset.id);
    assert.ok(restored.assets.some((a) => a.id === restored.project.brief.logoAssetId));
    const restoredPoster = restored.versions.find((v) => v.poster?.logoAssetId);
    assert.ok(restoredPoster);
    assert.notEqual(restoredPoster.poster!.logoAssetId, asset.id);
    const restoredGroup = restored.project.board.nodes.find((n) => n.data.kind === 'group');
    const restoredNote = restored.project.board.nodes.find((n) => n.data.kind === 'annotation');
    assert.ok(restoredGroup && restoredNote);
    assert.equal(restoredNote.parentId, restoredGroup.id);
    assert.equal(restoredNote.data.text, '发布前核对价格');
    // A backup carrying a runnable task node without a snapshot must be rejected.
    const raw = JSON.parse(strFromU8(unzipSync(backupBytes)['project.json']));
    raw.project.board.nodes.push({
      id: 'runnable-task-node',
      type: 'content',
      position: { x: 0, y: 0 },
      data: {
        kind: 'generation',
        label: '外部任务',
        taskId: '00000000-0000-4000-a000-000000000000',
      },
    });
    const tampered = zipSync({
      'project.json': strToU8(JSON.stringify(raw)),
      ...Object.fromEntries(
        manifest.assets.map((a: { id: string }) => [
          `assets/${a.id}.png`,
          unzipSync(backupBytes)[`assets/${a.id}.png`],
        ]),
      ),
    });
    r = await s.app.inject({
      method: 'POST',
      url: '/api/import',
      ...multipart(Buffer.from(tampered), 'tampered.zip', 'application/zip'),
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /无法恢复为历史记录/);
  } finally {
    await s.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
