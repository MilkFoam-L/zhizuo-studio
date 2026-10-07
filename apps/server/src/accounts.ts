import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db';

export interface PublicAccount {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled: boolean;
  workspace: { id: string; name: string };
  createdAt: string;
}

export interface WorkspaceMembership {
  id: string;
  name: string;
  role: 'owner' | 'member';
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

export interface InviteLink {
  id: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  urlPath: string;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: 'INVALID_CREDENTIALS' | 'ACCOUNT_EXISTS' | 'ACCOUNT_NOT_FOUND' | 'LAST_ADMIN',
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const emailSchema = z.string().trim().toLowerCase().max(254).email();
const passwordSchema = z.string().min(12, '密码至少 12 个字符').max(256, '密码最多 256 个字符');
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]+$/u);
const roleSchema = z.enum(['admin', 'member']);
const accountSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
const bootstrapSchema = accountSchema.extend({ displayName: displayNameSchema.default('管理员') });
const loginSchema = z.object({ email: emailSchema, password: z.string().max(256) });
const SESSION_MS = 7 * 86_400_000;
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenSchema = /^[a-f0-9]{64}$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

let dummyHash: Promise<string> | undefined;
function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(32).toString('hex')));
}

async function matchesPassword(password: string, storedHash: string): Promise<boolean> {
  const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(storedHash);
  if (!match) {
    // Corrupt or unknown hash formats still perform the normal password work.
    await matchesPassword(password, await dummyPasswordHash());
    return false;
  }
  const candidate = await derive(password, Buffer.from(match[1], 'hex'));
  return timingSafeEqual(candidate, Buffer.from(match[2], 'hex'));
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  disabled: boolean;
  workspace_id: string;
  workspace_name: string;
  created_at: Date | string;
}

const publicColumns = `u.id, u.email, u.display_name, u.role, u.disabled, u.created_at,
  w.id AS workspace_id, w.name AS workspace_name`;
function publicAccount(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled,
    workspace: { id: row.workspace_id, name: row.workspace_name },
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// The application currently runs in one process. Share this guard even if two
// services wrap the same database; the final-admin check and revocation stay ordered.
const writeTails = new WeakMap<Database, Promise<unknown>>();
function serialize<T>(db: Database, operation: () => Promise<T>): Promise<T> {
  const tail = writeTails.get(db) ?? Promise.resolve();
  const next = tail.then(operation, operation);
  writeTails.set(
    db,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export class AccountService {
  constructor(private readonly db: Database) {}

  async initialize(bootstrap?: { email: string; password: string; displayName?: string }) {
    await this.db.query(`CREATE TABLE IF NOT EXISTS auth_users (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
      display_name text NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin', 'member')),
      disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS auth_workspaces (
      id text PRIMARY KEY,
      owner_id text NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
      name text NOT NULL
    )`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    )`);
    await this.db.query('CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id)');
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at)',
    );
    await this.db.query(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id text NOT NULL REFERENCES auth_workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id)
    )`);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id)',
    );
    await this.db.query('INSERT INTO migrations(version) VALUES(4) ON CONFLICT DO NOTHING');
    await dummyPasswordHash();
    if (bootstrap) {
      await serialize(this.db, async () => {
        const existing = await this.db.query<{ id: string }>('SELECT id FROM auth_users LIMIT 1');
        if (existing.length) return;
        await this.insertAccount(bootstrapSchema.parse(bootstrap), 'admin');
      });
    }
  }

  async createAccount(
    input: { email: string; password: string; displayName: string },
    role: 'admin' | 'member' = 'member',
  ): Promise<PublicAccount> {
    const account = accountSchema.parse(input);
    const checkedRole = roleSchema.parse(role);
    return serialize(this.db, () => this.insertAccount(account, checkedRole));
  }

  private async insertAccount(
    account: z.infer<typeof accountSchema>,
    role: 'admin' | 'member',
  ): Promise<PublicAccount> {
    const passwordHash = await hashPassword(account.password);
    try {
      const rows = await this.db.query<AccountRow>(
        `WITH new_user AS (
          INSERT INTO auth_users(id, email, display_name, password_hash, role)
          VALUES($1, $2, $3, $4, $5) RETURNING *
        ), new_workspace AS (
          INSERT INTO auth_workspaces(id, owner_id, name)
          SELECT $6, id, $7 FROM new_user RETURNING *
        )
        SELECT ${publicColumns} FROM new_user u JOIN new_workspace w ON w.owner_id = u.id`,
        [
          randomUUID(),
          account.email,
          account.displayName,
          passwordHash,
          role,
          randomUUID(),
          `${account.displayName}的工作空间`,
        ],
      );
      return publicAccount(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AccountError('此邮箱已创建账号', 409, 'ACCOUNT_EXISTS');
      throw error;
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; user: PublicAccount; expiresAt: number }> {
    const credentials = loginSchema.safeParse({ email, password });
    const rows = credentials.success
      ? await this.db.query<{ id: string; password_hash: string; disabled: boolean }>(
          'SELECT id, password_hash, disabled FROM auth_users WHERE email = $1',
          [credentials.data.email],
        )
      : [];
    const candidate = rows[0];
    const correct = await matchesPassword(
      credentials.success ? credentials.data.password : 'invalid credentials',
      candidate?.password_hash ?? (await dummyPasswordHash()),
    );
    if (!credentials.success || !candidate || !correct || candidate.disabled)
      throw new AccountError('邮箱或密码不正确', 401, 'INVALID_CREDENTIALS');

    return serialize(this.db, async () => {
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_MS;
      await this.db.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      // Recheck disabled after password verification, including a concurrent disable.
      const rows = await this.db.query<AccountRow>(
        `WITH new_session AS (
          INSERT INTO auth_sessions(token_hash, user_id, expires_at)
          SELECT $1, id, $3::timestamptz FROM auth_users WHERE id = $2 AND NOT disabled
          RETURNING user_id
        )
        SELECT ${publicColumns} FROM new_session s
        JOIN auth_users u ON u.id = s.user_id JOIN auth_workspaces w ON w.owner_id = u.id`,
        [tokenHash(token), candidate.id, new Date(expiresAt).toISOString()],
      );
      if (!rows[0]) throw new AccountError('邮箱或密码不正确', 401, 'INVALID_CREDENTIALS');
      return { token, user: publicAccount(rows[0]), expiresAt };
    });
  }

  async session(token: string): Promise<PublicAccount | undefined> {
    if (typeof token !== 'string' || !tokenSchema.test(token)) return undefined;
    const rows = await this.db.query<AccountRow>(
      `SELECT ${publicColumns} FROM auth_sessions s
       JOIN auth_users u ON u.id = s.user_id JOIN auth_workspaces w ON w.owner_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
      [tokenHash(token)],
    );
    return rows[0] ? publicAccount(rows[0]) : undefined;
  }

  async logout(token: string): Promise<void> {
    if (typeof token !== 'string' || !tokenSchema.test(token)) return;
    await this.db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]);
  }

  async listAccounts(): Promise<PublicAccount[]> {
    const rows = await this.db.query<AccountRow>(
      `SELECT ${publicColumns} FROM auth_users u JOIN auth_workspaces w ON w.owner_id = u.id
       ORDER BY u.created_at, u.id`,
    );
    return rows.map(publicAccount);
  }

  async setDisabled(id: string, disabled: boolean): Promise<PublicAccount> {
    z.string().uuid().parse(id);
    z.boolean().parse(disabled);
    return serialize(this.db, async () => {
      const rows = await this.db.query<AccountRow>(
        `WITH updated_user AS (
          UPDATE auth_users SET disabled = $2
          WHERE id = $1 AND (
            NOT $2 OR disabled OR role <> 'admin' OR
            (SELECT count(*) FROM auth_users WHERE role = 'admin' AND NOT disabled) > 1
          ) RETURNING *
        ), revoked_sessions AS (
          DELETE FROM auth_sessions WHERE $2 AND user_id IN (SELECT id FROM updated_user)
          RETURNING user_id
        )
        SELECT ${publicColumns} FROM updated_user u JOIN auth_workspaces w ON w.owner_id = u.id`,
        [id, disabled],
      );
      if (rows[0]) return publicAccount(rows[0]);
      const existing = await this.db.query<{ id: string }>(
        'SELECT id FROM auth_users WHERE id = $1',
        [id],
      );
      if (!existing[0]) throw new AccountError('账号不存在', 404, 'ACCOUNT_NOT_FOUND');
      throw new AccountError('至少保留一个可用的管理员账号', 409, 'LAST_ADMIN');
    });
  }

  async memberships(userId: string): Promise<WorkspaceMembership[]> {
    if (!/^[a-f0-9-]{36}$/i.test(userId)) return [];
    const owned = await this.db.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM auth_workspaces w
       JOIN auth_users u ON u.id = w.owner_id
       WHERE w.owner_id = $1 AND NOT u.disabled`,
      [userId],
    );
    const joined = await this.db.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM workspace_members m
       JOIN auth_workspaces w ON w.id = m.workspace_id
       JOIN auth_users o ON o.id = w.owner_id
       JOIN auth_users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND NOT o.disabled AND NOT u.disabled`,
      [userId],
    );
    return [
      ...owned.map((row) => ({ id: row.id, name: row.name, role: 'owner' as const })),
      ...joined.map((row) => ({ id: row.id, name: row.name, role: 'member' as const })),
    ];
  }

  // Resolved per request; membership removal takes effect without touching sessions.
  async roleIn(userId: string, workspaceId: string): Promise<'owner' | 'member' | undefined> {
    if (!/^[a-f0-9-]{36}$/i.test(userId) || !/^[a-f0-9-]{36}$/i.test(workspaceId)) return undefined;
    const [owned] = await this.db.query<{ id: string }>(
      `SELECT w.id FROM auth_workspaces w
       JOIN auth_users u ON u.id = w.owner_id
       WHERE w.id = $2 AND w.owner_id = $1 AND NOT u.disabled`,
      [userId, workspaceId],
    );
    if (owned) return 'owner';
    const [joined] = await this.db.query<{ role: 'owner' | 'member' }>(
      `SELECT m.role FROM workspace_members m
       JOIN auth_workspaces w ON w.id = m.workspace_id
       JOIN auth_users o ON o.id = w.owner_id
       JOIN auth_users u ON u.id = m.user_id
       WHERE m.workspace_id = $2 AND m.user_id = $1 AND NOT o.disabled AND NOT u.disabled`,
      [userId, workspaceId],
    );
    return joined?.role;
  }

  async listMembers(workspaceId: string, requesterId: string): Promise<WorkspaceMember[]> {
    z.string().uuid().parse(workspaceId);
    if ((await this.roleIn(requesterId, workspaceId)) !== 'owner')
      throw new AccountError('只有工作空间所有者可以查看成员', 403, 'LAST_ADMIN');
    const rows = await this.db.query<{
      user_id: string;
      email: string;
      display_name: string;
      is_owner: boolean;
      joined_at: Date | string;
    }>(
      `SELECT u.id AS user_id, u.email, u.display_name, (w.owner_id = u.id) AS is_owner,
              COALESCE(m.created_at, u.created_at) AS joined_at
       FROM auth_workspaces w
       JOIN auth_users u ON u.id = w.owner_id
          OR u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id = w.id)
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id
       WHERE w.id = $1 AND NOT u.disabled
       ORDER BY (w.owner_id = u.id) DESC, joined_at, u.id`,
      [workspaceId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.is_owner ? 'owner' : 'member',
      joinedAt: new Date(row.joined_at).toISOString(),
    }));
  }

  async removeMember(workspaceId: string, requesterId: string, userId: string): Promise<void> {
    z.string().uuid().parse(workspaceId);
    z.string().uuid().parse(userId);
    if ((await this.roleIn(requesterId, workspaceId)) !== 'owner')
      throw new AccountError('只有工作空间所有者可以移除成员', 403, 'LAST_ADMIN');
    if (requesterId === userId) throw new AccountError('所有者不能移除自己', 409, 'LAST_ADMIN');
    await this.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      workspaceId,
      userId,
    ]);
  }

  async createInvite(
    workspaceId: string,
    requesterId: string,
    expiresHours: number,
  ): Promise<InviteLink> {
    z.string().uuid().parse(workspaceId);
    const hours = z.number().int().min(1).max(168).parse(expiresHours);
    if ((await this.roleIn(requesterId, workspaceId)) !== 'owner')
      throw new AccountError('只有工作空间所有者可以创建邀请', 403, 'LAST_ADMIN');
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const now = new Date();
    const invite = {
      id,
      workspaceId,
      tokenHash: tokenHash(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    };
    await this.db.put('invites', id, invite);
    return { ...invite, urlPath: `/#/join/${token}` };
  }

  async listInvites(workspaceId: string, requesterId: string): Promise<InviteLink[]> {
    z.string().uuid().parse(workspaceId);
    if ((await this.roleIn(requesterId, workspaceId)) !== 'owner')
      throw new AccountError('只有工作空间所有者可以查看邀请', 403, 'LAST_ADMIN');
    const rows = await this.db.query<{
      body: {
        id: string;
        workspaceId: string;
        createdAt: string;
        expiresAt: string;
        revokedAt?: string;
      };
    }>(
      "SELECT body FROM documents WHERE scope='invites' AND body->>'workspaceId'=$1 ORDER BY body->>'createdAt' DESC",
      [workspaceId],
    );
    return rows.map((row) => ({
      id: row.body.id,
      workspaceId: row.body.workspaceId,
      createdAt: row.body.createdAt,
      expiresAt: row.body.expiresAt,
      ...(row.body.revokedAt ? { revokedAt: row.body.revokedAt } : {}),
      urlPath: '',
    }));
  }

  async revokeInvite(workspaceId: string, requesterId: string, inviteId: string): Promise<void> {
    z.string().uuid().parse(workspaceId);
    z.string().uuid().parse(inviteId);
    if ((await this.roleIn(requesterId, workspaceId)) !== 'owner')
      throw new AccountError('只有工作空间所有者可以撤销邀请', 403, 'LAST_ADMIN');
    const invite = await this.db.get<{ workspaceId: string; revokedAt?: string }>(
      'invites',
      inviteId,
    );
    if (!invite || invite.workspaceId !== workspaceId)
      throw new AccountError('邀请不存在', 404, 'ACCOUNT_NOT_FOUND');
    if (!invite.revokedAt)
      await this.db.put('invites', inviteId, {
        ...invite,
        revokedAt: new Date().toISOString(),
      });
  }

  async acceptInvite(userId: string, token: string): Promise<WorkspaceMembership> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AccountError('邀请链接无效', 404, 'ACCOUNT_NOT_FOUND');
    const [row] = await this.db.query<{
      body: { workspaceId: string; expiresAt: string; revokedAt?: string };
    }>("SELECT body FROM documents WHERE scope='invites' AND body->>'tokenHash'=$1", [
      tokenHash(token),
    ]);
    const invite = row?.body;
    if (!invite || invite.revokedAt || !(Date.parse(invite.expiresAt) > Date.now()))
      throw new AccountError('邀请链接已失效', 404, 'ACCOUNT_NOT_FOUND');
    const [workspace] = await this.db.query<{ id: string; name: string; owner_id: string }>(
      `SELECT w.id, w.name, w.owner_id FROM auth_workspaces w
       JOIN auth_users o ON o.id = w.owner_id
       WHERE w.id = $1 AND NOT o.disabled`,
      [invite.workspaceId],
    );
    if (!workspace) throw new AccountError('邀请链接已失效', 404, 'ACCOUNT_NOT_FOUND');
    if (workspace.owner_id === userId)
      return { id: workspace.id, name: workspace.name, role: 'owner' };
    const [existing] = await this.db.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
      [workspace.id, userId],
    );
    if (!existing)
      await this.db.query(
        "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
        [workspace.id, userId],
      );
    return { id: workspace.id, name: workspace.name, role: 'member' };
  }

  /** Password check without side effects; used to confirm destructive operations. */
  async verifyPassword(userId: string, password: string): Promise<boolean> {
    z.string().uuid().parse(userId);
    const [user] = await this.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM auth_users WHERE id=$1 AND NOT disabled',
      [userId],
    );
    return matchesPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
  }

  /** Self-service password change; every other session is revoked. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentToken?: string,
  ): Promise<void> {
    z.string().uuid().parse(userId);
    const next = passwordSchema.parse(newPassword);
    await serialize(this.db, async () => {
      const [user] = await this.db.query<{ id: string; password_hash: string; disabled: boolean }>(
        'SELECT id, password_hash, disabled FROM auth_users WHERE id=$1 AND NOT disabled',
        [userId],
      );
      if (!user) throw new AccountError('账号不存在', 404, 'ACCOUNT_NOT_FOUND');
      if (!(await matchesPassword(currentPassword, user.password_hash)))
        throw new AccountError('当前密码不正确', 401, 'INVALID_CREDENTIALS');
      await this.db.query('UPDATE auth_users SET password_hash=$2 WHERE id=$1', [
        userId,
        await hashPassword(next),
      ]);
      await this.db.query('DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
      // Re-login flow issues a fresh session; the current token is invalidated too.
      void currentToken;
    });
  }

  /** Admin reset; every session of the target account is revoked. */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    z.string().uuid().parse(userId);
    const next = passwordSchema.parse(newPassword);
    await serialize(this.db, async () => {
      const rows = await this.db.query<{ id: string }>(
        'UPDATE auth_users SET password_hash=$2 WHERE id=$1 RETURNING id',
        [userId, await hashPassword(next)],
      );
      if (!rows.length) throw new AccountError('账号不存在', 404, 'ACCOUNT_NOT_FOUND');
      await this.db.query('DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
    });
  }
}
