import { buildApp } from './app.ts';
import { config } from './config.ts';
import { startWorkers } from './workers/index.ts';

const app = await buildApp({ dataDir: config.dataDir, logger: process.env.LOG === '1' });
const stop = startWorkers();
await app.listen({ port: config.port, host: config.host });
console.log(`\n  Tessera is running\n  Dashboard:  http://localhost:${config.port}/\n  API base:   http://localhost:${config.port}/v1\n  Data dir:   ${config.dataDir}\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stop();
    await app.close();
    process.exit(0);
  });
}
