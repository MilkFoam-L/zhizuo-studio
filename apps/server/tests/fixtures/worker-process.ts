import { createRuntime } from '../../src/runtime';
const workerId = process.env.TEST_WORKER_ID!;
const runtime = await createRuntime({
  dataDir: process.env.DATA_DIR!,
  databaseUrl: process.env.DATABASE_URL!,
  encryptionKey: process.env.ENCRYPTION_KEY!,
  role: 'worker',
  execution: {
    workerId,
    keepAlive: true,
    leaseDurationMs: 1400,
    heartbeatMs: 200,
    generateCopy: async (_config, _key, _brief, prompt, signal) => {
      await runtime.db.query('INSERT INTO validation_calls(worker_id,prompt) VALUES($1,$2)', [
        workerId,
        prompt,
      ]);
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, prompt === 'crash-unknown' ? 8000 : 250);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new Error('fixture aborted'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return {
        titles: [prompt],
        body: '用于进程并发测试的固定文本，不是真实AI生成',
        tags: [],
        pages: [{ headline: prompt, body: 'fixture' }],
        warnings: [],
      };
    },
  },
});
await runtime.runner.start();
process.send?.({ ready: true, workerId });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(() => process.exit(0));
  });
