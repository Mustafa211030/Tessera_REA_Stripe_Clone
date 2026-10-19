import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addInterval } from '../src/domain/billing/invoices.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const T0 = Date.UTC(2026, 2, 1, 12) / 1000; // Mar 1 2026
const DAY = 86400;
const advance = (clock: string, to: number) => api(env, 'POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: to });
const invoicesOf = async (sub: string) => (await api(env, 'GET', '/v1/invoices', { subscription: sub, limit: 100 })).body.data.reverse();
const hosted = async (method: string, path: string, body?: any) => {
  const r = await fetch(`${env.base}/hosted-api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
};

async function clockCustomer(start = T0, pm = 'pm_card_visa') {
  const clock = (await api(env, 'POST', '/v1/test_helpers/test_clocks', { frozen_time: start })).body;
  const cus = (await api(env, 'POST', '/v1/customers', { email: `g${Math.random()}@example.com`, test_clock: clock.id })).body;
  const a = await api(env, 'POST', `/v1/payment_methods/${pm}/attach`, { customer: cus.id });
  await api(env, 'POST', `/v1/customers/${cus.id}`, { invoice_settings: { default_payment_method: a.body.id } });
  return { clock, cus };
}
const product = async (name: string) => (await api(env, 'POST', '/v1/products', { name })).body;

describe('pricing models', () => {
  it('computes graduated, volume and package prices on invoices', async () => {
    const prod = await product('API calls');
    const grad = await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: [{ up_to: 10, unit_amount: 100 }, { up_to: 'inf', unit_amount: 50, flat_amount: 200 }] });
    assert.equal(grad.status, 200, JSON.stringify(grad.body));
    assert.equal(grad.body.unit_amount, null);
    const vol = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'volume', tiers: [{ up_to: 10, unit_amount: 100 }, { up_to: 'inf', unit_amount: 60 }] })).body;
    const pkg = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 500, transform_quantity: { divide_by: 100, round: 'up' } })).body;
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'tiers@example.com' })).body;
    for (const [price, qty] of [[grad.body.id, 15], [vol.id, 15], [pkg.id, 250]] as const) await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, price, quantity: qty });
    const inv = await api(env, 'POST', '/v1/invoices', { customer: cus.id, pending_invoice_items_behavior: 'include' });
    const amounts = inv.body.lines.data.map((l: any) => l.amount).sort((a: number, b: number) => a - b);
    // graduated: 10×100 + 5×50 + 200 = 1450; volume: 15×60 = 900; package: ceil(250/100)=3 × 500 = 1500
    assert.deepEqual(amounts, [900, 1450, 1500]);
    const bad = await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: [{ up_to: 10, unit_amount: 100 }] });
    assert.equal(bad.status, 400, 'the last tier must be up_to=inf');
  });
});

describe('usage-based billing', () => {
  it('bills metered usage in arrears at each renewal', async () => {
    const meter = await api(env, 'POST', '/v1/billing/meters', { display_name: 'API requests', event_name: 'api_requests', default_aggregation: { formula: 'sum' } });
    assert.equal(meter.status, 200, JSON.stringify(meter.body));
    const dup = await api(env, 'POST', '/v1/billing/meters', { display_name: 'Again', event_name: 'api_requests', default_aggregation: { formula: 'sum' } });
    assert.equal(dup.status, 400);
    const prod = await product('Requests');
    const base = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } })).body;
    const metered = await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 2, recurring: { interval: 'month', usage_type: 'metered', meter: meter.body.id } });
    assert.equal(metered.status, 200, JSON.stringify(metered.body));
    const noMeter = await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 2, recurring: { interval: 'month', usage_type: 'metered' } });
    assert.equal(noMeter.status, 400);

    const { clock, cus } = await clockCustomer();
    const qtyErr = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: metered.body.id, quantity: 3 }] });
    assert.equal(qtyErr.status, 400);
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: base.id }, { price: metered.body.id }], expand: ['latest_invoice'] });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.latest_invoice.amount_paid, 1000, 'usage is not billed up front');
    assert.equal(sub.body.items.data.find((i: any) => i.price.id === metered.body.id).quantity, null);

    await advance(clock.id, T0 + 5 * DAY);
    for (const [i, v] of [120, 300, 80].entries()) {
      const ev = await api(env, 'POST', '/v1/billing/meter_events', { event_name: 'api_requests', payload: { stripe_customer_id: cus.id, value: String(v) }, timestamp: T0 + (i + 1) * DAY, identifier: `evt-${cus.id}-${i}` });
      assert.equal(ev.status, 200, JSON.stringify(ev.body));
    }
    const again = await api(env, 'POST', '/v1/billing/meter_events', { event_name: 'api_requests', payload: { stripe_customer_id: cus.id, value: '5' }, identifier: `evt-${cus.id}-0` });
    assert.equal(again.status, 400, 'identifiers are unique');
    const adj = await api(env, 'POST', '/v1/billing/meter_event_adjustments', { event_name: 'api_requests', cancel: { identifier: `evt-${cus.id}-2` } });
    assert.equal(adj.body.status, 'complete');

    const summary = await api(env, 'GET', `/v1/billing/meters/${meter.body.id}/event_summaries`, { customer: cus.id, start_time: T0, end_time: T0 + 10 * DAY });
    assert.equal(summary.body.data[0].aggregated_value, 420);
    const upcoming = await api(env, 'GET', '/v1/invoices/upcoming', { subscription: sub.body.id });
    assert.equal(upcoming.status, 200, JSON.stringify(upcoming.body));
    assert.equal(upcoming.body.amount_due, 1000 + 420 * 2, 'preview includes usage to date');

    const periodEnd = addInterval(T0, 'month', 1);
    await advance(clock.id, periodEnd + 60);
    const invs = await invoicesOf(sub.body.id);
    assert.equal(invs.length, 2);
    const renewal = invs[1];
    assert.equal(renewal.billing_reason, 'subscription_cycle');
    const usageLine = renewal.lines.data.find((l: any) => l.price === metered.body.id);
    assert.equal(usageLine.quantity, 420);
    assert.equal(usageLine.amount, 840);
    assert.equal(usageLine.period.end, periodEnd, 'usage is for the period that just ended');
    assert.equal(renewal.amount_paid, 1840);

    // Usage in the new period, then cancel at period end: a final usage invoice.
    await api(env, 'POST', '/v1/billing/meter_events', { event_name: 'api_requests', payload: { stripe_customer_id: cus.id, value: '50' } });
    await api(env, 'POST', `/v1/subscriptions/${sub.body.id}`, { cancel_at_period_end: 'true' });
    await advance(clock.id, addInterval(T0, 'month', 1, 2) + 60);
    const final = await invoicesOf(sub.body.id);
    assert.equal(final.length, 3);
    assert.equal(final[2].amount_paid, 100);
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${sub.body.id}`)).body.status, 'canceled');
  });

  it('supports count and last aggregation, and deactivation', async () => {
    const m = (await api(env, 'POST', '/v1/billing/meters', { display_name: 'Seats', event_name: 'seats_in_use', default_aggregation: { formula: 'last' } })).body;
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'seats@example.com' })).body;
    const now = Math.floor(Date.now() / 1000);
    for (const [i, v] of [5, 9, 7].entries()) await api(env, 'POST', '/v1/billing/meter_events', { event_name: 'seats_in_use', payload: { stripe_customer_id: cus.id, value: String(v) }, timestamp: now - 100 + i });
    const s = await api(env, 'GET', `/v1/billing/meters/${m.id}/event_summaries`, { customer: cus.id, start_time: now - 3600, end_time: now + 60 });
    assert.equal(s.body.data[0].aggregated_value, 7);
    const off = await api(env, 'POST', `/v1/billing/meters/${m.id}/deactivate`);
    assert.equal(off.body.status, 'inactive');
    const rejected = await api(env, 'POST', '/v1/billing/meter_events', { event_name: 'seats_in_use', payload: { stripe_customer_id: cus.id, value: '1' } });
    assert.equal(rejected.status, 400);
  });
});

describe('promotion codes', () => {
  it('applies codes with restrictions and redemption limits', async () => {
    const coupon = (await api(env, 'POST', '/v1/coupons', { percent_off: 25, duration: 'once', name: 'Spring' })).body;
    const promo = await api(env, 'POST', '/v1/promotion_codes', { coupon: coupon.id, code: 'spring25', max_redemptions: 2, restrictions: { minimum_amount: 2000, minimum_amount_currency: 'usd' } });
    assert.equal(promo.status, 200, JSON.stringify(promo.body));
    assert.equal(promo.body.code, 'SPRING25');
    assert.equal(promo.body.promotion.coupon, coupon.id);
    const legacy = await api(env, 'GET', `/v1/promotion_codes/${promo.body.id}`, undefined, { 'Stripe-Version': '2024-06-20' });
    assert.equal(legacy.body.coupon.id, coupon.id, 'older API versions embed the coupon');
    assert.equal(legacy.body.promotion, undefined);
    const dup = await api(env, 'POST', '/v1/promotion_codes', { coupon: coupon.id, code: 'Spring25' });
    assert.equal(dup.status, 400, 'codes are unique, ignoring case');

    const prod = await product('Studio');
    const cheap = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } })).body;
    const pricey = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 4000, recurring: { interval: 'month' } })).body;
    const mk = async () => {
      const c = (await api(env, 'POST', '/v1/customers', { email: `p${Math.random()}@example.com` })).body;
      const pm = await api(env, 'POST', '/v1/payment_methods/pm_card_visa/attach', { customer: c.id });
      await api(env, 'POST', `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: pm.body.id } });
      return c;
    };
    const tooSmall = await api(env, 'POST', '/v1/subscriptions', { customer: (await mk()).id, items: [{ price: cheap.id }], promotion_code: promo.body.id });
    assert.equal(tooSmall.status, 400);
    assert.equal(tooSmall.body.error.code, 'promotion_code_invalid');
    const ok = await api(env, 'POST', '/v1/subscriptions', { customer: (await mk()).id, items: [{ price: pricey.id }], discounts: [{ promotion_code: promo.body.id }], expand: ['latest_invoice'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.discount.promotion_code, promo.body.id);
    assert.equal(ok.body.latest_invoice.amount_paid, 3000);
    await api(env, 'POST', '/v1/subscriptions', { customer: (await mk()).id, items: [{ price: pricey.id }], promotion_code: promo.body.id });
    const used = await api(env, 'GET', `/v1/promotion_codes/${promo.body.id}`);
    assert.equal(used.body.times_redeemed, 2);
    assert.equal(used.body.active, false, 'deactivates at max_redemptions');
    const third = await api(env, 'POST', '/v1/subscriptions', { customer: (await mk()).id, items: [{ price: pricey.id }], promotion_code: promo.body.id });
    assert.equal(third.status, 400);
    const list = await api(env, 'GET', '/v1/promotion_codes', { code: 'spring25' });
    assert.equal(list.body.data.length, 1);
  });

  it('limits first-time codes to new customers', async () => {
    const coupon = (await api(env, 'POST', '/v1/coupons', { amount_off: 500, currency: 'usd', duration: 'once' })).body;
    const promo = (await api(env, 'POST', '/v1/promotion_codes', { coupon: coupon.id, restrictions: { first_time_transaction: 'true' } })).body;
    const c = (await api(env, 'POST', '/v1/customers', { email: 'returning@example.com' })).body;
    await api(env, 'POST', '/v1/payment_intents', { amount: 1500, currency: 'usd', customer: c.id, payment_method: 'pm_card_visa', confirm: 'true' });
    const r = await api(env, 'POST', '/v1/invoices', { customer: c.id, discounts: [{ promotion_code: promo.id }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /first-time/);
  });

  it('accepts codes typed into checkout', async () => {
    const coupon = (await api(env, 'POST', '/v1/coupons', { percent_off: 10, duration: 'once' })).body;
    await api(env, 'POST', '/v1/promotion_codes', { coupon: coupon.id, code: 'WELCOME10' });
    const s = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'https://example.com/ok', allow_promotion_codes: 'true', line_items: [{ price_data: { currency: 'usd', unit_amount: 5000, product_data: { name: 'Mug' } }, quantity: 1 }] });
    const bad = await hosted('POST', `/checkout/${s.body.id}/promotion_code`, { code: 'NOPE' });
    assert.equal(bad.status, 400);
    const good = await hosted('POST', `/checkout/${s.body.id}/promotion_code`, { code: 'welcome10' });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.amount_total, 4500);
    assert.equal(good.body.discount.code, 'WELCOME10');
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_visa' } });
    const paid = await hosted('POST', `/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'buyer@example.com', name: 'Buyer' });
    assert.equal(paid.body.status, 'succeeded', JSON.stringify(paid.body));
    const after = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`);
    assert.equal(after.body.total_details.amount_discount, 500);
    assert.equal(after.body.amount_total, 4500);
    const promo = (await api(env, 'GET', '/v1/promotion_codes', { code: 'WELCOME10' })).body.data[0];
    assert.equal(promo.times_redeemed, 1);
  });
});

describe('payment links', () => {
  it('opens a new checkout session per visit and deactivates at its limit', async () => {
    const prod = await product('Poster');
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 2500 })).body;
    const link = await api(env, 'POST', '/v1/payment_links', {
      line_items: [{ price: price.id, quantity: 2, adjustable_quantity: { enabled: 'true', minimum: 1, maximum: 5 } }],
      after_completion: { type: 'hosted_confirmation', hosted_confirmation: { custom_message: 'Thanks — posters ship Monday.' } },
      restrictions: { completed_sessions: { limit: 1 } },
    });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body.object, 'payment_link');
    assert.match(link.body.url, /\/b\/test_/);
    const items = await api(env, 'GET', `/v1/payment_links/${link.body.id}/line_items`);
    assert.equal(items.body.data[0].amount_total, 5000);

    const visit = await fetch(link.body.url, { redirect: 'manual' });
    assert.equal(visit.status, 303);
    const sessionId = visit.headers.get('location')!.split('/pay/')[1]!;
    const view = await hosted('GET', `/checkout/${sessionId}`);
    assert.equal(view.body.amount_total, 5000);
    assert.equal(view.body.custom_message, 'Thanks — posters ship Monday.');
    const q = await hosted('POST', `/checkout/${sessionId}/quantity`, { line_item: view.body.line_items[0].id, quantity: 3 });
    assert.equal(q.body.amount_total, 7500);
    const tooMany = await hosted('POST', `/checkout/${sessionId}/quantity`, { line_item: view.body.line_items[0].id, quantity: 9 });
    assert.equal(tooMany.status, 400);
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_visa' } });
    const paid = await hosted('POST', `/checkout/${sessionId}/pay`, { payment_method: pm.body.id, email: 'fan@example.com', name: 'Fan' });
    assert.equal(paid.body.status, 'succeeded');
    const s = await api(env, 'GET', `/v1/checkout/sessions/${sessionId}`);
    assert.equal(s.body.payment_link, link.body.id);
    const after = await api(env, 'GET', `/v1/payment_links/${link.body.id}`);
    assert.equal(after.body.restrictions.completed_sessions.count, 1);
    assert.equal(after.body.active, false);
    const again = await fetch(link.body.url, { redirect: 'manual' });
    assert.match(again.headers.get('location')!, /link-unavailable/);
  });

  it('creates subscriptions with trials from recurring links', async () => {
    const prod = await product('Club');
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 900, recurring: { interval: 'month' } })).body;
    const link = (await api(env, 'POST', '/v1/payment_links', { line_items: [{ price: price.id, quantity: 1 }], subscription_data: { trial_period_days: 14 }, after_completion: { type: 'redirect', redirect: { url: 'https://example.com/welcome' } } })).body;
    const visit = await fetch(link.url, { redirect: 'manual' });
    const id = visit.headers.get('location')!.split('/pay/')[1]!;
    const view = await hosted('GET', `/checkout/${id}`);
    assert.equal(view.body.mode, 'subscription');
    assert.equal(view.body.trial_period_days, 14);
    assert.equal(view.body.auto_redirect, true);
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_visa' } });
    const r = await hosted('POST', `/checkout/${id}/pay`, { payment_method: pm.body.id, email: 'club@example.com', name: 'Member' });
    assert.equal(r.body.success_url, 'https://example.com/welcome');
    const s = await api(env, 'GET', `/v1/checkout/sessions/${id}`, { expand: ['subscription'] });
    assert.equal(s.body.subscription.status, 'trialing');
    const off = await api(env, 'POST', `/v1/payment_links/${link.id}`, { active: 'false' });
    assert.equal(off.body.active, false);
  });
});

describe('subscription schedules', () => {
  it('starts in the future, moves through phases, then releases', async () => {
    const { clock, cus } = await clockCustomer();
    const prod = await product('Gym');
    const intro = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } })).body;
    const std = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 3000, recurring: { interval: 'month' } })).body;
    const startAt = T0 + 10 * DAY;
    const sched = await api(env, 'POST', '/v1/subscription_schedules', {
      customer: cus.id, start_date: startAt, end_behavior: 'release',
      phases: [{ items: [{ price: intro.id }], iterations: 2 }, { items: [{ price: std.id, quantity: 2 }], iterations: 1 }],
    });
    assert.equal(sched.status, 200, JSON.stringify(sched.body));
    assert.equal(sched.body.status, 'not_started');
    assert.equal(sched.body.subscription, null);
    assert.equal(sched.body.phases[0].end_date, addInterval(startAt, 'month', 1, 2));

    await advance(clock.id, startAt + 60);
    let s = (await api(env, 'GET', `/v1/subscription_schedules/${sched.body.id}`)).body;
    assert.equal(s.status, 'active');
    assert.ok(s.subscription);
    assert.deepEqual(s.current_phase, { start_date: startAt, end_date: s.phases[0].end_date });
    const sub = (await api(env, 'GET', `/v1/subscriptions/${s.subscription}`)).body;
    assert.equal(sub.schedule, s.id);

    // Upcoming invoice at the end of phase 1 already shows phase 2's prices.
    await advance(clock.id, addInterval(startAt, 'month', 1) + 60);
    const up = await api(env, 'GET', '/v1/invoices/upcoming', { subscription: sub.id });
    assert.equal(up.body.amount_due, 6000);

    await advance(clock.id, addInterval(startAt, 'month', 1, 2) + 60);
    s = (await api(env, 'GET', `/v1/subscription_schedules/${sched.body.id}`)).body;
    assert.equal(s.current_phase.start_date, s.phases[1].start_date);
    const invs = await invoicesOf(sub.id);
    assert.deepEqual(invs.map((i: any) => i.amount_paid), [1000, 1000, 6000]);

    await advance(clock.id, addInterval(startAt, 'month', 1, 3) + 60);
    s = (await api(env, 'GET', `/v1/subscription_schedules/${sched.body.id}`)).body;
    assert.equal(s.status, 'completed');
    assert.equal(s.released_subscription, sub.id);
    const after = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(after.status, 'active', 'released subscriptions keep billing');
    assert.equal(after.schedule, null);
    assert.equal((await invoicesOf(sub.id)).at(-1).amount_paid, 6000);
  });

  it('takes over an existing subscription, changes interval, and cancels at the end', async () => {
    const { clock, cus } = await clockCustomer();
    const prod = await product('Annual switch');
    const monthly = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' } })).body;
    const yearly = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 15000, recurring: { interval: 'year' } })).body;
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: monthly.id }] })).body;
    const sched = (await api(env, 'POST', '/v1/subscription_schedules', { from_subscription: sub.id })).body;
    assert.equal(sched.status, 'active');
    assert.equal(sched.phases[0].end_date, sub.current_period_end);
    const twice = await api(env, 'POST', '/v1/subscription_schedules', { from_subscription: sub.id });
    assert.equal(twice.status, 400);
    const upd = await api(env, 'POST', `/v1/subscription_schedules/${sched.id}`, {
      end_behavior: 'cancel',
      phases: [{ items: [{ price: monthly.id }], start_date: sched.phases[0].start_date, end_date: sched.phases[0].end_date }, { items: [{ price: yearly.id }], iterations: 1 }],
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    await advance(clock.id, sub.current_period_end + 60);
    const now = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(now.items.data[0].price.id, yearly.id);
    assert.equal(now.current_period_end, addInterval(sub.current_period_end, 'year', 1));
    assert.equal((await invoicesOf(sub.id)).at(-1).amount_paid, 15000);
    await advance(clock.id, addInterval(sub.current_period_end, 'year', 1) + 60);
    const done = (await api(env, 'GET', `/v1/subscription_schedules/${sched.id}`)).body;
    assert.equal(done.status, 'completed');
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body.status, 'canceled');
  });

  it('releases or cancels on request', async () => {
    const { cus } = await clockCustomer();
    const prod = await product('Plan');
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 500, recurring: { interval: 'month' } })).body;
    const a = (await api(env, 'POST', '/v1/subscription_schedules', { customer: cus.id, phases: [{ items: [{ price: price.id }], iterations: 3 }] })).body;
    assert.equal(a.status, 'active', 'start_date defaults to now');
    const rel = await api(env, 'POST', `/v1/subscription_schedules/${a.id}/release`);
    assert.equal(rel.body.status, 'released');
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${a.subscription}`)).body.status, 'active');
    const b = (await api(env, 'POST', '/v1/subscription_schedules', { customer: cus.id, phases: [{ items: [{ price: price.id }], iterations: 3 }] })).body;
    const can = await api(env, 'POST', `/v1/subscription_schedules/${b.id}/cancel`);
    assert.equal(can.body.status, 'canceled');
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${b.subscription}`)).body.status, 'canceled');
    const list = await api(env, 'GET', '/v1/subscription_schedules', { customer: cus.id });
    assert.equal(list.body.data.length, 2);
  });
});
