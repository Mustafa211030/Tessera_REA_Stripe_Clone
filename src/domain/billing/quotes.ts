import { invalid, missing } from '../../lib/errors.ts';
import { newId, nowSeconds } from '../../lib/ids.ts';
import { documentPdf } from '../../lib/pdf.ts';
import { arr, bool, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { getAccount } from '../accounts.ts';
import { billingConnectParams } from '../connect/transfers.ts';
import { emit } from '../events.ts';
import { ZERO_DECIMAL } from '../fx.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { priceLines, taxRateIds } from '../tax.ts';
import { discountAmount, priceAmount, priceSummary, resolvePrice } from './catalog.ts';
import { clockTime } from './clocks.ts';
import { createInvoice, createInvoiceItem, finalizeInvoice, intervalLabel } from './invoices.ts';
import { createSubscription } from './subscriptions.ts';

/**
 * Quotes: a priced offer the customer accepts.
 *
 *   draft ──finalize──► open ──accept──► accepted (creates a subscription and/or invoice)
 *     └──────────────────┴──cancel──► canceled          open quotes past expires_at can't be accepted
 *
 * Totals use the same discount and tax engine as invoices. `computed.upfront` is what the
 * first invoice will charge; `computed.recurring` is each later period. A PDF is available
 * at /v1/quotes/:id/pdf once the quote is finalized.
 */

const DAY = 86400;

async function buildLines(ctx: Ctx, items: any[]) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const price = await resolvePrice(ctx, it, `line_items[${i}]`);
    const product = await findObject<any>(ctx.accountId, 'product', price.product);
    const qty = int(it, 'quantity', { min: 1 }) ?? 1;
    out.push({
      id: newId('li', 16),
      object: 'item',
      amount_discount: 0,
      amount_subtotal: priceAmount(price, qty),
      amount_tax: 0,
      amount_total: priceAmount(price, qty),
      currency: price.currency,
      description: product?.name ?? 'Item',
      discounts: [] as any[],
      price,
      quantity: qty,
      taxes: [] as any[],
      _tax_rates: (await taxRateIds(ctx, it, 'tax_rates')) ?? [],
    });
  }
  return out;
}

async function applyParams(ctx: Ctx, q: any, p: Params) {
  if (p.customer !== undefined) {
    if (p.customer) {
      const c = await getObject<any>(ctx.accountId, 'customer', String(p.customer), 'customer', 'customer');
      q.customer = c.id;
      q.test_clock = c.test_clock ?? null;
    } else q.customer = null;
  }
  const items = arr(p, 'line_items');
  if (items) {
    if (!items.length) throw invalid('A quote needs at least one line item.', 'line_items');
    q._line_items = await buildLines(ctx, items);
    const cur = q._line_items[0].currency;
    if (q._line_items.some((l: any) => l.currency !== cur)) throw invalid('All line items must use the same currency.', 'line_items');
    const recurring = q._line_items.filter((l: any) => l.price.type === 'recurring');
    if (recurring.some((l: any) => l.price.recurring.interval !== recurring[0].price.recurring.interval || l.price.recurring.interval_count !== recurring[0].price.recurring.interval_count)) {
      throw invalid('All recurring line items must share the same interval.', 'line_items');
    }
    q.currency = cur;
  }
  if (p.collection_method !== undefined) q.collection_method = oneOf(p, 'collection_method', ['charge_automatically', 'send_invoice'] as const);
  if (p.invoice_settings?.days_until_due !== undefined) q.invoice_settings.days_until_due = int(p.invoice_settings, 'days_until_due', { min: 0 }) ?? null;
  if (q.collection_method === 'send_invoice' && q.invoice_settings.days_until_due === null) q.invoice_settings.days_until_due = 30;
  for (const k of ['description', 'header', 'footer'] as const) if (p[k] !== undefined) q[k] = p[k] === '' ? null : String(p[k]).slice(0, 500);
  if (p.expires_at !== undefined) q.expires_at = int(p, 'expires_at');
  if (p.default_tax_rates !== undefined) q.default_tax_rates = (await taxRateIds(ctx, p, 'default_tax_rates')) ?? [];
  if (p.automatic_tax?.enabled !== undefined) q.automatic_tax.enabled = bool(p.automatic_tax, 'enabled');
  const coupons = arr(p, 'discounts');
  if (coupons !== undefined) {
    q.discounts = [];
    q._promotion_code = null;
    for (const d of coupons) {
      if (d.promotion_code) {
        const { validatePromotion } = await import('./promotions.ts');
        const promo = await getObject<any>(ctx.accountId, 'promotion_code', String(d.promotion_code), 'promotion code', 'discounts[0][promotion_code]');
        const c = await validatePromotion(ctx, promo, { customer: q.customer, currency: q.currency, param: 'discounts[0][promotion_code]' });
        q.discounts.push(c.id);
        q._promotion_code = promo.id;
        continue;
      }
      const c = await getObject<any>(ctx.accountId, 'coupon', String(d.coupon), 'coupon', 'discounts[0][coupon]');
      if (!c.valid) throw invalid(`Coupon ${c.id} is no longer valid.`, 'discounts');
      q.discounts.push(c.id);
    }
  }
  if (p.subscription_data) {
    const sd = p.subscription_data;
    if (sd.trial_period_days !== undefined) q.subscription_data.trial_period_days = int(sd, 'trial_period_days', { min: 0 }) ?? null;
    if (sd.description !== undefined) q.subscription_data.description = sd.description || null;
    if (sd.effective_date !== undefined) q.subscription_data.effective_date = sd.effective_date === 'current_period_end' ? sd.effective_date : int(sd, 'effective_date') ?? null;
  }
  Object.assign(q, await billingConnectParams(ctx, { ...p, _existing_transfer_data: q.transfer_data }, { percent: true }));
  q.metadata = metadata(p, q.metadata);
  await computeTotals(ctx, q);
}

/** Upfront (first invoice) and recurring totals, with discounts and tax. */
async function computeTotals(ctx: Ctx, q: any) {
  const lines = q._line_items as any[];
  const customer = q.customer ? await findObject<any>(ctx.accountId, 'customer', q.customer) : null;
  const coupon = q.discounts[0] ? await findObject<any>(ctx.accountId, 'coupon', q.discounts[0]) : null;
  const discount = coupon ? { coupon, end: null } : null;
  const trial = !!q.subscription_data.trial_period_days;
  const upfrontLines = lines.filter((l) => l.price.type !== 'recurring' || !trial);
  const price = async (ls: any[], firstInvoice: boolean) => {
    const sub = ls.reduce((s, l) => s + l.amount_subtotal, 0);
    const off = discount ? discountAmount(discount, sub, q.currency, nowSeconds(), firstInvoice) : 0;
    return priceLines(ctx, ls.map((l) => ({ amount: l.amount_subtotal, tax_rates: l._tax_rates, price: l.price })), { discountTotal: off, defaultTaxRates: q.default_tax_rates, automatic: q.automatic_tax.enabled, customer });
  };
  const up = await price(upfrontLines, true);
  upfrontLines.forEach((l, i) => {
    const pl = up.lines[i]!;
    l.amount_discount = pl.discount;
    l.amount_tax = pl.tax_amounts.reduce((s, t) => s + t.amount, 0);
    l.amount_total = l.amount_subtotal - pl.discount + pl.tax_amounts.filter((t) => !t.inclusive).reduce((s, t) => s + t.amount, 0);
    l.discounts = pl.discount && coupon ? [{ amount: pl.discount, discount: { coupon: coupon.id } }] : [];
    l.taxes = pl.tax_amounts.map((t) => ({ amount: t.amount, rate: t.tax_rate, taxability_reason: t.taxability_reason, taxable_amount: t.taxable_amount }));
  });
  const details = (r: Awaited<ReturnType<typeof price>>) => ({ amount_discount: r.discount, amount_shipping: 0, amount_tax: r.tax, breakdown: { discounts: [], taxes: r.total_tax_amounts.map((t) => ({ amount: t.amount, rate: t.tax_rate, taxability_reason: t.taxability_reason, taxable_amount: t.taxable_amount })) } });
  q.amount_subtotal = up.subtotal;
  q.amount_total = up.total;
  q.total_details = details(up);
  q.automatic_tax.status = up.automatic_status;
  q.computed.upfront = { amount_subtotal: up.subtotal, amount_total: up.total, line_items: { object: 'list', data: upfrontLines.map((l) => l.id), has_more: false, url: `/v1/quotes/${q.id}/computed_upfront_line_items` }, total_details: details(up) };
  const rec = lines.filter((l) => l.price.type === 'recurring');
  if (rec.length) {
    const r = await price(rec, false);
    q.computed.recurring = { amount_subtotal: r.subtotal, amount_total: r.total, interval: rec[0].price.recurring.interval, interval_count: rec[0].price.recurring.interval_count, total_details: details(r) };
  } else q.computed.recurring = null;
}

export async function createQuote(ctx: Ctx, p: Params) {
  const now = nowSeconds();
  const id = newId('qt');
  const q: any = {
    id,
    object: 'quote',
    amount_subtotal: 0,
    amount_total: 0,
    application: null,
    application_fee_amount: null,
    application_fee_percent: null,
    automatic_tax: { enabled: false, liability: null, status: null as string | null },
    collection_method: 'charge_automatically',
    computed: { recurring: null as any, upfront: null as any },
    created: now,
    currency: null as string | null,
    customer: null as string | null,
    default_tax_rates: [] as string[],
    description: null,
    discounts: [] as string[],
    expires_at: now + 30 * DAY,
    footer: null,
    from_quote: null,
    header: null,
    invoice: null as string | null,
    invoice_settings: { days_until_due: null as number | null, issuer: { type: 'self' } },
    livemode: false,
    metadata: {},
    number: null as string | null,
    on_behalf_of: null,
    status: 'draft',
    status_transitions: { accepted_at: null as number | null, canceled_at: null as number | null, finalized_at: null as number | null },
    subscription: null as string | null,
    subscription_data: { description: null, effective_date: null, trial_period_days: null as number | null },
    subscription_schedule: null,
    test_clock: null as string | null,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    transfer_data: null,
    _line_items: [] as any[],
  };
  if (!arr(p, 'line_items')?.length) throw missing('line_items');
  await applyParams(ctx, q, p);
  await insertObject(ctx.accountId, q);
  await emit(ctx, 'quote.created', q);
  return q;
}

export async function updateQuote(ctx: Ctx, id: string, p: Params) {
  const q = await getObject<any>(ctx.accountId, 'quote', id, 'quote');
  if (q.status !== 'draft') throw invalid(`Only draft quotes can be updated. This quote is ${q.status}.`, 'quote', 'quote_not_editable');
  await applyParams(ctx, q, p);
  await saveObject(ctx.accountId, q);
  await emit(ctx, 'quote.updated' as string, q);
  return q;
}

export async function finalizeQuote(ctx: Ctx, id: string, p: Params) {
  const q = await getObject<any>(ctx.accountId, 'quote', id, 'quote');
  if (q.status !== 'draft') throw invalid(`This quote is already ${q.status}.`, 'quote', 'quote_not_editable');
  if (!q.customer) throw invalid('Set a customer before finalizing the quote.', 'customer', 'quote_missing_customer');
  if (q.automatic_tax.enabled && q.automatic_tax.status === 'requires_location_inputs') {
    throw invalid("The customer's location isn't recognized, so tax can't be calculated. Add an address to the customer first.", 'customer', 'customer_tax_location_invalid');
  }
  const now = nowSeconds();
  if (p.expires_at !== undefined) q.expires_at = int(p, 'expires_at');
  if (q.expires_at <= now) throw invalid('expires_at must be in the future.', 'expires_at');
  const c = await getObject<any>(ctx.accountId, 'customer', q.customer);
  c._quote_seq = (c._quote_seq ?? 0) + 1;
  await saveObject(ctx.accountId, c);
  q.number = `QT-${c.invoice_prefix}-${String(c._quote_seq).padStart(4, '0')}-1`;
  q.status = 'open';
  q.status_transitions.finalized_at = now;
  await computeTotals(ctx, q);
  await saveObject(ctx.accountId, q);
  await emit(ctx, 'quote.finalized', q);
  return q;
}

/** Accepting turns the quote into a subscription (recurring items) and/or an invoice (one-time items). */
export async function acceptQuote(ctx: Ctx, id: string) {
  const q = await getObject<any>(ctx.accountId, 'quote', id, 'quote');
  if (q.status !== 'open') throw invalid(`Only open quotes can be accepted. This quote is ${q.status}.`, 'quote', 'quote_not_accepted');
  const customer = await getObject<any>(ctx.accountId, 'customer', q.customer);
  const now = await clockTime(ctx.accountId, customer.test_clock);
  if (q.expires_at < now) throw invalid('This quote has expired.', 'quote', 'quote_expired');
  const recurring = q._line_items.filter((l: any) => l.price.type === 'recurring');
  const oneTime = q._line_items.filter((l: any) => l.price.type !== 'recurring');
  const connect = { ...(q.application_fee_percent !== null && q.application_fee_percent !== undefined ? { application_fee_percent: q.application_fee_percent } : {}), ...(q.transfer_data ? { transfer_data: q.transfer_data } : {}), ...(q.on_behalf_of ? { on_behalf_of: q.on_behalf_of } : {}) };
  for (const l of oneTime) {
    await createInvoiceItem(ctx, { customer: q.customer, price: l.price.id, quantity: l.quantity, tax_rates: l._tax_rates, metadata: { quote: q.id } });
  }
  if (recurring.length) {
    const hasPm = !!customer.invoice_settings?.default_payment_method;
    const sub = await createSubscription(ctx, {
      customer: q.customer,
      items: recurring.map((l: any) => ({ price: l.price.id, quantity: l.quantity, tax_rates: l._tax_rates })),
      collection_method: q.collection_method,
      days_until_due: q.collection_method === 'send_invoice' ? q.invoice_settings.days_until_due ?? 30 : undefined,
      default_tax_rates: q.default_tax_rates,
      automatic_tax: { enabled: q.automatic_tax.enabled ? 'true' : 'false' },
      ...(q._promotion_code ? { promotion_code: q._promotion_code } : q.discounts[0] ? { coupon: q.discounts[0] } : {}),
      trial_period_days: q.subscription_data.trial_period_days ?? undefined,
      description: q.subscription_data.description ?? q.description ?? undefined,
      payment_behavior: hasPm ? 'allow_incomplete' : 'default_incomplete',
      metadata: { quote: q.id },
      ...connect,
    });
    if ((sub as any)?.object === 'subscription') {
      q.subscription = (sub as any).id;
      q.invoice = (sub as any).latest_invoice;
    }
  } else {
    const inv = await createInvoice(ctx, {
      customer: q.customer, collection_method: q.collection_method, days_until_due: q.collection_method === 'send_invoice' ? q.invoice_settings.days_until_due ?? 30 : undefined,
      pending_invoice_items_behavior: 'include', default_tax_rates: q.default_tax_rates, automatic_tax: { enabled: q.automatic_tax.enabled ? 'true' : 'false' },
      description: q.description ?? undefined, auto_advance: 'true', metadata: { quote: q.id }, ...(q._promotion_code ? { discounts: [{ promotion_code: q._promotion_code }] } : q.discounts[0] ? { discounts: [{ coupon: q.discounts[0] }] } : {}),
    });
    q.invoice = inv.id;
    await finalizeInvoice(ctx, await getObject<any>(ctx.accountId, 'invoice', inv.id));
  }
  q.status = 'accepted';
  q.status_transitions.accepted_at = now;
  await saveObject(ctx.accountId, q);
  await emit(ctx, 'quote.accepted', q);
  return q;
}

export async function cancelQuote(ctx: Ctx, id: string) {
  const q = await getObject<any>(ctx.accountId, 'quote', id, 'quote');
  if (!['draft', 'open'].includes(q.status)) throw invalid(`This quote is ${q.status} and can't be canceled.`, 'quote');
  q.status = 'canceled';
  q.status_transitions.canceled_at = nowSeconds();
  await saveObject(ctx.accountId, q);
  await emit(ctx, 'quote.canceled', q);
  return q;
}

export function quoteLineItems(q: any, upfrontOnly = false) {
  const ids = new Set(q.computed?.upfront?.line_items?.data ?? []);
  const data = (q._line_items as any[]).filter((l) => !upfrontOnly || ids.has(l.id)).map(({ _tax_rates, ...l }) => l);
  return { object: 'list', data, has_more: false, url: `/v1/quotes/${q.id}/${upfrontOnly ? 'computed_upfront_line_items' : 'line_items'}` };
}

const fmt = (amount: number, cur: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(ZERO_DECIMAL.has(cur) ? amount : amount / 100);
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

export async function quotePdf(ctx: Ctx, id: string) {
  const q = await getObject<any>(ctx.accountId, 'quote', id, 'quote');
  if (q.status === 'draft') throw invalid('Finalize the quote before downloading its PDF.', 'quote', 'quote_not_finalized');
  const acct = await getAccount(ctx.accountId);
  const c = await findObject<any>(ctx.accountId, 'customer', q.customer);
  const cur = q.currency;
  const totals: [string, string, boolean?][] = [['Subtotal', fmt(q.amount_subtotal, cur)]];
  if (q.total_details.amount_discount) totals.push(['Discount', `-${fmt(q.total_details.amount_discount, cur)}`]);
  for (const t of q.total_details.breakdown?.taxes ?? []) {
    const r = await findObject<any>(ctx.accountId, 'tax_rate', t.rate);
    totals.push([`${r?.display_name ?? 'Tax'} (${r?.percentage ?? 0}%${r?.inclusive ? ' incl.' : ''})`, fmt(t.amount, cur)]);
  }
  totals.push([q.computed.recurring ? 'Total due on first invoice' : 'Total', fmt(q.amount_total, cur), true]);
  if (q.computed.recurring) totals.push([`Then every ${q.computed.recurring.interval_count > 1 ? `${q.computed.recurring.interval_count} ` : ''}${q.computed.recurring.interval}${q.computed.recurring.interval_count > 1 ? 's' : ''}`, fmt(q.computed.recurring.amount_total, cur)]);
  return documentPdf({
    kind: 'Quote',
    number: q.number,
    status: q.status === 'open' ? null : q.status,
    merchant: { name: acct?.business_profile?.name ?? 'Merchant', email: acct?.email },
    billTo: { name: c?.name, email: c?.email, address: c?.address },
    meta: [['Quote number', q.number ?? ''], ['Date', day(q.status_transitions.finalized_at ?? q.created)], ['Expires', day(q.expires_at)], ...(q.subscription_data.trial_period_days ? [['Free trial', `${q.subscription_data.trial_period_days} days`] as [string, string]] : [])],
    header: q.header ?? q.description,
    lines: q._line_items.map((l: any) => ({ description: l.description, quantity: l.quantity, unit: l.price.billing_scheme === 'tiered' || l.price.transform_quantity ? priceSummary(l.price) : `${fmt(l.price.unit_amount, cur)}${l.price.recurring ? ` ${intervalLabel(l.price)}` : ''}`, amount: fmt(l.amount_subtotal, cur) })),
    totals,
    footer: q.footer,
  });
}
