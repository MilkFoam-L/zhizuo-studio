import path from 'node:path';
import type { RuntimeOptions } from './runtime';

export function readRuntimeOptions(role: 'api' | 'worker' = 'api'): RuntimeOptions {
  const password = process.env.APP_PASSWORD;
  const accountMode = process.env.AUTH_MODE === 'accounts';
  if (process.env.AUTH_MODE && !['local', 'shared', 'accounts'].includes(process.env.AUTH_MODE))
    throw new Error('AUTH_MODE 必须为 local、shared 或 accounts');
  if (process.env.AUTH_MODE === 'local' && password)
    throw new Error('local 模式不能同时配置 APP_PASSWORD');
  if (process.env.AUTH_MODE === 'shared' && (!password || password.length < 16))
    throw new Error('shared 模式需要至少16字符 APP_PASSWORD');
  if (process.env.STORAGE_BACKEND && !['local', 's3'].includes(process.env.STORAGE_BACKEND))
    throw new Error('STORAGE_BACKEND 必须为 local 或 s3');
  const storage =
    process.env.STORAGE_BACKEND === 's3'
      ? {
          endpoint: process.env.S3_ENDPOINT || '',
          region: process.env.S3_REGION || '',
          bucket: process.env.S3_BUCKET || '',
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
          prefix: process.env.S3_PREFIX || undefined,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
        }
      : undefined;
  const bootstrap =
    role === 'api' && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
      ? {
          email: process.env.ADMIN_EMAIL,
          password: process.env.ADMIN_PASSWORD,
          displayName: process.env.ADMIN_NAME || '管理员',
        }
      : undefined;
  if (role === 'worker' && (!process.env.DATABASE_URL || !process.env.ENCRYPTION_KEY))
    throw new Error(
      '独立 worker 需要共享 PostgreSQL DATABASE_URL 和 ENCRYPTION_KEY；PGlite 仅支持内嵌运行',
    );
  return {
    dataDir: path.resolve(process.env.DATA_DIR || '.data'),
    databaseUrl: process.env.DATABASE_URL,
    encryptionKey: process.env.ENCRYPTION_KEY,
    password: accountMode ? undefined : password,
    accounts: accountMode ? { bootstrap } : undefined,
    storage,
    role,
    execution: role === 'worker' ? { keepAlive: true } : undefined,
  };
}
