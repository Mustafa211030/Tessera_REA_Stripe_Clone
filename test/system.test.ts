import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig, config } from '../src/config.ts';
import { query } from '../src/db/index.ts';
import { acquire, resetLimits, simulateLag } from '../src/platform/ratelimit.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const until = async (fn: () => Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
};

describe('shards and data movement', () => {
  it('places accounts on shards and moves one with writes in flight, losing nothing', async () => {
    for (let i = 0; i < 20; i++) await api(env, 'POST', '/v1/customers', { email: `c${i}@example.com` });
    const before = await api(env, 'GET', '/v1/tessera/shards');
    assert.equal(before.body.shard_count, config.shardCount);
    assert.equal(before.body.shards.length, config.shardCount);
    const from = before.body.account.shard;
    assert.equal(before.body.account.directory_version, 1);
    const target = (from + 1) % config.shardCount;
    const same = await api(env, 'POST', '/v1/tessera/shard_moves', { target_shard: from });
    assert.equal(same.status, 400);
    const move = await api(env, 'POST', '/v1/tessera/shard_moves', { target_shard: target });
    assert.equal(move.status, 200, JSON.stringify(move.body));
    assert.equal(move.body.status, 'registered');
    const busy = await api(env, 'POST', '/v1/tessera/shard_moves', { target_shard: target });
    assert.equal(busy.status, 409);
    // Keep writing and reading while the move runs.
    const written: string[] = [];
    let done = false;
    const writer = (async () => {
      while (!done) {
        const c = await api(env, 'POST', '/v1/customers', { email: `during${written.length}@example.com` });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        written.push(c.body.id);
        if (written.length % 3 === 0) await api(env, 'POST', `/v1/customers/${written.at(-1)}`, { name: 'Updated during move' });
      }
    })();
    await until(async () => ['complete', 'failed'].includes((await api(env, 'GET', `/v1/tessera/shard_moves/${move.body.id}`)).body.status));
    done = true;
    await writer;
    const m = (await api(env, 'GET', `/v1/tessera/shard_moves/${move.body.id}`)).body;
    assert.equal(m.status, 'complete', JSON.stringify(m));
    assert.deepEqual(m.steps.map((s: any) => s.step), ['register', 'bulk_import', 'replicate', 'verify', 'switch', 'deregister']);
    assert.ok(m.switch_ms < 2000);
    const after = (await api(env, 'GET', '/v1/tessera/shards')).body;
    assert.equal(after.account.shard, target);
    assert.equal(after.account.directory_version, 2);
    // Every object lives on the target shard only, and everything written during the move survived.
    const rows = await query<{ shard: number; n: number }>('SELECT shard, count(*)::int AS n FROM objects WHERE account_id = (SELECT account_id FROM objects WHERE id = $1) GROUP BY shard', [written[0]]);
    assert.deepEqual(rows.map((r) => r.shard), [target]);
    for (const id of written) assert.equal((await api(env, 'GET', `/v1/customers/${id}`)).status, 200);
    const updated = await api(env, 'GET', `/v1/customers/${written.at(2)}`);
    assert.equal(updated.body.name, 'Updated during move');
    const list = await api(env, 'GET', '/v1/customers', { limit: 100 });
    assert.equal(list.body.data.length, Math.min(100, 20 + written.length));
    const total = await query<{ n: number }>("SELECT count(*)::int AS n FROM objects WHERE type = 'customer' AND account_id = (SELECT account_id FROM objects WHERE id = $1)", [written[0]]);
    assert.ok(total[0]!.n >= 20 + written.length);
    assert.equal((await query('SELECT count(*)::int AS n FROM shard_staging'))[0].n, 0);
  });
});

describe('load shedding', () => {
  it('fleet shedder keeps the last 20% of capacity for critical requests', () => {
    resetLimits();
    const cap = config.fleetCapacity;
    setConfig({ fleetCapacity: 10, concurrencyLimit: 100 });
    simulateLag(0);
    try {
      const held = Array.from({ length: 8 }, (_, i) => acquire(`k${i}`, `a${i}`, 'get'));
      assert.throws(() => acquire('k9', 'a9', 'post'), /shedding non-critical/);
      const crit = acquire('k10', 'a10', 'critical');
      crit();
      held.forEach((r) => r());
      acquire('k11', 'a11', 'get')();
    } finally { setConfig({ fleetCapacity: cap }); resetLimits(); }
  });

  it('worker shedder drops low-priority traffic first when the server falls behind', async () => {
    const lag = (ms: number | '') => api(env, 'POST', '/v1/tessera/system/simulate_load', { event_loop_delay_ms: ms });
    const s = await lag(config.shedLagMs * 2);
    assert.equal(s.body.served_up_to, 'post');
    const get = await api(env, 'GET', '/v1/customers');
    assert.equal(get.status, 429);
    assert.equal(get.headers.get('stripe-rate-limited-reason'), 'worker-utilization');
    const post = await api(env, 'POST', '/v1/customers', { email: 'still@example.com' });
    assert.equal(post.status, 200);
    await lag(config.shedLagMs * 4);
    assert.equal((await api(env, 'POST', '/v1/customers', { email: 'shed@example.com' })).status, 429);
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' });
    assert.equal(pi.body.status, 'succeeded', 'critical payment calls are never shed');
    const cleared = await lag('');
    assert.equal(cleared.body.served_up_to, 'low');
    assert.ok(cleared.body.counters.worker_shed >= 2);
    assert.equal((await api(env, 'GET', '/v1/customers')).status, 200);
  });
});

describe('ledger reconciliation and metrics', () => {
  it('passes for real activity and catches a corrupted ledger', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' });
    await api(env, 'POST', '/v1/refunds', { payment_intent: pi.body.id, amount: 1000 });
    await runWorkersOnce();
    await api(env, 'POST', '/v1/payouts', { amount: 1000, currency: 'usd' });
    const ok = await api(env, 'POST', '/v1/tessera/reconciliation_runs');
    assert.equal(ok.body.status, 'passed', JSON.stringify(ok.body.checks));
    assert.deepEqual(ok.body.checks.map((c: any) => c.name), ['balanced', 'clearing', 'completeness', 'balances', 'timeliness']);
    const acct = (await query<{ account_id: string }>("SELECT account_id FROM objects WHERE id = $1", [pi.body.id]))[0]!.account_id;
    await query("INSERT INTO ledger_entries (account_id, group_id, ledger_account, amount, currency, source, description, created) VALUES ($1, 'lg_broken', 'merchant_available', 123, 'usd', 'manual', 'bad write', 0)", [acct]);
    const bad = await api(env, 'POST', '/v1/tessera/reconciliation_runs');
    assert.equal(bad.body.status, 'discrepancies_found');
    const balanced = bad.body.checks.find((c: any) => c.name === 'balanced');
    assert.deepEqual(balanced.examples, ['lg_broken']);
    assert.ok(bad.body.checks.find((c: any) => c.name === 'balances').failures >= 1);
    await query("DELETE FROM ledger_entries WHERE group_id = 'lg_broken'");
    const runs = await api(env, 'GET', '/v1/tessera/reconciliation_runs');
    assert.equal(runs.body.data.length, 2);
    const sys = await api(env, 'GET', '/v1/tessera/system');
    assert.ok(sys.body.traffic.requests_total > 10);
    assert.equal(sys.body.traffic.series.length, 60);
    assert.ok(sys.body.load_shedding.counters.allowed > 0);
  });
});
