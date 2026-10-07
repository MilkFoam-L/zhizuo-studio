import { zipSync, strToU8 } from 'fflate';
import type { Database } from './db';
import type { Media } from './media';
import type { Repository } from './repository';
import { backup } from './backup';
import type { Asset, Project } from '../../../packages/shared/src/index';

const MAX_EXPORT_BYTES = 500 * 1024 * 1024;

export interface AccountExportResult {
  buffer: Buffer;
  projectCount: number;
}

/** Per-account data export: one project ZIP per project plus a manifest. */
export async function exportAccountData(
  db: Database,
  repo: Repository,
  media: Media,
  workspaceId: string,
  account: { id: string; email: string; displayName: string },
): Promise<AccountExportResult> {
  const projects = await db.query<{ body: Project }>(
    "SELECT body FROM documents WHERE scope='projects' AND COALESCE(body->>'workspaceId','local')=$1 ORDER BY body->>'updatedAt' DESC",
    [workspaceId],
  );
  const files: Record<string, Uint8Array> = {};
  const manifest: {
    format: string;
    schemaVersion: number;
    createdAt: string;
    account: { id: string; email: string; displayName: string };
    workspace: { id: string };
    projects: { id: string; title: string; file: string }[];
  } = {
    format: 'zhizuo-account-export',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    account,
    workspace: { id: workspaceId },
    projects: [],
  };
  let total = 0;
  for (const [index, row] of projects.entries()) {
    const projectZip = await backup(repo, media, row.body.id);
    const file = `${String(index + 1).padStart(3, '0')}-${row.body.id}.zip`;
    total += projectZip.length;
    if (total > MAX_EXPORT_BYTES) throw new Error('账号数据导出超过 500 MB 限制，请分项目手动备份');
    files[`projects/${file}`] = new Uint8Array(projectZip);
    manifest.projects.push({ id: row.body.id, title: row.body.title, file });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return { buffer: Buffer.from(zipSync(files, { level: 1 })), projectCount: projects.length };
}

export interface AccountDeletionResult {
  projects: number;
  assets: number;
  versions: number;
  tasks: number;
  /** 额度审计事件按保留策略不删除。 */
  retainedQuotaEvents: number;
}

/**
 * Terminal account deletion. Caller must have verified authorization and the
 * operator password. Quota audit events are retained for compliance; everything
 * else in the personal workspace is removed, including storage objects.
 */
export async function deleteAccountData(
  db: Database,
  media: Media,
  userId: string,
  workspaceId: string,
): Promise<AccountDeletionResult> {
  const result: AccountDeletionResult = {
    projects: 0,
    assets: 0,
    versions: 0,
    tasks: 0,
    retainedQuotaEvents: 0,
  };
  const projects = await db.query<{ id: string }>(
    "SELECT id FROM documents WHERE scope='projects' AND COALESCE(body->>'workspaceId','local')=$1",
    [workspaceId],
  );
  const projectIds = projects.map((row) => row.id);
  result.projects = projectIds.length;

  // Queued/running work stops first; a deleted account can never publish results.
  if (projectIds.length)
    await db.query(
      `UPDATE documents SET body=body || $1::jsonb
       WHERE scope='tasks' AND body->>'projectId' = ANY($2::text[])
         AND body->>'status' IN ('queued','running','reconciling')`,
      [
        JSON.stringify({
          status: 'cancelled',
          recoveryStopped: true,
          error: '所属账号已删除，任务已终止。供应商可能仍在生成并计费，请核对供应商记录。',
          updatedAt: new Date().toISOString(),
        }),
        projectIds,
      ],
    );

  // Storage objects and asset records leave together; missing objects are tolerated.
  for (const projectId of projectIds) {
    for (const row of await db.list<Asset>('assets', projectId)) {
      await media.remove(row.id).catch(() => {});
      result.assets++;
    }
    result.versions += (await db.list('versions', projectId)).length;
    result.tasks += (await db.list('tasks', projectId)).length;
  }

  if (projectIds.length) {
    await db.query(
      `DELETE FROM documents WHERE body->>'projectId' = ANY($1::text[])
       AND scope IN ('versions','tasks','usage','pending_assets','task_events')`,
      [projectIds],
    );
    await db.query(
      `DELETE FROM documents WHERE scope='projects' AND COALESCE(body->>'workspaceId','local')=$1`,
      [workspaceId],
    );
  }
  await db.query(
    `DELETE FROM documents WHERE scope IN ('providers','brand_kits')
     AND COALESCE(body->>'workspaceId','local')=$1`,
    [workspaceId],
  );
  await db.query(`DELETE FROM documents WHERE scope='shares' AND body->>'workspaceId'=$1`, [
    workspaceId,
  ]);
  await db.query(`DELETE FROM documents WHERE scope='invites' AND body->>'workspaceId'=$1`, [
    workspaceId,
  ]);
  // Per-workspace quota state goes with the account; audit events are retained.
  await db.query('DELETE FROM quota_reservations WHERE workspace_id=$1', [workspaceId]);
  await db.query('DELETE FROM quota_windows WHERE workspace_id=$1', [workspaceId]);
  await db.query('DELETE FROM quota_policies WHERE workspace_id=$1', [workspaceId]);
  const [quotaEvents] = await db.query<{ count: string }>(
    'SELECT count(*) AS count FROM quota_events WHERE workspace_id=$1',
    [workspaceId],
  );
  result.retainedQuotaEvents = Number(quotaEvents?.count ?? 0);
  // auth_workspaces and auth_sessions cascade from the user row.
  await db.query('DELETE FROM auth_users WHERE id=$1', [userId]);
  return result;
}
