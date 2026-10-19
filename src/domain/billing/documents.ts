import { getAccount } from '../accounts.ts';
import { ZERO_DECIMAL } from '../fx.ts';
import { findObject } from '../store.ts';
import { documentPdf } from '../../lib/pdf.ts';

const fmt = (amount: number, cur: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(ZERO_DECIMAL.has(cur) ? amount : amount / 100);
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

/** The invoice PDF behind `invoice_pdf` (public link, like the hosted invoice page). */
export async function invoicePdf(accountId: string, inv: any) {
  const acct = await getAccount(accountId);
  const cur = inv.currency;
  const totals: [string, string, boolean?][] = [['Subtotal', fmt(inv.subtotal, cur)]];
  for (const d of inv.total_discount_amounts ?? []) totals.push(['Discount', `-${fmt(d.amount, cur)}`]);
  for (const t of inv.total_tax_amounts ?? []) {
    const r = await findObject<any>(accountId, 'tax_rate', t.tax_rate);
    totals.push([t.taxability_reason === 'reverse_charge' ? `${r?.display_name ?? 'VAT'} - reverse charge` : `${r?.display_name ?? 'Tax'}${r?.jurisdiction ? ` - ${r.jurisdiction}` : ''} (${r?.percentage ?? 0}%${t.inclusive ? ' included' : ''})`, fmt(t.amount, cur)]);
  }
  totals.push(['Total', fmt(inv.total, cur), true]);
  const reverse = (inv.total_tax_amounts ?? []).some((t: any) => t.taxability_reason === 'reverse_charge');
  const notes = [
    ...(reverse ? ['Reverse charge: the customer is liable for VAT on this supply.'] : []),
    ...(inv.amounts_due?.length ? [`Payment schedule: ${inv.amounts_due.map((a: any, i: number) => `${i + 1}) ${fmt(a.amount, cur)} due ${day(a.due_date)}${a.status === 'paid' ? ' (paid)' : ''}`).join('; ')}`] : []),
    ...(inv.footer ? [inv.footer] : []),
  ];
  const usedBalance = (inv.ending_balance ?? inv.starting_balance ?? 0) - (inv.starting_balance ?? 0);
  if (usedBalance) totals.push([usedBalance > 0 ? 'Applied balance (credit)' : 'Previous balance owed', fmt(-usedBalance, cur)]);
  if (inv.pre_payment_credit_notes_amount) totals.push(['Credit notes', `-${fmt(inv.pre_payment_credit_notes_amount, cur)}`]);
  if (inv.amount_paid) totals.push(['Amount paid', fmt(inv.amount_paid, cur)]);
  totals.push(['Amount due', fmt(inv.amount_remaining, cur), true]);
  return documentPdf({
    kind: 'Invoice',
    number: inv.number,
    status: inv.status === 'paid' ? 'Paid' : inv.status === 'void' ? 'Void' : null,
    merchant: { name: acct?.business_profile?.name ?? acct?.settings?.dashboard?.display_name ?? 'Merchant', email: acct?.email },
    billTo: { name: inv.customer_name, email: inv.customer_email, address: inv.customer_address },
    meta: [['Invoice number', inv.number ?? 'Draft'], ['Date of issue', day(inv.status_transitions?.finalized_at ?? inv.created)], ...(inv.due_date ? [['Date due', day(inv.due_date)] as [string, string]] : []), ...(inv.customer_tax_ids ?? []).map((t: any) => [t.type.replace(/_/g, ' ').toUpperCase(), t.value] as [string, string])],
    header: inv.description,
    lines: inv.lines.data.map((l: any) => ({ description: l.description, quantity: l.quantity ?? 1, unit: l.quantity ? fmt(Math.round(l.amount / l.quantity), cur) : '', amount: fmt(l.amount, cur), note: l.period && l.type === 'subscription' ? `${day(l.period.start)} - ${day(l.period.end)}` : undefined })),
    totals,
    footer: notes.length ? notes.join('\n') : null,
  });
}

/** The credit note PDF behind `credit_note.pdf`. */
export async function creditNotePdf(accountId: string, cn: any) {
  const acct = await getAccount(accountId);
  const inv = await findObject<any>(accountId, 'invoice', cn.invoice);
  const cur = cn.currency;
  const totals: [string, string, boolean?][] = [['Subtotal', fmt(cn.subtotal, cur)]];
  if (cn.discount_amount) totals.push(['Discount', `-${fmt(cn.discount_amount, cur)}`]);
  for (const t of cn.tax_amounts ?? []) {
    const r = await findObject<any>(accountId, 'tax_rate', t.tax_rate);
    totals.push([`${r?.display_name ?? 'Tax'} (${r?.percentage ?? 0}%${t.inclusive ? ' included' : ''})`, fmt(t.amount, cur)]);
  }
  totals.push(['Total credited', fmt(cn.total, cur), true]);
  if (cn.type === 'post_payment') {
    const refunded = cn.refunds.reduce((s: number, r: any) => s + r.amount_refunded, 0);
    if (refunded) totals.push(['Refunded to card', fmt(refunded, cur)]);
    if (cn._credit_amount) totals.push(['Credited to balance', fmt(cn._credit_amount, cur)]);
    if (cn.out_of_band_amount) totals.push(['Settled outside Tessera', fmt(cn.out_of_band_amount, cur)]);
  } else totals.push(['Deducted from amount due', fmt(cn.total, cur)]);
  const reason: Record<string, string> = { duplicate: 'Duplicate', fraudulent: 'Fraudulent', order_change: 'Order change', product_unsatisfactory: 'Product unsatisfactory' };
  return documentPdf({
    kind: 'Credit note',
    number: cn.number,
    status: cn.status === 'void' ? 'Void' : null,
    merchant: { name: acct?.business_profile?.name ?? acct?.settings?.dashboard?.display_name ?? 'Merchant', email: acct?.email },
    billTo: { name: inv?.customer_name, email: inv?.customer_email, address: inv?.customer_address },
    meta: [['Credit note number', cn.number], ['Invoice', inv?.number ?? cn.invoice], ['Date of issue', day(cn.created)], ...(cn.reason ? [['Reason', reason[cn.reason] ?? cn.reason] as [string, string]] : [])],
    header: cn.memo,
    lines: cn.lines.data.map((l: any) => ({ description: l.description, quantity: l.quantity ?? 1, unit: l.unit_amount !== null ? fmt(l.unit_amount, cur) : '', amount: fmt(l.amount, cur) })),
    totals,
    footer: null,
  });
}
