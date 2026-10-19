import { invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { arr, bool, currency, int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { diff, emit } from './events.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/**
 * Shipping rates: a named, fixed shipping charge with an optional delivery estimate,
 * offered at Checkout (`shipping_options`). Shipping is taxed like physical goods when
 * automatic tax is on (tax code txcd_92010001) and is never discounted.
 */

const UNITS = ['business_day', 'day', 'hour', 'week', 'month'] as const;
export const SHIPPING_TAX_CODE = 'txcd_92010001';

function estimate(e: any, param: string) {
  if (!e) return null;
  const bound = (b: any, k: string) => (b ? { unit: oneOf(b, 'unit', UNITS) ?? (() => { throw missing(`${param}[${k}][unit]`); })(), value: int(b, 'value', { required: true, min: 1 })! } : null);
  const out = { maximum: bound(e.maximum, 'maximum'), minimum: bound(e.minimum, 'minimum') };
  if (out.minimum && out.maximum && out.minimum.unit === out.maximum.unit && out.minimum.value > out.maximum.value) throw invalid('The minimum delivery estimate must not be after the maximum.', param);
  return out;
}

export function buildShippingRate(p: Params, param = '') {
  const type = oneOf(p, 'type', ['fixed_amount'] as const, 'fixed_amount');
  if (!p.fixed_amount) throw missing(`${param}fixed_amount`);
  return {
    id: newId('shr'),
    object: 'shipping_rate',
    active: true,
    created: nowSeconds(),
    delivery_estimate: estimate(p.delivery_estimate, `${param}delivery_estimate`),
    display_name: str(p, 'display_name', { required: true, max: 100 })!,
    fixed_amount: { amount: int(p.fixed_amount, 'amount', { required: true, min: 0 })!, currency: currency(p.fixed_amount)! },
    livemode: false,
    metadata: metadata(p),
    tax_behavior: oneOf(p, 'tax_behavior', ['inclusive', 'exclusive', 'unspecified'] as const, 'unspecified'),
    tax_code: str(p, 'tax_code') ?? SHIPPING_TAX_CODE,
    type,
  };
}

export async function createShippingRate(ctx: Ctx, p: Params) {
  const rate = buildShippingRate(p);
  await insertObject(ctx.accountId, rate);
  await emit(ctx, 'shipping_rate.created', rate);
  return rate;
}

export async function updateShippingRate(ctx: Ctx, id: string, p: Params) {
  const r = await getObject<any>(ctx.accountId, 'shipping_rate', id, 'shipping rate');
  const before = structuredClone(r);
  if (p.active !== undefined) r.active = bool(p, 'active');
  if (p.tax_behavior !== undefined) {
    if (r.tax_behavior !== 'unspecified') throw invalid("tax_behavior can only be set once (from 'unspecified').", 'tax_behavior');
    r.tax_behavior = oneOf(p, 'tax_behavior', ['inclusive', 'exclusive', 'unspecified'] as const);
  }
  r.metadata = metadata(p, r.metadata);
  await saveObject(ctx.accountId, r);
  await emit(ctx, 'shipping_rate.updated', r, diff(before, r));
  return r;
}

/** Resolves Checkout's `shipping_options[]` (an existing rate or inline `shipping_rate_data`). */
export async function resolveShippingOptions(ctx: Ctx, p: Params, cur: string) {
  const opts = arr(p, 'shipping_options') ?? [];
  if (opts.length > 5) throw invalid('You can offer at most 5 shipping options.', 'shipping_options');
  const out = [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    let rate: any;
    if (o.shipping_rate) {
      rate = await getObject<any>(ctx.accountId, 'shipping_rate', String(o.shipping_rate), 'shipping rate', `shipping_options[${i}][shipping_rate]`);
      if (!rate.active) throw invalid(`The shipping rate ${rate.id} is inactive.`, `shipping_options[${i}][shipping_rate]`);
    } else if (o.shipping_rate_data) {
      rate = buildShippingRate(o.shipping_rate_data, `shipping_options[${i}][shipping_rate_data]`);
      await insertObject(ctx.accountId, rate);
    } else throw missing(`shipping_options[${i}][shipping_rate]`);
    if (rate.fixed_amount.currency !== cur) throw invalid(`Shipping rate ${rate.id} is in ${rate.fixed_amount.currency.toUpperCase()} but the session is in ${cur.toUpperCase()}.`, `shipping_options[${i}]`);
    out.push({ shipping_amount: rate.fixed_amount.amount, shipping_rate: rate.id });
  }
  return out;
}

/** "3–5 business days" style label for a delivery estimate. */
export function estimateLabel(e: any) {
  if (!e || (!e.minimum && !e.maximum)) return null;
  const unit = (b: any) => `${b.unit.replace('_', ' ')}${b.value === 1 ? '' : 's'}`;
  if (e.minimum && e.maximum) return e.minimum.unit === e.maximum.unit ? `${e.minimum.value}–${e.maximum.value} ${unit(e.maximum)}` : `${e.minimum.value} ${unit(e.minimum)} – ${e.maximum.value} ${unit(e.maximum)}`;
  const b = e.minimum ?? e.maximum;
  return `${e.minimum ? 'At least' : 'Up to'} ${b.value} ${unit(b)}`;
}
