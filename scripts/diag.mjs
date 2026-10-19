// Startup diagnostics: runs each startup step on its own and logs progress to diag-log.txt,
// so the log shows how far it got even if Node crashes.
import { appendFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, totalmem, freemem, cpus } from 'node:os';
import { join } from 'node:path';
const LOG = join(process.cwd(), 'diag-log.txt');
writeFileSync(LOG, '');
const log = (m) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const mb = (n) => `${Math.round(n / 1048576)} MB`;
log(`node ${process.version} ${process.platform} ${process.arch} · flags: ${process.execArgv.join(' ') || '(none)'}`);
log(`memory: total ${mb(totalmem())}, free ${mb(freemem())} · cpus ${cpus().length} · ${cpus()[0]?.model}`);
const step = async (name, fn) => {
  log(`START ${name}`); const t = Date.now();
  await fn();
  log(`OK    ${name} (${Date.now() - t} ms, heap ${mb(process.memoryUsage().rss)} rss)`);
};
try {
  const { PGlite } = await import('@electric-sql/pglite');
  await step('1 database engine in memory', async () => { const db = new PGlite(); await db.query('select 1'); await db.close(); });
  const dir = mkdtempSync(join(tmpdir(), 'tessera-diag-'));
  await step('2 database engine on disk', async () => { const db = new PGlite(join(dir, 'pg')); await db.exec('create table t(x int); insert into t values (1)'); await db.close(); });
  const { register } = await import('tsx/esm/api');
  register();
  await step('3 Tessera schema on a fresh database', async () => { const m = await import('../src/db/index.ts'); await m.openDb(join(dir, 'pg2')); await m.closeDb(); });
  await step('4 card vault', async () => { const v = await import('../src/vault/vault.ts'); await v.openVault(join(dir, 'vault')); await v.closeVault(); });
  await step('5 Tessera schema on your data folder', async () => { const m = await import('../src/db/index.ts'); await m.openDb(join(process.cwd(), 'data', 'pg')); await m.closeDb(); });
  log('ALL STEPS PASSED');
} catch (e) { log('ERROR ' + (e?.stack || e)); }
