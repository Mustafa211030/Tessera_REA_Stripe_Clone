import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addInterval } from '../src/domain/billing/invoices.ts';
import { planRetry } from '../src/domain/billing/retries.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const T0 = Date.UTC(2026, 3, 3, 12) / 1000; // Apr 3 2026
const DAY = 86400;
const advance = (clock: string, to: number) => api(env, 'POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: to });
const events = async (type: string) => (await api(env, 'GET', '/v1/events', { type, limit: 100 })).body.data;
async function clockCustomer(pm = 'pm_card_visa') {
  const clock = (await api(env, 'POST', '/v1/test_helpers/test_clocks', { frozen_time: T0 })).body;
  const cus = (await api(env, 'POST', '/v1/customers', { email: `b${Math.random()}@example.com`, test_clock: clock.id })).body;
  const a = await api(env, 'POST', `/v1/payment_methods/${pm}/attach`, { customer: cus.id });
  await api(env, 'POST', `/v1/customers/${cus.id}`, { invoice_settings: { default_payment_method: a.body.id } });
  return { clock, cus, pm: a.body.id };
}
const monthly = async (name: string, amount = 2000) => {
  const prod = (await api(env, 'POST', '/v1/products', { name })).body;
  const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: amount, recurring: { interval: 'month' } })).body;
  return { prod, price };
};

describe('smart retries', () => {
  it('plans retries from the decline', () => {
    const s: any = { retry: { mode: 'smart', schedule_days: [3, 5, 7], max_attempts: 8, window_days: 14 }, after_failure: { subscription: 'cancel', invoice: 'open' } };
    const now = Date.UTC(2026, 3, 3, 12) / 1000;
    const hard = planRetry(s, { attempt_count: 1 }, now, 'expired_card');
    assert.equal(hard.next, null);
    assert.match(hard.reason, /expired/);
    const funds = planRetry(s, { attempt_count: 1, _first_failure_at: now }, now, 'insufficient_funds');
    assert.equal(funds.next, Date.UTC(2026, 3, 15, 14) / 1000, 'the next 15th');
    const generic = planRetry(s, { attempt_count: 1, _first_failure_at: now }, now, 'card_declined');
    assert.equal(generic.next, Date.UTC(2026, 3, 4, 14) / 1000);
    const late = planRetry(s, { attempt_count: 3, _first_failure_at: now - 13 * DAY }, now, 'card_declined');
    assert.equal(late.next, now + DAY, 'capped at the end of the window');
    const used = planRetry(s, { attempt_count: 8, _first_failure_at: now }, now, 'card_declined');
    assert.equal(used.next, null);
    const sched = planRetry({ ...s, retry: { ...s.retry, mode: 'schedule' } }, { attempt_count: 2 }, now, 'expired_card');
    assert.equal(sched.next, now + 5 * DAY, 'a fixed schedule ignores the decline');
  });

  it('retries renewals on the smart plan, then marks the subscription unpaid', async () => {
    const bad = await api(env, 'POST', '/v1/tessera/billing_settings', { retry: { mode: 'odd' } });
    assert.equal(bad.status, 400);
    const set = await api(env, 'POST', '/v1/tessera/billing_settings', { retry: { mode: 'smart', max_attempts: 3 }, after_failure: { subscription: 'unpaid', invoice: 'uncollectible' } });
    assert.equal(set.body.retry.mode, 'smart', JSON.stringify(set.body));
    const { clock, cus } = await clockCustomer('pm_card_chargeCustomerFail');
    const { price } = await monthly('Smart plan');
    // The first invoice is paid out of band so the subscription starts active.
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: price.id }], payment_behavior: 'default_incomplete' })).body;
    await api(env, 'POST', `/v1/invoices/${sub.latest_invoice}/pay`, { paid_out_of_band: 'true' });
    const renewAt = addInterval(T0, 'month', 1);
    await advance(clock.id, renewAt + 60);
    const s1 = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s1.status, 'past_due');
    const inv = (await api(env, 'GET', '/v1/invoices', { subscription: sub.id, limit: 10 })).body.data[0];
    assert.equal(inv.attempt_count, 1);
    assert.equal(inv.next_payment_attempt, Date.UTC(2026, 4, 4, 14) / 1000, 'one day later, 14:00 UTC');
    const hist = (await api(env, 'GET', `/v1/tessera/invoices/${inv.id}/retries`)).body;
    assert.equal(hist.attempts.length, 1);
    assert.match(hist.attempts[0].reason, /Retrying on May 4/);
    await advance(clock.id, renewAt + 10 * DAY);
    const s2 = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s2.status, 'unpaid', 'after 3 attempts');
    const inv2 = (await api(env, 'GET', `/v1/invoices/${inv.id}`)).body;
    assert.equal(inv2.attempt_count, 3);
    assert.equal(inv2.status, 'uncollectible');
    assert.equal(inv2.next_payment_attempt, null);
    await api(env, 'POST', '/v1/tessera/billing_settings', { retry: { mode: 'schedule' }, after_failure: { subscription: 'cancel', invoice: 'open' } });
  });
});

describe('entitlements', () => {
  it('follows the customer subscriptions and sends summary events', async () => {
    const api1 = (await api(env, 'POST', '/v1/entitlements/features', { name: 'API access', lookup_key: 'api-access' })).body;
    const sso = (await api(env, 'POST', '/v1/entitlements/features', { name: 'Single sign-on', lookup_key: 'sso' })).body;
    const dup = await api(env, 'POST', '/v1/entitlements/features', { name: 'Again', lookup_key: 'sso' });
    assert.equal(dup.status, 400);
    const { prod, price } = await monthly('Pro');
    const pf = await api(env, 'POST', `/v1/products/${prod.id}/features`, { entitlement_feature: api1.id });
    assert.equal(pf.body.entitlement_feature.lookup_key, 'api-access', JSON.stringify(pf.body));
    const { cus } = await clockCustomer();
    assert.deepEqual((await api(env, 'GET', '/v1/entitlements/active_entitlements', { customer: cus.id })).body.data, []);
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: price.id }] })).body;
    assert.equal(sub.status, 'active');
    const active = (await api(env, 'GET', '/v1/entitlements/active_entitlements', { customer: cus.id })).body.data;
    assert.deepEqual(active.map((e: any) => e.lookup_key), ['api-access']);
    const one = await api(env, 'GET', `/v1/entitlements/active_entitlements/${active[0].id}`, { customer: cus.id });
    assert.equal(one.body.feature, api1.id);
    // Adding a feature to the product reaches existing subscribers.
    await api(env, 'POST', `/v1/products/${prod.id}/features`, { entitlement_feature: sso.id });
    assert.deepEqual((await api(env, 'GET', '/v1/entitlements/active_entitlements', { customer: cus.id })).body.data.map((e: any) => e.lookup_key), ['api-access', 'sso']);
    const summaries = (await events('entitlements.active_entitlement_summary.updated')).filter((e: any) => e.data.object.customer === cus.id);
    assert.equal(summaries.length, 2);
    assert.deepEqual(summaries[0].data.object.entitlements.data.map((e: any) => e.lookup_key), ['api-access', 'sso']);
    await api(env, 'DELETE', `/v1/subscriptions/${sub.id}`);
    assert.deepEqual((await api(env, 'GET', '/v1/entitlements/active_entitlements', { customer: cus.id })).body.data, []);
    const last = (await events('entitlements.active_entitlement_summary.updated')).find((e: any) => e.data.object.customer === cus.id);
    assert.deepEqual(last.data.object.entitlements.data, []);
    const listed = await api(env, 'GET', `/v1/products/${prod.id}/features`);
    assert.equal(listed.body.data.length, 2);
    const del = await api(env, 'DELETE', `/v1/products/${prod.id}/features/${pf.body.id}`);
    assert.equal(del.body.deleted, true);
  });
});

describe('billing credits', () => {
  it('pays for metered usage before tax, by priority, and comes back when the invoice is voided', async () => {
    const meter = (await api(env, 'POST', '/v1/billing/meters', { display_name: 'Tokens', event_name: 'tokens', default_aggregation: { formula: 'sum' } })).body;
    const prod = (await api(env, 'POST', '/v1/products', { name: 'AI tokens' })).body;
    const base = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } })).body;
    const metered = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1, recurring: { interval: 'month', usage_type: 'metered', meter: meter.id } })).body;
    const { clock, cus } = await clockCustomer();
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: base.id }, { price: metered.id }] })).body;
    const noCus = await api(env, 'POST', '/v1/billing/credit_grants', { amount: { type: 'monetary', monetary: { currency: 'usd', value: 500 } } });
    assert.equal(noCus.status, 400);
    const promo = (await api(env, 'POST', '/v1/billing/credit_grants', { customer: cus.id, name: 'Welcome credit', category: 'promotional', priority: 10, amount: { type: 'monetary', monetary: { currency: 'usd', value: 500 } }, applicability_config: { scope: { price_type: 'metered' } } })).body;
    const paid = (await api(env, 'POST', '/v1/billing/credit_grants', { customer: cus.id, name: 'Prepaid', amount: { type: 'monetary', monetary: { currency: 'usd', value: 1000 } }, applicability_config: { scope: { price_type: 'metered' } } })).body;
    assert.equal(promo.effective_at, T0);
    const bal0 = (await api(env, 'GET', '/v1/billing/credit_balance_summary', { customer: cus.id, filter: { type: 'applicability_scope', applicability_scope: { price_type: 'metered' } } })).body;
    assert.equal(bal0.balances[0].available_balance.monetary.value, 1500);
    await advance(clock.id, T0 + 2 * DAY);
    await api(env, 'POST', '/v1/billing/meter_events', { event_name: 'tokens', payload: { stripe_customer_id: cus.id, value: '800' }, timestamp: T0 + DAY });
    await advance(clock.id, addInterval(T0, 'month', 1) + 60);
    const inv = (await api(env, 'GET', '/v1/invoices', { subscription: sub.id, limit: 10 })).body.data[0];
    assert.equal(inv.billing_reason, 'subscription_cycle');
    assert.equal(inv.subtotal, 1800);
    assert.deepEqual(inv.total_pretax_credit_amounts.map((c: any) => c.amount), [500, 300], 'the promotional grant (priority 10) is used first');
    assert.equal(inv.total, 1000, 'credits only cover the 800 of usage, not the 1000 base fee');
    assert.equal(inv.status, 'paid');
    const line = inv.lines.data.find((l: any) => l.price === metered.id);
    assert.equal(line.pretax_credit_amounts.length, 2);
    const bal1 = (await api(env, 'GET', '/v1/billing/credit_balance_summary', { customer: cus.id })).body;
    assert.equal(bal1.balances[0].available_balance.monetary.value, 700);
    const txns = (await api(env, 'GET', '/v1/billing/credit_balance_transactions', { customer: cus.id, limit: 100 })).body.data;
    assert.equal(txns.filter((t: any) => t.type === 'debit').length, 2);
    assert.equal(txns.find((t: any) => t.type === 'debit').debit.credits_applied.invoice, inv.id);

    // A one-off invoice for more usage than the credit left: finalize, then void; the credit returns.
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, price: metered.id, quantity: 900 });
    const manual = (await api(env, 'POST', '/v1/invoices', { customer: cus.id, pending_invoice_items_behavior: 'include', collection_method: 'send_invoice', days_until_due: 7 })).body;
    const fin = (await api(env, 'POST', `/v1/invoices/${manual.id}/finalize`)).body;
    assert.deepEqual(fin.total_pretax_credit_amounts.map((c: any) => c.amount), [700]);
    assert.equal(fin.total, 200);
    assert.equal(fin.status, 'open');
    assert.equal((await api(env, 'GET', '/v1/billing/credit_balance_summary', { customer: cus.id })).body.balances[0].available_balance.monetary.value, 0);
    await api(env, 'POST', `/v1/invoices/${manual.id}/void`);
    assert.equal((await api(env, 'GET', '/v1/billing/credit_balance_summary', { customer: cus.id })).body.balances[0].available_balance.monetary.value, 700);

    const voided = await api(env, 'POST', `/v1/billing/credit_grants/${paid.id}/void`);
    assert.ok(voided.body.voided_at);
    assert.equal((await api(env, 'GET', '/v1/billing/credit_balance_summary', { customer: cus.id })).body.balances[0].available_balance.monetary.value, 0);
    const again = await api(env, 'POST', `/v1/billing/credit_grants/${paid.id}/void`);
    assert.equal(again.status, 400);
  });
});

describe('payment element and express checkout', () => {
  const post = (path: string, body: any) => fetch(`${env.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

  it('loads a PaymentIntent with the publishable key and every enabled method', async () => {
    const cfg = (await api(env, 'GET', '/v1/payment_method_configurations')).body.data[0];
    await api(env, 'POST', `/v1/payment_method_configurations/${cfg.id}`, { us_bank_account: { display_preference: { preference: 'on' } }, quartet: { display_preference: { preference: 'on' } } });
    const pi = (await api(env, 'POST', '/v1/payment_intents', { amount: 4900, currency: 'usd', automatic_payment_methods: { enabled: true } })).body;
    assert.deepEqual([...pi.payment_method_types].sort(), ['card', 'quartet', 'us_bank_account']);
    const seen = await api(env, 'GET', `/v1/payment_intents/${pi.id}`, { client_secret: pi.client_secret }, {}, env.pk);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.amount, 4900);
    // A bank account from the form: confirmed with the publishable key and an online mandate.
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: '000123456789', account_type: 'checking' }, billing_details: { name: 'Dana Debit', email: 'dana@example.com' } }, {}, env.pk);
    const c = await api(env, 'POST', `/v1/payment_intents/${pi.id}/confirm`, { client_secret: pi.client_secret, payment_method: pm.body.id, mandate_data: { customer_acceptance: { type: 'online', online: { infer_from_client: 'true', user_agent: 'test' } } } }, {}, env.pk);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(['requires_action', 'processing'].includes(c.body.status));
  });

  it('pays with Quick pay: client secret → code → saved card → confirm', async () => {
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_visa' } });
    const acct = (await api(env, 'GET', '/v1/account')).body.id;
    const { accountCtx } = await import('../src/domain/connect/accounts.ts');
    await (await import('../src/domain/oneclick.ts')).saveCard(accountCtx(acct), pm.body.id, 'quick@example.com', 'Quinn Quick');
    const pi = (await api(env, 'POST', '/v1/payment_intents', { amount: 1500, currency: 'usd', automatic_payment_methods: { enabled: true } })).body;
    const bad = await post('/hosted-api/elements/oneclick/lookup', { client_secret: `${pi.id}_secret_wrong`, email: 'quick@example.com' });
    assert.equal(bad.status, 400);
    const look = await post('/hosted-api/elements/oneclick/lookup', { client_secret: pi.client_secret, email: 'quick@example.com' });
    assert.equal(look.body.exists, true, JSON.stringify(look.body));
    const v = await post('/hosted-api/oneclick/verify', { challenge: look.body.challenge, code: '000000' });
    const made = await post('/hosted-api/elements/oneclick/payment_method', { client_secret: pi.client_secret, token: v.body.token, card: v.body.cards[0].id });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.card.wallet.type, 'oneclick');
    assert.equal(made.body.card.number, undefined);
    const c = await api(env, 'POST', `/v1/payment_intents/${pi.id}/confirm`, { client_secret: pi.client_secret, payment_method: made.body.id }, {}, env.pk);
    assert.equal(c.body.status, 'succeeded', JSON.stringify(c.body));
    const again = await post('/hosted-api/elements/oneclick/payment_method', { client_secret: pi.client_secret, token: v.body.token });
    assert.equal(again.body.error.code, 'payment_intent_unexpected_state');
  });
});
