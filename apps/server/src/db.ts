import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Scope =
  | 'projects'
  | 'assets'
  | 'versions'
  | 'tasks'
  | 'providers'
  | 'sessions'
  | 'usage'
  | 'pending_assets'
  | 'brand_kits'
  | 'shares'
  | 'invites';
export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  get<T>(scope: Scope, id: string): Promise<T | undefined>;
  list<T>(scope: Scope, projectId?: string): Promise<T[]>;
  put<T>(scope: Scope, id: string, body: T): Promise<void>;
  remove(scope: Scope, id: string): Promise<void>;
  close(): Promise<void>;
}
export async function openDatabase(dataDir: string, databaseUrl?: string): Promise<Database> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const pg = databaseUrl
    ? postgres(databaseUrl, {
        max: 5,
        // Database.query uses JSON text for json/jsonb binds, matching PGlite.
        // postgres.js otherwise JSON.stringify's that text a second time.
        types: {
          json: {
            to: 114,
            from: [114, 3802],
            serialize: (value: unknown) =>
              typeof value === 'string' ? value : JSON.stringify(value),
            parse: JSON.parse,
          },
        },
        onnotice: (notice) => {
          if (notice.code !== '42P07') console.warn('PostgreSQL notice', notice.code);
        },
      })
    : undefined;
  const local = pg ? undefined : new PGlite(path.join(dataDir, 'db'));
  type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  const context = new AsyncLocalStorage<{ query: Query; active: boolean }>();
  let savepointSequence = 0;
  const baseQuery = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (pg) return [...(await pg.unsafe(sql, params as never[]))] as T[];
    return (await local!.query<T>(sql, params)).rows;
  };
  const query: Query = async (sql, params = []) => {
    const current = context.getStore();
    if (current && !current.active) throw new Error('事务已结束，不能继续写入');
    return (current?.query ?? baseQuery)(sql, params);
  };
  const transaction = async <T>(work: () => Promise<T>): Promise<T> => {
    const parent = context.getStore();
    if (parent) {
      if (!parent.active) throw new Error('事务已结束');
      const savepoint = `zhizuo_sp_${++savepointSequence}`;
      await query(`SAVEPOINT ${savepoint}`);
      try {
        const value = await work();
        await query(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        await query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    const run = async (execute: Query) => {
      const state = { query: execute, active: true };
      try {
        return await context.run(state, work);
      } finally {
        state.active = false;
      }
    };
    if (pg) {
      const result = await pg.begin(async (connection) => ({
        value: await run(
          async <R>(sql: string, params: unknown[] = []) =>
            [...(await connection.unsafe(sql, params as never[]))] as R[],
        ),
      }));
      return result.value;
    }
    return local!.transaction(async (connection) =>
      run(
        async <R>(sql: string, params: unknown[] = []) =>
          (await connection.query<R>(sql, params)).rows,
      ),
    );
  };
  await transaction(async () => {
    if (pg) await query("SELECT pg_advisory_xact_lock(hashtext('zhizuo-schema'))");
    await query(`CREATE TABLE IF NOT EXISTS documents (
    scope text NOT NULL, id text NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY (scope, id)
  )`);
    await query(
      `CREATE INDEX IF NOT EXISTS documents_project ON documents (scope, (body->>'projectId'))`,
    );
    await query(
      `CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await query(`INSERT INTO migrations(version) VALUES(1) ON CONFLICT DO NOTHING`);
  });
  return {
    query,
    transaction,
    async get<T>(scope: Scope, id: string) {
      return (
        await query<{ body: T }>('SELECT body FROM documents WHERE scope=$1 AND id=$2', [scope, id])
      )[0]?.body;
    },
    async list<T>(scope: Scope, projectId?: string) {
      return (
        await query<{ body: T }>(
          `SELECT body FROM documents WHERE scope=$1 ${projectId ? "AND body->>'projectId'=$2" : ''} ORDER BY body->>'createdAt' DESC`,
          projectId ? [scope, projectId] : [scope],
        )
      ).map((r) => r.body);
    },
    async put(scope, id, body) {
      await query(
        'INSERT INTO documents(scope,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(scope,id) DO UPDATE SET body=EXCLUDED.body',
        [scope, id, JSON.stringify(body)],
      );
    },
    async remove(scope, id) {
      await query('DELETE FROM documents WHERE scope=$1 AND id=$2', [scope, id]);
    },
    async close() {
      if (pg) await pg.end();
      else await local!.close();
    },
  };
}
