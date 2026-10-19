import { one, query } from '../../db/index.ts';
import { invalid, missing } from '../../lib/errors.ts';
import { base62, newId, nowSeconds } from '../../lib/ids.ts';
import { arr, bool, currency, int, metadata, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { diff, emit } from '../events.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { redeemCoupon } from './catalog.ts';

/**
 * Promotion codes: customer-facing codes (e.g. "SPRING25") that point at a coupon.
 *
 * A code can be limited to one customer, expire, cap its redemptions, and carry
 * restrictions: first-time customers only, and a minimum order amount. Codes are
 * matched case-insensitively and must be unique among active codes.
 */

const CODE_RE = /^[a-zA-Z0-9]{3,50}$/;

/** The coupon a promotion code points at. */
export const couponOf = (promo: any): string => promo.promotion?.coupon ?? promo.coupon?.id ?? promo.coupon;

export async function createPromotionCode(ctx: Ctx, p: Params) {
  // Current API: promotion[type]=coupon & promotion[coupon]; older versions passed `coupon` directly.
  const legacy = str(p, 'coupon');
  if (p.promotion && p.promotion.type !== undefined && p.promotion.type !== 'coupon') throw invalid("promotion[type] must be 'coupon'.", 'promotion[type]');
  const couponId = str(p.promotion ?? {}, 'coupon') ?? legacy;
  if (!couponId) throw missing('promotion[coupon]');
  const param = legacy ? 'coupon' : 'promotion[coupon]';
  const coupon = await getObject<any>(ctx.accountId, 'coupon', couponId, 'coupon', param);
  if (coupon.deleted) throw invalid(`No such coupon: '${couponId}'`, param, 'resource_missing');
  const code = (str(p, 'code', { max: 50 }) ?? base62(8)).toUpperCase();
  if (!CODE_RE.test(code)) throw invalid('Promotion codes may only contain letters and digits (3–50 characters).', 'code');
  if (await activeByCode(ctx.accountId, code)) throw invalid(`An active promotion code with \`code: ${code}\` already exists.`, 'code', 'promotion_code_already_exists');
  const r = p.restrictions ?? {};
  const minimum = int(r, 'minimum_amount', { min: 1 });
  const expires = int(p, 'expires_at');
  if (expires !== undefined && expires <= nowSeconds()) throw invalid('expires_at must be in the future.', 'expires_at');
  if (expires && coupon.redeem_by && expires > coupon.redeem_by) throw invalid("The promotion code can't outlive its coupon's redeem_by date.", 'expires_at');
  const customer = str(p, 'customer');
  if (customer) await getObject(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const promo = {
    id: newId('promo'),
    object: 'promotion_code',
    active: bool(p, 'active') ?? true,
    code,
    promotion: { coupon: coupon.id, type: 'coupon' },
    created: nowSeconds(),
    customer: customer ?? null,
    expires_at: expires ?? null,
    livemode: false,
    max_redemptions: int(p, 'max_redemptions', { min: 1 }) ?? null,
    metadata: metadata(p),
    restrictions: {
      currency_options: {},
      first_time_transaction: bool(r, 'first_time_transaction') ?? false,
      minimum_amount: minimum ?? null,
      minimum_amount_currency: minimum ? currency(r, 'minimum_amount_currency')! : null,
    },
    times_redeemed: 0,
  };
  await insertObject(ctx.accountId, promo);
  await emit(ctx, 'promotion_code.created', promo);
  return promo;
}

export async function updatePromotionCode(ctx: Ctx, id: string, p: Params) {
  const promo = await getObject<any>(ctx.accountId, 'promotion_code', id, 'promotion code');
  const before = structuredClone(promo);
  if (p.active !== undefined) {
    const active = bool(p, 'active')!;
    if (active && !promo.active && (await activeByCode(ctx.accountId, promo.code))) throw invalid(`Another active promotion code already uses \`${promo.code}\`.`, 'active', 'promotion_code_already_exists');
    if (active && promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) throw invalid('This promotion code has reached its max_redemptions and cannot be reactivated.', 'active');
    promo.active = active;
  }
  promo.metadata = metadata(p, promo.metadata);
  await saveObject(ctx.accountId, promo);
  await emit(ctx, 'promotion_code.updated', promo, diff(before, promo));
  return promo;
}

async function activeByCode(accountId: string, code: string) {
  const row = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'promotion_code' AND upper(data->>'code') = $2 AND data->>'active' = 'true' ORDER BY seq DESC LIMIT 1", [accountId, code.toUpperCase()]);
  return row?.data ?? null;
}

/** Finds an active code by what a customer typed (hosted pages). */
export async function findByCode(ctx: Ctx, code: string) {
  const promo = await activeByCode(ctx.accountId, code.trim());
  if (!promo) throw invalid('This code is invalid.', 'promotion_code', 'promotion_code_invalid');
  return promo;
}

/** Whether this customer has paid anything before (for first_time_transaction codes). */
async function hasPriorTransaction(accountId: string, customerId: string) {
  const r = await query("SELECT 1 FROM objects WHERE account_id = $1 AND ((type = 'charge' AND data->>'status' = 'succeeded') OR (type = 'invoice' AND data->>'status' = 'paid' AND (data->>'amount_paid')::bigint > 0)) AND data->>'customer' = $2 LIMIT 1", [accountId, customerId]);
  return r.length > 0;
}

/**
 * Checks a code can be used now, by this customer, for this amount. Throws a
 * customer-presentable error otherwise. `customer` may be null for new checkout buyers.
 */
export async function validatePromotion(ctx: Ctx, promo: any, use: { customer?: string | null; amount?: number; currency?: string; now?: number; param?: string }) {
  const param = use.param ?? 'promotion_code';
  const now = use.now ?? nowSeconds();
  const fail = (msg: string) => invalid(msg, param, 'promotion_code_invalid');
  if (!promo.active) throw fail('This code is no longer active.');
  if (promo.expires_at && promo.expires_at <= now) throw fail('This code has expired.');
  if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) throw fail('This code has reached its redemption limit.');
  const coupon = await findObject<any>(ctx.accountId, 'coupon', couponOf(promo));
  if (!coupon || coupon.deleted || !coupon.valid || (coupon.redeem_by && coupon.redeem_by < now)) throw fail('This code is no longer valid.');
  if (promo.customer && use.customer && promo.customer !== use.customer) throw fail('This code is not valid for this customer.');
  if (promo.customer && !use.customer) throw fail('This code is only valid for a specific customer.');
  if (promo.restrictions.first_time_transaction && use.customer && (await hasPriorTransaction(ctx.accountId, use.customer))) throw fail('This code is only valid for first-time customers.');
  const min = promo.restrictions.minimum_amount;
  if (min && use.amount !== undefined) {
    if (use.currency && promo.restrictions.minimum_amount_currency !== use.currency) throw fail(`This code is only valid for orders in ${promo.restrictions.minimum_amount_currency.toUpperCase()}.`);
    if (use.amount < min) {
      const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: promo.restrictions.minimum_amount_currency.toUpperCase() }).format(min / 100);
      throw fail(`This code requires a minimum order of ${fmt}.`);
    }
  }
  if (coupon.amount_off && use.currency && coupon.currency !== use.currency) throw fail(`This code only applies to ${coupon.currency.toUpperCase()} purchases.`);
  return coupon;
}

/** Validates and redeems a promotion code: returns a Discount carrying `promotion_code`. */
export async function redeemPromotion(ctx: Ctx, promoId: string, target: { customer: string; subscription?: string | null }, now: number, use: { amount?: number; currency?: string; param?: string } = {}) {
  const promo = await getObject<any>(ctx.accountId, 'promotion_code', promoId, 'promotion code', use.param ?? 'promotion_code');
  const coupon = await validatePromotion(ctx, promo, { ...use, customer: target.customer, now });
  promo.times_redeemed++;
  if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) promo.active = false;
  await saveObject(ctx.accountId, promo);
  const discount = await redeemCoupon(ctx, coupon.id, target, now);
  discount.promotion_code = promo.id;
  return discount;
}

/**
 * Reads `coupon`, `promotion_code`, `discounts[0][coupon]` or `discounts[0][promotion_code]`
 * and redeems the one given. Returns null when none was passed.
 */
export async function discountFromParams(ctx: Ctx, p: Params, target: { customer: string; subscription?: string | null }, now: number, use: { amount?: number; currency?: string } = {}) {
  const d0 = arr(p, 'discounts')?.[0] ?? {};
  const couponId = str(p, 'coupon') ?? (d0.coupon ? String(d0.coupon) : undefined);
  const promoId = str(p, 'promotion_code') ?? (d0.promotion_code ? String(d0.promotion_code) : undefined);
  if (couponId && promoId) throw invalid('Pass either a coupon or a promotion_code, not both.', 'promotion_code');
  if (promoId) return redeemPromotion(ctx, promoId, target, now, { ...use, param: p.promotion_code ? 'promotion_code' : 'discounts[0][promotion_code]' });
  if (couponId) return redeemCoupon(ctx, couponId, target, now);
  return null;
}

export const promoIdFromParams = (p: Params) => {
  const d0 = arr(p, 'discounts')?.[0] ?? {};
  return str(p, 'promotion_code') ?? (d0.promotion_code ? String(d0.promotion_code) : undefined);
};
void missing;
