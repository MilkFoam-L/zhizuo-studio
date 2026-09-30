import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountError, AccountService, type PublicAccount } from '../src/accounts';
import { openDatabase } from '../src/db';

const password = 'A long private password 2026';
const adminInput = { email: 'admin@example.com', password, displayName: '管理员' };

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-accounts-'));
  const db = await openDatabase(dir);
  const accounts = new AccountService(db);
  await accounts.initialize(adminInput);
  return {
    db,
    accounts,
    dir,
    async close() {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function assertPublic(account: PublicAccount) {
  assert.deepEqual(Object.keys(account).sort(), [
    'createdAt',
    'disabled',
    'displayName',
    'email',
    'id',
    'role',
    'workspace',
  ]);
  assert.match(account.id, /^[a-f0-9-]{36}$/);
  assert.match(account.workspace.id, /^[a-f0-9-]{36}$/);
  assert.equal(Number.isNaN(Date.parse(account.createdAt)), false);
  assert.equal(JSON.stringify(account).includes(password), false);
}

test('bootstrap persists one admin with a private workspace and does not reset on restart', async () => {
  const f = await fixture();
  try {
    const list = await f.accounts.listAccounts();
    assert.equal(list.length, 1);
    assert.equal(list[0].role, 'admin');
    assert.equal(list[0].disabled, false);
    assertPublic(list[0]);
    const login = await f.accounts.login(' ADMIN@EXAMPLE.COM ', password);
    assert.deepEqual(login.user, list[0]);
    const serviceAgain = new AccountService(f.db);
    await serviceAgain.initialize({
      email: 'replacement@example.com',
      password: 'A different admin password',
      displayName: '替换',
    });
    assert.deepEqual(await serviceAgain.listAccounts(), list);
    await assert.rejects(serviceAgain.login(adminInput.email, 'A different admin password'), {
      code: 'INVALID_CREDENTIALS',
    });
    assert.deepEqual((await serviceAgain.login(adminInput.email, password)).user, list[0]);
    const stored = await f.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM auth_users',
    );
    assert.match(stored[0].password_hash, /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    assert.equal(stored[0].password_hash.includes(password), false);
  } finally {
    await f.close();
  }
});

test('account creation normalizes unique emails and creates workspaces atomically', async () => {
  const f = await fixture();
  try {
    const outcomes = await Promise.allSettled([
      f.accounts.createAccount({ email: ' Writer@Example.com ', password, displayName: '写作者' }),
      f.accounts.createAccount({ email: 'writer@example.com', password, displayName: '重复' }),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    assert.equal(rejected?.reason.code, 'ACCOUNT_EXISTS');
    assert.equal(rejected?.reason.statusCode, 409);
    const list = await f.accounts.listAccounts();
    assert.equal(list.length, 2);
    const member = list.find((account) => account.email === 'writer@example.com')!;
    assertPublic(member);
    assert.equal(member.role, 'member');
    assert.notEqual(
      member.workspace.id,
      list.find((account) => account.role === 'admin')!.workspace.id,
    );
    const rows = await f.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM auth_users ORDER BY email',
    );
    assert.notEqual(rows[0].password_hash, rows[1].password_hash);
    const spaces = await f.db.query('SELECT id FROM auth_workspaces');
    assert.equal(spaces.length, 2);

    await f.db.query(
      `ALTER TABLE auth_workspaces ADD CONSTRAINT fail_one_workspace CHECK (name <> '回滚检查的工作空间')`,
    );
    await assert.rejects(
      f.accounts.createAccount({
        email: 'rollback@example.com',
        password,
        displayName: '回滚检查',
      }),
    );
    assert.equal((await f.db.query('SELECT id FROM auth_users')).length, 2);
    assert.equal((await f.db.query('SELECT id FROM auth_workspaces')).length, 2);
  } finally {
    await f.close();
  }
});

test('invalid, disabled and unknown credentials share one error without exposing account details', async () => {
  const f = await fixture();
  try {
    const member = await f.accounts.createAccount({
      email: 'disabled@example.com',
      password,
      displayName: '停用账号',
    });
    await f.accounts.setDisabled(member.id, true);
    for (const [email, supplied] of [
      [adminInput.email, 'wrong password'],
      ['missing@example.com', password],
      [member.email, password],
      ['invalid email', password],
      [adminInput.email, 'x'.repeat(257)],
      [adminInput.email, ''],
    ]) {
      await assert.rejects(f.accounts.login(email, supplied), (error: unknown) => {
        assert.ok(error instanceof AccountError);
        assert.equal(error.message, '邮箱或密码不正确');
        assert.equal(error.code, 'INVALID_CREDENTIALS');
        assert.equal(error.statusCode, 401);
        return true;
      });
    }
    assert.equal((await f.db.query('SELECT token_hash FROM auth_sessions')).length, 0);
  } finally {
    await f.close();
  }
});

test('session tokens are hashed, isolated from legacy sessions, expire and can be revoked', async () => {
  const f = await fixture();
  try {
    const before = Date.now();
    const first = await f.accounts.login(adminInput.email, password);
    const second = await f.accounts.login(adminInput.email, password);
    assert.match(first.token, /^[a-f0-9]{64}$/);
    assert.notEqual(first.token, second.token);
    assert.ok(first.expiresAt >= before + 7 * 86_400_000);
    assert.ok(first.expiresAt <= Date.now() + 7 * 86_400_000);
    assert.deepEqual(await f.accounts.session(first.token), first.user);
    const stored = await f.db.query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions');
    assert.equal(stored.length, 2);
    assert.ok(
      stored.some(
        (row) => row.token_hash === createHash('sha256').update(first.token).digest('hex'),
      ),
    );
    assert.ok(
      stored.every((row) => row.token_hash !== first.token && row.token_hash !== second.token),
    );
    const legacy = 'a'.repeat(64);
    await f.db.put('sessions', createHash('sha256').update(legacy).digest('hex'), {
      expiresAt: Date.now() + 86_400_000,
    });
    assert.equal(await f.accounts.session(legacy), undefined);
    assert.equal(await f.accounts.session('not a token'), undefined);
    assert.equal(await f.accounts.session(''), undefined);

    await f.accounts.logout(first.token);
    await f.accounts.logout(first.token);
    await f.accounts.logout('malformed');
    assert.equal(await f.accounts.session(first.token), undefined);
    assert.deepEqual(await f.accounts.session(second.token), second.user);
    await f.db.query('UPDATE auth_sessions SET expires_at = $1::timestamptz', [
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    assert.equal(await f.accounts.session(second.token), undefined);
    await f.accounts.login(adminInput.email, password);
    assert.equal((await f.db.query('SELECT token_hash FROM auth_sessions')).length, 1);
  } finally {
    await f.close();
  }
});

test('disabling revokes all sessions and re-enabling does not resurrect them', async () => {
  const f = await fixture();
  try {
    const member = await f.accounts.createAccount({
      email: 'member@example.com',
      password,
      displayName: '成员',
    });
    const loginA = await f.accounts.login(member.email, password);
    const loginB = await f.accounts.login(member.email, password);
    const admin = await f.accounts.login(adminInput.email, password);
    const disabled = await f.accounts.setDisabled(member.id, true);
    assert.equal(disabled.disabled, true);
    assert.equal(await f.accounts.session(loginA.token), undefined);
    assert.equal(await f.accounts.session(loginB.token), undefined);
    assert.deepEqual(await f.accounts.session(admin.token), admin.user);
    assert.equal(
      (await f.db.query('SELECT user_id FROM auth_sessions WHERE user_id = $1', [member.id]))
        .length,
      0,
    );
    assert.equal((await f.accounts.setDisabled(member.id, false)).disabled, false);
    assert.equal(await f.accounts.session(loginA.token), undefined);
    assert.equal((await f.accounts.login(member.email, password)).user.id, member.id);
    await assert.rejects(f.accounts.setDisabled(randomUUID(), true), {
      code: 'ACCOUNT_NOT_FOUND',
      statusCode: 404,
    });
  } finally {
    await f.close();
  }
});

test('concurrent disable requests cannot remove the final active administrator', async () => {
  const f = await fixture();
  try {
    const admin = (await f.accounts.listAccounts())[0];
    await assert.rejects(f.accounts.setDisabled(admin.id, true), {
      code: 'LAST_ADMIN',
      statusCode: 409,
    });
    const other = await f.accounts.createAccount(
      { email: 'other-admin@example.com', password, displayName: '另一管理员' },
      'admin',
    );
    const serviceAgain = new AccountService(f.db);
    const outcomes = await Promise.allSettled([
      f.accounts.setDisabled(admin.id, true),
      serviceAgain.setDisabled(other.id, true),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = outcomes.find((result) => result.status === 'rejected');
    assert.equal(rejection?.reason.code, 'LAST_ADMIN');
    const list = await f.accounts.listAccounts();
    assert.equal(list.filter((account) => account.role === 'admin' && !account.disabled).length, 1);
    const disabled = list.find((account) => account.disabled)!;
    assert.equal((await f.accounts.setDisabled(disabled.id, true)).disabled, true);
  } finally {
    await f.close();
  }
});

test('creation validates passwords, role and names before writing any records', async () => {
  const f = await fixture();
  try {
    for (const invalid of [
      { email: 'short@example.com', password: 'short', displayName: '短密码' },
      { email: 'long@example.com', password: 'a'.repeat(257), displayName: '长密码' },
      { email: 'not-an-email', password, displayName: '邮箱' },
      { email: 'blank@example.com', password, displayName: ' ' },
      { email: 'control@example.com', password, displayName: '换\n行' },
    ]) {
      await assert.rejects(f.accounts.createAccount(invalid));
    }
    await assert.rejects(
      f.accounts.createAccount(
        { email: 'role@example.com', password, displayName: '角色' },
        'owner' as 'admin',
      ),
    );
    assert.equal((await f.accounts.listAccounts()).length, 1);
    assert.equal((await f.db.query('SELECT id FROM auth_workspaces')).length, 1);
  } finally {
    await f.close();
  }
});

test('accounts and sessions survive reopening the database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-account-persist-'));
  let db = await openDatabase(dir);
  try {
    const first = new AccountService(db);
    await first.initialize(adminInput);
    const login = await first.login(adminInput.email, password);
    await db.close();
    db = await openDatabase(dir);
    const next = new AccountService(db);
    await next.initialize();
    assert.deepEqual(await next.session(login.token), login.user);
    assert.deepEqual((await next.login(adminInput.email, password)).user, login.user);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
