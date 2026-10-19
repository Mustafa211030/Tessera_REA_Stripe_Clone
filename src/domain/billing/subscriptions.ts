import { query } from '../../db/index.ts';
import { CommitThenFail, invalid, missing } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { arr, bool, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { applicationId } from '../connect/accounts.ts';
import { billingConnectParams } from '../connect/transfers.ts';
import { locate, priceLines, taxRateIds } from '../tax.ts';
import { diff, emit } from '../events.ts';
import { resolvePaymentMethod } from '../paymentMethods.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { licensedAmount, priceAmount, redeemCoupon, resolvePrice } from './catalog.ts';
import { atTime, clockTime } from './clocks.ts';
import { hasMetered, meteredLines } from './meters.ts';
import { discountFromParams } from './promotions.ts';
import { addInterval, draftInvoice, finalizeInvoice, markUncollectible, payInvoice, voidInvoice, type SubLine } from './invoices.ts';

const DAY = 86400;
const LIVE_STATUSES = ['trialing', 'active', 'past_due'];

function itemObject(subId: string, price: any, quantity: number, now: number, period: { start: number; end: number }, taxRates: string[] = [], thresholds: any = null) {
  return {
    id: newId('si', 14),
    object: 'subscription_item',
    billing_thresholds: thresholds,
    created: now,
    current_period_end: period.end,
    current_period_start: period.start,
    discounts: [],
    metadata: {},
    price,
    quantity,
    subscription: subId,
    tax_rates: taxRates,
  };
}

const isMetered = (price: any) => price?.recurring?.usage_type === 'metered';

/** `billing_thresholds[amount_gte]` (+ reset_billing_cycle_anchor) on a subscription; '' clears it. */
function subThresholds(p: Params, existing: any = null) {
  if (p.billing_thresholds === undefined) return existing;
  if (p.billing_thresholds === '') return null;
  const amount = int(p.billing_thresholds, 'amount_gte', { min: 50 });
  if (amount === undefined) throw missing('billing_thresholds[amount_gte]');
  return { amount_gte: amount, reset_billing_cycle_anchor: bool(p.billing_thresholds, 'reset_billing_cycle_anchor') ?? false };
}

/** `items[i][billing_thresholds][usage_gte]`: only for metered prices. */
function itemThresholds(spec: any, price: any, i: number) {
  if (!spec?.billing_thresholds) return null;
  if (!isMetered(price)) throw invalid('Usage thresholds can only be set on metered prices.', `items[${i}][billing_thresholds]`);
  return { usage_gte: int(spec.billing_thresholds, 'usage_gte', { required: true, min: 1 })! };
}

/** Lines billed in advance for a period. Metered items appear at zero (usage is billed in arrears) unless skipped. */
function linesFor(sub: any, period: { start: number; end: number }, opts: { skipMetered?: boolean } = {}): SubLine[] {
  return sub.items.data
    .filter((it: any) => !(opts.skipMetered && isMetered(it.price)))
    .map((it: any) => ({ price: it.price, quantity: it.quantity ?? 0, subscription_item: it.id, period, tax_rates: it.tax_rates ?? [] }));
}

/** Quantity for a subscription item: metered prices take none (usage comes from the meter). */
function itemQuantity(spec: any, price: any, param: string, fallback: number | null = 1) {
  if (isMetered(price)) {
    if (spec?.quantity !== undefined && spec.quantity !== '') throw invalid('You cannot set the quantity for metered plans.', param);
    return null;
  }
  return int(spec, 'quantity', { min: 0 }) ?? fallback ?? 1;
}

function setPeriod(sub: any, start: number, end: number) {
  sub.current_period_start = start;
  sub.current_period_end = end;
  for (const it of sub.items.data) {
    it.current_period_start = start;
    it.current_period_end = end;
  }
}

async function attachDefaultPm(ctx: Ctx, customer: any, pmId: string | undefined) {
  if (!pmId) return undefined;
  const pm = await resolvePaymentMethod(ctx, pmId, 'default_payment_method');
  if (pm.customer && pm.customer !== customer.id) throw invalid('This PaymentMethod belongs to a different customer.', 'default_payment_method');
  if (!pm.customer) {
    pm.customer = customer.id;
    await saveObject(ctx.accountId, pm);
    await emit(ctx, 'payment_method.attached', pm);
  }
  return pm.id as string;
}

export async function createSubscription(ctx: Ctx, p: Params, internal: { schedule?: string } = {}) {
  const customerId = str(p, 'customer', { required: true })!;
  const customer = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer', 'customer');
  const now = await clockTime(ctx.accountId, customer.test_clock);
  const itemsIn = arr(p, 'items');
  if (!itemsIn?.length) throw missing('items');
  const prices = [];
  for (let i = 0; i < itemsIn.length; i++) {
    const price = await resolvePrice(ctx, itemsIn[i], `items[${i}]`);
    if (price.type !== 'recurring') throw invalid(`The price specified is set to \`type=one_time\` but this field only accepts prices with \`type=recurring\`.`, `items[${i}][price]`);
    prices.push({ price, quantity: itemQuantity(itemsIn[i], price, `items[${i}][quantity]`) as any, tax_rates: (await taxRateIds(ctx, itemsIn[i], 'tax_rates')) ?? [], thresholds: itemThresholds(itemsIn[i], price, i) });
  }
  const first = prices[0]!.price;
  for (const { price } of prices) {
    if (price.currency !== first.currency) throw invalid('All prices on a subscription must have the same currency.', 'items');
    if (price.recurring.interval !== first.recurring.interval || price.recurring.interval_count !== first.recurring.interval_count) {
      throw invalid('All prices on a subscription must have the same recurring interval and interval_count.', 'items');
    }
  }
  const collection_method = oneOf(p, 'collection_method', ['charge_automatically', 'send_invoice'] as const, 'charge_automatically')!;
  const days_until_due = int(p, 'days_until_due', { min: 0 });
  if (collection_method === 'send_invoice' && days_until_due === undefined) throw missing('days_until_due');
  const payment_behavior = oneOf(p, 'payment_behavior', ['allow_incomplete', 'default_incomplete', 'error_if_incomplete', 'pending_if_incomplete'] as const, 'allow_incomplete')!;
  const default_payment_method = await attachDefaultPm(ctx, customer, str(p, 'default_payment_method'));

  let trialEnd: number | null = null;
  const trialDays = int(p, 'trial_period_days', { min: 0, max: 730 });
  if (trialDays) trialEnd = now + trialDays * DAY;
  if (p.trial_end !== undefined && p.trial_end !== 'now') {
    trialEnd = int(p, 'trial_end')!;
    if (trialEnd <= now) throw invalid('trial_end must be in the future.', 'trial_end');
  }
  const interval = first.recurring.interval;
  const count = first.recurring.interval_count;
  const anchor = trialEnd ?? now;
  const periodEnd = trialEnd ?? addInterval(anchor, interval, count);

  const id = newId('sub');
  const sub: any = {
    id,
    object: 'subscription',
    application: null,
    application_fee_percent: null,
    automatic_tax: { enabled: bool(p.automatic_tax ?? {}, 'enabled') ?? false, liability: null },
    billing_cycle_anchor: anchor,
    cancel_at: int(p, 'cancel_at') ?? null,
    cancel_at_period_end: bool(p, 'cancel_at_period_end') ?? false,
    canceled_at: null,
    cancellation_details: { comment: null, feedback: null, reason: null },
    collection_method,
    created: now,
    currency: first.currency,
    current_period_end: periodEnd,
    current_period_start: now,
    customer: customerId,
    days_until_due: days_until_due ?? null,
    default_payment_method: default_payment_method ?? null,
    default_tax_rates: (await taxRateIds(ctx, p, 'default_tax_rates')) ?? [],
    description: str(p, 'description') ?? null,
    discount: null as any,
    ended_at: null,
    items: { object: 'list', data: [] as any[], has_more: false, total_count: prices.length, url: `/v1/subscription_items?subscription=${id}` },
    latest_invoice: null as string | null,
    livemode: false,
    metadata: metadata(p),
    pause_collection: null,
    pending_update: null,
    billing_thresholds: null as any,
    schedule: internal.schedule ?? null,
    start_date: now,
    status: 'incomplete',
    test_clock: customer.test_clock ?? null,
    trial_end: trialEnd,
    trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
    trial_start: trialEnd ? now : null,
    // Number of whole intervals from billing_cycle_anchor to current_period_end.
    _cycles: trialEnd ? 0 : 1,
  };
  Object.assign(sub, { on_behalf_of: null, transfer_data: null }, await billingConnectParams(ctx, p, { percent: true }));
  if (sub.application_fee_percent !== null || sub.transfer_data) sub.application = ctx.platformAccountId ? applicationId(ctx.platformAccountId) : null;
  sub.items.data = prices.map(({ price, quantity, tax_rates, thresholds }) => itemObject(id, price, quantity, now, { start: now, end: periodEnd }, tax_rates, thresholds));
  sub.billing_thresholds = subThresholds(p);
  if (sub.automatic_tax.enabled && !locate(customer)) {
    throw invalid("The customer's location isn't recognized. Set an address with a country (and a state for the US and Canada) to use automatic tax.", 'customer', 'customer_tax_location_invalid');
  }
  const firstAmount = trialEnd ? 0 : prices.reduce((s, x) => s + licensedAmount(x.price, x.quantity as any), 0);
  sub.discount = await discountFromParams(ctx, p, { customer: customerId, subscription: id }, now, { amount: trialEnd ? undefined : firstAmount, currency: first.currency });
  await insertObject(ctx.accountId, sub);

  // First invoice: $0 for trials, otherwise the first period in advance.
  const lines = linesFor(sub, { start: now, end: periodEnd });
  if (trialEnd) for (const l of lines) { l.amount = 0; l.description = `Trial period for ${(await findObject<any>(ctx.accountId, 'product', l.price.product))?.name ?? 'subscription'}`; }
  const inv = await draftInvoice(ctx, { customer, subscription: sub, billing_reason: 'subscription_create', collection_method, days_until_due, now, lines, default_payment_method });
  sub.latest_invoice = inv.id;
  sub.status = trialEnd ? 'trialing' : collection_method === 'send_invoice' ? 'active' : 'incomplete';
  await saveObject(ctx.accountId, sub);
  await emit(ctx, 'customer.subscription.created', sub);

  await finalizeInvoice(ctx, inv, now);
  if (!trialEnd && collection_method === 'charge_automatically') {
    if (payment_behavior === 'default_incomplete') {
      await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id), { confirm: false });
    } else {
      const r = await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id), { throwOnFailure: payment_behavior === 'error_if_incomplete' });
      if (payment_behavior === 'error_if_incomplete' && r instanceof CommitThenFail) {
        const s = await getObject<any>(ctx.accountId, 'subscription', id);
        s.status = 'incomplete_expired';
        await saveObject(ctx.accountId, s);
        return r;
      }
    }
  }
  return getObject<any>(ctx.accountId, 'subscription', id);
}

/** Prorated amount for the unused (or remaining) part of a period. */
const prorate = (amount: number, from: number, to: number, start: number, end: number) => Math.round((amount * Math.max(0, to - from)) / Math.max(1, end - start));

export async function updateSubscription(ctx: Ctx, id: string, p: Params) {
  const sub = await getObject<any>(ctx.accountId, 'subscription', id, 'subscription');
  if (['canceled', 'incomplete_expired'].includes(sub.status)) throw invalid(`A ${sub.status} subscription can't be updated.`, 'subscription');
  const before = structuredClone(sub);
  const customer = await getObject<any>(ctx.accountId, 'customer', sub.customer);
  const now = await clockTime(ctx.accountId, sub.test_clock);
  const behavior = oneOf(p, 'proration_behavior', ['create_prorations', 'none', 'always_invoice'] as const, 'create_prorations')!;

  if (p.cancel_at_period_end !== undefined) {
    sub.cancel_at_period_end = bool(p, 'cancel_at_period_end');
    sub.canceled_at = sub.cancel_at_period_end ? now : null;
    sub.cancellation_details.reason = sub.cancel_at_period_end ? 'cancellation_requested' : null;
  }
  if (p.cancel_at !== undefined) sub.cancel_at = p.cancel_at === '' ? null : int(p, 'cancel_at');
  if (p.default_payment_method !== undefined) sub.default_payment_method = p.default_payment_method ? await attachDefaultPm(ctx, customer, String(p.default_payment_method)) : null;
  if (p.description !== undefined) sub.description = p.description || null;
  if (p.pause_collection !== undefined) sub.pause_collection = pauseFrom(p, now);
  if (p.collection_method !== undefined) sub.collection_method = oneOf(p, 'collection_method', ['charge_automatically', 'send_invoice'] as const);
  if (p.days_until_due !== undefined) sub.days_until_due = int(p, 'days_until_due');
  if (p.discounts === '' || (Array.isArray(p.discounts) && !p.discounts.length)) sub.discount = null;
  else {
    const d = await discountFromParams(ctx, p, { customer: sub.customer, subscription: id }, now, { currency: sub.currency, amount: sub.items.data.reduce((s: number, it: any) => s + licensedAmount(it.price, it.quantity), 0) });
    if (d) sub.discount = d;
  }
  if (p.trial_end === 'now' && sub.status === 'trialing') {
    sub.trial_end = now;
    sub.billing_cycle_anchor = now;
    sub._cycles = 0;
    sub.current_period_end = now; // the engine renews immediately into a paid period
  }
  sub.metadata = metadata(p, sub.metadata);
  if (p.default_tax_rates !== undefined) sub.default_tax_rates = (await taxRateIds(ctx, p, 'default_tax_rates')) ?? [];
  sub.billing_thresholds = subThresholds(p, sub.billing_thresholds ?? null);
  if (p.automatic_tax?.enabled !== undefined) sub.automatic_tax.enabled = bool(p.automatic_tax, 'enabled');
  Object.assign(sub, await billingConnectParams(ctx, { ...p, _existing_transfer_data: sub.transfer_data }, { percent: true }));

  const itemsIn = arr(p, 'items');
  if (itemsIn?.length) {
    const credits: { it: any; amount: number }[] = [];
    const debits: { price: any; quantity: number; amount: number }[] = [];
    const next = sub.items.data.map((x: any) => ({ ...x }));
    for (let i = 0; i < itemsIn.length; i++) {
      const spec = itemsIn[i];
      const existing = spec.id ? next.find((x: any) => x.id === spec.id) : null;
      if (spec.id && !existing) throw invalid(`No such subscription item: '${spec.id}'`, `items[${i}][id]`);
      if (existing && (spec.deleted === 'true' || spec.deleted === true)) {
        credits.push({ it: existing, amount: licensedAmount(existing.price, existing.quantity) });
        next.splice(next.indexOf(existing), 1);
        continue;
      }
      const price = spec.price || spec.price_data ? await resolvePrice(ctx, spec, `items[${i}]`) : existing?.price;
      if (!price) throw missing(`items[${i}][price]`);
      if (price.type !== 'recurring') throw invalid('Subscription items need recurring prices.', `items[${i}][price]`);
      const qty = itemQuantity(spec, price, `items[${i}][quantity]`, existing && existing.price.id === price.id ? existing.quantity : 1) as any;
      if (existing) {
        if (existing.price.id === price.id && existing.quantity === qty) continue;
        credits.push({ it: existing, amount: licensedAmount(existing.price, existing.quantity) });
        existing.price = price;
        existing.quantity = qty;
        debits.push({ price, quantity: qty, amount: licensedAmount(price, qty) });
      } else {
        const it = itemObject(id, price, qty, now, { start: sub.current_period_start, end: sub.current_period_end });
        next.push(it);
        debits.push({ price, quantity: qty, amount: licensedAmount(price, qty) });
      }
    }
    if (!next.length) throw invalid('A subscription must keep at least one item.', 'items');
    const ref = next[0].price.recurring;
    if (next.some((x: any) => x.price.recurring.interval !== ref.interval || x.price.recurring.interval_count !== ref.interval_count || x.price.currency !== sub.currency)) {
      throw invalid('All items must share the same currency, interval and interval_count.', 'items');
    }
    const intervalChanged = ref.interval !== before.items.data[0].price.recurring.interval || ref.interval_count !== before.items.data[0].price.recurring.interval_count;
    sub.items.data = next;
    sub.items.total_count = next.length;
    const start = sub.current_period_start;
    const end = sub.current_period_end;
    const product = async (price: any) => (await findObject<any>(ctx.accountId, 'product', price.product))?.name ?? 'item';
    const mkItem = async (amount: number, description: string, priceId: string | null, qty: number, period: { start: number; end: number }) => {
      const taxRates = sub.items.data.find((x: any) => x.price.id === priceId)?.tax_rates ?? before.items.data.find((x: any) => x.price.id === priceId)?.tax_rates ?? [];
      const item = { id: newId('ii'), object: 'invoiceitem', amount, currency: sub.currency, customer: sub.customer, date: now, description, discountable: false, invoice: null, livemode: false, metadata: {}, period, price: priceId, proration: true, quantity: qty, subscription: id, tax_rates: taxRates, test_clock: sub.test_clock, created: now };
      await insertObject(ctx.accountId, item);
    };
    if (sub.status !== 'trialing' && behavior !== 'none') {
      for (const c of credits) await mkItem(-prorate(c.amount, now, end, start, end), `Unused time on ${await product(c.it.price)} after ${new Date(now * 1000).toISOString().slice(0, 10)}`, c.it.price.id, c.it.quantity, { start: now, end });
      if (!intervalChanged) for (const d of debits) await mkItem(prorate(d.amount, now, end, start, end), `Remaining time on ${d.quantity} × ${await product(d.price)} after ${new Date(now * 1000).toISOString().slice(0, 10)}`, d.price.id, d.quantity, { start: now, end });
    }
    if (intervalChanged && sub.status !== 'trialing') {
      // A new interval resets the billing cycle: bill the new period now (with any credits).
      const newEnd = addInterval(now, ref.interval, ref.interval_count);
      sub.billing_cycle_anchor = now;
      sub._cycles = 1;
      setPeriod(sub, now, newEnd);
      await saveObject(ctx.accountId, sub);
      const usage = await meteredLines(ctx, before, start, now);
      const inv = await draftInvoice(ctx, { customer, subscription: sub, billing_reason: 'subscription_update', collection_method: sub.collection_method, days_until_due: sub.days_until_due, now, lines: [...usage, ...linesFor(sub, { start: now, end: newEnd }, { skipMetered: true })] });
      sub.latest_invoice = inv.id;
      await saveObject(ctx.accountId, sub);
      await finalizeInvoice(ctx, inv, now);
      if (sub.collection_method === 'charge_automatically') await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id));
    } else if (behavior === 'always_invoice' && sub.status !== 'trialing') {
      await saveObject(ctx.accountId, sub);
      const inv = await draftInvoice(ctx, { customer, subscription: sub, billing_reason: 'subscription_update', collection_method: sub.collection_method, days_until_due: sub.days_until_due, now, lines: [] });
      sub.latest_invoice = inv.id;
      await saveObject(ctx.accountId, sub);
      await finalizeInvoice(ctx, inv, now);
      if (sub.collection_method === 'charge_automatically') await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id));
    }
  }
  // Invoice payments above may have changed the stored status (e.g. past_due -> active).
  const stored = await getObject<any>(ctx.accountId, 'subscription', id);
  const fresh = { ...sub, status: stored.status };
  await saveObject(ctx.accountId, fresh);
  await emit(ctx, 'customer.subscription.updated', fresh, diff(before, fresh));
  if (p.trial_end === 'now') await runBilling(ctx, fresh.test_clock, now);
  return getObject<any>(ctx.accountId, 'subscription', id);
}

export async function cancelSubscription(ctx: Ctx, id: string, p: Params, reason = 'cancellation_requested') {
  const sub = await getObject<any>(ctx.accountId, 'subscription', id, 'subscription');
  if (sub.status === 'canceled') throw invalid('This subscription is already canceled.', 'subscription');
  const now = await clockTime(ctx.accountId, sub.test_clock);
  return endSubscription(ctx, sub, now, reason, bool(p, 'invoice_now') ?? false);
}

async function endSubscription(ctx: Ctx, sub: any, at: number, reason: string, invoiceNow = false) {
  const prev = sub.status;
  // Usage reported during the final (paid) period is billed on a last invoice.
  const usage = prev !== 'trialing' && LIVE_STATUSES.includes(prev) && hasMetered(sub) ? await meteredLines(ctx, sub, sub.current_period_start, at) : [];
  sub.status = 'canceled';
  sub.canceled_at = sub.canceled_at ?? at;
  sub.ended_at = at;
  sub.cancellation_details = { ...sub.cancellation_details, reason };
  await saveObject(ctx.accountId, sub);
  if (invoiceNow || usage.some((l) => (l.amount ?? 0) > 0)) {
    const customer = await getObject<any>(ctx.accountId, 'customer', sub.customer);
    const inv = await draftInvoice(ctx, { customer, subscription: sub, billing_reason: 'subscription_update', collection_method: sub.collection_method, days_until_due: sub.days_until_due, now: at, lines: usage, includePending: invoiceNow });
    if (inv.lines.data.length) {
      await finalizeInvoice(ctx, inv, at);
      await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id));
    }
  }
  if (prev === 'incomplete') sub.status = 'incomplete_expired';
  await saveObject(ctx.accountId, sub);
  await emit(ctx, 'customer.subscription.deleted', sub);
  await (await import('./schedules.ts')).subscriptionEnded(ctx, sub, at);
  return sub;
}

/**
 * pause_collection: renewals keep happening (the subscription stays active), but their
 * invoices are kept as drafts, marked uncollectible or voided instead of being collected.
 * `resumes_at` lifts the pause automatically.
 */
function pauseFrom(p: Params, now: number) {
  const v = p.pause_collection;
  if (v === '' || v === null) return null;
  if (typeof v !== 'object') throw invalid('pause_collection must be an object, or an empty string to resume collection.', 'pause_collection');
  const behavior = oneOf(v, 'behavior', ['keep_as_draft', 'mark_uncollectible', 'void'] as const);
  if (!behavior) throw invalid('Missing required param: pause_collection[behavior].', 'pause_collection[behavior]', 'parameter_missing');
  const resumes_at = v.resumes_at === undefined || v.resumes_at === '' ? null : int(v, 'resumes_at')!;
  if (resumes_at !== null && resumes_at <= now) throw invalid('pause_collection[resumes_at] must be in the future.', 'pause_collection[resumes_at]');
  return { behavior, resumes_at };
}

const pausedAt = (sub: any, at: number) => !!sub.pause_collection && (sub.pause_collection.resumes_at === null || sub.pause_collection.resumes_at > at);

// ---------------- billing engine ----------------

/** Moves one subscription forward by one period: cancels, or invoices the next period. */
async function renewOnce(ctx: Ctx, sub: any) {
  const at = sub.current_period_end;
  if (sub.cancel_at && sub.cancel_at <= at) return endSubscription(ctx, sub, sub.cancel_at, 'cancellation_requested');
  if (sub.cancel_at_period_end) return endSubscription(ctx, sub, at, 'cancellation_requested');
  const customer = await getObject<any>(ctx.accountId, 'customer', sub.customer);
  const ref = sub.items.data[0].price.recurring;
  const wasTrial = sub.status === 'trialing';
  // Metered usage from the period that just ended is billed in arrears on the renewal invoice.
  const usage = wasTrial ? [] : await meteredLines(ctx, sub, Math.max(sub.current_period_start, sub._usage_from ?? 0), at);
  delete sub._usage_from;
  sub._cycles = (sub._cycles ?? 0) + 1;
  const end = addInterval(sub.billing_cycle_anchor, ref.interval, ref.interval_count, sub._cycles);
  setPeriod(sub, at, end);
  if (wasTrial) sub.status = 'active';
  await saveObject(ctx.accountId, sub);
  if (wasTrial) await emit(ctx, 'customer.subscription.updated', sub, { status: 'trialing' });
  const inv = await draftInvoice(ctx, { customer, subscription: sub, billing_reason: 'subscription_cycle', collection_method: sub.collection_method, days_until_due: sub.days_until_due, now: at, lines: [...usage, ...linesFor(sub, { start: at, end }, { skipMetered: true })] });
  sub.latest_invoice = inv.id;
  await saveObject(ctx.accountId, sub);
  if (pausedAt(sub, at)) {
    const b = sub.pause_collection.behavior;
    if (b === 'keep_as_draft') {
      inv.auto_advance = false;
      await saveObject(ctx.accountId, inv);
      return;
    }
    await finalizeInvoice(ctx, inv, at);
    const fresh = await getObject<any>(ctx.accountId, 'invoice', inv.id);
    if (fresh.status !== 'open') return; // $0 invoices are already paid
    fresh.auto_advance = false;
    if (b === 'void') await voidInvoice(ctx, fresh);
    else await markUncollectible(ctx, fresh);
    return;
  }
  await finalizeInvoice(ctx, inv, at);
  if (sub.collection_method === 'charge_automatically') await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id));
}

async function retryInvoice(ctx: Ctx, inv: any) {
  // A failure schedules the next attempt (or applies the after-failure settings) itself.
  await payInvoice(ctx, inv);
}

/** Retries ran out and Settings → Billing says to cancel. */
export async function cancelForNonPayment(ctx: Ctx, sub: any, at: number) {
  return endSubscription(ctx, sub, at, 'payment_failed');
}

type Due = { at: number; kind: 'renew' | 'retry' | 'expire' | 'trial_will_end' | 'schedule' | 'resume'; id: string };
// At the same instant, schedule phase changes run before renewals so the renewal bills the new phase;
// a pause that ends at a renewal is lifted first, so that renewal is collected.
const KIND_ORDER: Record<Due['kind'], number> = { schedule: 0, resume: 1, trial_will_end: 2, renew: 3, expire: 4, retry: 5 };

async function nextDue(accountId: string, clockId: string | null, now: number): Promise<Due | null> {
  const clockCond = clockId ? "data->>'test_clock' = $2" : "data->>'test_clock' IS NULL";
  const args = clockId ? [accountId, clockId] : [accountId];
  const subs = await query<{ data: any }>(`SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription' AND ${clockCond} AND data->>'status' IN ('trialing','active','past_due','incomplete')`, args);
  const invs = await query<{ data: any }>(`SELECT data FROM objects WHERE account_id = $1 AND type = 'invoice' AND ${clockCond} AND data->>'status' = 'open' AND data->>'next_payment_attempt' IS NOT NULL`, args);
  const cands: Due[] = [];
  for (const { data: s } of subs) {
    if (s.status === 'incomplete') cands.push({ at: s.created + 23 * 3600, kind: 'expire', id: s.id });
    else cands.push({ at: s.current_period_end, kind: 'renew', id: s.id });
    if (s.status === 'trialing' && !s._trial_will_end_sent && s.trial_end) cands.push({ at: s.trial_end - 3 * DAY, kind: 'trial_will_end', id: s.id });
    if (s.pause_collection?.resumes_at) cands.push({ at: s.pause_collection.resumes_at, kind: 'resume', id: s.id });
  }
  for (const { data: i } of invs) cands.push({ at: i.next_payment_attempt, kind: 'retry', id: i.id });
  cands.push(...(await (await import('./schedules.ts')).scheduleDues(accountId, clockId)));
  const due = cands.filter((c) => c.at <= now).sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return due[0] ?? null;
}

/** Process every billing event due up to `now`, in time order (renewals, retries, expiries). */
export async function runBilling(ctx: Ctx, clockId: string | null, now: number): Promise<number> {
  let n = 0;
  for (; n < 1000; n++) {
    const due = await nextDue(ctx.accountId, clockId, now);
    if (!due) break;
    await atTime(due.at, () => processDue(ctx, due));
  }
  return n;
}

async function processDue(ctx: Ctx, due: Due) {
  {
    if (due.kind === 'renew') {
      await renewOnce(ctx, await getObject(ctx.accountId, 'subscription', due.id));
    } else if (due.kind === 'retry') {
      const inv = await getObject<any>(ctx.accountId, 'invoice', due.id);
      await retryInvoice(ctx, inv);
      const fresh = await getObject<any>(ctx.accountId, 'invoice', due.id);
      if (fresh.status === 'open' && fresh.next_payment_attempt !== null && fresh.next_payment_attempt <= due.at) {
        fresh.next_payment_attempt = null; // safety: never loop on the same attempt
        await saveObject(ctx.accountId, fresh);
      }
    } else if (due.kind === 'expire') {
      const sub = await getObject<any>(ctx.accountId, 'subscription', due.id);
      sub.status = 'incomplete_expired';
      sub.ended_at = due.at;
      await saveObject(ctx.accountId, sub);
      if (sub.latest_invoice) {
        const inv = await findObject<any>(ctx.accountId, 'invoice', sub.latest_invoice);
        if (inv?.status === 'open') await voidInvoice(ctx, inv);
      }
      await emit(ctx, 'customer.subscription.deleted', sub);
      await (await import('./schedules.ts')).subscriptionEnded(ctx, sub, due.at);
    } else if (due.kind === 'resume') {
      const sub = await getObject<any>(ctx.accountId, 'subscription', due.id);
      const prev = sub.pause_collection;
      sub.pause_collection = null;
      await saveObject(ctx.accountId, sub);
      await emit(ctx, 'customer.subscription.updated', sub, { pause_collection: prev });
    } else if (due.kind === 'schedule') {
      await (await import('./schedules.ts')).advanceSchedule(ctx, due.id, due.at);
    } else {
      const sub = await getObject<any>(ctx.accountId, 'subscription', due.id);
      sub._trial_will_end_sent = true;
      await saveObject(ctx.accountId, sub);
      await emit(ctx, 'customer.subscription.trial_will_end', sub);
    }
  }
}

/** Preview of the next invoice (what the renewal would bill, including pending prorations). */
export async function previewUpcoming(ctx: Ctx, subId: string) {
  const sub = await getObject<any>(ctx.accountId, 'subscription', subId, 'subscription', 'subscription');
  if (!LIVE_STATUSES.includes(sub.status)) throw invalid('No upcoming invoices for this subscription.', 'subscription', 'invoice_upcoming_none');
  const ref = sub.items.data[0].price.recurring;
  const start = sub.current_period_end;
  let end = addInterval(sub.billing_cycle_anchor, ref.interval, ref.interval_count, (sub._cycles ?? 0) + 1);
  const pending = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'invoiceitem' AND data->>'customer' = $2 AND data->>'invoice' IS NULL", [ctx.accountId, sub.customer])).map((r) => r.data).filter((i) => !i.subscription || i.subscription === sub.id);
  // A schedule whose next phase starts at the renewal changes what the renewal bills.
  let nextItems = sub.items.data;
  if (sub.schedule) {
    const sched = await findObject<any>(ctx.accountId, 'subscription_schedule', sub.schedule);
    const next = sched?.status === 'active' && sched._phase !== null ? sched.phases[sched._phase + 1] : null;
    if (next && sched.phases[sched._phase].end_date === sub.current_period_end) {
      nextItems = [];
      for (const it of next.items) nextItems.push({ price: await getObject<any>(ctx.accountId, 'price', it.price), quantity: it.quantity, tax_rates: it.tax_rates ?? [] });
    }
  }
  const nref = nextItems[0].price.recurring;
  if (nextItems !== sub.items.data && (nref.interval !== ref.interval || nref.interval_count !== ref.interval_count)) end = addInterval(start, nref.interval, nref.interval_count);
  const names: Record<string, string> = {};
  for (const it of [...sub.items.data, ...nextItems]) names[it.price.product] = (await findObject<any>(ctx.accountId, 'product', it.price.product))?.name ?? it.price.product;
  const { priceSummary } = await import('./catalog.ts');
  const now = await clockTime(ctx.accountId, sub.test_clock);
  const usage = sub.status === 'trialing' ? [] : await meteredLines(ctx, sub, sub.current_period_start, Math.min(now + 1, sub.current_period_end));
  const lines = [
    ...usage.map((u) => ({ object: 'line_item', amount: u.amount!, currency: u.price.currency, description: u.description!, period: { start: sub.current_period_start, end: sub.current_period_end }, price: u.price.id, proration: false, quantity: u.quantity, type: 'subscription' })),
    ...nextItems.filter((it: any) => !isMetered(it.price)).map((it: any) => ({ object: 'line_item', amount: licensedAmount(it.price, it.quantity), currency: it.price.currency, description: `${it.quantity} × ${names[it.price.product]} (${priceSummary(it.price)})`, period: { start, end }, price: it.price.id, proration: false, quantity: it.quantity, type: 'subscription' })),
    ...pending.map((i) => ({ object: 'line_item', amount: i.amount, currency: i.currency, description: i.description, period: i.period, price: i.price, proration: i.proration, quantity: i.quantity, type: 'invoiceitem' })),
  ];
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const { discountAmount } = await import('./catalog.ts');
  const off = sub.discount ? discountAmount(sub.discount, Math.max(0, subtotal), sub.currency, start, !sub.discount._applied) : 0;
  const customer = await findObject<any>(ctx.accountId, 'customer', sub.customer);
  const itemRates = (l: any) => sub.items.data.find((it: any) => it.price.id === l.price)?.tax_rates ?? [];
  const priced = await priceLines(ctx, lines.map((l: any) => ({ amount: l.amount, discountable: !l.proration, tax_rates: itemRates(l), price: l.price })), { discountTotal: off, defaultTaxRates: sub.default_tax_rates, automatic: sub.automatic_tax?.enabled, customer });
  lines.forEach((l: any, i: number) => { l.tax_amounts = priced.lines[i]!.tax_amounts; });
  const { balanceEffect } = await import('./balance.ts');
  const bal = balanceEffect(customer, Math.max(0, priced.total), sub.currency);
  return {
    object: 'invoice',
    id: null,
    amount_due: bal.due,
    starting_balance: bal.starting,
    ending_balance: bal.ending,
    automatic_tax: { enabled: !!sub.automatic_tax?.enabled, liability: null, status: priced.automatic_status },
    tax: priced.tax,
    total_tax_amounts: priced.total_tax_amounts,
    total_excluding_tax: Math.max(0, priced.total) - priced.tax,
    billing_reason: 'upcoming',
    currency: sub.currency,
    customer: sub.customer,
    lines: { object: 'list', data: lines, has_more: false, url: '' },
    next_payment_attempt: start,
    period_end: start,
    period_start: sub.current_period_start,
    status: 'draft',
    subscription: sub.id,
    subtotal,
    total: Math.max(0, priced.total),
    total_discount_amounts: off ? [{ amount: off, discount: sub.discount.id }] : [],
  };
}

/**
 * Billing thresholds: when usage since the last invoice reaches `billing_thresholds[amount_gte]`
 * (in money) or an item's `usage_gte` (in units), bill it right away instead of waiting for the
 * period to end (billing_reason=subscription_threshold). With reset_billing_cycle_anchor the
 * subscription also starts a fresh period now. Checked whenever usage is reported.
 */
export async function checkThresholds(ctx: Ctx, customerId: string) {
  const subs = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription' AND data->>'customer' = $2 AND data->>'status' IN ('active','past_due')", [ctx.accountId, customerId])).map((r) => r.data);
  for (const sub of subs) {
    const itemLimits = sub.items.data.filter((it: any) => it.billing_thresholds?.usage_gte);
    if (!sub.billing_thresholds && !itemLimits.length) continue;
    const now = await clockTime(ctx.accountId, sub.test_clock);
    const from = Math.max(sub.current_period_start, sub._usage_from ?? 0);
    const usage = await meteredLines(ctx, sub, from, now + 1);
    const { markBilled } = await import('./meters.ts');
    const total = usage.reduce((s, l) => s + (l.amount ?? 0), 0);
    const hitAmount = sub.billing_thresholds && total >= sub.billing_thresholds.amount_gte;
    const hitUsage = itemLimits.some((it: any) => (usage.find((l) => l.subscription_item === it.id)?.quantity ?? 0) >= it.billing_thresholds.usage_gte);
    if (!hitAmount && !hitUsage) continue;
    const customer = await getObject<any>(ctx.accountId, 'customer', sub.customer);
    const lines: SubLine[] = usage.map((l) => ({ ...l, period: { start: from, end: now } }));
    const reset = hitAmount && sub.billing_thresholds.reset_billing_cycle_anchor;
    if (reset) {
      // A new period starts now: credit the unused licensed time and bill the next period.
      const ref = sub.items.data[0].price.recurring;
      for (const it of sub.items.data.filter((x: any) => !isMetered(x.price))) {
        const credit = prorate(licensedAmount(it.price, it.quantity), now, sub.current_period_end, sub.current_period_start, sub.current_period_end);
        if (credit) lines.push({ price: it.price, quantity: it.quantity, subscription_item: it.id, period: { start: now, end: sub.current_period_end }, amount: -credit, description: `Unused time on ${it.quantity} × ${(await findObject<any>(ctx.accountId, 'product', it.price.product))?.name ?? 'item'}`, tax_rates: it.tax_rates ?? [] });
      }
      const end = addInterval(now, ref.interval, ref.interval_count);
      sub.billing_cycle_anchor = now;
      sub._cycles = 1;
      setPeriod(sub, now, end);
      lines.push(...linesFor(sub, { start: now, end }, { skipMetered: true }));
    }
    await markBilled(ctx.accountId, sub, from, now + 1);
    await saveObject(ctx.accountId, sub);
    const inv = await draftInvoice(ctx, { customer, subscription: sub, billing_reason: 'subscription_threshold', collection_method: sub.collection_method, days_until_due: sub.days_until_due, now, lines, includePending: false });
    sub.latest_invoice = inv.id;
    await saveObject(ctx.accountId, sub);
    await finalizeInvoice(ctx, inv, now);
    if (sub.collection_method === 'charge_automatically') await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id));
  }
}
