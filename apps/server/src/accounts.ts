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
}
