import { CAPTURE_ON, one, query, transaction } from '../db/index.ts';
import { forgetShard } from './store.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Ctx } from '../platform/context.ts';

/**
 * Shards and zero-downtime data movement (after Stripe's published DocDB design).
 *
 * The object store is split into shards (Postgres partitions objects_s0 … objects_sN). The shard
 * directory maps each account to its shard. Moving an account to another shard follows the six
 * published steps:
 *
 *   1. register     record the intent; writes to the account start being captured (shard_oplog)
 *   2. bulk import  copy a snapshot of the account's objects into a staging copy
 *   3. replicate    replay the captured writes onto the copy until it has caught up
 *   4. verify       compare the copy with the source: same ids, same documents (checksums)
 *   5. switch       briefly hold the account's API requests, apply the last writes, swap the
 *                   rows into the target shard and bump the directory version (one transaction)
 *   6. deregister   drop the staging copy and the change log
 *
 * Requests for the account keep being served during steps 1–4; during step 5 they wait (at most
 * a couple of seconds) and then continue against the new shard.
 */

type Move = {
  id: string; object: 'tessera.shard_move'; account: string; source_shard: number; target_shard: number;
  status: 'registered' | 'copying' | 'replicating' | 'verifying' | 'switching' | 'complete' | 'failed';
  created: number; steps: { step: string; at: number; detail: string }[];
  objects_copied: number; changes_replayed: number; switch_ms: number | null; failure: string | null;
};

// ---------------------------------------------------------------- request gate (step 5)

const gates = new Map<string, Promise<void>>();

/** API requests for an account wait here while its data is switching shards. */
export async function waitForGate(accountId: string) {
  const g = gates.get(accountId);
  if (!g) return;
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000));
  if ((await Promise.race([g.then(() => 'ok' as const), timeout])) === 'timeout') {
    throw new ApiError(503, 'api_error', 'This account is being moved between storage shards. Retry the request in a moment.', { code: 'lock_timeout', headers: { 'Stripe-Should-Retry': 'true' } });
  }
}

// ---------------------------------------------------------------- directory and stats

export async function shardOf(accountId: string) {
  return (await one<{ shard: number; version: number }>('SELECT shard, version FROM shard_directory WHERE account_id = $1', [accountId])) ?? null;
}

/** All shards: accounts, objects and approximate size on disk. */
export async function overview(accountId: string) {
  const count = (await one<{ n: number }>('SELECT shard_count AS n FROM shard_config WHERE id = 1'))?.n ?? 1;
  const stats = await query<{ shard: number; accounts: number; objects: number }>(
    'SELECT d.shard, count(DISTINCT d.account_id)::int AS accounts, (SELECT count(*)::int FROM objects o WHERE o.shard = d.shard) AS objects FROM shard_directory d GROUP BY d.shard',
  );
  const shards = [];
  for (let i = 0; i < count; i++) {
    const s = stats.find((x) => x.shard === i);
    const bytes = (await one<{ b: string }>(`SELECT pg_total_relation_size('objects_s${i}')::text AS b`))?.b ?? '0';
    shards.push({ shard: i, table: `objects_s${i}`, accounts: s?.accounts ?? 0, objects: s?.objects ?? (await one<{ n: number }>('SELECT count(*)::int AS n FROM objects WHERE shard = $1', [i]))?.n ?? 0, bytes: Number(bytes) });
  }
  const mine = await shardOf(accountId);
  const moves = (await query<{ data: Move }>("SELECT data FROM shard_moves WHERE account_id = $1 ORDER BY created DESC LIMIT 10", [accountId])).map((r) => r.data);
  return { object: 'tessera.shards', shard_count: count, shards, account: { id: accountId, shard: mine?.shard ?? null, directory_version: mine?.version ?? null }, moves };
}

// ---------------------------------------------------------------- moves

async function save(m: Move) {
  await query('UPDATE shard_moves SET status = $2, updated = $3, data = $4 WHERE id = $1', [m.id, m.status, nowSeconds(), JSON.stringify(m)]);
}
const log = (m: Move, step: string, detail: string) => m.steps.push({ step, at: Date.now(), detail });

export async function getMove(accountId: string, id: string) {
  const r = await one<{ data: Move }>('SELECT data FROM shard_moves WHERE id = $1 AND account_id = $2', [id, accountId]);
  if (!r) throw new ApiError(404, 'invalid_request_error', `No such shard move: '${id}'`, { code: 'resource_missing', param: 'id' });
  return r.data;
}

/** Step 1. Returns at once; the remaining steps run in the background (see runMove). */
export async function startMove(ctx: Ctx, target: number) {
  const count = (await one<{ n: number }>('SELECT shard_count AS n FROM shard_config WHERE id = 1'))?.n ?? 1;
  if (!Number.isInteger(target) || target < 0 || target >= count) throw invalid(`target_shard must be between 0 and ${count - 1}.`, 'target_shard');
  const accountId = ctx.accountId;
  const cur = await shardOf(accountId);
  if (!cur) throw invalid('This account has no data yet, so there is nothing to move.', 'account');
  if (cur.shard === target) throw invalid(`This account is already on shard ${target}.`, 'target_shard');
  const busy = await one("SELECT 1 FROM shard_moves WHERE account_id = $1 AND status NOT IN ('complete', 'failed')", [accountId]);
  if (busy) throw new ApiError(409, 'invalid_request_error', 'A move for this account is already in progress.', { code: 'shard_move_in_progress' });
  const m: Move = {
    id: newId('smv', 20), object: 'tessera.shard_move', account: accountId, source_shard: cur.shard, target_shard: target, status: 'registered',
    created: nowSeconds(), steps: [], objects_copied: 0, changes_replayed: 0, switch_ms: null, failure: null,
  };
  log(m, 'register', `Move registered: shard ${cur.shard} → shard ${target}. Indexes already exist on every shard.`);
  await query('INSERT INTO shard_moves (id, account_id, source, target, status, created, updated, data) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)', [m.id, accountId, cur.shard, target, m.status, m.created, JSON.stringify(m)]);
  return m;
}

const pause = () => new Promise((r) => setTimeout(r, 15));

/** Steps 2–6. Each step is its own transaction, so the account keeps serving requests in between. */
export async function runMove(id: string) {
  let m = (await one<{ data: Move }>('SELECT data FROM shard_moves WHERE id = $1', [id]))!.data;
  try {
    // 2. Bulk import. Capture starts first (status copying), so no write can fall between the snapshot and the log.
    await transaction(async () => {
      await query(CAPTURE_ON);
      m.status = 'copying';
      await save(m);
    });
    await pause();
    await transaction(async () => {
      await query('INSERT INTO shard_staging (move_id, id, seq, type, created, data) SELECT $1, id, seq, type, created, data FROM objects WHERE account_id = $2 AND shard = $3', [m.id, m.account, m.source_shard]);
      m.objects_copied = (await one<{ n: number }>('SELECT count(*)::int AS n FROM shard_staging WHERE move_id = $1', [m.id]))!.n;
      m.status = 'replicating';
      log(m, 'bulk_import', `Copied a snapshot of ${m.objects_copied} objects.`);
      await save(m);
    });
    // 3. Replicate: replay captured writes until the copy has caught up.
    for (let round = 0; round < 50; round++) {
      await pause();
      const n = await transaction(() => replay(m));
      if (n === 0) break;
    }
    log(m, 'replicate', `Replayed ${m.changes_replayed} writes made during the copy.`);
    // 4. Verify.
    await transaction(async () => {
      m.status = 'verifying';
      await save(m);
      const v = await verify(m);
      if (!v.ok) throw new Error(`Verification failed: ${v.detail}`);
      log(m, 'verify', v.detail);
      await save(m);
    });
    // 5. Switch: hold the account's requests, apply the last writes, swap shards atomically.
    let release!: () => void;
    gates.set(m.account, new Promise<void>((r) => { release = r; }));
    const t0 = Date.now();
    try {
      await transaction(async () => {
        await replay(m);
        const v = await verify(m);
        if (!v.ok) throw new Error(`Final verification failed: ${v.detail}`);
        m.status = 'switching'; // capture stops: the rows below are the move itself
        await save(m);
        await query('DELETE FROM objects WHERE account_id = $1 AND shard = $2', [m.account, m.source_shard]);
        await query('INSERT INTO objects (seq, id, account_id, type, created, data, shard) SELECT seq, id, $2, type, created, data, $3 FROM shard_staging WHERE move_id = $1', [m.id, m.account, m.target_shard]);
        await query('UPDATE shard_directory SET shard = $2, version = version + 1, updated = $3 WHERE account_id = $1', [m.account, m.target_shard, nowSeconds()]);
        forgetShard(m.account);
        m.switch_ms = Date.now() - t0;
        log(m, 'switch', `Traffic switched to shard ${m.target_shard} in ${m.switch_ms} ms (directory version bumped).`);
        await save(m);
      });
    } finally {
      gates.delete(m.account);
      release();
    }
    // 6. Deregister.
    await transaction(async () => {
      await query('DELETE FROM shard_staging WHERE move_id = $1', [m.id]);
      await query('DELETE FROM shard_oplog WHERE move_id = $1', [m.id]);
      m.status = 'complete';
      log(m, 'deregister', 'Staging copy and change log dropped.');
      await save(m);
      await captureOffIfIdle();
    });
    // Reclaim the space the moved rows left behind on the source shard.
    await query(`VACUUM objects_s${m.source_shard}`).catch(() => {});
  } catch (e) {
    await transaction(async () => {
      m = (await one<{ data: Move }>('SELECT data FROM shard_moves WHERE id = $1', [id]))!.data;
      m.status = 'failed';
      m.failure = (e as Error).message;
      log(m, 'abort', `Move abandoned; the account stays on shard ${m.source_shard}. ${m.failure}`);
      await save(m);
      await query('DELETE FROM shard_staging WHERE move_id = $1', [m.id]);
      await query('DELETE FROM shard_oplog WHERE move_id = $1', [m.id]);
      await captureOffIfIdle();
    });
  }
  return m;
}

async function captureOffIfIdle() {
  const active = await one("SELECT 1 FROM shard_moves WHERE status NOT IN ('complete', 'failed')");
  if (!active) await query('DROP TRIGGER IF EXISTS objects_capture ON objects');
}

/** Applies captured writes to the staging copy, oldest first. */
async function replay(m: Move) {
  const ops = await query<{ seq: string; op: string; object_id: string; obj_seq: string; type: string; created: string; data: any }>(
    'SELECT seq::text, op, object_id, obj_seq::text, type, created::text, data FROM shard_oplog WHERE move_id = $1 ORDER BY seq', [m.id],
  );
  for (const o of ops) {
    if (o.op === 'delete') await query('DELETE FROM shard_staging WHERE move_id = $1 AND id = $2', [m.id, o.object_id]);
    else await query(
      'INSERT INTO shard_staging (move_id, id, seq, type, created, data) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (move_id, id) DO UPDATE SET data = EXCLUDED.data, seq = EXCLUDED.seq, type = EXCLUDED.type',
      [m.id, o.object_id, Number(o.obj_seq), o.type, Number(o.created), JSON.stringify(o.data)],
    );
  }
  if (ops.length) await query('DELETE FROM shard_oplog WHERE move_id = $1 AND seq <= $2', [m.id, ops.at(-1)!.seq]);
  m.changes_replayed += ops.length;
  return ops.length;
}

/** Same ids and byte-identical documents on both sides (an md5 over the ordered rows). */
async function verify(m: Move) {
  const src = await one<{ n: number; h: string }>("SELECT count(*)::int AS n, coalesce(md5(string_agg(id || ':' || data::text, '|' ORDER BY id)), '') AS h FROM objects WHERE account_id = $1 AND shard = $2", [m.account, m.source_shard]);
  const dst = await one<{ n: number; h: string }>("SELECT count(*)::int AS n, coalesce(md5(string_agg(id || ':' || data::text, '|' ORDER BY id)), '') AS h FROM shard_staging WHERE move_id = $1", [m.id]);
  const ok = src!.n === dst!.n && src!.h === dst!.h;
  return { ok, detail: ok ? `${src!.n} objects match (checksum ${src!.h.slice(0, 12)}).` : `source has ${src!.n} objects, copy has ${dst!.n}; checksums ${src!.h.slice(0, 8)} vs ${dst!.h.slice(0, 8)}` };
}
