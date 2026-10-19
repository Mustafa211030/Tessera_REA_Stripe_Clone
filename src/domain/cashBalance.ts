import { createHash } from 'node:crypto';
import { query } from '../db/index.ts';
import { invalid, missing } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { currency, int, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { balances, post } from './ledger.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/**
 * Customer cash balance (bank transfers).
 *
 * Each customer can get a virtual bank account (funding instructions). Money they send to it
 * lands in their cash balance; PaymentIntents that accept `customer_balance` are paid from it.
 * If the balance can't cover a payment, the PaymentIntent waits in `requires_action` with
 * `display_bank_transfer_instructions` (amount remaining, account details, reference) and any
 * funds that arrive later are applied automatically (reconciliation_mode=automatic), oldest
 * payment first — or the one whose reference the sender quoted. Partial funds are applied as
 * they come. Canceling a payment returns what was applied; refunds go back to the balance.
 *
 * Ledger: customer_cash:<customer> holds the balance; customer_cash_applied:<pi> holds funds
 * applied to a payment that isn't complete yet.
 */

function virtualAccount(customerId: string) {
  const digits = BigInt('0x' + createHash('sha256').update(`va:${customerId}`).digest('hex').slice(0, 14)).toString();
  return `9${digits.slice(0, 11).padStart(11, '0')}`;
}

export async function availableCash(accountId: string, customerId: string) {
  const b = await balances(accountId);
  const v = b[`customer_cash:${customerId}`] ?? {};
  return Object.fromEntries(Object.entries(v).filter(([, n]) => n !== 0).map(([c, n]) => [c, -n]));
}

export async function cashBalance(ctx: Ctx, customerId: string) {
  const c = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer');
  return { object: 'cash_balance', available: await availableCash(ctx.accountId, c.id), customer: c.id, livemode: false, settings: { reconciliation_mode: c._reconciliation_mode ?? 'automatic', using_merchant_default: !c._reconciliation_mode } };
}

export async function updateCashBalance(ctx: Ctx, customerId: string, p: Params) {
  const c = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer');
  const mode = oneOf(p.settings ?? {}, 'reconciliation_mode', ['automatic', 'manual', 'merchant_default'] as const);
  if (mode) c._reconciliation_mode = mode === 'merchant_default' ? undefined : mode;
  await saveObject(ctx.accountId, c);
  return cashBalance(ctx, customerId);
}

function instructions(customerId: string, cur: string) {
  return {
    bank_transfer: {
      country: 'US',
      financial_addresses: [{ aba: { account_holder_address: null, account_holder_name: 'Tessera Payments', account_number: virtualAccount(customerId), account_type: 'checking', bank_address: null, bank_name: 'Tessera Test Bank', routing_number: '110000000' }, supported_networks: ['ach', 'domestic_wire_us'], type: 'aba' }],
      type: 'us_bank_transfer',
    },
    currency: cur,
    funding_type: 'bank_transfer',
    livemode: false,
    object: 'funding_instructions',
  };
}

export async function fundingInstructions(ctx: Ctx, customerId: string, p: Params) {
  await getObject(ctx.accountId, 'customer', customerId, 'customer');
  if ((p.funding_type ?? 'bank_transfer') !== 'bank_transfer') throw invalid("funding_type must be 'bank_transfer'.", 'funding_type');
  const type = p.bank_transfer?.type;
  if (!type) throw missing('bank_transfer[type]');
  if (type !== 'us_bank_transfer') throw invalid('Only us_bank_transfer is supported.', 'bank_transfer[type]');
  return instructions(customerId, currency(p)!);
}

async function cashTxn(ctx: Ctx, customer: string, cur: string, type: string, net: number, extra: Record<string, any> = {}) {
  const t = {
    id: newId('ccsbtxn'), object: 'customer_cash_balance_transaction', created: nowSeconds(), currency: cur, customer,
    ending_balance: (await availableCash(ctx.accountId, customer))[cur] ?? 0, livemode: false, net_amount: net, type, ...extra,
  };
  await insertObject(ctx.accountId, t);
  await emit(ctx, 'customer_cash_balance_transaction.created', t);
  return t;
}

/** Test helper: the customer's bank transfer arrives. */
export async function fundCashBalance(ctx: Ctx, customerId: string, p: Params) {
  const c = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer');
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  const cur = currency(p)!;
  const reference = str(p, 'reference') ?? null;
  await post(ctx.accountId, cur, [{ account: 'cash', amount }, { account: `customer_cash:${c.id}`, amount: -amount }], `fund_${c.id}`, `Bank transfer from ${c.id}`);
  const t = await cashTxn(ctx, c.id, cur, 'funded', amount, { funded: { bank_transfer: { reference, type: 'us_bank_transfer', us_bank_transfer: { network: 'ach', sender_name: c.name ?? 'Customer' } } } });
  await emit(ctx, 'cash_balance.funds_available', { id: c.id, created: nowSeconds(), ...(await cashBalance(ctx, c.id)) } as any);
  if ((c._reconciliation_mode ?? 'automatic') === 'automatic') await reconcile(ctx, c.id, cur, reference);
  return t;
}

/** Applies available cash to waiting payments: the referenced one first, then oldest first. */
async function reconcile(ctx: Ctx, customerId: string, cur: string, reference: string | null) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'payment_intent' AND data->>'customer' = $2 AND data->>'status' = 'requires_action' AND data->>'currency' = $3 AND data->>'_cash_reference' IS NOT NULL ORDER BY seq", [ctx.accountId, customerId, cur]);
  const pis = rows.map((r) => r.data).sort((a, b) => Number(b._cash_reference === reference) - Number(a._cash_reference === reference));
  for (const pi of pis) {
    if (!((await availableCash(ctx.accountId, customerId))[cur] > 0)) break;
    const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method);
    await applyTo(ctx, pi, pm);
  }
}

async function applyTo(ctx: Ctx, pi: any, pm: any) {
  const have = (await availableCash(ctx.accountId, pi.customer))[pi.currency] ?? 0;
  const remaining = pi.amount - (pi._cash_applied ?? 0);
  const use = Math.min(have, remaining);
  if (use > 0) {
    await post(ctx.accountId, pi.currency, [{ account: `customer_cash:${pi.customer}`, amount: use }, { account: `customer_cash_applied:${pi.id}`, amount: -use }], pi.id, `Cash balance applied to ${pi.id}`);
    pi._cash_applied = (pi._cash_applied ?? 0) + use;
    await cashTxn(ctx, pi.customer, pi.currency, 'applied_to_payment', -use, { applied_to_payment: { payment_intent: pi.id } });
  }
  if (pi._cash_applied >= pi.amount) {
    // Money is already with us: turn the applied funds into the network receivable recordCapture expects to settle.
    await post(ctx.accountId, pi.currency, [{ account: `customer_cash_applied:${pi.id}`, amount: pi.amount }, { account: 'cash', amount: -pi.amount }], pi.id, `Cash balance payment ${pi.id}`);
    const { succeedOffline } = await import('./paymentIntents.ts');
    return succeedOffline(ctx, pi, pm);
  }
  pi.status = 'requires_action';
  pi.next_action = {
    display_bank_transfer_instructions: {
      amount_remaining: pi.amount - (pi._cash_applied ?? 0), currency: pi.currency,
      financial_addresses: instructions(pi.customer, pi.currency).bank_transfer.financial_addresses,
      hosted_instructions_url: `${ctx.baseUrl}/bank-transfer/${pi.id}`, reference: pi._cash_reference, type: 'us_bank_transfer',
    },
    type: 'display_bank_transfer_instructions',
  };
  await saveObject(ctx.accountId, pi);
  if (use > 0) await emit(ctx, 'payment_intent.partially_funded', pi);
  return pi;
}

export async function confirmWithCashBalance(ctx: Ctx, pi: any, p: Params, existingPm?: any) {
  if (!(pi.payment_method_types ?? []).includes('customer_balance')) throw invalid('This PaymentIntent does not accept customer_balance. Create it with allowed_payment_method_types[]=customer_balance.', 'payment_method_data[type]', 'payment_intent_incompatible_payment_method');
  if (!pi.customer) throw invalid('A customer is required to pay from a cash balance.', 'customer', 'parameter_missing');
  const opts = p.payment_method_options?.customer_balance ?? pi.payment_method_options?.customer_balance ?? {};
  if (opts.funding_type && opts.funding_type !== 'bank_transfer') throw invalid("funding_type must be 'bank_transfer'.", 'payment_method_options[customer_balance][funding_type]');
  let pm = existingPm ?? (pi.payment_method ? await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method) : null);
  if (!pm || pm.type !== 'customer_balance') {
    pm = { id: newId('pm'), object: 'payment_method', allow_redisplay: 'unspecified', billing_details: { address: null, email: null, name: null, phone: null }, created: nowSeconds(), customer: pi.customer, customer_balance: {}, livemode: false, metadata: {}, type: 'customer_balance' };
    await insertObject(ctx.accountId, pm);
  }
  pi.payment_method = pm.id;
  pi.payment_method_options = { ...(pi.payment_method_options ?? {}), customer_balance: { bank_transfer: { type: 'us_bank_transfer' }, funding_type: 'bank_transfer' } };
  pi._cash_reference ??= base62(10).toUpperCase();
  const r = await applyTo(ctx, pi, pm);
  if (r.status === 'requires_action') await emit(ctx, 'payment_intent.requires_action', r);
  return r;
}

/** Canceling a payment returns funds already applied to it. */
export async function unapplyFromPayment(ctx: Ctx, pi: any) {
  const amt = pi._cash_applied ?? 0;
  if (!amt) return;
  await post(ctx.accountId, pi.currency, [{ account: `customer_cash_applied:${pi.id}`, amount: amt }, { account: `customer_cash:${pi.customer}`, amount: -amt }], pi.id, `Cash returned from ${pi.id}`);
  pi._cash_applied = 0;
  await cashTxn(ctx, pi.customer, pi.currency, 'unapplied_from_payment', amt, { unapplied_from_payment: { payment_intent: pi.id } });
}

/** Refunds of cash-balance payments go back to the customer's cash balance. */
export async function refundToCashBalance(ctx: Ctx, refund: any, charge: any) {
  if (!charge.customer) return;
  await post(ctx.accountId, refund.currency, [{ account: 'cash', amount: refund.amount }, { account: `customer_cash:${charge.customer}`, amount: -refund.amount }], refund.id, `Refund ${refund.id} to cash balance`);
  refund.destination_details = { customer_cash_balance: {}, type: 'customer_cash_balance' };
  await cashTxn(ctx, charge.customer, refund.currency, 'refunded_from_payment', refund.amount, { refunded_from_payment: { refund: refund.id } });
}
