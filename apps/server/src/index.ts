import 'dotenv/config';
import path from 'node:path';
import { createApp } from './app';
import { readRuntimeOptions } from './config';
const host = process.env.HOST || '127.0.0.1';
const options = readRuntimeOptions('api');
const workerMode = process.env.WORKER_MODE || 'inline';
if (!['inline', 'external'].includes(workerMode))
  throw new Error('WORKER_MODE 必须是 inline 或 external');
if (workerMode === 'external' && (!options.databaseUrl || !options.encryptionKey))
  throw new Error('外置 worker 模式需要 DATABASE_URL 和 ENCRYPTION_KEY');
if (
  !['127.0.0.1', 'localhost', '::1'].includes(host) &&
  (!process.env.APP_ORIGIN ||
    (!options.accounts && (!options.password || options.password.length < 16)))
)
  throw new Error('非本地监听需要 APP_ORIGIN，以及账号模式或至少16字符共享密码');
const { app } = await createApp({
  ...options,
  worker: workerMode === 'inline',
  origin: process.env.APP_ORIGIN,
  staticRoot: path.resolve('dist/web'),
});
try {
  await app.listen({ host, port: Number(process.env.PORT || 4317) });
} catch (error) {
  await app.close();
  throw error;
}
console.log(`织作 API 已启动：http://${host}:${process.env.PORT || 4317}（worker: ${workerMode}）`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
