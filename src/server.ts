import { buildApp } from './app.ts';
import { config } from './config.ts';
import { startWorkers } from './workers/index.ts';

// Node 24 on Windows crashes while loading the embedded database ("Fatal process out of memory: Zone").
const major = Number(process.versions.node.split('.')[0]);
if (process.platform === 'win32' && major >= 24) {
  console.warn(`\n  Warning: Node ${process.version} on Windows is known to crash while loading Tessera's embedded database.\n  Install Node 22 LTS (https://nodejs.org/en/download), or run once without installing:\n    npx -y node@22 --import tsx src/server.ts\n`);
}

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
