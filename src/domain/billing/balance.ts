import { invalid } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { currency, int, metadata, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { diff, emit } from '../events.ts';
import { getObject, insertObject, saveObject } from '../store.ts';
import { clockTime } from './clocks.ts';

/**
 * Customer balance (invoice credit balance).
 *
 * `customer.balance` is in the customer's currency: negative means credit the customer can
 * spend, positive means an amount they owe that the next invoice collects. Every change is a
 * `customer_balance_transaction`: manual adjustments, credit notes, and the amount applied to
 * (or returned from) an invoice. Finalizing an invoice applies the balance, which is why an
 * invoice has `starting_balance`, `ending_balance` and an `amount_due` lower than its total.
 */

export type BalanceTxnType =
  | 'adjustment' | 'applied_to_invoice' | 'credit_note' | 'initial' | 'invoice_overpaid'
  | 'invoice_too_large' | 'invoice_too_small' | 'unapplied_from_invoice' | 'unspent_receiver_credit';

/** Records a balance change and moves the customer's balance. */
export async function recordBalanceTxn(ctx: Ctx, customer: any, t: { amount: number; currency: string; type: BalanceTxnType; description?: string | null; invoice?: string | null; credit_note?: string | null; metadata?: Record<string, string> }) {
  if (customer.currency && customer.currency !== t.currency) {
    throw invalid(`The customer's balance is in ${customer.currency.toUpperCase()}; this change is in ${t.currency.toUpperCase()}.`, 'currency', 'customer_currency_mismatch');
  }
  const before = structuredClone(customer);
  customer.currency ??= t.currency;
  customer.balance = (customer.balance ?? 0) + t.amount;
  const now = await clockTime(ctx.accountId, customer.test_clock);
  const txn = {
    id: newId('cbtxn'),
    object: 'customer_balance_transaction',
    amount: t.amount,
    created: now,
    credit_note: t.credit_note ?? null,
    currency: t.currency,
    customer: customer.id,
    description: t.description ?? null,
    ending_balance: customer.balance,
    invoice: t.invoice ?? null,
    livemode: false,
    metadata: t.metadata ?? {},
    type: t.type,
  };
  await insertObject(ctx.accountId, txn);
  await saveObject(ctx.accountId, customer);
  await emit(ctx, 'customer_balance_transaction.created', txn);
  await emit(ctx, 'customer.updated', customer, diff(before, customer));
  return txn;
}

/** POST /v1/customers/:id/balance_transactions — a manual adjustment (negative = credit). */
export async function createAdjustment(ctx: Ctx, customerId: string, p: Params) {
  const customer = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer', 'customer');
  const amount = int(p, 'amount', { required: true })!;
  if (amount === 0) throw invalid('amount must not be zero.', 'amount');
  return recordBalanceTxn(ctx, customer, { amount, currency: currency(p)!, type: 'adjustment', description: str(p, 'description', { max: 350 }) ?? null, metadata: metadata(p) });
}

export async function updateBalanceTxn(ctx: Ctx, customerId: string, id: string, p: Params) {
  const t = await getObject<any>(ctx.accountId, 'customer_balance_transaction', id, 'customer balance transaction');
  if (t.customer !== customerId) throw invalid(`No such customer balance transaction: '${id}'`, 'id', 'resource_missing');
  if (p.description !== undefined) t.description = p.description === '' ? null : String(p.description).slice(0, 350);
  t.metadata = metadata(p, t.metadata);
  await saveObject(ctx.accountId, t);
  return t;
}

/**
 * How much of the balance an invoice would use. Credit (negative balance) reduces the amount
 * due down to zero; a positive balance (the customer owes) is added to it.
 */
export function balanceEffect(customer: any, total: number, currencyCode: string) {
  const start = customer?.currency === currencyCode ? customer.balance ?? 0 : 0;
  if (!start) return { starting: 0, ending: 0, due: total };
  const combined = total + start;
  return { starting: start, ending: Math.min(0, combined), due: Math.max(0, combined) };
}

/** On finalization: take the balance into the invoice and record the change. */
export async function applyBalanceToInvoice(ctx: Ctx, inv: any) {
  const customer = await getObject<any>(ctx.accountId, 'customer', inv.customer);
  const e = balanceEffect(customer, inv.total, inv.currency);
  inv.starting_balance = e.starting;
  inv.ending_balance = e.ending;
  inv.amount_due = e.due;
  inv.amount_remaining = inv.amount_due - inv.amount_paid;
  if (e.ending !== e.starting) {
    await recordBalanceTxn(ctx, customer, { amount: e.ending - e.starting, currency: inv.currency, type: 'applied_to_invoice', invoice: inv.id });
  } else if (!customer.currency && inv.total > 0) {
    customer.currency = inv.currency;
    await saveObject(ctx.accountId, customer);
  }
}

/** Voiding an invoice gives back the balance it used. */
export async function unapplyBalanceFromInvoice(ctx: Ctx, inv: any) {
  const used = (inv.ending_balance ?? inv.starting_balance) - (inv.starting_balance ?? 0);
  if (!used) return;
  const customer = await getObject<any>(ctx.accountId, 'customer', inv.customer);
  await recordBalanceTxn(ctx, customer, { amount: -used, currency: inv.currency, type: 'unapplied_from_invoice', invoice: inv.id });
}
