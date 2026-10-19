import type { FastifyInstance } from 'fastify';
import { detached, queryProfile } from '../db/index.ts';
import * as recon from '../domain/reconciliation.ts';
import * as shards from '../domain/shards.ts';
import { invalid } from '../lib/errors.ts';
import { snapshot } from '../platform/metrics.ts';
import { apiRoute } from '../platform/http.ts';
import { limiterState, simulateLag } from '../platform/ratelimit.ts';

/** System health: traffic, load shedding, shards and data movement, ledger reconciliation. */
export function registerSystem(app: FastifyInstance) {
  apiRoute(app, 'GET', '/v1/tessera/system', { resource: 'system' }, async (ctx, p) => ({
    object: 'tessera.system', traffic: snapshot(Math.min(120, Math.max(10, Number(p.window ?? 60)))), load_shedding: limiterState(), storage: await shards.overview(ctx.accountId),
    // Slowest SQL statements by total time, when the server runs with TESSERA_PROFILE=1.
    query_profile: queryProfile(15),
  }));
  apiRoute(app, 'GET', '/v1/tessera/shards', { resource: 'system' }, (ctx) => shards.overview(ctx.accountId));
  apiRoute(app, 'POST', '/v1/tessera/shard_moves', { resource: 'system' }, async (ctx, p) => {
    if (p.target_shard === undefined) throw invalid('Missing required param: target_shard.', 'target_shard', 'parameter_missing');
    const m = await shards.startMove(ctx, Number(p.target_shard));
    // Steps 2–6 run in the background, outside this request's transaction.
    detached(() => setTimeout(() => { shards.runMove(m.id).catch((e) => console.error('[shard move]', e)); }, 20));
    return m;
  });
  apiRoute(app, 'GET', '/v1/tessera/shard_moves/:id', { resource: 'system' }, (ctx, p) => shards.getMove(ctx.accountId, p.id));
  apiRoute(app, 'POST', '/v1/tessera/reconciliation_runs', { resource: 'system' }, (ctx) => recon.runReconciliation(ctx));
  apiRoute(app, 'GET', '/v1/tessera/reconciliation_runs', { resource: 'system' }, (ctx, p) => recon.listRuns(ctx, p));
  /** Demo and tests: pretend the worker is overloaded (event-loop delay in ms), or clear it with an empty value. */
  apiRoute(app, 'POST', '/v1/tessera/system/simulate_load', { resource: 'system', critical: true }, async (_ctx, p) => {
    const v = p.event_loop_delay_ms === undefined || p.event_loop_delay_ms === '' ? null : Number(p.event_loop_delay_ms);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 60000)) throw invalid('event_loop_delay_ms must be between 0 and 60000.', 'event_loop_delay_ms');
    simulateLag(v);
    return limiterState();
  });
}
