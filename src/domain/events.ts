import { one, query } from '../db/index.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Ctx } from '../platform/context.ts';
import { cached, insertObject, type ApiObject } from './store.ts';

/**
 * Events are immutable snapshots written in the same transaction as the change that
 * caused them (transactional outbox). The webhook worker delivers them afterwards.
 */
export async function emit(ctx: Ctx, type: string, object: ApiObject, previous?: Record<string, unknown>) {
  const platform = ctx.platformAccountId ?? (await one<{ platform: string | null }>('SELECT platform FROM accounts WHERE id = $1', [ctx.accountId]))?.platform ?? null;
  const evt: any = {
    id: newId('evt'),
    object: 'event',
    ...(platform ? { account: ctx.accountId } : {}),
    api_version: ctx.apiVersion,
    created: nowSeconds(),
    data: { object: structuredClone(object), ...(previous ? { previous_attributes: previous } : {}) },
    livemode: false,
    pending_webhooks: 0,
    request: { id: ctx.requestId ?? null, idempotency_key: ctx.idempotencyKey ?? null },
    type,
  };
  // Account endpoints get the account's own events; a platform's Connect endpoints
  // (connect=true) get events from all of its connected accounts.
  // Hot path (several events per payment): endpoints are cached briefly and dropped on any change.
  const endpoints = await cached(`webhooks:${ctx.accountId}:${platform ?? '-'}`, 5000, () => query<{ account_id: string; data: any }>(
    "SELECT account_id, data FROM objects WHERE type = 'webhook_endpoint' AND data->>'status' = 'enabled' AND ((account_id = $1 AND coalesce(data->>'connect', 'false') <> 'true') OR (account_id = $2 AND data->>'connect' = 'true'))",
    [ctx.accountId, platform ?? '-'],
  ));
  const now = nowSeconds();
  for (const { account_id, data: ep } of endpoints) {
    const events: string[] = ep.enabled_events ?? [];
    if (!events.includes('*') && !events.includes(type)) continue;
    // issuing_authorization.request is delivered synchronously by the issuing engine, never queued.
    if (type === 'issuing_authorization.request') continue;
    evt.pending_webhooks++;
    await query(
      'INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event_id, status, attempts, next_attempt_at, created, updated) VALUES ($1,$2,$3,$4,$5,0,$6,$6,$6)',
      [newId('whd', 16), account_id, ep.id, evt.id, 'pending', now],
    );
  }
  await insertObject(ctx.accountId, evt as any);
  // Simulated customer emails (receipts, invoices, dunning) follow from events.
  await (await import('./emails.ts')).afterEvent(ctx, type, object);
  // Subscription changes can change what a customer is entitled to.
  await (await import('./entitlements.ts')).afterEvent(ctx, type, object);
  return evt;
}

/** Shallow diff for `previous_attributes`. */
export function diff(before: Record<string, any>, after: Record<string, any>) {
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) prev[k] = before[k] ?? null;
  }
  return prev;
}
