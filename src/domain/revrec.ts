import { query } from '../db/index.ts';
import { invalid } from '../lib/errors.ts';
import { nowSeconds } from '../lib/ids.ts';
import { int, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';

/**
 * Revenue recognition (accrual accounting) derived from invoices, payments, refunds and
 * credit notes. Every event becomes balanced double-entry journal lines:
 *
 *   invoice finalized   Dr AccountsReceivable      Cr DeferredRevenue (service-period lines)
 *                                                  Cr Revenue (point-in-time lines)
 *                                                  Cr TaxLiability
 *   service period      Dr DeferredRevenue         Cr Revenue          (ratably, by second)
 *   invoice paid        Dr Cash                    Cr AccountsReceivable
 *   credit note         Dr CreditNotes (contra)    Cr AccountsReceivable
 *   payment w/o invoice Dr Cash                    Cr Revenue
 *   refund              Dr Refunds (contra)        Cr Cash   (credit-note refunds: Dr AR)
 *   uncollectible       Dr BadDebt                 Cr AccountsReceivable
 *
 * A line whose period spans more than a day is recognized evenly over that period; other
 * lines are recognized when the invoice is finalized. Voided invoices are ignored. Months are
 * calendar months in UTC. Amounts are in minor units of the invoice currency.
 */

export type Journal = {
  booked: number; debit: string; credit: string; amount: number; currency: string; kind: string;
  invoice?: string | null; line?: string | null; product?: string | null; customer?: string | null; charge?: string | null; source: string;
};

const DAY = 86400;

const monthStart = (t: number) => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };
const nextMonth = (t: number) => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; };
export const monthKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);

/** Splits `amount` over [start, end) by calendar month, proportional to seconds. */
export function splitByMonth(amount: number, start: number, end: number): { at: number; amount: number }[] {
  const total = end - start;
  const out: { at: number; amount: number }[] = [];
  let given = 0;
  for (let m = monthStart(start); m < end; m = nextMonth(m)) {
    const a = Math.max(start, m), b = Math.min(end, nextMonth(m));
    if (b <= a) continue;
    const isLast = nextMonth(m) >= end;
    const part = isLast ? amount - given : Math.round((amount * (b - a)) / total);
    given += part;
    // Book recognition at the end of the slice (or the period end) so a month only
    // recognizes service already delivered.
    out.push({ at: b - 1, amount: part });
  }
  return out;
}

async function all(accountId: string, type: string) {
  return (await query<{ data: any }>('SELECT data FROM objects WHERE account_id = $1 AND type = $2 ORDER BY seq', [accountId, type])).map((r) => r.data);
}

export async function journal(accountId: string): Promise<Journal[]> {
  const out: Journal[] = [];
  const prices = new Map((await all(accountId, 'price')).map((p) => [p.id, p]));
  const productOf = (price: any) => (typeof price === 'string' ? prices.get(price)?.product : price?.product) ?? null;
  const invoices = (await all(accountId, 'invoice')).filter((i) => i.status_transitions?.finalized_at && i.status !== 'void');
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const add = (j: Journal) => { if (j.amount !== 0) out.push(j); };

  for (const inv of invoices) {
    const fin = inv.status_transitions.finalized_at as number;
    const cur = inv.currency;
    let lineTotal = 0;
    for (const l of inv.lines?.data ?? []) {
      const discounts = (l.discount_amounts ?? []).reduce((s: number, d: any) => s + d.amount, 0);
      const net = l.amount - discounts;
      lineTotal += net;
      const refs = { invoice: inv.id, line: l.id, product: productOf(l.price), customer: inv.customer, source: inv.id, currency: cur };
      const span = l.period && l.period.end - l.period.start > DAY;
      if (!span) { add({ ...refs, booked: fin, debit: 'AccountsReceivable', credit: 'Revenue', amount: net, kind: 'invoice_line' }); continue; }
      add({ ...refs, booked: fin, debit: 'AccountsReceivable', credit: 'DeferredRevenue', amount: net, kind: 'invoice_line_deferred' });
      for (const s of splitByMonth(net, l.period.start, l.period.end)) {
        // Service delivered before the invoice is recognized when the invoice is finalized.
        add({ ...refs, booked: Math.max(s.at, fin), debit: 'DeferredRevenue', credit: 'Revenue', amount: s.amount, kind: 'recognition' });
      }
    }
    const tax = (inv.total ?? lineTotal) - lineTotal;
    add({ booked: fin, debit: 'AccountsReceivable', credit: 'TaxLiability', amount: tax, currency: cur, kind: 'tax', invoice: inv.id, customer: inv.customer, source: inv.id });
    if (inv.status_transitions.paid_at && inv.amount_paid) {
      add({ booked: inv.status_transitions.paid_at, debit: 'Cash', credit: 'AccountsReceivable', amount: inv.amount_paid, currency: cur, kind: 'payment', invoice: inv.id, customer: inv.customer, source: inv.id });
    }
    if (inv.status === 'uncollectible' && inv.status_transitions.marked_uncollectible_at) {
      add({ booked: inv.status_transitions.marked_uncollectible_at, debit: 'BadDebt', credit: 'AccountsReceivable', amount: inv.amount_remaining ?? inv.amount_due, currency: cur, kind: 'uncollectible', invoice: inv.id, customer: inv.customer, source: inv.id });
    }
  }

  const creditNoteRefunds = new Set<string>();
  for (const cn of await all(accountId, 'credit_note')) {
    if (cn.status === 'void') continue;
    for (const r of cn.refunds ?? []) creditNoteRefunds.add(r.refund);
    add({ booked: cn.effective_at ?? cn.created, debit: 'CreditNotes', credit: 'AccountsReceivable', amount: cn.total_excluding_tax ?? cn.total, currency: cn.currency, kind: 'credit_note', invoice: cn.invoice, customer: cn.customer, source: cn.id });
    const cnTax = cn.total - (cn.total_excluding_tax ?? cn.total);
    add({ booked: cn.effective_at ?? cn.created, debit: 'TaxLiability', credit: 'AccountsReceivable', amount: cnTax, currency: cn.currency, kind: 'credit_note_tax', invoice: cn.invoice, customer: cn.customer, source: cn.id });
  }

  const pis = new Map((await all(accountId, 'payment_intent')).map((p) => [p.id, p]));
  const charges = await all(accountId, 'charge');
  const chargeInvoice = new Map<string, string | null>();
  for (const ch of charges) {
    const inv = (ch.payment_intent && pis.get(ch.payment_intent)?.invoice) ?? ch.invoice ?? null;
    chargeInvoice.set(ch.id, inv);
    if (ch.status !== 'succeeded' || (inv && invoiceIds.has(inv))) continue;
    add({ booked: ch.created, debit: 'Cash', credit: 'Revenue', amount: ch.amount_captured ?? ch.amount, currency: ch.currency, kind: 'payment', charge: ch.id, customer: ch.customer ?? null, source: ch.id });
  }
  for (const re of await all(accountId, 'refund')) {
    if (re.status === 'failed' || re.status === 'canceled') continue;
    const viaCreditNote = creditNoteRefunds.has(re.id);
    add({ booked: re.created, debit: viaCreditNote ? 'AccountsReceivable' : 'Refunds', credit: 'Cash', amount: re.amount, currency: re.currency, kind: 'refund', charge: re.charge, invoice: re.charge ? chargeInvoice.get(re.charge) ?? null : null, source: re.id });
  }
  return out.sort((a, b) => a.booked - b.booked);
}

const REVENUE_ACCOUNTS = ['Revenue', 'Refunds', 'CreditNotes'];

function effect(j: Journal, account: string) { return (j.credit === account ? j.amount : 0) - (j.debit === account ? j.amount : 0); }

/** Monthly summary: billed, recognized, contra revenue and the deferred revenue roll-forward. */
export async function summary(ctx: Ctx, p: Params) {
  const now = nowSeconds();
  const start = monthStart(int(p, 'interval_start') ?? monthStart(now - 150 * DAY));
  const end = int(p, 'interval_end') ?? nextMonth(now);
  if (end <= start) throw invalid('interval_end must be after interval_start.', 'interval_end');
  const currency = String(p.currency ?? 'usd').toLowerCase();
  const js = (await journal(ctx.accountId)).filter((j) => j.currency === currency);
  const months: any[] = [];
  for (let m = start; m < end; m = nextMonth(m)) {
    const e = nextMonth(m);
    const before = js.filter((j) => j.booked < m);
    const inMonth = js.filter((j) => j.booked >= m && j.booked < e);
    const sum = (xs: Journal[], acct: string) => xs.reduce((s, j) => s + effect(j, acct), 0);
    const recognized = sum(inMonth, 'Revenue');
    const refunds = -sum(inMonth, 'Refunds');
    const credits = -sum(inMonth, 'CreditNotes');
    const billed = inMonth.filter((j) => j.debit === 'AccountsReceivable' && (j.credit === 'Revenue' || j.credit === 'DeferredRevenue')).reduce((s, j) => s + j.amount, 0);
    months.push({
      month: monthKey(m), start: m, end: e, future: m > now,
      billed, recognized, refunds, credit_notes: credits, bad_debt: inMonth.filter((j) => j.debit === 'BadDebt').reduce((s, j) => s + j.amount, 0),
      net_revenue: recognized - refunds - credits,
      deferred_revenue_start: sum(before, 'DeferredRevenue'), deferred_revenue_end: sum(before, 'DeferredRevenue') + sum(inMonth, 'DeferredRevenue'),
      accounts_receivable_end: -(sum(before, 'AccountsReceivable') + sum(inMonth, 'AccountsReceivable')),
    });
  }
  const upToNow = js.filter((j) => j.booked < now);
  const byProduct = new Map<string, { product: string | null; recognized: number; deferred: number }>();
  for (const j of js) {
    if (j.kind !== 'invoice_line' && j.kind !== 'invoice_line_deferred' && j.kind !== 'recognition') continue;
    const k = j.product ?? '';
    const row = byProduct.get(k) ?? { product: j.product ?? null, recognized: 0, deferred: 0 };
    if (j.booked < now) { row.recognized += effect(j, 'Revenue'); row.deferred += effect(j, 'DeferredRevenue'); }
    byProduct.set(k, row);
  }
  const names = new Map((await all(ctx.accountId, 'product')).map((p) => [p.id, p.name]));
  return {
    object: 'revenue_recognition.summary', currency, interval_start: start, interval_end: end, as_of: now,
    totals: {
      recognized_to_date: upToNow.reduce((s, j) => s + effect(j, 'Revenue'), 0),
      deferred_revenue: upToNow.reduce((s, j) => s + effect(j, 'DeferredRevenue'), 0),
      accounts_receivable: -upToNow.reduce((s, j) => s + effect(j, 'AccountsReceivable'), 0),
      contra_revenue: -upToNow.reduce((s, j) => s + effect(j, 'Refunds') + effect(j, 'CreditNotes'), 0),
    },
    months,
    products: [...byProduct.values()].map((r) => ({ ...r, name: r.product ? names.get(r.product) ?? r.product : 'Payments without an invoice' })).sort((a, b) => b.recognized - a.recognized),
    journal_lines: js.length,
  };
}

/** Rows for the revenue_recognition.* report types. */
export async function reportRows(accountId: string, type: string, params: any) {
  const { interval_start: start, interval_end: end, currency } = params;
  const major = (n: number) => (n / 100).toFixed(2);
  const js = (await journal(accountId)).filter((j) => (!currency || j.currency === currency));
  if (type === 'revenue_recognition.debits_and_credits.1') {
    return js.filter((j) => j.booked >= start && j.booked < end).map((j) => ({
      accounting_period: monthKey(j.booked), booked_date: new Date(j.booked * 1000).toISOString().slice(0, 10), debit_gl_account: j.debit, credit_gl_account: j.credit,
      amount: major(j.amount), currency: j.currency, event_type: j.kind, invoice_id: j.invoice ?? '', invoice_line_item_id: j.line ?? '', product_id: j.product ?? '', customer_id: j.customer ?? '', charge_id: j.charge ?? '', source_id: j.source,
    }));
  }
  // revenue_recognition.summary.1: one row per month and currency.
  const rows: Record<string, unknown>[] = [];
  const curs = [...new Set(js.map((j) => j.currency))].sort();
  for (const cur of curs.length ? curs : ['usd']) {
    for (let m = monthStart(start); m < end; m = nextMonth(m)) {
      const e = nextMonth(m);
      const mine = js.filter((j) => j.currency === cur);
      const inM = mine.filter((j) => j.booked >= m && j.booked < e);
      const s = (xs: Journal[], a: string) => xs.reduce((t, j) => t + effect(j, a), 0);
      const recognized = s(inM, 'Revenue');
      rows.push({
        accounting_period: monthKey(m), currency: cur, recognized_revenue: major(recognized), refunds: major(-s(inM, 'Refunds')), credit_notes: major(-s(inM, 'CreditNotes')),
        net_revenue: major(recognized + s(inM, 'Refunds') + s(inM, 'CreditNotes')), deferred_revenue_ending: major(s(mine.filter((j) => j.booked < e), 'DeferredRevenue')),
      });
    }
  }
  return rows;
}

export const REVREC_REPORTS = {
  'revenue_recognition.debits_and_credits.1': { name: 'Revenue recognition: debits and credits', columns: ['accounting_period', 'booked_date', 'debit_gl_account', 'credit_gl_account', 'amount', 'currency', 'event_type', 'invoice_id', 'invoice_line_item_id', 'product_id', 'customer_id', 'charge_id', 'source_id'] },
  'revenue_recognition.summary.1': { name: 'Revenue recognition: monthly summary', columns: ['accounting_period', 'currency', 'recognized_revenue', 'refunds', 'credit_notes', 'net_revenue', 'deferred_revenue_ending'] },
};
