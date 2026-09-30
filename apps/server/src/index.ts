import 'dotenv/config';
import path from 'node:path';
import { createApp } from './app';
const host = process.env.HOST || '127.0.0.1';
const password = process.env.APP_PASSWORD;
const accountMode = process.env.AUTH_MODE === 'accounts';
if (process.env.AUTH_MODE && !['local', 'shared', 'accounts'].includes(process.env.AUTH_MODE))
  throw new Error('AUTH_MODE 必须为 local、shared 或 accounts');
if (process.env.AUTH_MODE === 'local' && password)
  throw new Error('local 模式不能同时设置 APP_PASSWORD，请明确选择访问方式');
if (process.env.AUTH_MODE === 'shared' && (!password || password.length < 16))
  throw new Error('shared 模式需要至少 16 字符的 APP_PASSWORD');
if (
  !['127.0.0.1', 'localhost', '::1'].includes(host) &&
  (!process.env.APP_ORIGIN || (!accountMode && (!password || password.length < 16)))
)
  throw new Error(
    '非本地监听需要 APP_ORIGIN，并启用 accounts 模式或配置至少 16 字符的 APP_PASSWORD',
  );
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
if (process.env.STORAGE_BACKEND && !['local', 's3'].includes(process.env.STORAGE_BACKEND))
  throw new Error('STORAGE_BACKEND 必须为 local 或 s3');
const { app } = await createApp({
  dataDir: path.resolve(process.env.DATA_DIR || '.data'),
  databaseUrl: process.env.DATABASE_URL,
  encryptionKey: process.env.ENCRYPTION_KEY,
  password: accountMode ? undefined : password,
  accounts: accountMode
    ? {
        bootstrap:
          process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
            ? {
                email: process.env.ADMIN_EMAIL,
                password: process.env.ADMIN_PASSWORD,
                displayName: process.env.ADMIN_NAME || '管理员',
              }
            : undefined,
      }
    : undefined,
  storage,
  origin: process.env.APP_ORIGIN,
  staticRoot: path.resolve('dist/web'),
});
try {
  await app.listen({ host, port: Number(process.env.PORT || 4317) });
} catch (error) {
  await app.close();
  throw error;
}
console.log(`织作 API 已启动：http://${host}:${process.env.PORT || 4317}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
