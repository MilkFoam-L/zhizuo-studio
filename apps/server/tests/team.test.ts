import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import type { ProjectDetail } from '../../../packages/shared/src/index';

const headers = { host: 'localhost:4317' };

test('workspace members share resources through invite links and lose access on removal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-team-'));
  const state = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: { email: 'owner@example.test', password: 'owner-password-123' } },
  });
  try {
    const call = (
      method: 'GET' | 'POST' | 'DELETE',
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
    const login = async (email: string, password: string) => {
      const response = await call('POST', '/api/session', undefined, { email, password });
      assert.equal(response.statusCode, 200, response.body);
      return (response.headers['set-cookie'] as string).split(';')[0];
    };
    const owner = await login('owner@example.test', 'owner-password-123');
    const created = await call('POST', '/api/admin/accounts', owner, {
      email: 'teammate@example.test',
      password: 'teammate-password-1',
      displayName: '队友',
    });
    assert.equal(created.statusCode, 200, created.body);
    const teammate = await login('teammate@example.test', 'teammate-password-1');

    // Owner workspace has one project the teammate must not see before joining.
    const project = await call('POST', '/api/projects', owner, { title: '团队项目' });
    assert.equal(project.statusCode, 200, project.body);
    const projectId = project.json<ProjectDetail>().project.id;
    const stranger = await call('GET', `/api/projects/${projectId}`, teammate);
    assert.equal(stranger.statusCode, 404);

    // Members list and invites are owner-only.
    assert.equal((await call('GET', `/api/workspaces`, teammate)).statusCode, 200);
    const ownerWorkspace = (await call('GET', '/api/workspaces', owner)).json()[0].id;
    assert.equal(
      (await call('GET', `/api/workspaces/${ownerWorkspace}/members`, teammate)).statusCode,
      403,
    );
    assert.equal(
      (
        await call('POST', `/api/workspaces/${ownerWorkspace}/invites`, teammate, {
          expiresHours: 24,
        })
      ).statusCode,
      403,
    );

    const invite = await call('POST', `/api/workspaces/${ownerWorkspace}/invites`, owner, {
      expiresHours: 24,
    });
    assert.equal(invite.statusCode, 200, invite.body);
    const token = invite.json().urlPath.split('/').pop();
    assert.match(token as string, /^[A-Za-z0-9_-]{43}$/);

    const accepted = await call('POST', '/api/invites/accept', teammate, { token });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().role, 'member');
    // Joining twice stays a single membership.
    const again = await call('POST', '/api/invites/accept', teammate, { token });
    assert.equal(again.statusCode, 200, again.body);

    // Switching the active workspace grants access to shared resources.
    const switched = await call('POST', '/api/workspaces/switch', teammate, {
      workspaceId: ownerWorkspace,
    });
    assert.equal(switched.statusCode, 200, switched.body);
    const workspaceCookie = `${teammate}; ${(switched.headers['set-cookie'] as string).split(';')[0]}`;
    const visible = await call('GET', '/api/projects', workspaceCookie);
    assert.equal(visible.statusCode, 200, visible.body);
    assert.ok(visible.json().some((p: { id: string }) => p.id === projectId));
    assert.equal(
      (await call('GET', `/api/projects/${projectId}`, workspaceCookie)).statusCode,
      200,
    );
    const memberProject = await call('POST', '/api/projects', workspaceCookie, {
      title: '成员新建项目',
    });
    assert.equal(memberProject.statusCode, 200, memberProject.body);
    assert.equal(memberProject.json<ProjectDetail>().project.workspaceId, ownerWorkspace);

    // Members still cannot manage the workspace.
    assert.equal(
      (await call('GET', `/api/workspaces/${ownerWorkspace}/members`, workspaceCookie)).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          'DELETE',
          `/api/workspaces/${ownerWorkspace}/members/${ownerWorkspace}`,
          workspaceCookie,
        )
      ).statusCode,
      403,
    );

    // Owner sees both members and removes the teammate.
    const members = await call('GET', `/api/workspaces/${ownerWorkspace}/members`, owner);
    assert.equal(members.statusCode, 200, members.body);
    const memberRow = members.json().find((m: { role: string }) => m.role === 'member');
    assert.ok(memberRow);
    const removed = await call(
      'DELETE',
      `/api/workspaces/${ownerWorkspace}/members/${memberRow.userId}`,
      owner,
    );
    assert.equal(removed.statusCode, 200, removed.body);

    // The stale workspace cookie no longer grants access; requests fall back
    // to the personal workspace and the shared project disappears again.
    const afterRemoval = await call('GET', `/api/projects/${projectId}`, workspaceCookie);
    assert.equal(afterRemoval.statusCode, 404);

    // Revoked invites stop accepting.
    const second = await call('POST', `/api/workspaces/${ownerWorkspace}/invites`, owner, {
      expiresHours: 24,
    });
    const secondToken = second.json().urlPath.split('/').pop();
    const third = await call('POST', '/api/admin/accounts', owner, {
      email: 'late@example.test',
      password: 'late-password-12345',
      displayName: '迟到者',
    });
    assert.equal(third.statusCode, 200, third.body);
    const late = await login('late@example.test', 'late-password-12345');
    await call(
      'POST',
      `/api/workspaces/${ownerWorkspace}/invites/${second.json().id}/revoke`,
      owner,
    );
    const rejected = await call('POST', '/api/invites/accept', late, { token: secondToken });
    assert.equal(rejected.statusCode, 404, rejected.body);
  } finally {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
