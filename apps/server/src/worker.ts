import 'dotenv/config';
import { createRuntime } from './runtime';
import { readRuntimeOptions } from './config';
const runtime = await createRuntime(readRuntimeOptions('worker'));
runtime.startMaintenance();
await runtime.runner.start();
console.log('织作独立 worker 已启动，等待任务');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void runtime.close().then(() => process.exit(0));
  });
