import { query } from '../../db/index.ts';
import { CommitThenFail, invalid, missing } from '../../lib/errors.ts';
import { newId, nowSeconds } from '../../lib/ids.ts';
import { arr, bool, currency, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { getAccount } from '../accounts.ts';
import { emit } from '../events.ts';
import { onPaymentFailed, onPaymentSucceeded } from '../hooks.ts';
import { createPaymentIntent } from '../paymentIntents.ts';
import { billingConnectParams } from '../connect/transfers.ts';
import { priceLines, taxRateIds } from '../tax.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { discountAmount, licensedAmount, priceAmount, priceSummary, redeemCoupon, resolvePrice } from './catalog.ts';
import { clockTime } from './clocks.ts';
import { applyInstallmentPayment, finalizeSchedule, setAmountsDue, settleAll } from './installments.ts';

/** Days after each failed automatic attempt before retrying (then the subscription is canceled). */
export const RETRY_DAYS = [3, 5, 7];
const DAY = 86400;

// ---------------- time ----------------
/** Adds `n` billing intervals to an anchor, clamping month-end days (Jan 31 -> Feb 28 -> Mar 31). */
export function addInterval(anchor: number, interval: string, count: number, n = 1): number {
  const d = new Date(anchor * 1000);
  if (interval === 'day') return anchor + n * count * DAY;
  if (interval === 'week') return anchor + n * count * 7 * DAY;
  const months = interval === 'year' ? 12 * count * n : count * n;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return Math.floor(target.getTime() / 1000);
}

export function intervalLabel(price: any) {
  const r = price.recurring;
  if (!r) return '';
  return r.interval_count === 1 ? `/ ${r.interval}` : `every ${r.interval_count} ${r.interval}s`;
}

function fmt(amount: number, cur: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(amount / 100);
}

export async function customerNow(accountId: string, customerId: string): Promise<number> {
  const c = await findObject<any>(accountId, 'customer', customerId);
  return clockTime(accountId, c?.test_clock);
}

// ---------------- invoice items ----------------
export async function createInvoiceItem(ctx: Ctx, p: Params) {
  // Current API: pricing[price]; older versions: price.
  if (p.pricing?.price && !p.price) p = { ...p, price: p.pricing.price };
  const customer = str(p, 'customer', { required: true })!;
  const cust = await getObject<any>(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const now = await clockTime(ctx.accountId, cust.test_clock);
  let amount = int(p, 'amount');
  let cur = currency(p, 'currency', false);
  let price: any = null;
  const quantity = int(p, 'quantity', { min: 1 }) ?? 1;
  if (p.price || p.price_data) {
    price = await resolvePrice(ctx, p, '');
    amount = priceAmount(price, quantity);
    cur = price.currency;
  }
  if (amount === undefined) throw missing('amount');
  if (!cur) throw missing('currency');
  const invoiceId = str(p, 'invoice');
  if (invoiceId) {
    const inv = await getObject<any>(ctx.accountId, 'invoice', invoiceId, 'invoice', 'invoice');
    if (inv.status !== 'draft') throw invalid('Invoice items can only be added to draft invoices.', 'invoice');
  }
  const item = {
    id: newId('ii'),
    object: 'invoiceitem',
    amount,
    currency: cur,
    customer,
    date: now,
    description: str(p, 'description') ?? (price ? null : 'Invoice item'),
    discountable: p.discountable === undefined ? true : String(p.discountable) === 'true',
    invoice: invoiceId ?? null,
    livemode: false,
    metadata: metadata(p),
    period: { end: now, start: now },
    price: price?.id ?? null,
    pricing: price ? { price_details: { price: price.id, product: price.product }, type: 'price_details', unit_amount_decimal: price.unit_amount_decimal ?? null } : null,
    proration: false,
    quantity,
    subscription: str(p, 'subscription') ?? null,
    tax_rates: (await taxRateIds(ctx, p, 'tax_rates')) ?? [],
    test_clock: cust.test_clock ?? null,
    created: now,
  };
  await insertObject(ctx.accountId, item);
  if (invoiceId) {
    const inv = await getObject<any>(ctx.accountId, 'invoice', invoiceId);
    await attachItems(ctx, inv, [item]);
    await recompute(ctx, inv, now);
    await saveObject(ctx.accountId, inv);
  }
  await emit(ctx, 'invoiceitem.created', item);
  return item;
}

async function pendingItems(ctx: Ctx, customer: string, subscription: string | null) {
  const rows = await query<{ data: any }>(
    "SELECT data FROM objects WHERE account_id = $1 AND type = 'invoiceitem' AND data->>'customer' = $2 AND data->>'invoice' IS NULL ORDER BY seq",
    [ctx.accountId, customer],
  );
  return rows.map((r) => r.data).filter((i) => !i.deleted && (subscription ? i.subscription === subscription || !i.subscription : !i.subscription));
}

async function attachItems(ctx: Ctx, inv: any, items: any[]) {
  for (const it of items) {
    it.invoice = inv.id;
    await saveObject(ctx.accountId, it);
    inv.lines.data.push({
      id: newId('il', 20),
      object: 'line_item',
      amount: it.amount,
      currency: it.currency,
      description: it.description ?? 'Invoice item',
      discount_amounts: [],
      discountable: it.discountable,
      invoice: inv.id,
      invoice_item: it.id,
      livemode: false,
      metadata: it.metadata ?? {},
      period: it.period,
      price: it.price,
      proration: it.proration,
      quantity: it.quantity,
      subscription: it.subscription,
      tax_amounts: [] as any[],
      tax_rates: it.tax_rates ?? [],
      type: 'invoiceitem',
    });
  }
}

// ---------------- invoices ----------------
export type SubLine = { price: any; quantity: number; subscription_item: string; period: { start: number; end: number }; description?: string; amount?: number; tax_rates?: string[] };

/** Build a draft invoice: subscription lines + pending invoice items, then totals. */
export async function draftInvoice(
  ctx: Ctx,
  opts: { connect?: any; discount?: any; tax?: { default_tax_rates?: string[]; automatic?: boolean }; customer: any; subscription?: any; billing_reason: string; collection_method: 'charge_automatically' | 'send_invoice'; days_until_due?: number | null; now: number; lines?: SubLine[]; includePending?: boolean; description?: string | null; metadata?: Record<string, string>; auto_advance?: boolean; default_payment_method?: string | null; currency?: string },
) {
  const account = await getAccount(ctx.accountId);
  const sub = opts.subscription ?? null;
  const inv: any = {
    id: newId('in'),
    object: 'invoice',
    account_country: account?.country ?? 'US',
    account_name: account?.business_profile?.name ?? null,
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    amount_shipping: 0,
    application: sub?.application ?? null,
    application_fee_amount: null as number | null,
    attempt_count: 0,
    attempted: false,
    auto_advance: opts.auto_advance ?? true,
    automatic_tax: { enabled: !!(sub?.automatic_tax?.enabled ?? opts.tax?.automatic), liability: null, status: null as string | null },
    billing_reason: opts.billing_reason,
    collection_method: opts.collection_method,
    created: opts.now,
    currency: opts.currency ?? opts.lines?.[0]?.price.currency ?? 'usd',
    customer: opts.customer.id,
    customer_address: opts.customer.address ?? null,
    customer_email: opts.customer.email,
    customer_name: opts.customer.name,
    customer_tax_exempt: opts.customer.tax_exempt ?? 'none',
    customer_tax_ids: [] as { type: string; value: string }[],
    amounts_due: null as any[] | null,
    default_payment_method: opts.default_payment_method ?? null,
    default_tax_rates: sub?.default_tax_rates ?? opts.tax?.default_tax_rates ?? [],
    description: opts.description ?? null,
    discount: null as any,
    due_date: null as number | null,
    effective_at: null as number | null,
    ending_balance: null as number | null,
    hosted_invoice_url: null as string | null,
    invoice_pdf: null,
    last_finalization_error: null,
    lines: { object: 'list', data: [] as any[], has_more: false, total_count: 0, url: '' },
    livemode: false,
    metadata: opts.metadata ?? {},
    next_payment_attempt: null as number | null,
    number: null as string | null,
    on_behalf_of: sub?.on_behalf_of ?? opts.connect?.on_behalf_of ?? null,
    paid: false,
    paid_out_of_band: false,
    payment_intent: null as string | null,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    period_end: opts.lines?.[0]?.period.start ?? opts.now,
    period_start: opts.lines?.[0]?.period.start ?? opts.now,
    starting_balance: 0,
    status: 'draft',
    status_transitions: { finalized_at: null as number | null, marked_uncollectible_at: null as number | null, paid_at: null as number | null, voided_at: null as number | null },
    subscription: sub?.id ?? null,
    subtotal: 0,
    subtotal_excluding_tax: 0,
    tax: 0 as number | null,
    test_clock: opts.customer.test_clock ?? null,
    total: 0,
    total_discount_amounts: [] as any[],
    total_excluding_tax: 0,
    total_tax_amounts: [] as any[],
    total_pretax_credit_amounts: null as any[] | null,
    transfer_data: null as any,
    webhooks_delivered_at: opts.now,
    _days_until_due: opts.days_until_due ?? null,
    _fee_percent: sub?.application_fee_percent ?? null,
    _fee_fixed: opts.connect?.application_fee_amount ?? null,
    _transfer: sub?.transfer_data ?? opts.connect?.transfer_data ?? null,
  };
  inv.lines.url = `/v1/invoices/${inv.id}/lines`;
  for (const l of opts.lines ?? []) {
    const product = await findObject<any>(ctx.accountId, 'product', l.price.product);
    const amount = l.amount ?? licensedAmount(l.price, l.quantity);
    inv.lines.data.push({
      id: newId('il', 20),
      object: 'line_item',
      amount,
      currency: l.price.currency,
      description: l.description ?? (l.price.unit_amount !== null && l.price.billing_scheme !== 'tiered' && !l.price.transform_quantity ? `${l.quantity} × ${product?.name ?? 'Item'} (at ${fmt(l.price.unit_amount, l.price.currency)} ${intervalLabel(l.price)})` : `${l.quantity} × ${product?.name ?? 'Item'} (${priceSummary(l.price)})`),
      discount_amounts: [],
      discountable: true,
      invoice: inv.id,
      livemode: false,
      metadata: {},
      period: l.period,
      price: l.price.id,
      proration: false,
      quantity: l.quantity,
      subscription: sub?.id ?? null,
      subscription_item: l.subscription_item,
      pretax_credit_amounts: [] as any[],
      tax_amounts: [] as any[],
      tax_rates: l.tax_rates ?? [],
      type: 'subscription',
    });
  }
  if (opts.includePending !== false) await attachItems(ctx, inv, await pendingItems(ctx, opts.customer.id, sub?.id ?? null));
  if (inv.lines.data.length && !opts.currency) inv.currency = inv.lines.data[0].currency;
  for (const l of inv.lines.data) {
    if (l.currency !== inv.currency) throw invalid('All items on an invoice must use the same currency.', 'currency');
  }
  inv.discount = opts.discount ?? sub?.discount ?? opts.customer._discount ?? null;
  await recompute(ctx, inv, opts.now);
  await insertObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.created', inv);
  return inv;
}

async function recompute(ctx: Ctx, inv: any, now: number) {
  inv.subtotal = inv.lines.data.reduce((s: number, l: any) => s + l.amount, 0);
  inv.lines.total_count = inv.lines.data.length;
  const discountable = inv.lines.data.filter((l: any) => l.discountable && l.amount > 0).reduce((s: number, l: any) => s + l.amount, 0);
  const off = inv.discount ? discountAmount(inv.discount, discountable, inv.currency, now, !inv.discount._applied || inv.discount._applied === inv.id) : 0;
  inv.total_discount_amounts = off ? [{ amount: off, discount: inv.discount.id }] : [];
  // Discounts are spread over the lines, then tax (manual rates or automatic) is applied per line.
  const customer = await findObject<any>(ctx.accountId, 'customer', inv.customer);
  // Billing credits (applied at finalization) come off metered lines before tax.
  const credit = (l: any) => inv._credit_alloc?.[l.id] ?? 0;
  const priced = await priceLines(ctx, inv.lines.data.map((l: any) => ({ amount: l.amount - credit(l), discountable: l.discountable, tax_rates: l.tax_rates, price: l.price })), {
    discountTotal: off, defaultTaxRates: inv.default_tax_rates, automatic: inv.automatic_tax?.enabled, customer,
  });
  inv.lines.data.forEach((l: any, i: number) => {
    const pl = priced.lines[i]!;
    l.discount_amounts = pl.discount && inv.discount ? [{ amount: pl.discount, discount: inv.discount.id }] : [];
    l.tax_amounts = pl.tax_amounts;
    l.amount_excluding_tax = l.amount - pl.tax_amounts.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0);
  });
  inv.tax = priced.tax || (inv.automatic_tax?.enabled || inv.default_tax_rates?.length || inv.lines.data.some((l: any) => l.tax_rates?.length) ? 0 : null);
  inv.total_tax_amounts = priced.total_tax_amounts;
  if (inv.automatic_tax) inv.automatic_tax.status = priced.automatic_status;
  inv.customer_address = customer?.address ?? null;
  inv.customer_tax_exempt = customer?.tax_exempt ?? 'none';
  inv.subtotal_excluding_tax = inv.subtotal - priced.inclusiveTax;
  inv.total = Math.max(0, priced.total);
  inv.total_excluding_tax = inv.total - priced.tax;
  inv.amount_due = inv.total;
  inv.amount_remaining = inv.amount_due - inv.amount_paid;
  // Connect: fee and transfer amounts follow the invoice total.
  if (inv._fee_percent !== null && inv._fee_percent !== undefined) inv.application_fee_amount = Math.round((inv.total * inv._fee_percent) / 100);
  else if (inv._fee_fixed !== null && inv._fee_fixed !== undefined) inv.application_fee_amount = Math.min(inv._fee_fixed, inv.total);
  if (inv._transfer) {
    const t = inv._transfer;
    inv.transfer_data = { destination: t.destination, amount: t.amount_percent !== undefined ? Math.round((inv.total * t.amount_percent) / 100) : t.amount ?? null };
  }
}

async function nextNumber(ctx: Ctx, customerId: string) {
  const c = await getObject<any>(ctx.accountId, 'customer', customerId);
  c._invoice_seq = (c._invoice_seq ?? 0) + 1;
  await saveObject(ctx.accountId, c);
  return `${c.invoice_prefix}-${String(c._invoice_seq).padStart(4, '0')}`;
}

export async function createInvoice(ctx: Ctx, p: Params) {
  const customerId = str(p, 'customer', { required: true })!;
  const customer = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer', 'customer');
  const now = await clockTime(ctx.accountId, customer.test_clock);
  const collection_method = oneOf(p, 'collection_method', ['charge_automatically', 'send_invoice'] as const, 'charge_automatically')!;
  const days = int(p, 'days_until_due', { min: 0 });
  if (collection_method === 'send_invoice' && days === undefined && !p.due_date) throw invalid('Invoices with collection_method=send_invoice need days_until_due or due_date.', 'days_until_due');
  const pendingBehavior = oneOf(p, 'pending_invoice_items_behavior', ['include', 'exclude'] as const, 'exclude');
  const inv = await draftInvoice(ctx, {
    customer,
    billing_reason: 'manual',
    collection_method,
    days_until_due: days ?? null,
    now,
    includePending: pendingBehavior === 'include',
    description: str(p, 'description') ?? null,
    metadata: metadata(p),
    auto_advance: bool(p, 'auto_advance') ?? false,
    default_payment_method: str(p, 'default_payment_method') ?? null,
    currency: currency(p, 'currency', false),
    connect: await billingConnectParams(ctx, p, { percent: false }),
    tax: { default_tax_rates: (await taxRateIds(ctx, p, 'default_tax_rates')) ?? [], automatic: bool(p.automatic_tax ?? {}, 'enabled') ?? false },
    discount: (await (await import('./promotions.ts')).discountFromParams(ctx, p, { customer: customerId }, now, { currency: currency(p, 'currency', false) })) ?? undefined,
  });
  if (p.amounts_due !== undefined) {
    setAmountsDue(inv, p);
    await saveObject(ctx.accountId, inv);
  }
  return inv;
}

export async function finalizeInvoice(ctx: Ctx, inv: any, now?: number) {
  if (inv.status !== 'draft') throw invalid(`This invoice is already ${inv.status}.`, 'invoice', 'invoice_not_editable');
  now ??= await clockTime(ctx.accountId, inv.test_clock);
  if (inv.discount && !inv.discount._applied) {
    inv.discount._applied = inv.id;
    if (inv.subscription) {
      const sub = await findObject<any>(ctx.accountId, 'subscription', inv.subscription);
      if (sub?.discount) { sub.discount._applied = inv.id; await saveObject(ctx.accountId, sub); }
    }
  }
  await (await import('./credits.ts')).applyCredits(ctx, inv, now);
  await recompute(ctx, inv, now);
  if (inv.automatic_tax?.status === 'requires_location_inputs') {
    throw invalid("The customer's location isn't recognized. Add an address with a country (and a state for the US and Canada) before finalizing an invoice with automatic tax.", 'customer', 'customer_tax_location_invalid');
  }
  // The customer's credit (or debt) balance is applied when the invoice is finalized.
  await (await import('./balance.ts')).applyBalanceToInvoice(ctx, inv);
  inv.customer_tax_ids = (await (await import('../taxIds.ts')).customerTaxIds(ctx.accountId, inv.customer)).map((t: any) => ({ type: t.type, value: t.value }));
  inv.number = await nextNumber(ctx, inv.customer);
  inv.status = 'open';
  inv.status_transitions.finalized_at = now;
  inv.effective_at = now;
  inv.hosted_invoice_url = `${ctx.baseUrl}/invoices/pay/${inv.id}`;
  inv.invoice_pdf = `${ctx.baseUrl}/invoices/pdf/${inv.id}`;
  if (inv.collection_method === 'send_invoice') inv.due_date = now + (inv._days_until_due ?? 30) * DAY;
  finalizeSchedule(inv, now);
  await saveObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.finalized', inv);
  if (inv.amount_due === 0) await markPaid(ctx, inv, null, now);
  return inv;
}

/** Mark paid (idempotent) and bring the subscription back to active. */
export async function markPaid(ctx: Ctx, inv: any, pi: any | null, now?: number, outOfBand = false) {
  if (inv.status === 'paid') return inv;
  now ??= await clockTime(ctx.accountId, inv.test_clock);
  inv.status = 'paid';
  inv.paid = true;
  inv.paid_out_of_band = outOfBand;
  inv.amount_paid = inv.amount_due;
  inv.amount_remaining = 0;
  inv.attempted = inv.attempted || !!pi;
  inv.next_payment_attempt = null;
  inv.status_transitions.paid_at = now;
  settleAll(inv, now);
  if (pi && pi.metadata?.installment === undefined) inv.payment_intent = pi.id;
  await saveObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.paid', inv);
  await emit(ctx, 'invoice.payment_succeeded', inv);
  if (inv.subscription) {
    const sub = await findObject<any>(ctx.accountId, 'subscription', inv.subscription);
    if (sub && ['incomplete', 'past_due', 'unpaid'].includes(sub.status)) {
      const prev = sub.status;
      sub.status = sub.trial_end && sub.trial_end > now ? 'trialing' : 'active';
      await saveObject(ctx.accountId, sub);
      await emit(ctx, 'customer.subscription.updated', sub, { status: prev });
    }
  }
  return inv;
}

/** A failed attempt: retry settings (Settings → Billing) pick the next attempt, or none. */
async function recordFailure(ctx: Ctx, inv: any, now: number, failure: { code: string | null; message: string | null } = { code: null, message: null }) {
  inv.attempted = true;
  inv.attempt_count += 1;
  const { scheduleRetry, afterRetriesExhausted } = await import('./retries.ts');
  const { exhausted } = await scheduleRetry(ctx, inv, now, failure);
  await saveObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.payment_failed', inv);
  if (inv.subscription) {
    const sub = await findObject<any>(ctx.accountId, 'subscription', inv.subscription);
    if (sub && sub.status !== 'incomplete' && sub.status !== 'canceled' && sub.status !== 'past_due' && sub.status !== 'unpaid') {
      const prev = sub.status;
      sub.status = 'past_due';
      await saveObject(ctx.accountId, sub);
      await emit(ctx, 'customer.subscription.updated', sub, { status: prev });
    }
  }
  if (exhausted) await afterRetriesExhausted(ctx, inv, now);
}

/** Choose the payment method: invoice > subscription > customer default > first attached card. */
async function paymentMethodFor(ctx: Ctx, inv: any, explicit?: string) {
  if (explicit) return explicit;
  if (inv.default_payment_method) return inv.default_payment_method;
  if (inv.subscription) {
    const sub = await findObject<any>(ctx.accountId, 'subscription', inv.subscription);
    if (sub?.default_payment_method) return sub.default_payment_method;
  }
  const c = await findObject<any>(ctx.accountId, 'customer', inv.customer);
  if (c?.invoice_settings?.default_payment_method) return c.invoice_settings.default_payment_method;
  const pm = await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'payment_method' AND data->>'customer' = $2 AND data->>'type' = 'card' ORDER BY seq DESC LIMIT 1", [ctx.accountId, inv.customer]);
  return pm[0]?.id;
}

/**
 * Attempt payment. Returns the (reloaded) invoice; card failures are recorded on the invoice
 * (via the PaymentIntent hooks) rather than thrown, unless `throwOnFailure` is set.
 */
export async function payInvoice(ctx: Ctx, inv: any, opts: { payment_method?: string; paid_out_of_band?: boolean; confirm?: boolean; throwOnFailure?: boolean; return_url?: string; off_session?: boolean } = {}) {
  if (inv.status === 'draft') await finalizeInvoice(ctx, inv);
  // Renewals and API retries run without the customer present; the first invoice of a
  // subscription and the hosted invoice page are on-session (3-D Secure can be shown).
  const offSession = opts.off_session ?? (inv.billing_reason !== 'subscription_create' && !opts.return_url);
  if (inv.status === 'paid') return inv;
  if (inv.status !== 'open') throw invalid(`Invoice is ${inv.status} and cannot be paid.`, 'invoice', 'invoice_not_open');
  const now = await clockTime(ctx.accountId, inv.test_clock);
  if (opts.paid_out_of_band) return markPaid(ctx, inv, null, now, true);
  if (inv.amount_due > 0 && inv.amount_due < 50) {
    // Below the card minimum: settle it out of band (the platform would carry it to the next invoice).
    return markPaid(ctx, inv, null, now, true);
  }
  // Reuse an existing unconfirmed PaymentIntent (e.g. from payment_behavior=default_incomplete).
  if (inv.payment_intent) {
    const pi = await findObject<any>(ctx.accountId, 'payment_intent', inv.payment_intent);
    if (pi?.status === 'succeeded') return markPaid(ctx, inv, pi, now);
    if (pi && pi.status !== 'canceled') {
      const { confirmPaymentIntent } = await import('../paymentIntents.ts');
      const pm = await paymentMethodFor(ctx, inv, opts.payment_method);
      if (!pm) return failNoMethod(ctx, inv, now, opts.throwOnFailure);
      const r = await confirmPaymentIntent(ctx, pi.id, { payment_method: pm, off_session: offSession ? 'true' : undefined, return_url: opts.return_url });
      return afterAttempt(ctx, inv.id, r, opts.throwOnFailure);
    }
  }
  const pm = await paymentMethodFor(ctx, inv, opts.payment_method);
  if (!pm && opts.confirm !== false) return failNoMethod(ctx, inv, now, opts.throwOnFailure);
  const r = await createPaymentIntent(ctx, {
    amount: inv.amount_remaining ?? inv.amount_due,
    currency: inv.currency,
    customer: inv.customer,
    payment_method: pm,
    description: `Invoice ${inv.number}`,
    metadata: { invoice: inv.id },
    _invoice: inv.id,
    ...connectPaymentParams(inv),
    confirm: opts.confirm === false ? undefined : 'true',
    off_session: offSession ? 'true' : undefined,
    setup_future_usage: inv.subscription && !offSession ? 'off_session' : undefined,
    return_url: opts.return_url,
  });
  const piId = r instanceof CommitThenFail ? (r.error.extra.payment_intent as any)?.id : r.id;
  const fresh = await getObject<any>(ctx.accountId, 'invoice', inv.id);
  if (piId && !fresh.payment_intent) {
    fresh.payment_intent = piId;
    await saveObject(ctx.accountId, fresh);
  }
  return afterAttempt(ctx, inv.id, r, opts.throwOnFailure);
}

/** Connect fields of an invoice as PaymentIntent parameters. */
function connectPaymentParams(inv: any) {
  const out: any = {};
  if (inv.on_behalf_of) out.on_behalf_of = inv.on_behalf_of;
  if (inv.transfer_data) {
    out.transfer_data = { destination: inv.transfer_data.destination };
    if (inv.transfer_data.amount !== null && inv.transfer_data.amount !== undefined) out.transfer_data.amount = Math.min(inv.transfer_data.amount, inv.amount_due);
  }
  if (inv.application_fee_amount && !(out.transfer_data?.amount !== undefined)) out.application_fee_amount = Math.min(inv.application_fee_amount, inv.amount_due);
  return out;
}

async function afterAttempt(ctx: Ctx, invId: string, r: any, throwOnFailure?: boolean) {
  const inv = await getObject<any>(ctx.accountId, 'invoice', invId);
  if (r instanceof CommitThenFail && r.error.code === 'authentication_required') {
    // Off-session payment needs the customer: they can authenticate on the hosted invoice page.
    await emit(ctx, 'invoice.payment_action_required', inv);
  }
  if (r instanceof CommitThenFail && throwOnFailure) return r;
  if (!(r instanceof CommitThenFail) && r.status === 'requires_action') {
    // The customer must authenticate (e.g. 3-D Secure) before this invoice can be paid.
    await emit(ctx, 'invoice.payment_action_required', inv);
    if (inv.billing_reason !== 'subscription_create') await recordFailure(ctx, inv, await clockTime(ctx.accountId, inv.test_clock), { code: 'authentication_required', message: 'The customer must authenticate this payment.' });
    return getObject<any>(ctx.accountId, 'invoice', invId);
  }
  return inv;
}

async function failNoMethod(ctx: Ctx, inv: any, now: number, throwOnFailure?: boolean) {
  await recordFailure(ctx, inv, now, { code: 'no_payment_method', message: 'The customer has no payment method on file.' });
  if (throwOnFailure) throw invalid('The customer has no attached payment source or default payment method.', 'payment_method', 'invoice_no_customer_line_items');
  return inv;
}

export async function voidInvoice(ctx: Ctx, inv: any) {
  if (!['open', 'uncollectible'].includes(inv.status)) throw invalid(`You can only void open or uncollectible invoices; this one is ${inv.status}.`, 'invoice');
  inv.status = 'void';
  inv.next_payment_attempt = null;
  inv.status_transitions.voided_at = await clockTime(ctx.accountId, inv.test_clock);
  inv.amount_remaining = 0;
  await saveObject(ctx.accountId, inv);
  await (await import('./balance.ts')).unapplyBalanceFromInvoice(ctx, inv);
  await (await import('./credits.ts')).reinstateCredits(ctx, inv, inv.status_transitions.voided_at);
  await emit(ctx, 'invoice.voided', inv);
  return inv;
}

export async function markUncollectible(ctx: Ctx, inv: any) {
  if (inv.status !== 'open') throw invalid('Only open invoices can be marked uncollectible.', 'invoice');
  inv.status = 'uncollectible';
  inv.next_payment_attempt = null;
  inv.status_transitions.marked_uncollectible_at = await clockTime(ctx.accountId, inv.test_clock);
  await saveObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.marked_uncollectible', inv);
  return inv;
}

export async function deleteDraft(ctx: Ctx, inv: any) {
  if (inv.status !== 'draft') throw invalid('Only draft invoices can be deleted.', 'invoice');
  for (const l of inv.lines.data) {
    if (l.invoice_item) {
      const it = await findObject<any>(ctx.accountId, 'invoiceitem', l.invoice_item);
      if (it) { it.invoice = null; await saveObject(ctx.accountId, it); }
    }
  }
  inv.deleted = true;
  inv.status = 'deleted';
  await saveObject(ctx.accountId, inv);
  await emit(ctx, 'invoice.deleted', inv);
  return { id: inv.id, object: 'invoice', deleted: true };
}

// PaymentIntent outcomes drive invoice state, whichever path confirmed the payment.
onPaymentSucceeded(async (ctx, pi) => {
  const invId = pi.invoice ?? pi.metadata?.invoice;
  if (!invId) return;
  const inv = await findObject<any>(ctx.accountId, 'invoice', invId);
  if (!inv || inv.status !== 'open') return;
  if (pi.metadata?.installment !== undefined && (await applyInstallmentPayment(ctx, inv, pi))) return;
  await markPaid(ctx, inv, pi);
});

onPaymentFailed(async (ctx, pi) => {
  const invId = pi.invoice ?? pi.metadata?.invoice;
  if (!invId) return;
  const inv = await findObject<any>(ctx.accountId, 'invoice', invId);
  const err = pi.last_payment_error ?? null;
  if (inv && inv.status === 'open') await recordFailure(ctx, inv, await clockTime(ctx.accountId, inv.test_clock), { code: err?.decline_code ?? err?.code ?? null, message: err?.message ?? null });
});
