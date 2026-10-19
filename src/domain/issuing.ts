import { config } from '../config.ts';
import { query } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { arr, bool, currency, int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { balances, post } from './ledger.ts';
import { stripInternal } from './paymentIntents.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';
import { sign } from './webhooks.ts';

/**
 * Issuing: cards you create for your team or customers, funded from an Issuing balance.
 *
 * - Fund the balance with a top-up (`POST /v1/topups`, destination_balance=issuing).
 * - Cardholders own cards; cards (virtual or physical) start inactive and carry spending
 *   controls (allowed/blocked merchant categories, spending limits per authorization, day,
 *   week, month, year or all time) — on the card and on the cardholder.
 * - Purchases arrive as authorizations (test helpers simulate the card network). Each one is
 *   checked against card/cardholder status, spending controls and the available balance, then
 *   — if you listen for `issuing_authorization.request` — sent synchronously to your endpoint,
 *   which answers `{"approved": true|false}` within 2 seconds. Approved amounts are held.
 * - Captures and refunds become transactions that move money out of (or back into) the balance.
 *
 * Ledger: issuing_available (balance), issuing_reserved (held for pending authorizations).
 */

export const CATEGORIES: Record<string, string> = {
  advertising_services: '7311', airlines_air_carriers: '4511', automated_fuel_dispensers: '5542', bakeries: '5462', book_stores: '5942',
  bus_lines: '4131', car_rental_agencies: '7512', computer_network_services: '4816', computer_software_stores: '5734', digital_goods_media: '5815',
  drug_stores_and_pharmacies: '5912', eating_places_restaurants: '5812', electronics_stores: '5732', fast_food_restaurants: '5814',
  grocery_stores_supermarkets: '5411', hotels_motels_and_resorts: '7011', miscellaneous_general_merchandise: '5399',
  postal_services_government_only: '9402', professional_services: '8999', taxicabs_limousines: '4121', telecommunication_services: '4814',
  travel_agencies_tour_operators: '4722',
};
const INTERVALS = ['per_authorization', 'daily', 'weekly', 'monthly', 'yearly', 'all_time'] as const;

function categories(list: any, param: string) {
  if (list === undefined || list === '') return null;
  const items = (Array.isArray(list) ? list : Object.values(list)).map(String);
  for (const c of items) if (!CATEGORIES[c]) throw invalid(`'${c}' is not a supported merchant category.`, param);
  return items;
}

function spendingControls(p: any, existing: any, withCurrency: boolean) {
  const out = existing ? structuredClone(existing) : { allowed_categories: null, blocked_categories: null, spending_limits: [] as any[], ...(withCurrency ? { spending_limits_currency: null } : {}) };
  if (!p) return out;
  if (p.allowed_categories !== undefined) out.allowed_categories = categories(p.allowed_categories, 'spending_controls[allowed_categories]');
  if (p.blocked_categories !== undefined) out.blocked_categories = categories(p.blocked_categories, 'spending_controls[blocked_categories]');
  if (out.allowed_categories?.length && out.blocked_categories?.length) throw invalid('Use either allowed_categories or blocked_categories, not both.', 'spending_controls[blocked_categories]');
  if (p.spending_limits !== undefined) {
    out.spending_limits = (arr(p, 'spending_limits') ?? []).map((l: any, i: number) => ({
      amount: int(l, 'amount', { required: true, min: 0 })!,
      categories: categories(l.categories, `spending_controls[spending_limits][${i}][categories]`),
      interval: oneOf(l, 'interval', INTERVALS) ?? (() => { throw missing(`spending_controls[spending_limits][${i}][interval]`); })(),
    }));
  }
  if (withCurrency && p.spending_limits_currency !== undefined) out.spending_limits_currency = currency(p, 'spending_limits_currency');
  return out;
}

// ---------------- balance and top-ups ----------------

export async function issuingBalance(accountId: string) {
  const b = await balances(accountId);
  const curs = new Set([...Object.keys(b.issuing_available ?? {}), ...Object.keys(b.issuing_reserved ?? {})]);
  return [...curs].map((c) => ({ amount: -(b.issuing_available?.[c] ?? 0), currency: c }));
}
const availableIn = async (accountId: string, cur: string) => (await issuingBalance(accountId)).find((x) => x.currency === cur)?.amount ?? 0;

async function balanceTxn(ctx: Ctx, t: { amount: number; currency: string; type: string; source: string; description: string }) {
  const txn = {
    id: newId('txn'), object: 'balance_transaction', amount: t.amount, available_on: nowSeconds(), balance_type: 'issuing', created: nowSeconds(),
    currency: t.currency, description: t.description, exchange_rate: null, fee: 0, fee_details: [], livemode: false, net: t.amount,
    reporting_category: t.type, source: t.source, status: 'available', type: t.type, _network_settled: true,
  };
  await insertObject(ctx.accountId, txn);
  return txn;
}

export async function createTopup(ctx: Ctx, p: Params) {
  const amount = int(p, 'amount', { required: true, min: 100, max: 100_000_000 })!;
  const cur = currency(p)!;
  const dest = oneOf(p, 'destination_balance', ['issuing', 'payments'] as const, 'payments')!;
  const id = newId('tu');
  const now = nowSeconds();
  const ledgerAccount = dest === 'issuing' ? 'issuing_available' : 'merchant_available';
  await post(ctx.accountId, cur, [{ account: 'cash', amount }, { account: ledgerAccount, amount: -amount }], id, `Top-up ${id} to ${dest} balance`);
  const txn = await balanceTxn(ctx, { amount, currency: cur, type: 'topup', source: id, description: str(p, 'description') ?? 'Top-up' });
  if (dest === 'payments') (txn as any).balance_type = 'payments';
  await saveObject(ctx.accountId, txn as any);
  const topup = {
    id, object: 'topup', amount, balance_transaction: txn.id, created: now, currency: cur, description: str(p, 'description', { max: 1000 }) ?? null,
    destination_balance: dest, expected_availability_date: now, failure_code: null, failure_message: null, livemode: false, metadata: metadata(p),
    source: null, statement_descriptor: str(p, 'statement_descriptor', { max: 15 }) ?? null, status: 'succeeded', transfer_group: str(p, 'transfer_group') ?? null,
  };
  await insertObject(ctx.accountId, topup);
  await emit(ctx, 'topup.created', topup);
  await emit(ctx, 'topup.succeeded', topup);
  return topup;
}

// ---------------- cardholders ----------------

export async function createCardholder(ctx: Ctx, p: Params) {
  const type = oneOf(p, 'type', ['individual', 'company'] as const, 'individual')!;
  const a = p.billing?.address;
  if (!a) throw missing('billing[address]');
  for (const k of ['line1', 'city', 'postal_code', 'country']) if (!a[k]) throw missing(`billing[address][${k}]`);
  const ind = p.individual;
  const ch = {
    id: newId('ich'),
    object: 'issuing.cardholder',
    billing: { address: { city: String(a.city), country: String(a.country).toUpperCase(), line1: String(a.line1), line2: a.line2 ? String(a.line2) : null, postal_code: String(a.postal_code), state: a.state ? String(a.state) : null } },
    company: type === 'company' ? { tax_id_provided: !!p.company?.tax_id } : null,
    created: nowSeconds(),
    email: str(p, 'email') ?? null,
    individual: type === 'individual' && ind ? { card_issuing: ind.card_issuing?.user_terms_acceptance ? { user_terms_acceptance: { date: int(ind.card_issuing.user_terms_acceptance, 'date') ?? nowSeconds(), ip: ind.card_issuing.user_terms_acceptance.ip ?? null, user_agent: null } } : null, dob: ind.dob ? { day: Number(ind.dob.day), month: Number(ind.dob.month), year: Number(ind.dob.year) } : null, first_name: ind.first_name ?? null, last_name: ind.last_name ?? null, verification: null } : null,
    livemode: false,
    metadata: metadata(p),
    name: str(p, 'name', { required: true, max: 24 })!,
    phone_number: str(p, 'phone_number') ?? null,
    preferred_locales: [],
    requirements: { disabled_reason: null, past_due: [] as string[] },
    spending_controls: spendingControls(p.spending_controls, null, true),
    status: oneOf(p, 'status', ['active', 'inactive'] as const, 'active'),
    type,
  };
  await insertObject(ctx.accountId, ch);
  await emit(ctx, 'issuing_cardholder.created', ch);
  return ch;
}

export async function updateCardholder(ctx: Ctx, id: string, p: Params) {
  const ch = await getObject<any>(ctx.accountId, 'issuing.cardholder', id, 'issuing.cardholder');
  if (p.status !== undefined) ch.status = oneOf(p, 'status', ['active', 'inactive'] as const);
  if (p.email !== undefined) ch.email = p.email || null;
  if (p.phone_number !== undefined) ch.phone_number = p.phone_number || null;
  if (p.spending_controls !== undefined) ch.spending_controls = spendingControls(p.spending_controls, ch.spending_controls, true);
  ch.metadata = metadata(p, ch.metadata);
  await saveObject(ctx.accountId, ch);
  await emit(ctx, 'issuing_cardholder.updated', ch);
  return ch;
}

// ---------------- cards ----------------

function luhnNumber(prefix: string) {
  let body = prefix;
  while (body.length < 15) body += String(Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(body[14 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

export async function createCard(ctx: Ctx, p: Params) {
  const ch = await getObject<any>(ctx.accountId, 'issuing.cardholder', str(p, 'cardholder', { required: true })!, 'issuing.cardholder', 'cardholder');
  const type = oneOf(p, 'type', ['virtual', 'physical'] as const);
  if (!type) throw missing('type');
  const cur = currency(p)!;
  if (type === 'physical' && !p.shipping) throw missing('shipping');
  const number = luhnNumber('400000');
  const now = new Date();
  const status = oneOf(p, 'status', ['active', 'inactive'] as const, 'inactive')!;
  const card = {
    id: newId('ic'),
    object: 'issuing.card',
    brand: 'Visa',
    cancellation_reason: null as string | null,
    cardholder: ch.id,
    created: nowSeconds(),
    currency: cur,
    cvc: null as string | null,
    exp_month: now.getUTCMonth() + 1,
    exp_year: now.getUTCFullYear() + 3,
    last4: number.slice(-4),
    livemode: false,
    metadata: metadata(p),
    number: null as string | null,
    replaced_by: null,
    replacement_for: str(p, 'replacement_for') ?? null,
    replacement_reason: oneOf(p, 'replacement_reason', ['damaged', 'expired', 'lost', 'stolen'] as const) ?? null,
    shipping: type === 'physical' ? { address: p.shipping.address ?? null, carrier: 'usps', eta: nowSeconds() + 5 * 86400, name: p.shipping.name ?? ch.name, service: p.shipping.service ?? 'standard', status: 'pending', tracking_number: null, type: 'individual' } : null,
    spending_controls: spendingControls(p.spending_controls, null, true),
    status,
    type,
    wallets: { apple_pay: { eligible: type === 'virtual', ineligible_reason: null }, google_pay: { eligible: type === 'virtual', ineligible_reason: null }, primary_account_identifier: null },
    _number: number,
    _cvc: String(100 + Math.floor(Math.random() * 900)),
  };
  await insertObject(ctx.accountId, card);
  await emit(ctx, 'issuing_card.created', card);
  return card;
}

export async function updateCard(ctx: Ctx, id: string, p: Params) {
  const card = await getObject<any>(ctx.accountId, 'issuing.card', id, 'issuing.card');
  if (card.status === 'canceled') throw invalid('This card is canceled and can no longer be updated.', 'card', 'issuing_card_canceled');
  if (p.status !== undefined) {
    card.status = oneOf(p, 'status', ['active', 'inactive', 'canceled'] as const);
    if (card.status === 'canceled') card.cancellation_reason = oneOf(p, 'cancellation_reason', ['lost', 'stolen', 'design_rejected'] as const) ?? null;
  }
  if (p.spending_controls !== undefined) card.spending_controls = spendingControls(p.spending_controls, card.spending_controls, true);
  card.metadata = metadata(p, card.metadata);
  await saveObject(ctx.accountId, card);
  await emit(ctx, 'issuing_card.updated', card);
  return card;
}

/** API view: the cardholder is embedded; number and cvc only when expanded. */
export async function presentCard(accountId: string, card: any, expand?: any) {
  const paths: string[] = Array.isArray(expand) ? expand : expand ? [expand] : [];
  const has = (k: string) => paths.includes(k) || paths.includes(`data.${k}`);
  const ch = await findObject<any>(accountId, 'issuing.cardholder', card.cardholder);
  return { ...card, cardholder: ch ?? card.cardholder, number: has('number') ? card._number : null, cvc: has('cvc') ? card._cvc : null };
}

// ---------------- authorizations ----------------

function windowStart(interval: string, now: number) {
  const d = new Date(now * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  switch (interval) {
    case 'daily': return day;
    case 'weekly': return day - d.getUTCDay() * 86400;
    case 'monthly': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    case 'yearly': return Date.UTC(d.getUTCFullYear(), 0, 1) / 1000;
    default: return 0;
  }
}

/** Amount spent since `from` on these cards (approved authorizations and unlinked captures), optionally in some categories. */
async function spent(accountId: string, cardIds: string[], from: number, cats: string[] | null) {
  const auths = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'issuing.authorization' AND data->>'approved' = 'true' AND (data->>'created')::bigint >= $2", [accountId, from]);
  const txns = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'issuing.transaction' AND data->>'authorization' IS NULL AND (data->>'created')::bigint >= $2", [accountId, from]);
  const inCat = (m: any) => !cats || cats.includes(m.category);
  return auths.map((r) => r.data).filter((a) => cardIds.includes(a._card_id) && inCat(a.merchant_data) && a.status !== 'reversed').reduce((s, a) => s + (a.status === 'closed' ? a._captured ?? a.amount : a.amount), 0)
    + txns.map((r) => r.data).filter((t) => cardIds.includes(t.card) && inCat(t.merchant_data)).reduce((s, t) => s - t.amount, 0);
}

/** Checks controls; returns the decline reason or null when the authorization may proceed. */
async function controlsDecision(accountId: string, card: any, ch: any, amount: number, merchant: any, now: number) {
  if (card.status === 'canceled') return 'card_canceled';
  if (card.status !== 'active') return 'card_inactive';
  if (ch.status !== 'active') return 'cardholder_inactive';
  for (const [sc, cardIds] of [[card.spending_controls, [card.id]], [ch.spending_controls, null]] as const) {
    if (sc.allowed_categories?.length && !sc.allowed_categories.includes(merchant.category)) return 'spending_controls';
    if (sc.blocked_categories?.includes(merchant.category)) return 'spending_controls';
    for (const lim of sc.spending_limits ?? []) {
      if (lim.categories?.length && !lim.categories.includes(merchant.category)) continue;
      if (lim.interval === 'per_authorization') { if (amount > lim.amount) return 'spending_controls'; continue; }
      const ids = cardIds ?? (await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'issuing.card' AND data->>'cardholder' = $2", [accountId, ch.id])).map((r) => r.id);
      if ((await spent(accountId, [...ids], windowStart(lim.interval, now), lim.categories)) + amount > lim.amount) return 'spending_controls';
    }
  }
  if ((await availableIn(accountId, card.currency)) < amount) return 'insufficient_funds';
  return null;
}

const REASON_MESSAGE: Record<string, string> = {
  card_inactive: 'The card is inactive.', card_canceled: 'The card is canceled.', cardholder_inactive: 'The cardholder is inactive.',
  spending_controls: 'The authorization exceeds the spending controls on the card or cardholder.', insufficient_funds: 'The Issuing balance does not have enough funds.',
  webhook_declined: 'Declined by your issuing_authorization.request webhook.', webhook_timeout: 'Your issuing_authorization.request webhook did not respond within 2 seconds.',
  webhook_error: 'Your issuing_authorization.request webhook responded with an error or an invalid body.', webhook_approved: 'Approved by your issuing_authorization.request webhook.', card_active: 'The card is active and within its controls.',
};

/** Real-time authorization: send the request event synchronously to listening endpoints. */
async function realtime(ctx: Ctx, auth: any): Promise<{ reason: string; approved: boolean; amount?: number } | null> {
  const eps = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'webhook_endpoint' AND data->>'status' = 'enabled'", [ctx.accountId]);
  const ep = eps.map((r) => r.data).find((e) => (e.enabled_events ?? []).includes('issuing_authorization.request'));
  if (!ep) return null;
  const evt = await emit(ctx, 'issuing_authorization.request', auth);
  const payload = JSON.stringify({ ...stripInternal(evt), data: { object: stripInternal(auth) } }, null, 2);
  try {
    const res = await fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': sign(payload, ep.secret), 'user-agent': 'Tessera/1.0 (+webhooks)' }, body: payload, signal: AbortSignal.timeout(config.issuingWebhookTimeoutMs) });
    if (res.status < 200 || res.status >= 300) return { reason: 'webhook_error', approved: false };
    const body: any = await res.json().catch(() => null);
    if (!body || typeof body.approved !== 'boolean') return { reason: 'webhook_error', approved: false };
    return { reason: body.approved ? 'webhook_approved' : 'webhook_declined', approved: body.approved, amount: typeof body.amount === 'number' ? body.amount : undefined };
  } catch (e: any) {
    return { reason: e?.name === 'TimeoutError' ? 'webhook_timeout' : 'webhook_error', approved: false };
  }
}

function merchantData(m: any) {
  const category = m?.category ? String(m.category) : 'miscellaneous_general_merchandise';
  if (!CATEGORIES[category]) throw invalid(`'${category}' is not a supported merchant category.`, 'merchant_data[category]');
  return {
    category, category_code: CATEGORIES[category], city: m?.city ?? 'San Francisco', country: m?.country ?? 'US', name: m?.name ?? 'Test merchant',
    network_id: m?.network_id ?? '1234567890', postal_code: m?.postal_code ?? '94103', state: m?.state ?? 'CA', terminal_id: null, url: m?.url ?? null,
  };
}

async function hold(ctx: Ctx, a: any, amount: number, release = false) {
  if (!amount) return;
  const signed = release ? -amount : amount;
  await post(ctx.accountId, a.currency, [{ account: 'issuing_available', amount: signed }, { account: 'issuing_reserved', amount: -signed }], a.id, `${release ? 'Release' : 'Hold'} for ${a.id}`);
  const t = await balanceTxn(ctx, { amount: release ? amount : -amount, currency: a.currency, type: release ? 'issuing_authorization_release' : 'issuing_authorization_hold', source: a.id, description: `${release ? 'Release of' : 'Hold for'} ${a.merchant_data.name}` });
  a.balance_transactions.push(t.id);
}

/** Test helper: the card is used at a merchant. */
export async function createAuthorization(ctx: Ctx, p: Params) {
  const card = await getObject<any>(ctx.accountId, 'issuing.card', str(p, 'card', { required: true })!, 'issuing.card', 'card');
  const ch = await getObject<any>(ctx.accountId, 'issuing.cardholder', card.cardholder);
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  const merchant = merchantData(p.merchant_data);
  const now = nowSeconds();
  const method = oneOf(p, 'authorization_method', ['chip', 'contactless', 'keyed_in', 'online', 'swipe'] as const, 'online')!;
  const a: any = {
    id: newId('iauth'),
    object: 'issuing.authorization',
    amount: 0,
    amount_details: { atm_fee: null, cashback_amount: null },
    approved: false,
    authorization_method: method,
    balance_transactions: [] as string[],
    card: stripInternal(card),
    cardholder: ch.id,
    created: now,
    currency: card.currency,
    livemode: false,
    merchant_amount: amount,
    merchant_currency: card.currency,
    merchant_data: merchant,
    metadata: {},
    network_data: { acquiring_institution_id: '000000', system_trace_audit_number: String(100000 + Math.floor(Math.random() * 899999)), transaction_id: base62(15) },
    pending_request: { amount, amount_details: { atm_fee: null, cashback_amount: null }, currency: card.currency, is_amount_controllable: bool(p, 'is_amount_controllable') ?? false, merchant_amount: amount, merchant_currency: card.currency },
    request_history: [] as any[],
    status: 'pending',
    transactions: [] as string[],
    verification_data: { address_line1_check: 'not_provided', address_postal_code_check: 'match', cvc_check: method === 'online' || method === 'keyed_in' ? 'match' : 'not_provided', expiry_check: 'match' },
    wallet: oneOf(p, 'wallet', ['apple_pay', 'google_pay', 'samsung_pay'] as const) ?? null,
    _card_id: card.id,
  };
  let reason = await controlsDecision(ctx.accountId, card, ch, amount, merchant, now);
  let approvedAmount = amount;
  if (!reason) {
    const rt = await realtime(ctx, a);
    if (rt) {
      reason = rt.approved ? null : rt.reason;
      if (rt.approved && rt.amount !== undefined && a.pending_request.is_amount_controllable) approvedAmount = Math.min(amount, Math.max(1, rt.amount));
      a._rt_reason = rt.reason;
    }
  }
  const approved = !reason;
  a.request_history.push({ amount: approved ? approvedAmount : amount, amount_details: a.pending_request.amount_details, approved, authorization_code: approved ? String(100000 + Math.floor(Math.random() * 899999)) : null, created: now, currency: card.currency, merchant_amount: amount, merchant_currency: card.currency, reason: reason ?? a._rt_reason ?? 'card_active', reason_message: REASON_MESSAGE[reason ?? a._rt_reason ?? 'card_active'] ?? null, requested_at: now });
  a.pending_request = null;
  a.approved = approved;
  if (approved) {
    a.amount = approvedAmount;
    await hold(ctx, a, approvedAmount);
  } else {
    a.status = 'closed';
  }
  delete a._rt_reason;
  await insertObject(ctx.accountId, a);
  await emit(ctx, 'issuing_authorization.created', a);
  return a;
}

async function pendingAuth(ctx: Ctx, id: string) {
  const a = await getObject<any>(ctx.accountId, 'issuing.authorization', id, 'issuing.authorization');
  if (a.status !== 'pending') throw invalid(`This authorization is ${a.status}.`, 'authorization', 'issuing_authorization_not_pending');
  return a;
}

async function transaction(ctx: Ctx, t: { type: 'capture' | 'refund'; amount: number; card: any; cardholder: string; authorization: string | null; merchant: any; currency: string }) {
  // Captures debit the Issuing balance (negative amount); refunds credit it.
  const signed = t.type === 'capture' ? -t.amount : t.amount;
  const id = newId('ipi');
  await post(ctx.accountId, t.currency, [{ account: 'issuing_available', amount: -signed }, { account: 'cash', amount: signed }], id, `Issuing ${t.type} ${id}`);
  const bt = await balanceTxn(ctx, { amount: signed, currency: t.currency, type: 'issuing_transaction', source: id, description: `${t.type === 'capture' ? 'Purchase at' : 'Refund from'} ${t.merchant.name}` });
  const txn = {
    id, object: 'issuing.transaction', amount: signed, amount_details: { atm_fee: null, cashback_amount: null }, authorization: t.authorization, balance_transaction: bt.id,
    card: t.card.id, cardholder: t.cardholder, created: nowSeconds(), currency: t.currency, dispute: null, livemode: false, merchant_amount: signed, merchant_currency: t.currency,
    merchant_data: t.merchant, metadata: {}, network_data: { authorization_code: null, processing_date: new Date().toISOString().slice(0, 10), transaction_id: base62(15) }, purchase_details: null, type: t.type, wallet: null,
  };
  await insertObject(ctx.accountId, txn);
  await emit(ctx, 'issuing_transaction.created', txn);
  return txn;
}

export async function captureAuthorization(ctx: Ctx, id: string, p: Params) {
  const a = await pendingAuth(ctx, id);
  if (!a.approved) throw invalid('Declined authorizations cannot be captured.', 'authorization');
  const amount = int(p, 'capture_amount', { min: 1 }) ?? a.amount;
  const close = p.close_authorization === undefined ? true : String(p.close_authorization) === 'true';
  const card = await getObject<any>(ctx.accountId, 'issuing.card', a._card_id);
  await hold(ctx, a, close ? a.amount : Math.min(amount, a.amount), true);
  const t = await transaction(ctx, { type: 'capture', amount, card, cardholder: a.cardholder, authorization: a.id, merchant: a.merchant_data, currency: a.currency });
  a.transactions.push(t.id);
  a._captured = (a._captured ?? 0) + amount;
  if (close) a.status = 'closed';
  else a.amount = Math.max(0, a.amount - amount);
  await saveObject(ctx.accountId, a);
  await emit(ctx, 'issuing_authorization.updated', a);
  return a;
}

export async function expireAuthorization(ctx: Ctx, id: string) {
  const a = await pendingAuth(ctx, id);
  await hold(ctx, a, a.amount, true);
  a.status = 'expired';
  await saveObject(ctx.accountId, a);
  await emit(ctx, 'issuing_authorization.updated', a);
  return a;
}

export async function incrementAuthorization(ctx: Ctx, id: string, p: Params) {
  const a = await pendingAuth(ctx, id);
  const inc = int(p, 'increment_amount', { required: true, min: 1 })!;
  const card = await getObject<any>(ctx.accountId, 'issuing.card', a._card_id);
  const ch = await getObject<any>(ctx.accountId, 'issuing.cardholder', a.cardholder);
  const reason = await controlsDecision(ctx.accountId, card, ch, inc, a.merchant_data, nowSeconds());
  a.request_history.push({ amount: a.amount + inc, amount_details: a.amount_details, approved: !reason, authorization_code: null, created: nowSeconds(), currency: a.currency, merchant_amount: a.merchant_amount + inc, merchant_currency: a.currency, reason: reason ?? 'card_active', reason_message: REASON_MESSAGE[reason ?? 'card_active'] ?? null, requested_at: nowSeconds() });
  if (!reason) {
    await hold(ctx, a, inc);
    a.amount += inc;
    a.merchant_amount += inc;
  }
  await saveObject(ctx.accountId, a);
  await emit(ctx, 'issuing_authorization.updated', a);
  return a;
}

export async function reverseAuthorization(ctx: Ctx, id: string, p: Params) {
  const a = await pendingAuth(ctx, id);
  const amount = Math.min(int(p, 'reverse_amount', { min: 1 }) ?? a.amount, a.amount);
  await hold(ctx, a, amount, true);
  a.amount -= amount;
  if (a.amount === 0) a.status = 'reversed';
  await saveObject(ctx.accountId, a);
  await emit(ctx, 'issuing_authorization.updated', a);
  return a;
}

/** Test helpers: transactions without an authorization (force capture) and refunds. */
export async function forceCapture(ctx: Ctx, p: Params, type: 'capture' | 'refund') {
  const card = await getObject<any>(ctx.accountId, 'issuing.card', str(p, 'card', { required: true })!, 'issuing.card', 'card');
  return transaction(ctx, { type, amount: int(p, 'amount', { required: true, min: 1 })!, card, cardholder: card.cardholder, authorization: null, merchant: merchantData(p.merchant_data), currency: str(p, 'currency') ?? card.currency });
}

export async function refundTransaction(ctx: Ctx, id: string, p: Params) {
  const t = await getObject<any>(ctx.accountId, 'issuing.transaction', id, 'issuing.transaction');
  if (t.type !== 'capture') throw invalid('Only capture transactions can be refunded.', 'transaction');
  const amount = int(p, 'refund_amount', { min: 1 }) ?? -t.amount;
  if (amount > -t.amount) throw new ApiError(400, 'invalid_request_error', `The refund amount (${amount}) is more than the purchase (${-t.amount}).`, { param: 'refund_amount' });
  const card = await getObject<any>(ctx.accountId, 'issuing.card', t.card);
  const r = await transaction(ctx, { type: 'refund', amount, card, cardholder: t.cardholder, authorization: t.authorization, merchant: t.merchant_data, currency: t.currency });
  if (t.authorization) {
    const a = await getObject<any>(ctx.accountId, 'issuing.authorization', t.authorization);
    a.transactions.push(r.id);
    await saveObject(ctx.accountId, a);
  }
  return r;
}

// ---------------- disputes (cardholder disputes a purchase with the merchant's bank) ----------------

const DISPUTE_REASONS = ['canceled', 'duplicate', 'fraudulent', 'merchandise_not_as_described', 'no_valid_authorization', 'not_received', 'other', 'service_not_as_described'] as const;

function evidence(p: any, existing?: any) {
  if (!p) return existing ?? { reason: 'other', other: { additional_documentation: null, explanation: null, product_description: null, product_type: null } };
  const reason = oneOf(p, 'reason', DISPUTE_REASONS) ?? existing?.reason ?? 'other';
  const detail = p[reason] ?? existing?.[reason] ?? {};
  return { reason, [reason]: { additional_documentation: null, explanation: detail.explanation ?? null, ...Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, v === '' ? null : v])) } };
}

export async function createIssuingDispute(ctx: Ctx, p: Params) {
  const t = await getObject<any>(ctx.accountId, 'issuing.transaction', str(p, 'transaction', { required: true })!, 'issuing.transaction', 'transaction');
  if (t.type !== 'capture') throw invalid('Only purchases (capture transactions) can be disputed.', 'transaction');
  if (t.dispute) throw invalid(`This transaction already has a dispute (${t.dispute}).`, 'transaction', 'issuing_transaction_already_disputed');
  const amount = int(p, 'amount', { min: 1 }) ?? -t.amount;
  if (amount > -t.amount) throw invalid(`You can dispute at most ${-t.amount}.`, 'amount');
  const d = {
    id: newId('idp'), object: 'issuing.dispute', amount, balance_transactions: [] as string[], created: nowSeconds(), currency: t.currency,
    evidence: evidence(p.evidence), livemode: false, loss_reason: null as string | null, metadata: metadata(p), status: 'unsubmitted', transaction: t.id, treasury: null,
    _resolve_at: null as number | null,
  };
  await insertObject(ctx.accountId, d);
  t.dispute = d.id;
  await saveObject(ctx.accountId, t);
  await emit(ctx, 'issuing_dispute.created', d);
  return d;
}

export async function updateIssuingDispute(ctx: Ctx, id: string, p: Params) {
  const d = await getObject<any>(ctx.accountId, 'issuing.dispute', id, 'issuing.dispute');
  if (d.status !== 'unsubmitted') throw invalid('Only unsubmitted disputes can be updated.', 'dispute', 'issuing_dispute_not_editable');
  if (p.evidence) d.evidence = evidence(p.evidence, d.evidence);
  if (p.amount !== undefined) d.amount = int(p, 'amount', { min: 1 });
  d.metadata = metadata(p, d.metadata);
  await saveObject(ctx.accountId, d);
  await emit(ctx, 'issuing_dispute.updated', d);
  return d;
}

/** Submitting sends the evidence to the network. In test mode, an explanation containing `losing_evidence` loses; anything else wins. */
export async function submitIssuingDispute(ctx: Ctx, id: string, p: Params) {
  const d = await getObject<any>(ctx.accountId, 'issuing.dispute', id, 'issuing.dispute');
  if (d.status !== 'unsubmitted') throw invalid(`This dispute is already ${d.status}.`, 'dispute', 'issuing_dispute_already_submitted');
  if (!d.evidence?.[d.evidence.reason]?.explanation && d.evidence.reason !== 'fraudulent') throw invalid(`Add evidence[${d.evidence.reason}][explanation] before submitting.`, 'evidence', 'issuing_dispute_evidence_missing');
  d.status = 'submitted';
  d.metadata = metadata(p, d.metadata);
  d._resolve_at = nowSeconds() + config.disputeReviewSeconds;
  await saveObject(ctx.accountId, d);
  await emit(ctx, 'issuing_dispute.submitted', d);
  return d;
}

export async function resolveIssuingDisputes(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'issuing.dispute' AND data->>'status' = 'submitted' ORDER BY seq LIMIT 100");
  const { accountCtx } = await import('./connect/accounts.ts');
  let n = 0;
  for (const { account_id, data: d } of rows) {
    if (!d._resolve_at || d._resolve_at > now) continue;
    const ctx = accountCtx(account_id);
    const text = JSON.stringify(d.evidence);
    if (text.includes('losing_evidence')) {
      d.status = 'lost';
      d.loss_reason = 'merchant_provided_evidence';
    } else {
      d.status = 'won';
      await post(account_id, d.currency, [{ account: 'cash', amount: d.amount }, { account: 'issuing_available', amount: -d.amount }], d.id, `Issuing dispute won ${d.id}`);
      const bt = await balanceTxn(ctx, { amount: d.amount, currency: d.currency, type: 'issuing_dispute', source: d.id, description: 'Dispute won: funds returned to the Issuing balance' });
      d.balance_transactions.push(bt.id);
    }
    d._resolve_at = null;
    await saveObject(account_id, d);
    await emit(ctx, 'issuing_dispute.closed', d);
    if (d.status === 'won') await emit(ctx, 'issuing_dispute.funds_reinstated', d);
    n++;
  }
  return n;
}
