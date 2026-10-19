import { one, query } from '../../db/index.ts';
import { ApiError, invalid, missing } from '../../lib/errors.ts';
import { newId, nowSeconds } from '../../lib/ids.ts';
import { int, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { emit } from '../events.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { clockTime } from './clocks.ts';

/**
 * Usage-based billing with billing meters.
 *
 * A meter names an event (`event_name`) and how to aggregate it (sum, count or last).
 * The merchant reports usage with meter events — {event_name, payload: {stripe_customer_id,
 * value}, timestamp, identifier}. Metered prices point at a meter; at the end of each billing
 * period the subscription's invoice bills the aggregated usage for that period (in arrears).
 *
 * Identifiers make reporting idempotent (a repeated identifier is rejected), and a meter event
 * adjustment can cancel an event. Timestamps for customers on a test clock default to the
 * clock's time, so usage can be simulated across billing periods.
 */

export async function createMeter(ctx: Ctx, p: Params) {
  const display = str(p, 'display_name', { required: true, max: 250 })!;
  const eventName = str(p, 'event_name', { required: true, max: 100 })!;
  if (!/^[a-zA-Z0-9_.-]+$/.test(eventName)) throw invalid('event_name may contain letters, digits, dots, dashes and underscores.', 'event_name');
  if (await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'billing.meter' AND data->>'event_name' = $2 AND data->>'status' = 'active'", [ctx.accountId, eventName])) {
    throw invalid(`An active meter already uses the event name '${eventName}'.`, 'event_name', 'meter_event_name_taken');
  }
  const formula = oneOf(p.default_aggregation ?? {}, 'formula', ['sum', 'count', 'last'] as const);
  if (!formula) throw missing('default_aggregation[formula]');
  const now = nowSeconds();
  const meter = {
    id: newId('mtr'),
    object: 'billing.meter',
    created: now,
    customer_mapping: { event_payload_key: str(p.customer_mapping ?? {}, 'event_payload_key') ?? 'stripe_customer_id', type: 'by_id' },
    default_aggregation: { formula },
    display_name: display,
    event_name: eventName,
    event_time_window: oneOf(p, 'event_time_window', ['day', 'hour'] as const) ?? null,
    livemode: false,
    status: 'active',
    status_transitions: { deactivated_at: null as number | null },
    updated: now,
    value_settings: { event_payload_key: str(p.value_settings ?? {}, 'event_payload_key') ?? 'value' },
  };
  await insertObject(ctx.accountId, meter);
  return meter;
}

export async function updateMeter(ctx: Ctx, id: string, p: Params) {
  const m = await getObject<any>(ctx.accountId, 'billing.meter', id, 'billing meter');
  if (p.display_name !== undefined) m.display_name = str(p, 'display_name', { required: true });
  m.updated = nowSeconds();
  return saveObject(ctx.accountId, m);
}

export async function setMeterStatus(ctx: Ctx, id: string, active: boolean) {
  const m = await getObject<any>(ctx.accountId, 'billing.meter', id, 'billing meter');
  if ((m.status === 'active') === active) throw invalid(`This meter is already ${m.status}.`, 'id');
  m.status = active ? 'active' : 'inactive';
  m.status_transitions.deactivated_at = active ? null : nowSeconds();
  m.updated = nowSeconds();
  return saveObject(ctx.accountId, m);
}

export async function recordMeterEvent(ctx: Ctx, p: Params) {
  const eventName = str(p, 'event_name', { required: true })!;
  const meterRow = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'billing.meter' AND data->>'event_name' = $2 AND data->>'status' = 'active'", [ctx.accountId, eventName]);
  if (!meterRow) throw invalid(`No active meter found for event_name '${eventName}'.`, 'event_name', 'meter_not_found');
  const meter = meterRow.data;
  const payload = p.payload;
  if (!payload || typeof payload !== 'object') throw missing('payload');
  const custKey = meter.customer_mapping.event_payload_key;
  const customerId = payload[custKey];
  if (!customerId) throw missing(`payload[${custKey}]`);
  const customer = await findObject<any>(ctx.accountId, 'customer', String(customerId));
  if (!customer || customer.deleted) throw invalid(`No such customer: '${customerId}'`, `payload[${custKey}]`, 'resource_missing');
  const valueKey = meter.value_settings.event_payload_key;
  let value = 1;
  if (meter.default_aggregation.formula !== 'count') {
    if (payload[valueKey] === undefined) throw missing(`payload[${valueKey}]`);
    value = Number(payload[valueKey]);
    if (!Number.isFinite(value)) throw invalid(`payload[${valueKey}] must be a number.`, `payload[${valueKey}]`);
  }
  const identifier = str(p, 'identifier', { max: 100 }) ?? newId('mev', 20);
  if (await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'billing.meter_event' AND data->>'identifier' = $2", [ctx.accountId, identifier])) {
    throw new ApiError(400, 'invalid_request_error', `An event already exists with identifier ${identifier}.`, { code: 'duplicate_meter_event', param: 'identifier' });
  }
  const now = await clockTime(ctx.accountId, customer.test_clock);
  const timestamp = int(p, 'timestamp') ?? now;
  if (timestamp < now - 35 * 86400 || timestamp > now + 300) throw invalid('timestamp must be within the past 35 days and no more than 5 minutes in the future.', 'timestamp');
  const ev = {
    id: newId('mtre', 20),
    object: 'billing.meter_event',
    created: nowSeconds(),
    event_name: eventName,
    identifier,
    livemode: false,
    payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    timestamp,
    _meter: meter.id,
    _customer: customer.id,
    _value: value,
    _canceled: false,
  };
  await insertObject(ctx.accountId, ev);
  // Usage can cross a billing threshold, which invoices immediately.
  await (await import('./subscriptions.ts')).checkThresholds(ctx, customer.id);
  return ev;
}

/** Cancels a previously reported event (by identifier), as a meter event adjustment. */
export async function adjustMeterEvent(ctx: Ctx, p: Params) {
  const eventName = str(p, 'event_name', { required: true })!;
  if ((p.type ?? 'cancel') !== 'cancel') throw invalid("Only type='cancel' adjustments are supported.", 'type');
  const identifier = p.cancel?.identifier;
  if (!identifier) throw missing('cancel[identifier]');
  const row = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'billing.meter_event' AND data->>'identifier' = $2 AND data->>'event_name' = $3", [ctx.accountId, String(identifier), eventName]);
  if (!row) throw invalid(`No meter event with identifier '${identifier}'.`, 'cancel[identifier]', 'resource_missing');
  row.data._canceled = true;
  await saveObject(ctx.accountId, row.data);
  return { id: newId('mtradj', 20), object: 'billing.meter_event_adjustment', cancel: { identifier }, event_name: eventName, livemode: false, status: 'complete', type: 'cancel' };
}

/** Aggregated usage of `meterId` for a customer in [start, end). */
export async function usageFor(accountId: string, meterId: string, customerId: string, start: number, end: number) {
  const meter = await findObject<any>(accountId, 'billing.meter', meterId);
  if (!meter) return 0;
  const rows = await query<{ data: any }>(
    "SELECT data FROM objects WHERE account_id = $1 AND type = 'billing.meter_event' AND data->>'_meter' = $2 AND data->>'_customer' = $3 AND (data->>'timestamp')::bigint >= $4 AND (data->>'timestamp')::bigint < $5 AND coalesce(data->>'_canceled', 'false') <> 'true' AND coalesce(data->>'_billed', 'false') <> 'true' ORDER BY (data->>'timestamp')::bigint, seq",
    [accountId, meterId, customerId, start, end],
  );
  const values = rows.map((r) => Number(r.data._value));
  if (meter.default_aggregation.formula === 'count') return values.length;
  if (meter.default_aggregation.formula === 'last') return values.length ? values[values.length - 1]! : 0;
  return values.reduce((s, v) => s + v, 0);
}

export async function eventSummaries(ctx: Ctx, meterId: string, p: Params) {
  await getObject(ctx.accountId, 'billing.meter', meterId, 'billing meter');
  const customer = str(p, 'customer', { required: true })!;
  const start = int(p, 'start_time', { required: true })!;
  const end = int(p, 'end_time', { required: true })!;
  if (end <= start) throw invalid('end_time must be after start_time.', 'end_time');
  const window = oneOf(p, 'value_grouping_window', ['hour', 'day'] as const);
  const step = window === 'hour' ? 3600 : window === 'day' ? 86400 : end - start;
  const data = [];
  for (let t = start; t < end; t += step) {
    const e = Math.min(end, t + step);
    data.push({ id: newId('mtrusg', 20), object: 'billing.meter_event_summary', aggregated_value: await usageFor(ctx.accountId, meterId, customer, t, e), end_time: e, livemode: false, meter: meterId, start_time: t });
  }
  data.reverse();
  return { object: 'list', data: data.slice(0, Number(p.limit ?? 100)), has_more: data.length > Number(p.limit ?? 100), url: `/v1/billing/meters/${meterId}/event_summaries` };
}

/** Invoice lines for the metered items of a subscription over [start, end), billed in arrears. */
export async function meteredLines(ctx: Ctx, sub: any, start: number, end: number) {
  const { priceAmount } = await import('./catalog.ts');
  const lines = [];
  for (const it of sub.items.data) {
    if (it.price.recurring?.usage_type !== 'metered') continue;
    const usage = await usageFor(ctx.accountId, it.price.recurring.meter, sub.customer, start, end);
    const product = await findObject<any>(ctx.accountId, 'product', it.price.product);
    lines.push({
      price: it.price, quantity: usage, subscription_item: it.id, period: { start, end }, tax_rates: it.tax_rates ?? [],
      amount: priceAmount(it.price, usage),
      description: `${product?.name ?? 'Usage'}: ${usage.toLocaleString('en-US')} ${usage === 1 ? 'unit' : 'units'} used (${new Date(start * 1000).toISOString().slice(0, 10)} to ${new Date(end * 1000).toISOString().slice(0, 10)})`,
    });
  }
  return lines;
}

export const hasMetered = (sub: any) => sub.items.data.some((it: any) => it.price.recurring?.usage_type === 'metered');
void emit;

/** Threshold invoices bill usage early; the events they billed are excluded from later invoices. */
export async function markBilled(accountId: string, sub: any, start: number, end: number) {
  for (const it of sub.items.data) {
    if (it.price.recurring?.usage_type !== 'metered') continue;
    await query("UPDATE objects SET data = jsonb_set(data::jsonb, '{_billed}', 'true')::json WHERE account_id = $1 AND type = 'billing.meter_event' AND data->>'_meter' = $2 AND data->>'_customer' = $3 AND (data->>'timestamp')::bigint >= $4 AND (data->>'timestamp')::bigint < $5", [accountId, it.price.recurring.meter, sub.customer, start, end]);
  }
}
