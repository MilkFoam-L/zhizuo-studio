import 'dotenv/config';
import path from 'node:path';
import { createApp } from './app';
const host = process.env.HOST || '127.0.0.1';
const password = process.env.APP_PASSWORD;
if (
  !['127.0.0.1', 'localhost', '::1'].includes(host) &&
  (!password || password.length < 16 || !process.env.APP_ORIGIN)
)
  throw new Error('非本地监听需要至少 16 字符 APP_PASSWORD 和 APP_ORIGIN，请配置后重启');
const { app } = await createApp({
  dataDir: path.resolve(process.env.DATA_DIR || '.data'),
  databaseUrl: process.env.DATABASE_URL,
  encryptionKey: process.env.ENCRYPTION_KEY,
  password,
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
