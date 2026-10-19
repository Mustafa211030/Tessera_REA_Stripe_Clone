import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { ApiError, invalid, unexpectedState } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { int, metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { post } from './ledger.ts';
import { getObject, insertObject, listObjects, saveObject } from './store.ts';

/**
 * Capital-style financing: merchant cash advances repaid from a share of future sales.
 *
 *   undelivered ─mark_delivered─► delivered ─(merchant accepts on the hosted page)─► accepted
 *     ─(CAPITAL_PAYOUT_SECONDS)─► paid_out ─(withholding repays advance + fee)─► fully_repaid
 *   delivered ─(merchant declines)─► rejected        any open offer ─(expires_after)─► expired
 *
 * Offers belong to the platform (`account` names the business that receives the money);
 * the test helper creates them. When an advance is paid out, the business's ledger books
 * the whole obligation (advance + fee) as capital_receivable. Each card payment that becomes
 * available then withholds `withhold_rate` of its net amount until the obligation is repaid.
 */

const DAY = 86400;
const OPEN = ['undelivered', 'delivered'];
const ACTIVE = ['accepted', 'paid_out'];

function owner(ctx: Ctx) { return ctx.platformAccountId ?? ctx.accountId; }

async function findOffer(ownerId: string, id: string) {
  return getObject<any>(ownerId, 'capital.financing_offer', id, 'financing_offer');
}

/** POST /v1/test_helpers/capital/financing_offers/create (Stripe-Account picks the business). */
export async function createTestOffer(ctx: Ctx, p: Params) {
  const ownerId = owner(ctx);
  const business = ctx.accountId;
  const busy = await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'capital.financing_offer' AND data->>'account' = $2 AND data->>'status' = ANY($3)", [ownerId, business, [...OPEN, ...ACTIVE]]);
  if (busy) throw new ApiError(400, 'invalid_request_error', 'This account already has an open or active financing offer. Wait for it to be repaid, or let it expire.', { code: 'financing_offer_exists' });
  const advance = int(p, 'advance_amount', { min: 10_000, max: 200_000_000 }) ?? 500_000;
  const fee = int(p, 'fee_amount', { min: 0 }) ?? Math.round(advance * 0.1);
  const rate = p.withhold_rate === undefined ? 0.1 : Number(p.withhold_rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 0.3) throw invalid('withhold_rate must be greater than 0 and at most 0.3.', 'withhold_rate');
  const now = nowSeconds();
  const offer: any = {
    id: newId('financingoffer'), object: 'capital.financing_offer', account: business, accepted_terms: null, charged_off_at: null, created: now,
    expires_after: now + 30 * DAY, financing_type: 'cash_advance', livemode: false, metadata: metadata(p),
    offered_terms: { advance_amount: advance, campaign_type: 'newly_eligible_user', currency: 'usd', fee_amount: fee, previous_financing_fee_discount_rate: 0, withhold_rate: rate },
    product_type: 'standard', replacement: null, replacement_for: null, status: 'undelivered', type: 'cash_advance',
    _token: randomBytes(18).toString('base64url'), _paid: 0, _paid_advance: 0, _paid_fee: 0,
  };
  await insertObject(ownerId, offer);
  await emit({ ...ctx, accountId: ownerId, platformAccountId: undefined }, 'capital.financing_offer.created', offer);
  return offer;
}

export async function listOffers(ctx: Ctx, p: Params) {
  const filters: { field: string; value: string }[] = [];
  if (p.connected_account) filters.push({ field: 'account', value: String(p.connected_account) });
  if (p.status) filters.push({ field: 'status', value: String(p.status) });
  return listObjects(owner(ctx), 'capital.financing_offer', '/v1/capital/financing_offers', p, filters);
}

export const getOffer = (ctx: Ctx, id: string) => findOffer(owner(ctx), id);

export async function markDelivered(ctx: Ctx, id: string) {
  const o = await findOffer(owner(ctx), id);
  if (o.status !== 'undelivered') throw unexpectedState(`Only undelivered offers can be marked delivered. This offer is ${o.status}.`);
  o.status = 'delivered';
  await saveObject(owner(ctx), o);
  return o;
}

/** Tessera extension: the hosted page where the business reviews and accepts the offer. */
export async function applicationLink(ctx: Ctx, id: string) {
  const o = await findOffer(owner(ctx), id);
  if (o.status !== 'delivered') throw unexpectedState(`Mark the offer delivered before sending it to the business. This offer is ${o.status}.`);
  return { object: 'capital.application_link', financing_offer: o.id, url: `${ctx.baseUrl}/capital/apply/${o._token}` };
}

async function byToken(token: string) {
  return one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'capital.financing_offer' AND data->>'_token' = $1", [token]);
}

export async function hostedView(token: string) {
  const row = await byToken(token);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
  const o = row.data;
  const names = async (id: string) => {
    const a = (await one<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [id]))?.data;
    return a?.business_profile?.name ?? a?.settings?.dashboard?.display_name ?? a?.email ?? 'Your business';
  };
  return { id: o.id, status: o.status, business: await names(o.account), platform: await names(row.account_id), terms: o.accepted_terms ?? o.offered_terms, expires_after: o.expires_after };
}

export async function hostedDecide(token: string, accept: boolean) {
  const row = await byToken(token);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
  const o = row.data;
  if (o.status !== 'delivered') throw unexpectedState(`This offer is ${o.status.replace(/_/g, ' ')} and can no longer be ${accept ? 'accepted' : 'declined'}.`);
  const ctx = accountCtx(row.account_id);
  if (accept) {
    const t = o.offered_terms;
    o.accepted_terms = { advance_amount: t.advance_amount, currency: t.currency, fee_amount: t.fee_amount, previous_financing_fee_discount_amount: 0, withhold_rate: t.withhold_rate };
    o.status = 'accepted';
    o._accepted_at = nowSeconds();
  } else o.status = 'rejected';
  await saveObject(row.account_id, o);
  await emit(ctx, `capital.financing_offer.${accept ? 'accepted' : 'rejected'}`, o);
  return hostedView(token);
}

function finTxn(o: any, type: 'payout' | 'payment' | 'reversal', amounts: { advance: number; fee: number }, extra: { charge?: string; description: string }) {
  return {
    id: newId('cptxn'), object: 'capital.financing_transaction', account: o.account, created_at: nowSeconds(), created: nowSeconds(),
    details: {
      advance_amount: amounts.advance, currency: 'usd', fee_amount: amounts.fee, linked_payment: extra.charge ?? null, reason: type === 'payment' ? 'automatic_withholding' : null,
      total_amount: amounts.advance + amounts.fee, transaction: extra.charge ? { charge: extra.charge, treasury_transaction: null } : null,
    },
    financing_offer: o.id, legacy_balance_transaction_source: null, livemode: false, type, user_facing_description: extra.description,
  };
}

function balanceTxn(type: string, amount: number, source: string, description: string) {
  const now = nowSeconds();
  return {
    id: newId('txn'), object: 'balance_transaction', amount, available_on: now, created: now, currency: 'usd', description, exchange_rate: null,
    fee: 0, fee_details: [], livemode: false, net: amount, reporting_category: 'financing', source, status: 'available', type, _network_settled: true,
  };
}

/** Worker: accepted offers are paid out; open offers past expires_after expire. */
export async function processCapital(now = nowSeconds()) {
  let n = 0;
  const accepted = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'capital.financing_offer' AND data->>'status' = 'accepted'");
  for (const { account_id, data: o } of accepted) {
    if (now < (o._accepted_at ?? 0) + config.capitalPayoutSeconds) continue;
    const t = o.accepted_terms;
    // The business receives the advance and owes advance + fee.
    await post(o.account, 'usd', [
      { account: 'capital_receivable', amount: t.advance_amount + t.fee_amount },
      { account: 'merchant_available', amount: -t.advance_amount },
      { account: 'fee_revenue', amount: -t.fee_amount },
    ], o.id, `Capital advance ${o.id}`);
    await insertObject(o.account, balanceTxn('advance', t.advance_amount, o.id, 'Capital financing advance') as any);
    await insertObject(account_id, finTxn(o, 'payout', { advance: t.advance_amount, fee: t.fee_amount }, { description: 'Financing paid out' }) as any);
    o.status = 'paid_out';
    o._paid_out_at = now;
    await saveObject(account_id, o);
    await emit(accountCtx(account_id), 'capital.financing_offer.paid_out', o);
    n++;
  }
  const open = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'capital.financing_offer' AND data->>'status' = ANY($1) AND (data->>'expires_after')::bigint <= $2", [OPEN, now]);
  for (const { account_id, data: o } of open) {
    o.status = 'expired';
    await saveObject(account_id, o);
    await emit(accountCtx(account_id), 'capital.financing_offer.expired', o);
    n++;
  }
  return n;
}

/**
 * Called when a card payment's funds become available on `accountId`. Withholds the offer's
 * rate from the net amount (never more than what is still owed).
 */
export async function withhold(accountId: string, txn: any) {
  if (txn.type !== 'charge' && txn.type !== 'payment') return;
  if (txn.currency !== 'usd' || txn.net <= 0) return;
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'capital.financing_offer' AND data->>'account' = $1 AND data->>'status' = 'paid_out' LIMIT 1", [accountId]);
  if (!row) return;
  const o = row.data;
  const t = o.accepted_terms;
  const owed = t.advance_amount + t.fee_amount - o._paid;
  if (owed <= 0) return;
  const amount = Math.min(owed, Math.round(txn.net * t.withhold_rate));
  if (amount <= 0) return;
  // Split each repayment between advance and fee in proportion to the totals.
  const fee = Math.min(t.fee_amount - o._paid_fee, Math.round((amount * t.fee_amount) / (t.advance_amount + t.fee_amount)));
  const advance = amount - fee;
  await post(accountId, 'usd', [{ account: 'merchant_available', amount }, { account: 'capital_receivable', amount: -amount }], o.id, `Capital repayment from ${txn.source}`);
  await insertObject(accountId, balanceTxn('advance_repayment' as any, -amount, o.id, `Capital repayment (${Math.round(t.withhold_rate * 100)}% of ${txn.source})`) as any);
  await insertObject(row.account_id, finTxn(o, 'payment', { advance, fee }, { charge: txn.source, description: 'Automatic withholding from a payment' }) as any);
  o._paid += amount;
  o._paid_advance += advance;
  o._paid_fee += fee;
  if (o._paid >= t.advance_amount + t.fee_amount) {
    o.status = 'fully_repaid';
    o._repaid_at = nowSeconds();
    await emit(accountCtx(row.account_id), 'capital.financing_offer.fully_repaid', o);
  }
  await saveObject(row.account_id, o);
}

export async function listTransactions(ctx: Ctx, p: Params) {
  const filters: { field: string; value: string }[] = [];
  if (p.financing_offer) filters.push({ field: 'financing_offer', value: String(p.financing_offer) });
  if (p.connected_account) filters.push({ field: 'account', value: String(p.connected_account) });
  return listObjects(owner(ctx), 'capital.financing_transaction', '/v1/capital/financing_transactions', p, filters);
}

export const getTransaction = (ctx: Ctx, id: string) => getObject<any>(owner(ctx), 'capital.financing_transaction', id, 'financing_transaction');

/** GET /v1/capital/financing_summary for the calling (or Stripe-Account) business. */
export async function summary(ctx: Ctx) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE type = 'capital.financing_offer' AND data->>'account' = $1 ORDER BY seq DESC", [ctx.accountId]);
  const o = rows.map((r) => r.data).find((x) => ['delivered', ...ACTIVE].includes(x.status));
  if (!o) return { object: 'capital.financing_summary', details: null, financing_offer: null, status: 'none' };
  if (o.status === 'delivered') return { object: 'capital.financing_summary', details: null, financing_offer: o.id, status: 'delivered' };
  const t = o.accepted_terms;
  return {
    object: 'capital.financing_summary', financing_offer: o.id, status: 'accepted',
    details: {
      advance_amount: t.advance_amount, advance_paid_out_at: o._paid_out_at ?? null, currency: 'usd', current_repayment_interval: null, fee_amount: t.fee_amount,
      paid_amount: o._paid, remaining_amount: t.advance_amount + t.fee_amount - o._paid, repayments_begin_at: o._paid_out_at ?? null, withhold_rate: t.withhold_rate,
    },
  };
}

/** Dashboard view of an offer with repayment progress. */
export function progress(o: any) {
  const t = o.accepted_terms ?? o.offered_terms;
  return { total: t.advance_amount + t.fee_amount, paid: o._paid ?? 0, paid_advance: o._paid_advance ?? 0, paid_fee: o._paid_fee ?? 0 };
}
