import { query } from '../../db/index.ts';
import { invalid, missing } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { arr, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { diff, emit } from '../events.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { recordBalanceTxn } from './balance.ts';
import { clockTime } from './clocks.ts';
import { markPaid } from './invoices.ts';

/**
 * Credit notes reduce what an invoice is worth after it has been finalized.
 *
 * - On an *open* invoice (pre-payment) a credit note lowers `amount_due`; if nothing is left
 *   to pay the invoice is marked paid.
 * - On a *paid* invoice (post-payment) the credited amount goes back to the customer as a
 *   refund on the invoice's payment, as credit on their customer balance (spent by the next
 *   invoice), or "out of band" (settled outside Tessera) — any split that adds up to the total.
 *
 * Lines credit part or all of an invoice line (by quantity or amount, with that share of its
 * discount and tax) or add a custom amount. A credit note can be voided unless it refunded money.
 */

const REASONS = ['duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory'] as const;

/** Amounts already credited per invoice line by earlier (non-void) credit notes. */
async function creditedSoFar(accountId: string, invoiceId: string) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'credit_note' AND data->>'invoice' = $2 AND data->>'status' = 'issued'", [accountId, invoiceId]);
  const perLine: Record<string, number> = {};
  for (const { data: cn } of rows) for (const l of cn.lines.data) if (l.invoice_line_item) perLine[l.invoice_line_item] = (perLine[l.invoice_line_item] ?? 0) + l.amount;
  return { perLine, count: rows.length };
}

/** Works out the credit note (lines and totals) without saving anything: shared by preview and create. */
async function compute(ctx: Ctx, p: Params) {
  const invId = str(p, 'invoice', { required: true })!;
  const inv = await getObject<any>(ctx.accountId, 'invoice', invId, 'invoice', 'invoice');
  if (!['open', 'paid'].includes(inv.status)) throw invalid(`You can only create credit notes for open or paid invoices; this invoice is ${inv.status}.`, 'invoice', 'invoice_not_editable');
  const prior = await creditedSoFar(ctx.accountId, inv.id);
  const linesIn = arr(p, 'lines');
  const lines: any[] = [];
  const lineObj = (o: any) => ({ id: newId('cnli', 20), object: 'credit_note_line_item', livemode: false, discount_amount: 0, discount_amounts: [] as any[], tax_amounts: [] as any[], tax_rates: [] as string[], invoice_line_item: null, quantity: null, unit_amount: null, unit_amount_decimal: null, ...o });
  if (linesIn?.length) {
    for (let i = 0; i < linesIn.length; i++) {
      const l = linesIn[i];
      const type = oneOf(l, 'type', ['invoice_line_item', 'custom_line_item'] as const);
      if (!type) throw missing(`lines[${i}][type]`);
      if (type === 'custom_line_item') {
        const desc = str(l, 'description', { required: true, max: 500 })!;
        const unit = int(l, 'unit_amount', { required: true, min: 0 })!;
        const qty = int(l, 'quantity', { min: 1 }) ?? 1;
        lines.push(lineObj({ type, description: desc, amount: unit * qty, quantity: qty, unit_amount: unit, unit_amount_decimal: String(unit) }));
        continue;
      }
      const src = inv.lines.data.find((x: any) => x.id === l.invoice_line_item);
      if (!src) throw invalid(`No such invoice line item: '${l.invoice_line_item}'`, `lines[${i}][invoice_line_item]`, 'resource_missing');
      const left = src.amount - (prior.perLine[src.id] ?? 0) - lines.filter((x) => x.invoice_line_item === src.id).reduce((s, x) => s + x.amount, 0);
      let amount: number;
      let qty: number | null = null;
      if (l.quantity !== undefined && l.quantity !== '') {
        qty = int(l, 'quantity', { min: 1 })!;
        if (!src.quantity || qty > src.quantity) throw invalid(`You can credit at most ${src.quantity ?? 0} of this line's quantity.`, `lines[${i}][quantity]`);
        amount = Math.round((src.amount * qty) / src.quantity);
      } else if (l.amount !== undefined && l.amount !== '') {
        amount = int(l, 'amount', { min: 1 })!;
      } else {
        amount = left;
        qty = src.quantity ?? null;
      }
      if (amount > left) throw invalid(`The amount to credit for line ${src.id} (${amount}) is more than what is left to credit on it (${left}).`, `lines[${i}]`, 'credit_note_amount_too_large');
      const ratio = src.amount ? amount / src.amount : 0;
      const discount = Math.round((src.discount_amounts ?? []).reduce((s: number, d: any) => s + d.amount, 0) * ratio);
      lines.push(lineObj({
        type, description: src.description, amount, quantity: qty, invoice_line_item: src.id,
        unit_amount: qty ? Math.round(amount / qty) : null, unit_amount_decimal: qty ? String(Math.round(amount / qty)) : null,
        discount_amount: discount, discount_amounts: discount ? [{ amount: discount, discount: (src.discount_amounts[0] ?? {}).discount ?? null }] : [],
        tax_amounts: (src.tax_amounts ?? []).map((t: any) => ({ amount: Math.round(t.amount * ratio), inclusive: t.inclusive, tax_rate: t.tax_rate, taxability_reason: t.taxability_reason ?? null, taxable_amount: Math.round((t.taxable_amount ?? 0) * ratio) })),
        tax_rates: src.tax_rates ?? [],
      }));
    }
  } else if (p.amount !== undefined) {
    const amount = int(p, 'amount', { min: 1 })!;
    lines.push(lineObj({ type: 'custom_line_item', description: str(p, 'memo') ?? 'Credit', amount, quantity: 1, unit_amount: amount, unit_amount_decimal: String(amount) }));
  } else {
    throw invalid('Pass lines (what to credit) or an amount.', 'lines', 'parameter_missing');
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const discount = lines.reduce((s, l) => s + l.discount_amount, 0);
  const taxes: Record<string, any> = {};
  for (const l of lines) for (const t of l.tax_amounts) {
    const k = `${t.tax_rate}:${t.inclusive}`;
    taxes[k] ??= { amount: 0, inclusive: t.inclusive, tax_rate: t.tax_rate, taxability_reason: t.taxability_reason, taxable_amount: 0 };
    taxes[k].amount += t.amount;
    taxes[k].taxable_amount += t.taxable_amount;
  }
  const taxAmounts = Object.values(taxes);
  const exclusive = taxAmounts.filter((t) => !t.inclusive).reduce((s, t) => s + t.amount, 0);
  const inclusive = taxAmounts.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0);
  const total = subtotal - discount + exclusive;
  if (total <= 0) throw invalid('A credit note must be for a positive amount.', 'lines');

  const type = inv.status === 'paid' ? 'post_payment' : 'pre_payment';
  let refund = int(p, 'refund_amount', { min: 0 }) ?? 0;
  let credit = int(p, 'credit_amount', { min: 0 }) ?? 0;
  let oob = int(p, 'out_of_band_amount', { min: 0 }) ?? 0;
  if (type === 'pre_payment') {
    if (refund || credit || oob) throw invalid("This invoice hasn't been paid yet, so the credit note simply lowers the amount due: refund_amount, credit_amount and out_of_band_amount don't apply.", refund ? 'refund_amount' : credit ? 'credit_amount' : 'out_of_band_amount');
    if (total > inv.amount_remaining) throw invalid(`The credit note total (${total}) is more than the invoice's remaining amount due (${inv.amount_remaining}).`, 'lines', 'credit_note_amount_too_large');
  } else {
    if (!refund && !credit && !oob) credit = total; // nothing chosen: credit the customer's balance
    if (refund + credit + oob !== total) throw invalid(`refund_amount + credit_amount + out_of_band_amount must add up to the credit note total (${total}).`, 'refund_amount', 'credit_note_amount_mismatch');
    const creditable = inv.amount_paid - inv.post_payment_credit_notes_amount + Math.max(0, (inv.ending_balance ?? 0) - (inv.starting_balance ?? 0));
    if (total > creditable) throw invalid(`The credit note total (${total}) is more than what is left to credit on this invoice (${creditable}).`, 'lines', 'credit_note_amount_too_large');
    if (refund && !inv.payment_intent) throw invalid('This invoice was not paid with a payment that can be refunded. Use credit_amount or out_of_band_amount.', 'refund_amount');
  }
  void refund; void oob;
  return { inv, lines, subtotal, discount, taxAmounts, total, inclusive, type, refund, credit, oob, count: prior.count };
}

function shape(c: Awaited<ReturnType<typeof compute>>, p: Params, id: string, now: number, number: string) {
  return {
    id,
    object: 'credit_note',
    amount: c.total,
    amount_shipping: 0,
    created: now,
    currency: c.inv.currency,
    customer: c.inv.customer,
    customer_balance_transaction: null as string | null,
    discount_amount: c.discount,
    discount_amounts: c.discount ? [{ amount: c.discount, discount: c.inv.discount?.id ?? null }] : [],
    effective_at: now,
    invoice: c.inv.id,
    lines: { object: 'list', data: c.lines, has_more: false, total_count: c.lines.length, url: `/v1/credit_notes/${id}/lines` },
    livemode: false,
    memo: str(p, 'memo', { max: 5000 }) ?? null,
    metadata: metadata(p),
    number,
    out_of_band_amount: c.type === 'post_payment' ? c.oob : null,
    pdf: '',
    post_payment_amount: c.type === 'post_payment' ? c.total : 0,
    pre_payment_amount: c.type === 'pre_payment' ? c.total : 0,
    reason: oneOf(p, 'reason', REASONS) ?? null,
    refunds: [] as { amount_refunded: number; refund: string }[],
    status: 'issued',
    subtotal: c.subtotal,
    subtotal_excluding_tax: c.subtotal - c.inclusive,
    tax_amounts: c.taxAmounts,
    total: c.total,
    total_excluding_tax: c.total - c.taxAmounts.reduce((s, t) => s + t.amount, 0),
    type: c.type,
    voided_at: null as number | null,
    _credit_amount: c.credit,
    _refund_amount: c.refund,
  };
}

export async function previewCreditNote(ctx: Ctx, p: Params) {
  const c = await compute(ctx, p);
  const now = await clockTime(ctx.accountId, c.inv.test_clock);
  return shape(c, p, newId('cnp'), now, `${c.inv.number}-CN-${String(c.count + 1).padStart(2, '0')}`);
}

export async function createCreditNote(ctx: Ctx, p: Params) {
  const c = await compute(ctx, p);
  const inv = c.inv;
  const now = await clockTime(ctx.accountId, inv.test_clock);
  const id = newId('cn');
  const cn = shape(c, p, id, now, `${inv.number}-CN-${String(c.count + 1).padStart(2, '0')}`);
  cn.pdf = `${ctx.baseUrl}/credit_notes/pdf/${id}`;
  if (c.type === 'pre_payment') {
    inv.pre_payment_credit_notes_amount += c.total;
    inv.amount_due -= c.total;
    inv.amount_remaining = inv.amount_due - inv.amount_paid;
    // An unfinished payment for the old amount is canceled; the next attempt charges the new amount.
    if (inv.payment_intent) {
      const pi = await findObject<any>(ctx.accountId, 'payment_intent', inv.payment_intent);
      if (pi && !['succeeded', 'canceled', 'processing'].includes(pi.status)) {
        const { cancelPaymentIntent } = await import('../paymentIntents.ts');
        await cancelPaymentIntent(ctx, pi.id, { cancellation_reason: 'abandoned' });
        inv.payment_intent = null;
      }
    }
    await saveObject(ctx.accountId, inv);
  } else {
    inv.post_payment_credit_notes_amount += c.total;
    await saveObject(ctx.accountId, inv);
    if (c.refund) {
      const { createRefund } = await import('../refunds.ts');
      const re = await createRefund(ctx, { payment_intent: inv.payment_intent, amount: c.refund, metadata: { credit_note: id, invoice: inv.id } });
      cn.refunds.push({ amount_refunded: c.refund, refund: re.id });
    }
    if (c.credit) {
      const customer = await getObject<any>(ctx.accountId, 'customer', inv.customer);
      const t = await recordBalanceTxn(ctx, customer, { amount: -c.credit, currency: inv.currency, type: 'credit_note', credit_note: id, invoice: inv.id });
      cn.customer_balance_transaction = t.id;
    }
  }
  await insertObject(ctx.accountId, cn);
  await emit(ctx, 'credit_note.created', cn);
  if (c.type === 'pre_payment') {
    const fresh = await getObject<any>(ctx.accountId, 'invoice', inv.id);
    await emit(ctx, 'invoice.updated', fresh, { amount_due: fresh.amount_due + c.total });
    if (fresh.amount_due === 0 && fresh.status === 'open') await markPaid(ctx, fresh, null, now, false);
  }
  return cn;
}

export async function updateCreditNote(ctx: Ctx, id: string, p: Params) {
  const cn = await getObject<any>(ctx.accountId, 'credit_note', id, 'credit note');
  const before = structuredClone(cn);
  if (p.memo !== undefined) cn.memo = p.memo === '' ? null : String(p.memo).slice(0, 5000);
  cn.metadata = metadata(p, cn.metadata);
  await saveObject(ctx.accountId, cn);
  await emit(ctx, 'credit_note.updated', cn, diff(before, cn));
  return cn;
}

export async function voidCreditNote(ctx: Ctx, id: string) {
  const cn = await getObject<any>(ctx.accountId, 'credit_note', id, 'credit note');
  if (cn.status !== 'issued') throw invalid('This credit note is already void.', 'credit_note');
  if (cn.refunds.length) throw invalid('A credit note that refunded a payment cannot be voided.', 'credit_note', 'credit_note_has_refunds');
  const inv = await getObject<any>(ctx.accountId, 'invoice', cn.invoice);
  const now = await clockTime(ctx.accountId, inv.test_clock);
  if (cn.type === 'pre_payment') {
    if (inv.status !== 'open') throw invalid(`The invoice is ${inv.status}; only credit notes on open invoices can be voided.`, 'credit_note');
    inv.pre_payment_credit_notes_amount -= cn.total;
    inv.amount_due += cn.total;
    inv.amount_remaining = inv.amount_due - inv.amount_paid;
    await saveObject(ctx.accountId, inv);
  } else {
    inv.post_payment_credit_notes_amount -= cn.total;
    await saveObject(ctx.accountId, inv);
    if (cn._credit_amount) {
      const customer = await getObject<any>(ctx.accountId, 'customer', inv.customer);
      await recordBalanceTxn(ctx, customer, { amount: cn._credit_amount, currency: cn.currency, type: 'credit_note', credit_note: cn.id, invoice: inv.id, description: `Voided credit note ${cn.number}` });
    }
  }
  cn.status = 'void';
  cn.voided_at = now;
  await saveObject(ctx.accountId, cn);
  await emit(ctx, 'credit_note.voided', cn);
  return cn;
}
