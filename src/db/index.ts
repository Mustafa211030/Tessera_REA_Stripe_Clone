import { PGlite } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { config } from '../config.ts';
import { CAPTURE_TRIGGER, OBJECTS_DDL, SCHEMA } from './schema.ts';

/**
 * Online store. Real Postgres semantics (PGlite = Postgres compiled to WASM), so it runs
 * on Windows/macOS/Linux with no native build and no external server.
 *
 * Documents live in one `objects` table (id, type, account, jsonb body) the same way Stripe's
 * DocDB stores API objects as documents; money lives in a separate append-only ledger table.
 */
type Queryable = Pick<PGlite, 'query' | 'exec'>;

let db: PGlite | null = null;
const txStore = new AsyncLocalStorage<Queryable>();

export async function openDb(dataDir?: string): Promise<PGlite> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  db = await PGlite.create(dataDir ? dataDir : undefined);
  await db.exec(SCHEMA);
  const legacy = await detachLegacyObjects(db);
  await db.exec(OBJECTS_DDL);
  await ensureShards(db, config.shardCount);
  if (legacy) await importLegacyObjects(db);
  await recoverMoves(db);
  return db;
}

export async function closeDb() {
  if (db) await db.close();
  db = null;
}

function conn(): Queryable {
  const tx = txStore.getStore();
  if (tx) return tx;
  if (!db) throw new Error('Database is not open');
  return db;
}

/** Per-statement timings, collected only when TESSERA_PROFILE is set (see queryProfile). */
const profile = process.env.TESSERA_PROFILE ? new Map<string, { calls: number; ms: number }>() : null;

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!profile) return (await conn().query<T>(text, params as any[])).rows;
  const t = performance.now();
  try {
    return (await conn().query<T>(text, params as any[])).rows;
  } finally {
    const k = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    const s = profile.get(k) ?? { calls: 0, ms: 0 };
    s.calls++;
    s.ms += performance.now() - t;
    profile.set(k, s);
  }
}

/** Slowest statements by total time (TESSERA_PROFILE=1). */
export function queryProfile(top = 20) {
  if (!profile) return null;
  return [...profile.entries()].map(([sql, s]) => ({ sql, calls: s.calls, total_ms: Math.round(s.ms * 10) / 10, avg_ms: Math.round((s.ms / s.calls) * 100) / 100 })).sort((a, b) => b.total_ms - a.total_ms).slice(0, top);
}
export const resetQueryProfile = () => profile?.clear();

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Runs fn outside any surrounding transaction (background work started from a request). */
export function detached<T>(fn: () => T): T {
  return txStore.exit(fn);
}

/** Runs fn in a transaction; nested calls join the outer transaction. */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  if (!db) throw new Error('Database is not open');
  return db.transaction((tx) => txStore.run(tx as unknown as Queryable, fn));
}

/**
 * Change capture is only switched on while a shard move runs (writes pay for the trigger only
 * then). A move cut short by a restart cannot resume safely, so it is abandoned: the account
 * stays on its source shard, which was never touched.
 */
async function recoverMoves(d: PGlite) {
  const open = await d.query<{ id: string; data: any }>("SELECT id, data FROM shard_moves WHERE status NOT IN ('complete', 'failed')");
  for (const m of open.rows) {
    const data = { ...m.data, status: 'failed', failure: 'The server restarted during the move.' };
    data.steps = [...(data.steps ?? []), { step: 'abort', at: Date.now(), detail: `Move abandoned after a restart; the account stays on shard ${data.source_shard}.` }];
    await d.query("UPDATE shard_moves SET status = 'failed', data = $2 WHERE id = $1", [m.id, JSON.stringify(data)]);
    await d.query('DELETE FROM shard_staging WHERE move_id = $1', [m.id]);
    await d.query('DELETE FROM shard_oplog WHERE move_id = $1', [m.id]);
  }
  await d.exec('DROP TRIGGER IF EXISTS objects_capture ON objects');
}

export const CAPTURE_ON = CAPTURE_TRIGGER;

/** Creates the shard partitions (objects_s0 … objects_s<n-1>); the count only ever grows. */
export async function ensureShards(d: Pick<PGlite, 'query' | 'exec'>, want: number) {
  const cur = (await d.query<{ n: number }>('SELECT shard_count AS n FROM shard_config WHERE id = 1')).rows[0]?.n ?? 0;
  const n = Math.max(cur, want, 1);
  for (let i = 0; i < n; i++) await d.exec(`CREATE TABLE IF NOT EXISTS objects_s${i} PARTITION OF objects FOR VALUES IN (${i})`);
  await d.query('INSERT INTO shard_config (id, shard_count) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET shard_count = $1', [n]);
  return n;
}

/**
 * Databases from before sharding kept objects in one plain table. It is renamed out of the way
 * (with its indexes) so the sharded table can be created, then copied in by importLegacyObjects.
 */
async function detachLegacyObjects(d: PGlite) {
  const kind = (await d.query<{ relkind: string }>("SELECT relkind FROM pg_class WHERE relname = 'objects' AND relnamespace = 'public'::regnamespace")).rows[0]?.relkind;
  if (kind !== 'r') return false;
  await d.exec('ALTER TABLE objects RENAME TO objects_legacy');
  const idx = await d.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'objects_legacy'");
  for (const { indexname } of idx.rows) await d.exec(`ALTER INDEX "${indexname}" RENAME TO "${indexname}_legacy"`);
  return true;
}

async function importLegacyObjects(d: PGlite) {
  await d.transaction(async (tx) => {
    // Accounts are spread over the shards in order of first object, like new accounts.
    await tx.query('SELECT tessera_shard(account_id) FROM (SELECT account_id, min(seq) AS first FROM objects_legacy GROUP BY account_id ORDER BY first) a');
    await tx.query('INSERT INTO objects (seq, id, account_id, type, created, data, shard) SELECT l.seq, l.id, l.account_id, l.type, l.created, l.data, s.shard FROM objects_legacy l JOIN shard_directory s ON s.account_id = l.account_id ORDER BY l.seq');
    await tx.query("SELECT setval(pg_get_serial_sequence('objects', 'seq'), GREATEST((SELECT max(seq) FROM objects), 1))");
    await tx.exec('DROP TABLE objects_legacy');
  });
}
