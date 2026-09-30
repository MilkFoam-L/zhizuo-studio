import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export type Scope =
  | 'projects'
  | 'assets'
  | 'versions'
  | 'tasks'
  | 'providers'
  | 'sessions'
  | 'usage'
  | 'pending_assets';
export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(scope: Scope, id: string): Promise<T | undefined>;
  list<T>(scope: Scope, projectId?: string): Promise<T[]>;
  put<T>(scope: Scope, id: string, body: T): Promise<void>;
  remove(scope: Scope, id: string): Promise<void>;
  close(): Promise<void>;
}
export async function openDatabase(dataDir: string, databaseUrl?: string): Promise<Database> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const pg = databaseUrl ? postgres(databaseUrl, { max: 5 }) : undefined;
  const local = pg ? undefined : new PGlite(path.join(dataDir, 'db'));
  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (pg) return [...(await pg.unsafe(sql, params as never[]))] as T[];
    return (await local!.query<T>(sql, params)).rows;
  };
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
  return {
    query,
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
