import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { invalid } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { arr, metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { SUPPORTED_VERSIONS, transformForVersion, validateVersion } from '../platform/versioning.ts';
import { stripInternal } from './paymentIntents.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/** Endpoints may pin an API version; events sent to them are rendered in that version. */
function endpointVersion(v: unknown) {
  if (v === undefined || v === null || v === '') return null;
  try {
    const base = validateVersion(String(v));
    if (base < '2011-01-01') throw new Error('too old');
    return base;
  } catch {
    throw invalid(`Invalid api_version: '${v}'. Use a version date such as ${SUPPORTED_VERSIONS.slice(-2).join(' or ')}.`, 'api_version', 'api_version_invalid');
  }
}

export async function createEndpoint(ctx: Ctx, p: Params) {
  const url = str(p, 'url', { required: true })!;
  if (!/^https?:\/\//.test(url)) throw invalid('Invalid URL: must start with http:// or https://', 'url', 'url_invalid');
  const events = arr(p, 'enabled_events');
  if (!events?.length) throw invalid('Missing required param: enabled_events.', 'enabled_events', 'parameter_missing');
  const ep = {
    id: newId('we'),
    object: 'webhook_endpoint',
    api_version: endpointVersion(p.api_version),
    application: null,
    connect: p.connect === 'true' || p.connect === true,
    created: nowSeconds(),
    description: str(p, 'description') ?? null,
    enabled_events: events.map(String),
    livemode: false,
    metadata: metadata(p),
    secret: `whsec_${base62(32)}`,
    status: 'enabled',
    url,
  };
  await insertObject(ctx.accountId, ep);
  return ep;
}

export async function updateEndpoint(ctx: Ctx, id: string, p: Params) {
  const ep = await getObject<any>(ctx.accountId, 'webhook_endpoint', id, 'webhook_endpoint');
  if (p.url !== undefined) ep.url = str(p, 'url');
  const events = arr(p, 'enabled_events');
  if (events) ep.enabled_events = events.map(String);
  if (p.disabled !== undefined) ep.status = p.disabled === 'true' || p.disabled === true ? 'disabled' : 'enabled';
  if (p.description !== undefined) ep.description = p.description || null;
  ep.metadata = metadata(p, ep.metadata);
  return saveObject(ctx.accountId, ep);
}

/** Endpoint objects only reveal `secret` on creation, as on the public API. */
export const hideSecret = (ep: any) => {
  const { secret, ...rest } = ep;
  return rest;
};

export async function rollSecret(ctx: Ctx, id: string) {
  const ep = await getObject<any>(ctx.accountId, 'webhook_endpoint', id, 'webhook_endpoint');
  ep._previous_secret = ep.secret;
  ep._previous_secret_expires = nowSeconds() + 86400;
  ep.secret = `whsec_${base62(32)}`;
  await saveObject(ctx.accountId, ep);
  return ep;
}

/** `Stripe-Signature`-compatible header: t=<unix>,v1=<hex hmac-sha256 of "t.payload">. */
export function sign(payload: string, secret: string, t = nowSeconds()) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

export function verify(payload: string, header: string, secret: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(nowSeconds() - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return header
    .split(',')
    .filter((kv) => kv.startsWith('v1='))
    .some((kv) => {
      const sig = kv.slice(3);
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    });
}

/** Delivery worker: sends due deliveries, records each attempt, schedules retries with backoff. */
export async function deliverDue(): Promise<number> {
  const due = await query<any>(
    "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 20",
    [nowSeconds()],
  );
  for (const d of due) await deliverOne(d);
  return due.length;
}

export async function deliverOne(d: any) {
  const ep = (await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'webhook_endpoint'", [d.endpoint_id]))?.data;
  const evt = (await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'event'", [d.event_id]))?.data;
  const now = nowSeconds();
  if (!ep || !evt || ep.status !== 'enabled') {
    await query("UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated = $3 WHERE id = $1", [d.id, 'endpoint disabled or deleted', now]);
    return;
  }
  const version = ep.api_version ?? evt.api_version;
  const body = { ...evt, api_version: version, data: { ...evt.data, object: await transformForVersion(stripInternal(evt.data.object), version) } };
  const payload = JSON.stringify(body, null, 2);
  let header = sign(payload, ep.secret, now);
  if (ep._previous_secret && ep._previous_secret_expires > now) header += ',' + sign(payload, ep._previous_secret, now).split(',')[1];
  const started = Date.now();
  let code: number | null = null;
  let error: string | null = null;
  let respBody: string | null = null;
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': header, 'user-agent': 'Tessera/1.0 (+webhooks)' },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
    });
    code = res.status;
    respBody = (await res.text()).slice(0, 2000);
  } catch (e: any) {
    error = e?.name === 'TimeoutError' ? 'Timed out' : String(e?.cause?.code ?? e?.message ?? e);
  }
  const ms = Date.now() - started;
  await query('INSERT INTO webhook_attempts (delivery_id, attempted_at, response_code, duration_ms, error, response_body) VALUES ($1,$2,$3,$4,$5,$6)', [d.id, now, code, ms, error, respBody]);
  const attempts = d.attempts + 1;
  const ok = code !== null && code >= 200 && code < 300;
  if (ok) {
    await query("UPDATE webhook_deliveries SET status = 'succeeded', attempts = $2, last_response_code = $3, last_error = NULL, updated = $4 WHERE id = $1", [d.id, attempts, code, now]);
  } else {
    const delay = config.webhookRetrySchedule[attempts - 1];
    const status = delay === undefined ? 'failed' : 'pending';
    await query('UPDATE webhook_deliveries SET status = $2, attempts = $3, last_response_code = $4, last_error = $5, next_attempt_at = $6, updated = $7 WHERE id = $1', [
      d.id, status, attempts, code, error ?? (code && code >= 300 && code < 400 ? 'Redirects are treated as failures' : `HTTP ${code}`), delay === undefined ? null : now + delay, now,
    ]);
  }
  if (ok || config.webhookRetrySchedule[attempts - 1] === undefined) {
    // decrement pending_webhooks on the event
    evt.pending_webhooks = Math.max(0, (evt.pending_webhooks ?? 1) - 1);
    await query('UPDATE objects SET data = $1 WHERE id = $2', [JSON.stringify(evt), evt.id]);
  }
}

export async function deliveriesFor(accountId: string, endpointId: string) {
  return query(
    `SELECT d.id, d.event_id, d.status, d.attempts, d.next_attempt_at, d.last_response_code, d.last_error, d.created, o.data->>'type' AS event_type
       FROM webhook_deliveries d LEFT JOIN objects o ON o.id = d.event_id
      WHERE d.account_id = $1 AND d.endpoint_id = $2 ORDER BY d.created DESC LIMIT 100`,
    [accountId, endpointId],
  );
}

export async function attemptsFor(deliveryId: string) {
  return query('SELECT attempted_at, response_code, duration_ms, error, response_body FROM webhook_attempts WHERE delivery_id = $1 ORDER BY seq', [deliveryId]);
}

export async function resend(ctx: Ctx, eventId: string, endpointId: string) {
  const owned = await one("SELECT 1 FROM objects o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.id = $1 AND o.type = 'event' AND (o.account_id = $2 OR a.platform = $2)", [eventId, ctx.accountId]);
  if (!owned) await getObject(ctx.accountId, 'event', eventId, 'event');
  await getObject(ctx.accountId, 'webhook_endpoint', endpointId, 'webhook_endpoint');
  const id = newId('whd', 16);
  const now = nowSeconds();
  await query('INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event_id, status, attempts, next_attempt_at, created, updated) VALUES ($1,$2,$3,$4,$5,0,$6,$6,$6)', [id, ctx.accountId, endpointId, eventId, 'pending', now]);
  return { id, status: 'pending' };
}
