import { invalid, missing } from '../../lib/errors.ts';
import { base62, newId, nowSeconds } from '../../lib/ids.ts';
import { arr, bool, currency, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { diff, emit } from '../events.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';

// ---------------- products ----------------
export async function createProduct(ctx: Ctx, p: Params) {
  const name = str(p, 'name', { required: true, max: 250 })!;
  const id = str(p, 'id') ?? newId('prod', 14);
  if (await findObject(ctx.accountId, 'product', id)) throw invalid(`Product already exists with ID ${id}`, 'id', 'resource_already_exists');
  const now = nowSeconds();
  const product: any = {
    id,
    object: 'product',
    active: bool(p, 'active') ?? true,
    created: now,
    default_price: null,
    description: str(p, 'description') ?? null,
    images: [],
    livemode: false,
    marketing_features: [],
    metadata: metadata(p),
    name,
    package_dimensions: null,
    shippable: null,
    statement_descriptor: str(p, 'statement_descriptor', { max: 22 }) ?? null,
    tax_code: str(p, 'tax_code') ?? null,
    type: 'service',
    unit_label: str(p, 'unit_label') ?? null,
    updated: now,
    url: str(p, 'url') ?? null,
  };
  await insertObject(ctx.accountId, product);
  await emit(ctx, 'product.created', product);
  if (p.default_price_data) {
    const price = await createPrice(ctx, { ...p.default_price_data, product: product.id });
    product.default_price = price.id;
    await saveObject(ctx.accountId, product);
  }
  return product;
}

export async function updateProduct(ctx: Ctx, id: string, p: Params) {
  const prod = await getObject<any>(ctx.accountId, 'product', id, 'product');
  const before = structuredClone(prod);
  if (p.name !== undefined) prod.name = str(p, 'name', { required: true });
  if (p.description !== undefined) prod.description = p.description || null;
  if (p.active !== undefined) prod.active = bool(p, 'active');
  if (p.tax_code !== undefined) prod.tax_code = p.tax_code || null;
  if (p.default_price !== undefined) {
    const price = await getObject<any>(ctx.accountId, 'price', String(p.default_price), 'price', 'default_price');
    if (price.product !== id) throw invalid('The default price must belong to this product.', 'default_price');
    prod.default_price = price.id;
  }
  prod.metadata = metadata(p, prod.metadata);
  prod.updated = nowSeconds();
  await saveObject(ctx.accountId, prod);
  await emit(ctx, 'product.updated', prod, diff(before, prod));
  return prod;
}

// ---------------- prices ----------------

/**
 * Pricing models:
 *   per_unit      unit_amount × quantity
 *   package       transform_quantity: quantity is divided (e.g. per 1,000) and rounded up or down
 *   tiered        graduated (each tier prices the units that fall in it) or volume (the tier
 *                 the total falls in prices every unit); each tier may add a flat_amount
 * Metered prices (recurring.usage_type=metered) are billed in arrears from a billing meter.
 */
/** An amount given as `<key>` (integer, minor units) or `<key>_decimal` (up to 12 decimal places, e.g. 0.25 of a cent). */
function amountWithDecimal(p: Params, key: string): { amount: number | null; decimal: string | null } | undefined {
  const dec = p[`${key}_decimal`];
  if (dec !== undefined && dec !== '') {
    if (p[key] !== undefined && p[key] !== '') throw invalid(`Pass only one of ${key} and ${key}_decimal.`, `${key}_decimal`);
    if (!/^\d+(\.\d{1,12})?$/.test(String(dec))) throw invalid(`${key}_decimal must be a non-negative decimal with at most 12 decimal places.`, `${key}_decimal`);
    const n = Number(dec);
    return { amount: Number.isInteger(n) ? n : null, decimal: String(n) };
  }
  const v = int(p, key, { min: 0 });
  return v === undefined ? undefined : { amount: v, decimal: String(v) };
}

/** Unit amount as a number, using the decimal form when the price has a fractional amount. */
export const unitOf = (x: any): number => Number(x?.unit_amount_decimal ?? x?.unit_amount ?? 0);

function parseTiers(p: Params) {
  const raw = arr(p, 'tiers');
  if (!raw?.length) throw missing('tiers');
  const tiers = raw.map((t: any, i: number) => {
    const upTo = t.up_to === 'inf' ? null : int(t, 'up_to', { min: 1 });
    if (upTo === undefined) throw invalid(`tiers[${i}][up_to] must be a number or 'inf'.`, `tiers[${i}][up_to]`);
    const unit = amountWithDecimal(t, 'unit_amount');
    const flat = amountWithDecimal(t, 'flat_amount');
    if (!unit && !flat) throw invalid('Each tier needs unit_amount and/or flat_amount.', `tiers[${i}]`);
    return { flat_amount: flat?.amount ?? null, flat_amount_decimal: flat?.decimal ?? null, unit_amount: unit?.amount ?? null, unit_amount_decimal: unit?.decimal ?? null, up_to: upTo };
  });
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1]!.up_to;
    if (prev === null || (tiers[i]!.up_to !== null && tiers[i]!.up_to! <= prev)) throw invalid('Tiers must be in increasing up_to order, with only the last one up to inf.', 'tiers');
  }
  if (tiers[tiers.length - 1]!.up_to !== null) throw invalid("The last tier must have up_to='inf'.", 'tiers');
  return tiers;
}

/** Amount for `quantity` units of `price`, across every pricing model. */
export function priceAmount(price: any, quantity: number): number {
  if (!price) return 0;
  if (price.billing_scheme === 'tiered' && price.tiers) {
    const tiers = price.tiers as any[];
    if (price.tiers_mode === 'volume') {
      const t = tiers.find((x) => x.up_to === null || quantity <= x.up_to) ?? tiers[tiers.length - 1];
      return quantity > 0 ? Math.round(unitOf(t) * quantity + Number(t.flat_amount_decimal ?? t.flat_amount ?? 0)) : 0;
    }
    let total = 0;
    let prevUpTo = 0;
    for (const t of tiers) {
      if (quantity <= prevUpTo) break;
      const inTier = Math.min(quantity, t.up_to ?? Infinity) - prevUpTo;
      total += unitOf(t) * inTier + Number(t.flat_amount_decimal ?? t.flat_amount ?? 0);
      prevUpTo = t.up_to ?? Infinity;
    }
    return Math.round(total);
  }
  let q = quantity;
  if (price.transform_quantity) {
    const d = q / price.transform_quantity.divide_by;
    q = price.transform_quantity.round === 'down' ? Math.floor(d) : Math.ceil(d);
  }
  return Math.round(unitOf(price) * q);
}

/** Amount billed in advance for a subscription item (metered items are billed later, from usage). */
export const licensedAmount = (price: any, quantity: number) => (price?.recurring?.usage_type === 'metered' ? 0 : priceAmount(price, quantity));

/** Short human description of a price, e.g. "$0.04 per unit / month" or "graduated tiers". */
export function priceSummary(price: any) {
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency.toUpperCase() }).format(n / 100);
  const per = price.recurring ? ` / ${price.recurring.interval}` : '';
  if (price.billing_scheme === 'tiered') return `${price.tiers_mode} tiers${per}`;
  if (price.transform_quantity) return `${fmt(price.unit_amount)} per ${price.transform_quantity.divide_by} units${per}`;
  if (price.unit_amount === null) return `${new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency.toUpperCase(), maximumFractionDigits: 6 }).format(unitOf(price) / 100)} per unit${per}`;
  return `${fmt(price.unit_amount)}${price.recurring?.usage_type === 'metered' ? ' per unit' : ''}${per}`;
}
const INTERVALS = ['day', 'week', 'month', 'year'] as const;

export async function createPrice(ctx: Ctx, p: Params) {
  let productId = str(p, 'product');
  if (!productId && p.product_data) {
    productId = (await createProduct(ctx, { name: p.product_data.name, metadata: p.product_data.metadata })).id;
  }
  if (!productId) throw missing('product');
  await getObject(ctx.accountId, 'product', productId, 'product', 'product');
  const cur = currency(p)!;
  const scheme = oneOf(p, 'billing_scheme', ['per_unit', 'tiered'] as const, 'per_unit')!;
  const unitIn = amountWithDecimal(p, 'unit_amount');
  if (unitIn === undefined && scheme === 'per_unit') throw missing('unit_amount');
  if (unitIn && unitIn.amount === null && p.transform_quantity) throw invalid('Package prices need a whole unit_amount.', 'unit_amount_decimal');
  const tiers = scheme === 'tiered' ? parseTiers(p) : null;
  const tiersMode = scheme === 'tiered' ? oneOf(p, 'tiers_mode', ['graduated', 'volume'] as const) : null;
  if (scheme === 'tiered' && !tiersMode) throw missing('tiers_mode');
  let transform: any = null;
  if (p.transform_quantity) {
    if (scheme === 'tiered') throw invalid('transform_quantity cannot be combined with tiered pricing.', 'transform_quantity');
    const divide = int(p.transform_quantity, 'divide_by', { required: true, min: 1 })!;
    transform = { divide_by: divide, round: oneOf(p.transform_quantity, 'round', ['up', 'down'] as const, 'up') };
  }
  let recurring: any = null;
  if (p.recurring) {
    const interval = oneOf(p.recurring, 'interval', INTERVALS);
    if (!interval) throw missing('recurring[interval]');
    const count = int(p.recurring, 'interval_count', { min: 1 }) ?? 1;
    const maxCount = { day: 365, week: 52, month: 12, year: 3 }[interval];
    if (count > maxCount) throw invalid(`interval_count must be at most ${maxCount} for ${interval}`, 'recurring[interval_count]');
    const usage = oneOf(p.recurring, 'usage_type', ['licensed', 'metered'] as const, 'licensed')!;
    let meter: string | null = null;
    if (usage === 'metered') {
      meter = str(p.recurring, 'meter') ?? null;
      if (!meter) throw invalid('Metered prices need recurring[meter]: the billing meter whose events are billed.', 'recurring[meter]');
      const m = await getObject<any>(ctx.accountId, 'billing.meter', meter, 'billing meter', 'recurring[meter]');
      if (m.status !== 'active') throw invalid(`Meter ${meter} is inactive.`, 'recurring[meter]');
    }
    recurring = { interval, interval_count: count, meter, trial_period_days: null, usage_type: usage };
  }
  const lookup = str(p, 'lookup_key');
  const price = {
    id: newId('price'),
    object: 'price',
    active: bool(p, 'active') ?? true,
    billing_scheme: scheme,
    created: nowSeconds(),
    currency: cur,
    custom_unit_amount: null,
    livemode: false,
    lookup_key: lookup ?? null,
    metadata: metadata(p),
    nickname: str(p, 'nickname') ?? null,
    product: productId,
    recurring,
    tax_behavior: oneOf(p, 'tax_behavior', ['inclusive', 'exclusive', 'unspecified'] as const, 'unspecified'),
    tiers,
    tiers_mode: tiersMode,
    transform_quantity: transform,
    type: recurring ? 'recurring' : 'one_time',
    unit_amount: scheme === 'tiered' ? null : unitIn!.amount,
    unit_amount_decimal: scheme === 'tiered' ? null : unitIn!.decimal,
  };
  await insertObject(ctx.accountId, price);
  await emit(ctx, 'price.created', price);
  const prod = await getObject<any>(ctx.accountId, 'product', productId);
  if (!prod.default_price) {
    prod.default_price = price.id;
    await saveObject(ctx.accountId, prod);
  }
  return price;
}

export async function updatePrice(ctx: Ctx, id: string, p: Params) {
  const price = await getObject<any>(ctx.accountId, 'price', id, 'price');
  if (p.active !== undefined) price.active = bool(p, 'active');
  if (p.nickname !== undefined) price.nickname = p.nickname || null;
  if (p.lookup_key !== undefined) price.lookup_key = p.lookup_key || null;
  if (p.tax_behavior !== undefined) {
    if (price.tax_behavior !== 'unspecified') throw invalid('tax_behavior can only be set once, while it is unspecified.', 'tax_behavior');
    price.tax_behavior = oneOf(p, 'tax_behavior', ['inclusive', 'exclusive'] as const);
  }
  price.metadata = metadata(p, price.metadata);
  await saveObject(ctx.accountId, price);
  await emit(ctx, 'price.updated', price);
  return price;
}

/** Inline `price_data` (as on subscription items / invoice items) becomes a hidden one-off price. */
export async function resolvePrice(ctx: Ctx, item: any, param: string) {
  if (item.price) {
    const price = await getObject<any>(ctx.accountId, 'price', String(item.price), 'price', `${param}[price]`);
    if (!price.active) throw invalid(`The price ${price.id} is not active.`, `${param}[price]`);
    return price;
  }
  if (item.price_data) {
    const pd = item.price_data;
    const product = pd.product ?? (pd.product_data ? (await createProduct(ctx, { name: pd.product_data.name ?? 'Item' })).id : undefined);
    if (!product) throw missing(`${param}[price_data][product]`);
    const price = await createPrice(ctx, { ...pd, product });
    return price;
  }
  throw missing(`${param}[price]`);
}

// ---------------- coupons ----------------
export async function createCoupon(ctx: Ctx, p: Params) {
  const percent = p.percent_off !== undefined ? Number(p.percent_off) : undefined;
  const amount = int(p, 'amount_off', { min: 1 });
  if ((percent === undefined) === (amount === undefined)) throw invalid('Coupons need exactly one of percent_off or amount_off.', 'percent_off');
  if (percent !== undefined && !(percent > 0 && percent <= 100)) throw invalid('percent_off must be between 0 and 100.', 'percent_off');
  const duration = oneOf(p, 'duration', ['once', 'repeating', 'forever'] as const, 'once')!;
  const months = int(p, 'duration_in_months', { min: 1 });
  if (duration === 'repeating' && !months) throw missing('duration_in_months');
  const id = str(p, 'id') ?? base62(8);
  if (await findObject(ctx.accountId, 'coupon', id)) throw invalid(`Coupon already exists: ${id}`, 'id', 'resource_already_exists');
  const coupon = {
    id,
    object: 'coupon',
    amount_off: amount ?? null,
    created: nowSeconds(),
    currency: amount ? currency(p)! : null,
    duration,
    duration_in_months: duration === 'repeating' ? months : null,
    livemode: false,
    max_redemptions: int(p, 'max_redemptions', { min: 1 }) ?? null,
    metadata: metadata(p),
    name: str(p, 'name') ?? null,
    percent_off: percent ?? null,
    redeem_by: int(p, 'redeem_by') ?? null,
    times_redeemed: 0,
    valid: true,
  };
  await insertObject(ctx.accountId, coupon);
  await emit(ctx, 'coupon.created', coupon);
  return coupon;
}

/** Validates and redeems a coupon, returning a Discount object for a subscription or customer. */
export async function redeemCoupon(ctx: Ctx, couponId: string, target: { customer: string; subscription?: string | null }, now: number) {
  const coupon = await getObject<any>(ctx.accountId, 'coupon', couponId, 'coupon', 'coupon');
  if (!coupon.valid || (coupon.redeem_by && coupon.redeem_by < now) || (coupon.max_redemptions && coupon.times_redeemed >= coupon.max_redemptions)) {
    throw invalid(`Coupon expired: ${couponId}`, 'coupon', 'coupon_expired');
  }
  coupon.times_redeemed++;
  if (coupon.max_redemptions && coupon.times_redeemed >= coupon.max_redemptions) coupon.valid = false;
  await saveObject(ctx.accountId, coupon);
  return {
    id: newId('di', 14),
    object: 'discount',
    coupon: { ...coupon, _ref: true },
    customer: target.customer,
    end: coupon.duration === 'repeating' ? now + coupon.duration_in_months * 30 * 86400 : null,
    invoice: null,
    invoice_item: null,
    promotion_code: null,
    start: now,
    subscription: target.subscription ?? null,
  };
}

/** Discount amount for a subtotal, honouring duration and currency. */
export function discountAmount(discount: any, subtotal: number, currencyCode: string, now: number, firstInvoice: boolean): number {
  if (!discount) return 0;
  const c = discount.coupon;
  if (discount.end && discount.end < now) return 0;
  if (c.duration === 'once' && !firstInvoice) return 0;
  if (c.percent_off) return Math.round((subtotal * c.percent_off) / 100);
  if (c.amount_off && c.currency === currencyCode) return Math.min(subtotal, c.amount_off);
  return 0;
}
