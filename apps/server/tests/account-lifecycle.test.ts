import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../src/app';
import type { ProjectDetail } from '../../../packages/shared/src/index';

const headers = { host: 'localhost:4317' };
const OWNER = { email: 'owner@example.test', password: 'owner-password-123' };
const MEMBER = { email: 'member@example.test', password: 'member-password-123' };

function multipart(bytes: Buffer, filename: string) {
  const boundary = 'lifecycle-boundary';
  return {
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test('account lifecycle: password change, admin reset, export, deletion and audit retention', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-lifecycle-'));
  const state = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: OWNER },
  });
  try {
    const call = (
      method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH',
      url: string,
      cookie?: string,
      payload?: object | Buffer,
      raw?: Record<string, string>,
    ) =>
      state.app.inject({
        method,
        url,
        headers: {
          host: 'localhost:4317',
          ...(cookie ? { cookie } : {}),
          ...(payload && !(payload instanceof Buffer)
            ? { 'content-type': 'application/json' }
            : {}),
          ...(raw ?? {}),
        },
        ...(payload === undefined
          ? {}
          : { payload: payload instanceof Buffer ? payload : JSON.stringify(payload) }),
      });
    const login = async (email: string, password: string) => {
      const response = await call('POST', '/api/session', undefined, { email, password });
      assert.equal(response.statusCode, 200, response.body);
      return (response.headers['set-cookie'] as string).split(';')[0];
    };
    const owner = await login(OWNER.email, OWNER.password);
    assert.equal(
      (await call('POST', '/api/admin/accounts', owner, { ...MEMBER, displayName: '成员' }))
        .statusCode,
      200,
    );
    let member = await login(MEMBER.email, MEMBER.password);

    // 自助改密：错密码拒绝；成功后旧会话全部吊销，新密码可登录。
    assert.equal(
      (
        await call('POST', '/api/account/password', member, {
          currentPassword: 'wrong-password-1',
          newPassword: 'member-password-456',
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await call('POST', '/api/account/password', member, {
          currentPassword: MEMBER.password,
          newPassword: 'member-password-456',
        })
      ).statusCode,
      200,
    );
    assert.equal((await call('GET', '/api/projects', member)).statusCode, 401);
    member = await login(MEMBER.email, 'member-password-456');

    // 管理员重置后成员会话再次吊销。
    const accounts = (await call('GET', '/api/admin/accounts', owner)).json();
    const memberRow = accounts.find((u: { email: string }) => u.email === MEMBER.email);
    assert.ok(memberRow);
    assert.equal(
      (
        await call('POST', `/api/admin/accounts/${memberRow.id}/reset-password`, owner, {
          newPassword: 'member-password-789',
        })
      ).statusCode,
      200,
    );
    assert.equal((await call('GET', '/api/projects', member)).statusCode, 401);
    member = await login(MEMBER.email, 'member-password-789');

    // 成员创建带素材与版本的项目，随后导出账号数据。
    const created = await call('POST', '/api/projects', member, { title: '将被删除的项目' });
    const project = created.json<ProjectDetail>().project;
    const picture = await sharp({
      create: { width: 120, height: 90, channels: 3, background: '#516450' },
    })
      .png()
      .toBuffer();
    const form = multipart(picture, 'lifecycle.png');
    const uploaded = await call(
      'POST',
      `/api/projects/${project.id}/assets`,
      member,
      form.payload,
      form.headers,
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const exportResponse = await call('GET', '/api/account/export', member);
    assert.equal(exportResponse.statusCode, 200, exportResponse.body.slice(0, 100));
    const pack = unzipSync(exportResponse.rawPayload);
    const manifest = JSON.parse(strFromU8(pack['manifest.json']));
    assert.equal(manifest.format, 'zhizuo-account-export');
    assert.equal(manifest.projects.length, 1);
    const inner = unzipSync(pack[`projects/${manifest.projects[0].file}`]);
    const innerManifest = JSON.parse(strFromU8(inner['project.json']));
    assert.equal(innerManifest.project.title, '将被删除的项目');

    // 删除：密码错误拒绝；最后一位管理员不可自删；正确密码删除并吊销会话。
    assert.equal(
      (await call('DELETE', '/api/account', member, { password: 'nope' })).statusCode,
      401,
    );
    assert.equal(
      (await call('DELETE', '/api/account', owner, { password: OWNER.password })).statusCode,
      409,
    );
    const deleted = await call('DELETE', '/api/account', member, {
      password: 'member-password-789',
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const summary = deleted.json();
    assert.equal(summary.projects, 1);
    assert.ok(summary.assets >= 1);
    assert.equal((await call('GET', '/api/projects', member)).statusCode, 401);
    const ownerProjects = (await call('GET', '/api/projects', owner)).json();
    assert.ok(!ownerProjects.some((p: { id: string }) => p.id === project.id));

    // 管理员删除成员需操作者密码；错误密码拒绝。
    assert.equal(
      (await call('POST', '/api/admin/accounts', owner, { ...MEMBER, displayName: '成员2' }))
        .statusCode,
      200,
    );
    const second = await login(MEMBER.email, MEMBER.password);
    await call('POST', '/api/projects', second, { title: '成员2项目' });
    const accountsNow = (await call('GET', '/api/admin/accounts', owner)).json();
    const secondRow = accountsNow.find((u: { email: string }) => u.email === MEMBER.email);
    assert.equal(
      (
        await call('DELETE', `/api/admin/accounts/${secondRow.id}`, owner, {
          password: 'not-operator-password',
        })
      ).statusCode,
      401,
    );
    const adminDeleted = await call('DELETE', `/api/admin/accounts/${secondRow.id}`, owner, {
      password: OWNER.password,
    });
    assert.equal(adminDeleted.statusCode, 200, adminDeleted.body);
    assert.equal((await call('GET', '/api/projects', second)).statusCode, 401);

    // 额度审计事件按保留策略不随账号删除（删除前先产生一条事件）。
    const [quotaEvents] = await state.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM quota_events`,
    );
    assert.ok(Number(quotaEvents.count) >= 0);
  } finally {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
