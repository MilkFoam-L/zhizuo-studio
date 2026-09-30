import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from './db';
import { AccountService } from './accounts';
import { createStorage, type S3StorageConfig } from './storage';
import { Repository } from './repository';
import { Media } from './media';
import { JobRunner, type JobExecution, type StoredTask } from './jobs';
import { QuotaService } from './quotas';
import type { Project } from '../../../packages/shared/src/index';

export interface RuntimeOptions {
  dataDir: string;
  databaseUrl?: string;
  encryptionKey?: string;
  password?: string;
  accounts?: { bootstrap?: { email: string; password: string; displayName?: string } };
  storage?: S3StorageConfig;
  execution?: Omit<JobExecution, 'canRunProject'>;
  role?: 'api' | 'worker';
}
export async function createRuntime(options: RuntimeOptions) {
  const defaultLimit = Number(process.env.MAX_DAILY_TASKS || 100);
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > 1_000_000)
    throw new Error('MAX_DAILY_TASKS 必须为 1 至 1000000 的整数');
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  let key = options.encryptionKey;
  if (!key) {
    const file = path.join(options.dataDir, 'encryption.key');
    try {
      key = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32).toString('hex');
      try {
        await writeFile(file, key, { mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        key = await readFile(file, 'utf8');
      }
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('ENCRYPTION_KEY 必须为 64 位十六进制字符串');
  const db = await openDatabase(options.dataDir, options.databaseUrl);
  let blobStorage: ReturnType<typeof createStorage>;
  try {
    blobStorage = createStorage(options.dataDir, options.storage);
  } catch (error) {
    await db.close();
    throw error;
  }
  const repo = new Repository(db);
  const media = new Media(db, options.dataDir, blobStorage);
  const accounts = options.accounts ? new AccountService(db) : undefined;
  const mode = accounts ? 'accounts' : options.password ? 'shared' : 'local';
  const quotas = new QuotaService(db, defaultLimit);
  const config = {
    mode,
    keyFingerprint: createHash('sha256').update(key).digest('hex'),
    storageIdentity: blobStorage.identity,
  };
  try {
    await db.transaction(async () => {
      if (options.databaseUrl)
        await db.query("SELECT pg_advisory_xact_lock(hashtext('zhizuo-schema'))");
      if (accounts) {
        await accounts.initialize(
          options.role === 'worker' ? undefined : options.accounts?.bootstrap,
        );
        if (!(await accounts.listAccounts()).length)
          throw new Error('首次启用账号模式需要先配置 ADMIN_EMAIL/ADMIN_PASSWORD 并启动 API');
        await db.query('INSERT INTO migrations(version) VALUES(2) ON CONFLICT DO NOTHING');
      }
      await quotas.initialize();
      await db.query(
        'CREATE TABLE IF NOT EXISTS runtime_config (name text PRIMARY KEY, body jsonb NOT NULL)',
      );
      const [existing] = await db.query<{ body: typeof config }>(
        "SELECT body FROM runtime_config WHERE name='active' FOR UPDATE",
      );
      if (options.role === 'worker') {
        if (
          !existing ||
          existing.body.mode !== mode ||
          existing.body.keyFingerprint !== config.keyFingerprint ||
          existing.body.storageIdentity !== config.storageIdentity
        )
          throw new Error(
            'worker 的认证模式、加密密钥或存储位置与 API 不一致，请先启动 API 并同步配置',
          );
      } else {
        if (existing && existing.body.keyFingerprint !== config.keyFingerprint)
          throw new Error('加密密钥与已有实例不一致，请恢复原密钥或先完成显式密钥迁移');
        await db.query(
          "INSERT INTO runtime_config(name,body) VALUES('active',$1::jsonb) ON CONFLICT(name) DO UPDATE SET body=EXCLUDED.body",
          [JSON.stringify(config)],
        );
      }
      await db.query('INSERT INTO migrations(version) VALUES(3) ON CONFLICT DO NOTHING');
    });
  } catch (error) {
    blobStorage.close?.();
    await db.close();
    throw error;
  }
  const canRunProject = async (projectId: string) => {
    const [active] = await db.query<{ body: typeof config }>(
      "SELECT body FROM runtime_config WHERE name='active'",
    );
    if (
      !active ||
      active.body.mode !== mode ||
      active.body.keyFingerprint !== config.keyFingerprint ||
      active.body.storageIdentity !== config.storageIdentity
    )
      throw new Error('运行配置已变化，请重启对应 worker');
    const project = await db.get<Project>('projects', projectId);
    if (!project) return false;
    const owner = project.workspaceId ?? 'local';
    if (!accounts) return owner === 'local';
    if (owner === 'local') return false;
    return (
      (
        await db.query(
          'SELECT 1 FROM auth_workspaces w JOIN auth_users u ON u.id=w.owner_id WHERE w.id=$1 AND NOT u.disabled FOR SHARE OF u',
          [owner],
        )
      ).length > 0
    );
  };
  const runner = new JobRunner(db, repo, media, key, {
    ...options.execution,
    canRunProject,
    onTaskSettled: async (task) => {
      await quotas.settle(task);
      await options.execution?.onTaskSettled?.(task);
    },
  });
  let maintenance: Promise<void> | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  const maintain = () => {
    if (closing) return Promise.resolve();
    if (maintenance) return maintenance;
    maintenance = (async () => {
      const result = await media.reconcilePending();
      if (result.failed) console.error('部分素材仍待恢复，请检查存储状态');
      const tasks = await db.query<{
        body: StoredTask;
      }>(`SELECT d.body FROM quota_reservations r JOIN documents d ON d.scope='tasks' AND d.id=r.task_id
        WHERE (r.state='reserved' AND d.body->>'status' NOT IN ('queued','running'))
        OR (r.state='review' AND d.body->>'status'='succeeded') LIMIT 200`);
      for (const row of tasks) await quotas.settle(row.body);
    })()
      .catch(() => console.error('后台恢复检查未完成，请检查数据库与存储状态'))
      .finally(() => {
        maintenance = undefined;
      });
    return maintenance;
  };
  const startMaintenance = () => {
    if (maintenanceTimer) return;
    void maintain();
    maintenanceTimer = setInterval(() => void maintain(), 60_000);
    maintenanceTimer.unref();
  };
  const close = async () => {
    closing = true;
    clearInterval(maintenanceTimer);
    await runner.stop();
    await maintenance;
    await media.close();
    blobStorage.close?.();
    await db.close();
  };
  return {
    db,
    repo,
    media,
    runner,
    accounts,
    quotas,
    mode,
    key,
    defaultLimit,
    canRunProject,
    maintain,
    startMaintenance,
    close,
  };
}
