import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addInterval } from '../src/domain/billing/invoices.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const T0 = Date.UTC(2026, 0, 31, 12) / 1000; // Jan 31 2026, to exercise month-end clamping
const DAY = 86400;

async function setup(pm = 'pm_card_visa', clockStart = T0) {
  const clock = (await api(env, 'POST', '/v1/test_helpers/test_clocks', { frozen_time: clockStart, name: 'test' })).body;
  const cus = (await api(env, 'POST', '/v1/customers', { email: `b${Math.random()}@example.com`, test_clock: clock.id })).body;
  const attached = await api(env, 'POST', `/v1/payment_methods/${pm}/attach`, { customer: cus.id });
  await api(env, 'POST', `/v1/customers/${cus.id}`, { invoice_settings: { default_payment_method: attached.body.id } });
  const prod = (await api(env, 'POST', '/v1/products', { name: 'Pro plan', default_price_data: { currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } } })).body;
  return { clock, cus, pm: attached.body.id, price: prod.default_price, prod };
}

const advance = (clock: string, to: number) => api(env, 'POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: to });
const invoicesOf = async (sub: string) => (await api(env, 'GET', '/v1/invoices', { subscription: sub, limit: 100 })).body.data;

describe('billing periods', () => {
  it('clamps month ends: Jan 31 -> Feb 28 -> Mar 31', () => {
    const feb = addInterval(T0, 'month', 1, 1);
    const mar = addInterval(T0, 'month', 1, 2);
    assert.equal(new Date(feb * 1000).toISOString().slice(0, 10), '2026-02-28');
    assert.equal(new Date(mar * 1000).toISOString().slice(0, 10), '2026-03-31');
    assert.equal(new Date(addInterval(T0, 'year', 1) * 1000).toISOString().slice(0, 10), '2027-01-31');
  });
});

describe('subscriptions', () => {
  it('charges the first period, then renews each month on a test clock', async () => {
    const { clock, cus, price } = await setup();
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }], expand: ['latest_invoice'] });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.status, 'active');
    assert.equal(sub.body.latest_invoice.status, 'paid');
    assert.equal(sub.body.latest_invoice.amount_paid, 1000);
    assert.match(sub.body.latest_invoice.number, /-0001$/);
    await advance(clock.id, T0 + 95 * DAY); // through 3 renewals (Feb 28, Mar 31, Apr 30)
    const invs = await invoicesOf(sub.body.id);
    assert.equal(invs.length, 4);
    assert.ok(invs.every((i: any) => i.status === 'paid'));
    assert.deepEqual(invs.map((i: any) => i.billing_reason).reverse(), ['subscription_create', 'subscription_cycle', 'subscription_cycle', 'subscription_cycle']);
    const s = (await api(env, 'GET', `/v1/subscriptions/${sub.body.id}`)).body;
    assert.equal(new Date(s.current_period_end * 1000).toISOString().slice(0, 10), '2026-05-31');
  });

  it('trial: $0 invoice, then paid when the trial ends', async () => {
    const { clock, cus, price } = await setup();
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }], trial_period_days: 14 })).body;
    assert.equal(sub.status, 'trialing');
    await advance(clock.id, T0 + 15 * DAY);
    const s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.status, 'active');
    const invs = await invoicesOf(sub.id);
    assert.deepEqual(invs.map((i: any) => i.amount_paid), [1000, 0]);
    const evts = (await api(env, 'GET', '/v1/events', { type: 'customer.subscription.trial_will_end', limit: 100 })).body.data;
    assert.ok(evts.some((e: any) => e.data.object.id === sub.id));
  });

  it('failed renewal: past_due, smart-retry schedule, then canceled', async () => {
    const { clock, cus, price } = await setup();
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }] })).body;
    const bad = (await api(env, 'POST', '/v1/payment_methods/pm_card_chargeDeclined/attach', { customer: cus.id })).body;
    await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { default_payment_method: bad.id });
    await advance(clock.id, T0 + 29 * DAY);
    let s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.status, 'past_due');
    let inv = (await api(env, 'GET', `/v1/invoices/${s.latest_invoice}`)).body;
    assert.equal(inv.status, 'open');
    assert.equal(inv.attempt_count, 1);
    assert.equal(inv.next_payment_attempt, inv.status_transitions.finalized_at + 3 * DAY);
    await advance(clock.id, T0 + 28 * DAY + 16 * DAY); // retries at +3, +8, +15 days all fail
    s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.status, 'canceled');
    assert.equal(s.cancellation_details.reason, 'payment_failed');
    inv = (await api(env, 'GET', `/v1/invoices/${inv.id}`)).body;
    assert.equal(inv.attempt_count, 4);
  });

  it('recovers from past_due when the retry succeeds', async () => {
    const { clock, cus, price, pm } = await setup();
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }] })).body;
    const bad = (await api(env, 'POST', '/v1/payment_methods/pm_card_chargeDeclinedInsufficientFunds/attach', { customer: cus.id })).body;
    await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { default_payment_method: bad.id });
    await advance(clock.id, T0 + 29 * DAY);
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body.status, 'past_due');
    await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { default_payment_method: pm });
    await advance(clock.id, T0 + 33 * DAY);
    const s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.status, 'active');
    assert.equal((await api(env, 'GET', `/v1/invoices/${s.latest_invoice}`)).body.status, 'paid');
  });

  it('prorates a mid-period upgrade onto the next invoice', async () => {
    const { clock, cus, price } = await setup('pm_card_visa', Date.UTC(2026, 3, 1) / 1000); // Apr 1, 30-day month
    const start = Date.UTC(2026, 3, 1) / 1000;
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price, quantity: 1 }] })).body;
    await advance(clock.id, start + 15 * DAY); // halfway
    const upd = await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: sub.items.data[0].id, quantity: 3 }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const preview = (await api(env, 'GET', '/v1/invoices/upcoming', { subscription: sub.id })).body;
    const prorations = preview.lines.data.filter((l: any) => l.proration);
    assert.equal(prorations.length, 2);
    assert.equal(prorations.find((l: any) => l.amount < 0).amount, -500);
    assert.equal(prorations.find((l: any) => l.amount > 0).amount, 1500);
    assert.equal(preview.amount_due, 3000 + 1000);
    await advance(clock.id, start + 31 * DAY);
    const invs = await invoicesOf(sub.id);
    assert.equal(invs[0].amount_paid, 4000);
    assert.equal(invs[0].lines.data.length, 3);
  });

  it('coupons: forever 50% and once 100%', async () => {
    const { clock, cus, price } = await setup();
    await api(env, 'POST', '/v1/coupons', { id: `HALF${Date.now()}`, percent_off: 50, duration: 'forever' });
    const coupons = (await api(env, 'GET', '/v1/coupons', { limit: 1 })).body.data;
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }], coupon: coupons[0].id })).body;
    await advance(clock.id, T0 + 29 * DAY);
    assert.deepEqual((await invoicesOf(sub.id)).map((i: any) => i.amount_paid), [500, 500]);

    const s2 = await setup();
    await api(env, 'POST', '/v1/coupons', { id: `FIRST${Date.now()}`, percent_off: 100, duration: 'once' });
    const first = (await api(env, 'GET', '/v1/coupons', { limit: 1 })).body.data[0];
    const sub2 = (await api(env, 'POST', '/v1/subscriptions', { customer: s2.cus.id, items: [{ price: s2.price }], coupon: first.id })).body;
    await advance(s2.clock.id, T0 + 29 * DAY);
    assert.deepEqual((await invoicesOf(sub2.id)).map((i: any) => i.amount_paid), [1000, 0]);
  });

  it('cancel_at_period_end ends the subscription at renewal', async () => {
    const { clock, cus, price } = await setup();
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }] })).body;
    await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: 'true' });
    await advance(clock.id, T0 + 40 * DAY);
    const s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.status, 'canceled');
    assert.equal(s.ended_at, sub.current_period_end);
    assert.equal((await invoicesOf(sub.id)).length, 1);
  });

  it('default_incomplete: client confirms the first invoice PaymentIntent', async () => {
    const { cus, price } = await setup();
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }], payment_behavior: 'default_incomplete', expand: ['latest_invoice.payment_intent'] })).body;
    assert.equal(sub.status, 'incomplete');
    const pi = sub.latest_invoice.payment_intent;
    assert.equal(pi.status, 'requires_confirmation'); // the customer's default card is pre-filled
    const pm = (await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 1, exp_year: 2036, cvc: '111' } }, {}, env.pk)).body;
    const ok = await api(env, 'POST', `/v1/payment_intents/${pi.id}/confirm`, { client_secret: pi.client_secret, payment_method: pm.id }, {}, env.pk);
    assert.equal(ok.body.status, 'succeeded');
    const s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`, { expand: ['latest_invoice'] })).body;
    assert.equal(s.status, 'active');
    assert.equal(s.latest_invoice.status, 'paid');
  });

  it('incomplete subscriptions expire after 23 hours', async () => {
    const { clock, cus, price } = await setup('pm_card_chargeDeclined');
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price }] })).body;
    assert.equal(sub.status, 'incomplete');
    await advance(clock.id, T0 + DAY);
    const s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.status, 'incomplete_expired');
    assert.equal((await api(env, 'GET', `/v1/invoices/${s.latest_invoice}`)).body.status, 'void');
  });
});

describe('one-off invoices', () => {
  it('draft with items, finalize, pay; send_invoice with due date', async () => {
    const { cus } = await setup();
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 2500, currency: 'usd', description: 'Consulting' });
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 500, currency: 'usd', description: 'Expenses' });
    const draft = (await api(env, 'POST', '/v1/invoices', { customer: cus.id, pending_invoice_items_behavior: 'include' })).body;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.amount_due, 3000);
    const fin = (await api(env, 'POST', `/v1/invoices/${draft.id}/finalize`)).body;
    assert.equal(fin.status, 'open');
    assert.ok(fin.hosted_invoice_url.includes('/invoices/pay/'));
    const paid = (await api(env, 'POST', `/v1/invoices/${draft.id}/pay`)).body;
    assert.equal(paid.status, 'paid');
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 9900, currency: 'usd', description: 'Annual audit' });
    const si = (await api(env, 'POST', '/v1/invoices', { customer: cus.id, collection_method: 'send_invoice', days_until_due: 30, pending_invoice_items_behavior: 'include' })).body;
    const sent = (await api(env, 'POST', `/v1/invoices/${si.id}/send`)).body;
    assert.equal(sent.status, 'open');
    assert.equal(sent.due_date, sent.status_transitions.finalized_at + 30 * DAY);
    const voided = (await api(env, 'POST', `/v1/invoices/${si.id}/void`)).body;
    assert.equal(voided.status, 'void');
  });

  it('paying with a declined card returns 402 and records the attempt', async () => {
    const { cus } = await setup('pm_card_chargeDeclined');
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 1200, currency: 'usd' });
    const inv = (await api(env, 'POST', '/v1/invoices', { customer: cus.id, pending_invoice_items_behavior: 'include' })).body;
    const r = await api(env, 'POST', `/v1/invoices/${inv.id}/pay`);
    assert.equal(r.status, 402);
    const after = (await api(env, 'GET', `/v1/invoices/${inv.id}`)).body;
    assert.equal(after.status, 'open');
    assert.equal(after.attempt_count, 1);
  });
});

describe('checkout and hosted invoices', () => {
  const card = async (num: string, key: string) => (await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: num, exp_month: 1, exp_year: 2036, cvc: '111' } }, {}, key)).body;
  const hosted = async (method: string, path: string, body?: any) => {
    const r = await fetch(`${env.base}/hosted-api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as any };
  };

  it('mode=subscription creates customer, subscription and completes the session', async () => {
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Starter', default_price_data: { currency: 'usd', unit_amount: 1900, recurring: { interval: 'month' } } })).body;
    const s = (await api(env, 'POST', '/v1/checkout/sessions', { mode: 'subscription', success_url: 'http://example.com/ok?s={CHECKOUT_SESSION_ID}', line_items: [{ price: prod.default_price, quantity: 1 }] })).body;
    assert.ok(s.success_url.endsWith(s.id));
    const view = (await hosted('GET', `/checkout/${s.id}`)).body;
    assert.equal(view.line_items[0].interval, '/ month');
    const pm = await card('4242424242424242', view.publishable_key);
    const pay = await hosted('POST', `/checkout/${s.id}/pay`, { payment_method: pm.id, email: 'sub@example.com', name: 'Sub Buyer' });
    assert.equal(pay.body.status, 'succeeded', JSON.stringify(pay.body));
    const done = (await api(env, 'GET', `/v1/checkout/sessions/${s.id}`, { expand: ['subscription'] })).body;
    assert.equal(done.status, 'complete');
    assert.equal(done.subscription.status, 'active');
    const cus = (await api(env, 'GET', `/v1/customers/${done.customer}`)).body;
    assert.equal(cus.email, 'sub@example.com');
  });

  it('mode=subscription with a declined card can be retried with another card', async () => {
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Retry plan', default_price_data: { currency: 'usd', unit_amount: 900, recurring: { interval: 'month' } } })).body;
    const s = (await api(env, 'POST', '/v1/checkout/sessions', { mode: 'subscription', success_url: 'http://example.com/ok', line_items: [{ price: prod.default_price }] })).body;
    const view = (await hosted('GET', `/checkout/${s.id}`)).body;
    const bad = await hosted('POST', `/checkout/${s.id}/pay`, { payment_method: (await card('4000000000000002', view.publishable_key)).id, email: 'retry@example.com' });
    assert.equal(bad.status, 402);
    const good = await hosted('POST', `/checkout/${s.id}/pay`, { payment_method: (await card('4242424242424242', view.publishable_key)).id, email: 'retry@example.com' });
    assert.equal(good.body.status, 'succeeded', JSON.stringify(good.body));
    assert.equal((await api(env, 'GET', `/v1/checkout/sessions/${s.id}`)).body.status, 'complete');
  });

  it('hosted invoice page pays an open send_invoice invoice', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'ap@example.com' })).body;
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 45000, currency: 'usd', description: 'Implementation' });
    const inv = (await api(env, 'POST', '/v1/invoices', { customer: cus.id, collection_method: 'send_invoice', days_until_due: 14, pending_invoice_items_behavior: 'include' })).body;
    await api(env, 'POST', `/v1/invoices/${inv.id}/finalize`);
    const view = (await hosted('GET', `/invoices/${inv.id}`)).body;
    assert.equal(view.amount_due, 45000);
    const pm = await card('4242424242424242', view.publishable_key);
    const r = await hosted('POST', `/invoices/${inv.id}/pay`, { payment_method: pm.id });
    assert.equal(r.body.status, 'paid', JSON.stringify(r.body));
  });
});
