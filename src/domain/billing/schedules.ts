import { query } from '../../db/index.ts';
import { CommitThenFail, invalid, missing } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { arr, bool, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { diff, emit } from '../events.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { resolvePrice } from './catalog.ts';
import { clockTime } from './clocks.ts';
import { addInterval } from './invoices.ts';
import { cancelSubscription, createSubscription, updateSubscription } from './subscriptions.ts';

/**
 * Subscription schedules: a timeline of phases, each with its own prices and quantities,
 * that the billing engine applies automatically — "3 months at the intro price, then the
 * standard price", or "start next month", or "switch to annual after a year".
 *
 * A schedule either creates its subscription when the first phase starts, or takes over
 * an existing one (`from_subscription`). At each phase boundary the engine swaps the
 * subscription's items: aligned with a renewal the new prices simply apply to the next
 * period; mid-period it prorates (unless the phase says otherwise). When the last phase
 * ends, `end_behavior` decides whether the subscription keeps going (release) or cancels.
 */

type PhaseItem = { price: string; quantity?: number | null; tax_rates?: string[]; metadata?: Record<string, string> };

const END = ['release', 'cancel'] as const;
const PRORATE = ['create_prorations', 'none', 'always_invoice'] as const;

async function parsePhases(ctx: Ctx, phasesIn: any[], start: number, opts: { keepFirstStart?: boolean } = {}) {
  if (!phasesIn.length) throw missing('phases');
  if (phasesIn.length > 10) throw invalid('A schedule can have at most 10 phases.', 'phases');
  const phases = [];
  let at = start;
  for (let i = 0; i < phasesIn.length; i++) {
    const ph = phasesIn[i];
    const itemsIn = arr(ph, 'items');
    if (!itemsIn?.length) throw missing(`phases[${i}][items]`);
    const items: PhaseItem[] = [];
    let ref: any = null;
    for (let j = 0; j < itemsIn.length; j++) {
      const price = await resolvePrice(ctx, itemsIn[j], `phases[${i}][items][${j}]`);
      if (price.type !== 'recurring') throw invalid('Schedule phases need recurring prices.', `phases[${i}][items][${j}][price]`);
      if (ref && (price.currency !== ref.currency || price.recurring.interval !== ref.recurring.interval || price.recurring.interval_count !== ref.recurring.interval_count)) {
        throw invalid('All prices in a phase must share the same currency and billing interval.', `phases[${i}][items]`);
      }
      ref ??= price;
      const metered = price.recurring.usage_type === 'metered';
      if (metered && itemsIn[j].quantity !== undefined) throw invalid('You cannot set the quantity for metered plans.', `phases[${i}][items][${j}][quantity]`);
      items.push({ price: price.id, quantity: metered ? null : int(itemsIn[j], 'quantity', { min: 0 }) ?? 1, tax_rates: arr(itemsIn[j], 'tax_rates') ?? [], metadata: metadata(itemsIn[j]) });
    }
    const phaseStart = i === 0 && opts.keepFirstStart ? start : (ph.start_date && i === 0 ? (ph.start_date === 'now' ? start : int(ph, 'start_date')!) : at);
    // A phase lasts for `duration` (current API), `iterations` billing periods (older API) or until `end_date`.
    const iterations = int(ph, 'iterations', { min: 1, max: 1000 });
    const duration = ph.duration ? { interval: oneOf(ph.duration, 'interval', ['day', 'week', 'month', 'year'] as const), interval_count: int(ph.duration, 'interval_count', { min: 1, max: 1000 }) ?? 1 } : null;
    if (duration && !duration.interval) throw missing(`phases[${i}][duration][interval]`);
    const endDate = ph.end_date !== undefined && ph.end_date !== '' && ph.end_date !== 'now' ? int(ph, 'end_date')! : undefined;
    if ([iterations, endDate, duration].filter((x) => x !== undefined && x !== null).length > 1) throw invalid('Pass only one of duration, iterations or end_date for a phase.', `phases[${i}][end_date]`);
    let trialEnd: number | null = ph.trial_end !== undefined && ph.trial_end !== '' ? int(ph, 'trial_end')! : null;
    if (trialEnd !== null && i > 0) throw invalid('Only the first phase of a schedule can include a trial.', `phases[${i}][trial_end]`);
    const iv = ref.recurring;
    const periodsFrom = trialEnd ?? phaseStart;
    let end = endDate ?? (duration ? addInterval(periodsFrom, duration.interval!, duration.interval_count) : addInterval(periodsFrom, iv.interval, iv.interval_count, iterations ?? 1));
    if (bool(ph, 'trial')) {
      if (i > 0) throw invalid('Only the first phase of a schedule can include a trial.', `phases[${i}][trial]`);
      trialEnd = end;
    }
    if (end <= phaseStart) throw invalid('Each phase must end after it starts.', `phases[${i}][end_date]`);
    if (trialEnd !== null && (trialEnd <= phaseStart || trialEnd > end)) throw invalid('trial_end must fall within the phase.', `phases[${i}][trial_end]`);
    phases.push({
      add_invoice_items: [],
      application_fee_percent: ph.application_fee_percent !== undefined ? Number(ph.application_fee_percent) : null,
      automatic_tax: ph.automatic_tax ? { enabled: bool(ph.automatic_tax, 'enabled') ?? false, liability: null } : null,
      billing_cycle_anchor: null,
      collection_method: oneOf(ph, 'collection_method', ['charge_automatically', 'send_invoice'] as const) ?? null,
      discounts: phaseDiscounts(ph, i),
      currency: ref.currency,
      default_payment_method: str(ph, 'default_payment_method') ?? null,
      default_tax_rates: arr(ph, 'default_tax_rates') ?? [],
      description: str(ph, 'description') ?? null,
      end_date: end,
      invoice_settings: null,
      items,
      metadata: metadata(ph),
      on_behalf_of: null,
      proration_behavior: oneOf(ph, 'proration_behavior', PRORATE, 'create_prorations'),
      start_date: phaseStart,
      transfer_data: null,
      trial_end: trialEnd,
      _interval: `${iv.interval}/${iv.interval_count}`,
    });
    at = end;
    void end;
  }
  return phases;
}

/** Phase discounts: `discounts[0][coupon|promotion_code]` (current API) or `coupon` (older). */
function phaseDiscounts(ph: any, i: number) {
  const list = arr(ph, 'discounts') ?? (ph.coupon ? [{ coupon: ph.coupon }] : []);
  if (list.length > 1) throw invalid('Only one discount per phase is supported.', `phases[${i}][discounts]`);
  return list.map((d: any) => ({ coupon: d.coupon ? String(d.coupon) : null, discount: null, promotion_code: d.promotion_code ? String(d.promotion_code) : null }));
}
const phaseDiscountParams = (ph: any) => {
  const d = ph.discounts?.[0] ?? (ph.coupon ? { coupon: ph.coupon } : null);
  return d?.promotion_code ? { promotion_code: d.promotion_code } : d?.coupon ? { coupon: d.coupon } : {};
};

function defaultSettings(p: Params, existing?: any) {
  const d = p.default_settings ?? {};
  const base = existing ?? { application_fee_percent: null, automatic_tax: { enabled: false, liability: null }, billing_cycle_anchor: 'automatic', collection_method: 'charge_automatically', default_payment_method: null, description: null, invoice_settings: { days_until_due: null }, on_behalf_of: null, transfer_data: null };
  if (d.collection_method !== undefined) base.collection_method = oneOf(d, 'collection_method', ['charge_automatically', 'send_invoice'] as const);
  if (d.default_payment_method !== undefined) base.default_payment_method = d.default_payment_method || null;
  if (d.description !== undefined) base.description = d.description || null;
  if (d.automatic_tax?.enabled !== undefined) base.automatic_tax = { enabled: bool(d.automatic_tax, 'enabled'), liability: null };
  if (d.invoice_settings?.days_until_due !== undefined) base.invoice_settings = { days_until_due: int(d.invoice_settings, 'days_until_due', { min: 0 }) ?? null };
  if (base.collection_method === 'send_invoice' && base.invoice_settings.days_until_due === null) base.invoice_settings.days_until_due = 30;
  return base;
}

const currentPhase = (s: any) => (s.status === 'active' && s._phase !== null && s.phases[s._phase] ? { start_date: s.phases[s._phase].start_date, end_date: s.phases[s._phase].end_date } : null);

function refresh(s: any) {
  s.current_phase = currentPhase(s);
  return s;
}

/** Subscription params for one phase, combining the schedule defaults and the phase's own settings. */
function phaseSubParams(s: any, ph: any) {
  const d = s.default_settings;
  const cm = ph.collection_method ?? d.collection_method;
  return {
    collection_method: cm,
    ...(cm === 'send_invoice' ? { days_until_due: d.invoice_settings?.days_until_due ?? 30 } : {}),
    ...(ph.default_payment_method ?? d.default_payment_method ? { default_payment_method: ph.default_payment_method ?? d.default_payment_method } : {}),
    ...(ph.description ?? d.description ? { description: ph.description ?? d.description } : {}),
    automatic_tax: { enabled: (ph.automatic_tax?.enabled ?? d.automatic_tax?.enabled) ? 'true' : 'false' },
    ...(ph.default_tax_rates?.length ? { default_tax_rates: ph.default_tax_rates } : {}),
    ...(ph.application_fee_percent !== null && ph.application_fee_percent !== undefined ? { application_fee_percent: ph.application_fee_percent } : {}),
  };
}

const itemParams = (ph: any) => ph.items.map((it: PhaseItem) => ({ price: it.price, ...(it.quantity === null || it.quantity === undefined ? {} : { quantity: it.quantity }), tax_rates: it.tax_rates ?? [] }));

export async function createSchedule(ctx: Ctx, p: Params) {
  const fromSub = str(p, 'from_subscription');
  const id = newId('sub_sched');
  if (fromSub) {
    if (p.phases || p.customer || p.start_date) throw invalid('from_subscription cannot be combined with customer, phases or start_date. Update the schedule after creating it.', 'from_subscription');
    const sub = await getObject<any>(ctx.accountId, 'subscription', fromSub, 'subscription', 'from_subscription');
    if (sub.schedule) throw invalid(`The subscription ${sub.id} is already attached to a schedule.`, 'from_subscription', 'subscription_schedule_already_attached');
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) throw invalid(`A ${sub.status} subscription can't be scheduled.`, 'from_subscription');
    const now = await clockTime(ctx.accountId, sub.test_clock);
    const ref = sub.items.data[0].price;
    const phase = {
      add_invoice_items: [], application_fee_percent: sub.application_fee_percent, automatic_tax: { ...sub.automatic_tax }, billing_cycle_anchor: null,
      collection_method: sub.collection_method, discounts: sub.discount ? [{ coupon: sub.discount.coupon.id, discount: sub.discount.id, promotion_code: sub.discount.promotion_code ?? null }] : [], currency: sub.currency, default_payment_method: sub.default_payment_method,
      default_tax_rates: sub.default_tax_rates ?? [], description: sub.description, end_date: sub.current_period_end, invoice_settings: null,
      items: sub.items.data.map((it: any) => ({ price: it.price.id, quantity: it.quantity, tax_rates: it.tax_rates ?? [], metadata: it.metadata ?? {} })),
      metadata: {}, on_behalf_of: sub.on_behalf_of ?? null, proration_behavior: 'create_prorations', start_date: sub.current_period_start, transfer_data: sub.transfer_data ?? null,
      trial_end: sub.status === 'trialing' ? sub.trial_end : null, _interval: `${ref.recurring.interval}/${ref.recurring.interval_count}`,
    };
    const sched = {
      id, object: 'subscription_schedule', application: sub.application ?? null, canceled_at: null, completed_at: null, created: now, current_phase: null as any,
      customer: sub.customer, default_settings: defaultSettings({ default_settings: { collection_method: sub.collection_method, default_payment_method: sub.default_payment_method ?? '' } }),
      end_behavior: 'release', livemode: false, metadata: metadata(p), phases: [phase], released_at: null, released_subscription: null, status: 'active',
      subscription: sub.id, test_clock: sub.test_clock ?? null, _phase: 0 as number | null,
    };
    refresh(sched);
    await insertObject(ctx.accountId, sched);
    sub.schedule = id;
    await saveObject(ctx.accountId, sub);
    await emit(ctx, 'subscription_schedule.created', sched);
    return sched;
  }

  const customerId = str(p, 'customer', { required: true })!;
  const customer = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer', 'customer');
  const now = await clockTime(ctx.accountId, customer.test_clock);
  const startDate = p.start_date === undefined || p.start_date === 'now' ? now : int(p, 'start_date')!;
  if (startDate < now - 60) throw invalid('start_date cannot be in the past.', 'start_date');
  const phases = await parsePhases(ctx, arr(p, 'phases') ?? [], startDate, { keepFirstStart: true });
  const sched: any = {
    id, object: 'subscription_schedule', application: null, canceled_at: null, completed_at: null, created: now, current_phase: null,
    customer: customerId, default_settings: defaultSettings(p), end_behavior: oneOf(p, 'end_behavior', END, 'release'), livemode: false, metadata: metadata(p),
    phases, released_at: null, released_subscription: null, status: 'not_started', subscription: null, test_clock: customer.test_clock ?? null, _phase: null,
  };
  refresh(sched);
  await insertObject(ctx.accountId, sched);
  await emit(ctx, 'subscription_schedule.created', sched);
  if (startDate <= now) {
    const r = await startSchedule(ctx, sched, now);
    if (r instanceof CommitThenFail) return r;
  }
  return getObject<any>(ctx.accountId, 'subscription_schedule', id);
}

/** First phase begins: create the subscription. */
async function startSchedule(ctx: Ctx, sched: any, at: number) {
  const ph = sched.phases[0];
  const sub = await createSubscription(ctx, {
    customer: sched.customer,
    items: itemParams(ph),
    ...phaseSubParams(sched, ph),
    ...(ph.trial_end ? { trial_end: ph.trial_end } : {}),
    ...phaseDiscountParams(ph),
    metadata: { ...ph.metadata },
  }, { schedule: sched.id });
  if (sub instanceof CommitThenFail) {
    // The subscription exists (incomplete); the schedule still tracks it.
    const fresh = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription' AND data->>'schedule' = $2", [ctx.accountId, sched.id]);
    await markStarted(ctx, sched, fresh[0]?.data?.id ?? null);
    return sub;
  }
  await markStarted(ctx, sched, sub.id);
  void at;
  return sub;
}

async function markStarted(ctx: Ctx, sched: any, subId: string | null) {
  const s = await getObject<any>(ctx.accountId, 'subscription_schedule', sched.id);
  const before = structuredClone(s);
  s.status = 'active';
  s.subscription = subId;
  s._phase = 0;
  refresh(s);
  await saveObject(ctx.accountId, s);
  await emit(ctx, 'subscription_schedule.updated', s, diff(before, s));
}

/** Engine: what time this schedule next needs attention (phase start or end), if any. */
export async function scheduleDues(accountId: string, clockId: string | null) {
  const clockCond = clockId ? "data->>'test_clock' = $2" : "data->>'test_clock' IS NULL";
  const rows = await query<{ data: any }>(`SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription_schedule' AND ${clockCond} AND data->>'status' IN ('not_started','active')`, clockId ? [accountId, clockId] : [accountId]);
  return rows.map(({ data: s }) => ({ at: s.status === 'not_started' ? s.phases[0].start_date : s.phases[s._phase].end_date, kind: 'schedule' as const, id: s.id }));
}

/** Engine: start the schedule, move to the next phase, or finish. Runs at the phase boundary. */
export async function advanceSchedule(ctx: Ctx, id: string, at: number) {
  const s = await getObject<any>(ctx.accountId, 'subscription_schedule', id);
  if (s.status === 'not_started') return startSchedule(ctx, s, at);
  if (s.status !== 'active') return;
  const sub = s.subscription ? await findObject<any>(ctx.accountId, 'subscription', s.subscription) : null;
  const before = structuredClone(s);
  const nextIdx = s._phase + 1;
  if (!sub || ['canceled', 'incomplete_expired'].includes(sub.status)) {
    s.status = 'canceled';
    s.canceled_at = at;
    s._phase = null;
    refresh(s);
    await saveObject(ctx.accountId, s);
    await emit(ctx, 'subscription_schedule.aborted', s);
    return;
  }
  if (nextIdx >= s.phases.length) {
    // Last phase over.
    s._phase = null;
    s.completed_at = at;
    s.status = 'completed';
    if (s.end_behavior === 'cancel') {
      s.status = 'completed';
      refresh(s);
      await saveObject(ctx.accountId, s);
      if (sub.current_period_end === at) {
        sub.cancel_at = at; // the renewal at this instant ends it instead
        await saveObject(ctx.accountId, sub);
      } else {
        await cancelSubscription(ctx, sub.id, {});
      }
    } else {
      s.released_subscription = sub.id;
      refresh(s);
      await saveObject(ctx.accountId, s);
      sub.schedule = null;
      await saveObject(ctx.accountId, sub);
    }
    await emit(ctx, 'subscription_schedule.completed', s);
    return;
  }
  const ph = s.phases[nextIdx];
  s._phase = nextIdx;
  refresh(s);
  await saveObject(ctx.accountId, s);
  await applyPhase(ctx, s, sub, ph, at);
  await emit(ctx, 'subscription_schedule.updated', s, diff(before, s));
}

/** Puts a phase's items on the subscription. */
async function applyPhase(ctx: Ctx, s: any, sub: any, ph: any, at: number) {
  const prevInterval = `${sub.items.data[0].price.recurring.interval}/${sub.items.data[0].price.recurring.interval_count}`;
  const aligned = sub.current_period_end === at;
  if (aligned) {
    // The renewal at this same instant bills the new phase: swap the items with no prorations.
    const { meteredLines } = await import('./meters.ts');
    const usage = sub.status === 'trialing' ? [] : await meteredLines(ctx, sub, sub.current_period_start, at);
    const { createInvoiceItem } = await import('./invoices.ts');
    for (const u of usage) if ((u.amount ?? 0) > 0) await createInvoiceItem(ctx, { customer: sub.customer, amount: u.amount, currency: sub.currency, description: u.description, subscription: sub.id, period: u.period });
    if (usage.length) sub._usage_from = at;
    const items = [];
    for (const it of ph.items) {
      const price = await getObject<any>(ctx.accountId, 'price', it.price);
      const existing = sub.items.data.find((x: any) => x.price.id === it.price);
      items.push({ ...(existing ?? { id: newId('si', 14), object: 'subscription_item', created: at, discounts: [], metadata: {}, subscription: sub.id }), price, quantity: price.recurring.usage_type === 'metered' ? null : it.quantity ?? 1, tax_rates: it.tax_rates ?? [], metadata: it.metadata ?? {}, current_period_start: sub.current_period_start, current_period_end: sub.current_period_end });
    }
    const before = structuredClone(sub);
    sub.items.data = items;
    sub.items.total_count = items.length;
    const settings = phaseSubParams(s, ph);
    sub.collection_method = settings.collection_method;
    if ((settings as any).default_payment_method) sub.default_payment_method = (settings as any).default_payment_method;
    if (ph.default_tax_rates?.length) sub.default_tax_rates = ph.default_tax_rates;
    if (ph.automatic_tax) sub.automatic_tax.enabled = ph.automatic_tax.enabled;
    if (ph._interval !== prevInterval) {
      // New billing interval: the next period starts now and runs one new interval.
      sub.billing_cycle_anchor = at;
      sub._cycles = 0;
    }
    await saveObject(ctx.accountId, sub);
    await emit(ctx, 'customer.subscription.updated', sub, diff(before, sub));
    const dp: any = phaseDiscountParams(ph);
    if (dp.coupon || dp.promotion_code) {
      const { discountFromParams } = await import('./promotions.ts');
      sub.discount = await discountFromParams(ctx, dp, { customer: sub.customer, subscription: sub.id }, at, { currency: sub.currency });
      await saveObject(ctx.accountId, sub);
    }
    return;
  }
  // Mid-period: replace the items like an update, with the phase's proration behavior.
  const items: any[] = sub.items.data.filter((x: any) => !ph.items.some((n: PhaseItem) => n.price === x.price.id)).map((x: any) => ({ id: x.id, deleted: 'true' }));
  for (const it of ph.items) {
    const existing = sub.items.data.find((x: any) => x.price.id === it.price);
    items.push({ ...(existing ? { id: existing.id } : { price: it.price }), ...(it.quantity === null || it.quantity === undefined ? {} : { quantity: it.quantity }), tax_rates: it.tax_rates ?? [] });
  }
  await updateSubscription(ctx, sub.id, { items, proration_behavior: ph.proration_behavior ?? 'create_prorations', ...phaseDiscountParams(ph) });
}

export async function updateSchedule(ctx: Ctx, id: string, p: Params) {
  const s = await getObject<any>(ctx.accountId, 'subscription_schedule', id, 'subscription schedule');
  if (!['not_started', 'active'].includes(s.status)) throw invalid(`A ${s.status} schedule can't be updated.`, 'schedule');
  const before = structuredClone(s);
  if (p.end_behavior !== undefined) s.end_behavior = oneOf(p, 'end_behavior', END);
  if (p.default_settings) s.default_settings = defaultSettings(p, s.default_settings);
  s.metadata = metadata(p, s.metadata);
  const phasesIn = arr(p, 'phases');
  let applyNow: any = null;
  if (phasesIn) {
    if (s.status === 'not_started') {
      const start = phasesIn[0]?.start_date === undefined ? s.phases[0].start_date : phasesIn[0].start_date === 'now' ? await clockTime(ctx.accountId, s.test_clock) : int(phasesIn[0], 'start_date')!;
      s.phases = await parsePhases(ctx, phasesIn, start, { keepFirstStart: true });
    } else {
      // Past phases are fixed; the list must start with the current phase (same start date).
      const cur = s.phases[s._phase];
      const first = phasesIn[0];
      if (first.start_date !== undefined && first.start_date !== 'now' && Number(first.start_date) !== cur.start_date) {
        throw invalid('The first phase must be the current phase: its start_date cannot change.', 'phases[0][start_date]');
      }
      const parsed = await parsePhases(ctx, phasesIn, cur.start_date, { keepFirstStart: true });
      if (parsed[0]!.trial_end !== cur.trial_end && phasesIn[0].trial_end !== undefined) throw invalid("The current phase's trial can't be changed.", 'phases[0][trial_end]');
      parsed[0]!.trial_end = cur.trial_end;
      const now = await clockTime(ctx.accountId, s.test_clock);
      if (parsed[0]!.end_date <= now) throw invalid('The current phase must end in the future.', 'phases[0][end_date]');
      const changed = JSON.stringify(parsed[0]!.items) !== JSON.stringify(cur.items);
      s.phases = [...s.phases.slice(0, s._phase), ...parsed];
      s._phase = s._phase; // unchanged index
      if (changed) applyNow = parsed[0];
    }
  }
  refresh(s);
  await saveObject(ctx.accountId, s);
  if (applyNow && s.subscription) {
    const behavior = oneOf(p, 'proration_behavior', PRORATE, 'create_prorations');
    const sub = await getObject<any>(ctx.accountId, 'subscription', s.subscription);
    const items: any[] = sub.items.data.filter((x: any) => !applyNow.items.some((n: PhaseItem) => n.price === x.price.id)).map((x: any) => ({ id: x.id, deleted: 'true' }));
    for (const it of applyNow.items) {
      const existing = sub.items.data.find((x: any) => x.price.id === it.price);
      items.push({ ...(existing ? { id: existing.id } : { price: it.price }), ...(it.quantity === null || it.quantity === undefined ? {} : { quantity: it.quantity }), tax_rates: it.tax_rates ?? [] });
    }
    await updateSubscription(ctx, sub.id, { items, proration_behavior: behavior });
  }
  await emit(ctx, 'subscription_schedule.updated', s, diff(before, s));
  return s;
}

export async function cancelSchedule(ctx: Ctx, id: string, p: Params) {
  const s = await getObject<any>(ctx.accountId, 'subscription_schedule', id, 'subscription schedule');
  if (!['not_started', 'active'].includes(s.status)) throw invalid(`You can't cancel a ${s.status} schedule.`, 'schedule');
  const now = await clockTime(ctx.accountId, s.test_clock);
  s.status = 'canceled';
  s.canceled_at = now;
  s._phase = null;
  refresh(s);
  await saveObject(ctx.accountId, s);
  if (s.subscription) {
    const sub = await findObject<any>(ctx.accountId, 'subscription', s.subscription);
    if (sub && !['canceled', 'incomplete_expired'].includes(sub.status)) {
      sub.schedule = null; // so ending it doesn't report the schedule as aborted
      await saveObject(ctx.accountId, sub);
      await cancelSubscription(ctx, sub.id, { invoice_now: p.invoice_now ?? 'false' });
    }
  }
  await emit(ctx, 'subscription_schedule.canceled', s);
  return getObject<any>(ctx.accountId, 'subscription_schedule', id);
}

export async function releaseSchedule(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'subscription_schedule', id, 'subscription schedule');
  if (!['not_started', 'active'].includes(s.status)) throw invalid(`You can't release a ${s.status} schedule.`, 'schedule');
  const now = await clockTime(ctx.accountId, s.test_clock);
  s.status = 'released';
  s.released_at = now;
  s.released_subscription = s.subscription;
  s._phase = null;
  refresh(s);
  await saveObject(ctx.accountId, s);
  if (s.subscription) {
    const sub = await findObject<any>(ctx.accountId, 'subscription', s.subscription);
    if (sub) { sub.schedule = null; await saveObject(ctx.accountId, sub); }
  }
  await emit(ctx, 'subscription_schedule.released', s);
  return s;
}

/** Called when a scheduled subscription ends outside the schedule (canceled, expired). */
export async function subscriptionEnded(ctx: Ctx, sub: any, at: number) {
  if (!sub.schedule) return;
  const s = await findObject<any>(ctx.accountId, 'subscription_schedule', sub.schedule);
  if (!s || !['active', 'not_started'].includes(s.status)) return;
  s.status = s.end_behavior === 'cancel' && s._phase === s.phases.length - 1 && s.phases[s._phase].end_date === at ? 'completed' : 'canceled';
  if (s.status === 'completed') s.completed_at = at; else s.canceled_at = at;
  s._phase = null;
  refresh(s);
  await saveObject(ctx.accountId, s);
  await emit(ctx, s.status === 'completed' ? 'subscription_schedule.completed' : 'subscription_schedule.aborted', s);
}
