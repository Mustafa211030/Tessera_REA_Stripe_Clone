import { query } from '../../db/index.ts';
import { invalid, unexpectedState } from '../../lib/errors.ts';
import { nowSeconds } from '../../lib/ids.ts';
import { int, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { accountCtx } from '../connect/accounts.ts';
import { emit } from '../events.ts';
import { getObject, saveObject } from '../store.ts';

/**
 * Invoice payment plans: a send_invoice invoice split into installments.
 *
 *   amounts_due[0][amount]=5000&amounts_due[0][days_until_due]=0
 *   amounts_due[1][amount]=5000&amounts_due[1][due_date]=1767225600
 *
 * The installments must add up to amount_due when the invoice is finalized. The hosted
 * invoice page pays the next open installment (or the whole remainder). Each paid
 * installment raises amount_paid; the invoice is paid when the last one is. When an
 * installment's due date passes unpaid, invoice.overdue is sent once.
 */

const DAY = 86400;

export function setAmountsDue(inv: any, p: Params) {
  if (p.amounts_due === undefined) return;
  if (inv.status !== 'draft') throw invalid('amounts_due can only be changed while the invoice is a draft.', 'amounts_due');
  if (p.amounts_due === '' || (Array.isArray(p.amounts_due) && !p.amounts_due.length)) {
    inv._amounts_due_spec = null;
    inv.amounts_due = null;
    return;
  }
  if (inv.collection_method !== 'send_invoice') throw invalid('Payment plans need collection_method=send_invoice, so the customer pays each installment.', 'amounts_due');
  const raw: any[] = Array.isArray(p.amounts_due) ? p.amounts_due : Object.values(p.amounts_due);
  if (raw.length < 2 || raw.length > 12) throw invalid('A payment plan has between 2 and 12 installments.', 'amounts_due');
  inv._amounts_due_spec = raw.map((a, i) => {
    const amount = int(a, 'amount', { required: true, min: 50 })!;
    const due = a.due_date !== undefined ? int(a, 'due_date', { min: 1 })! : null;
    const days = a.days_until_due !== undefined ? int(a, 'days_until_due', { min: 0, max: 730 })! : null;
    if ((due === null) === (days === null)) throw invalid('Each installment needs exactly one of due_date or days_until_due.', `amounts_due[${i}]`);
    return { amount, due_date: due, days_until_due: days, description: a.description ? String(a.description).slice(0, 200) : null };
  });
  inv.amounts_due = inv._amounts_due_spec.map((s: any) => ({ ...s, amount_paid: 0, amount_remaining: s.amount, paid_at: null, status: 'open' }));
}

/** Fixes the schedule at finalization (amount_due is known after balances and credits). */
export function finalizeSchedule(inv: any, now: number) {
  const spec = inv._amounts_due_spec as any[] | null | undefined;
  if (!spec?.length) return;
  const sum = spec.reduce((s, a) => s + a.amount, 0);
  if (sum !== inv.amount_due) {
    throw invalid(`The installments add up to ${sum}, but the invoice's amount_due is ${inv.amount_due}. Adjust amounts_due so they match.`, 'amounts_due', 'invoice_amounts_due_mismatch');
  }
  const rows = spec.map((s) => ({ ...s, due_date: s.due_date ?? now + s.days_until_due * DAY }));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].due_date < rows[i - 1].due_date) throw invalid('Installment due dates must be in order.', `amounts_due[${i}]`);
  }
  inv.amounts_due = rows.map((r) => ({ amount: r.amount, amount_paid: 0, amount_remaining: r.amount, days_until_due: r.days_until_due, description: r.description, due_date: r.due_date, paid_at: null, status: 'open' }));
  inv.due_date = rows[rows.length - 1].due_date;
}

export function nextInstallment(inv: any) {
  const i = (inv.amounts_due ?? []).findIndex((a: any) => a.status === 'open');
  return i < 0 ? null : { index: i, ...inv.amounts_due[i] };
}

/** Pays the next open installment with a PaymentIntent (hosted page or the Tessera API). */
export async function payInstallment(ctx: Ctx, invIn: any, opts: { payment_method?: string; return_url?: string }) {
  const inv = await getObject<any>(ctx.accountId, 'invoice', invIn.id, 'invoice');
  if (inv.status !== 'open') throw unexpectedState(`Invoice is ${inv.status}; only open invoices can be paid.`);
  const next = nextInstallment(inv);
  if (!next) throw invalid('This invoice has no open installments.', 'invoice');
  if (!opts.payment_method) throw invalid('A payment method is required.', 'payment_method', 'parameter_missing');
  const { createPaymentIntent } = await import('../paymentIntents.ts');
  return createPaymentIntent(ctx, {
    amount: next.amount_remaining, currency: inv.currency, customer: inv.customer, payment_method: opts.payment_method,
    description: `Invoice ${inv.number} · installment ${next.index + 1} of ${inv.amounts_due.length}`,
    metadata: { invoice: inv.id, installment: String(next.index) },
    confirm: 'true', return_url: opts.return_url,
  });
}

/** PaymentIntent hook: credits one installment. Returns true when it handled the payment. */
export async function applyInstallmentPayment(ctx: Ctx, inv: any, pi: any) {
  const idx = Number(pi.metadata?.installment);
  if (!Number.isInteger(idx) || !inv.amounts_due?.[idx]) return false;
  const a = inv.amounts_due[idx];
  if (a.status === 'paid') return true;
  const now = nowSeconds();
  a.amount_paid = a.amount;
  a.amount_remaining = 0;
  a.status = 'paid';
  a.paid_at = now;
  a._payment_intent = pi.id;
  inv.amount_paid += pi.amount_received ?? pi.amount;
  inv.amount_remaining = Math.max(0, inv.amount_due - inv.amount_paid);
  inv.attempted = true;
  if (inv.amount_remaining === 0) {
    const { markPaid } = await import('./invoices.ts');
    await markPaid(ctx, inv, pi, now);
    return true;
  }
  await saveObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.updated', inv, { amount_paid: inv.amount_paid - (pi.amount_received ?? pi.amount) });
  return true;
}

/** When the whole remainder is paid at once, every open installment is settled. */
export function settleAll(inv: any, now: number) {
  for (const a of inv.amounts_due ?? []) {
    if (a.status === 'paid') continue;
    a.amount_paid = a.amount;
    a.amount_remaining = 0;
    a.status = 'paid';
    a.paid_at = now;
  }
}

/** Worker: invoice.overdue once per installment whose due date passed unpaid. */
export async function overdueInstallments(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'invoice' AND data->>'status' = 'open' AND data->'amounts_due' IS NOT NULL AND json_typeof(data->'amounts_due') = 'array'");
  let n = 0;
  for (const { account_id, data: inv } of rows) {
    let changed = false;
    for (const a of inv.amounts_due) {
      if (a.status === 'open' && a.due_date <= now && !a._overdue_sent) {
        a._overdue_sent = true;
        changed = true;
      }
    }
    if (changed) {
      await saveObject(account_id, inv);
      await emit(accountCtx(account_id), 'invoice.overdue', inv);
      n++;
    }
  }
  return n;
}
