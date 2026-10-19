import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { nowSeconds } from '../src/lib/ids.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await start();
  setConfig({ disputeReviewSeconds: 0 });
});
after(async () => { await env.close(); });

const customer = async () => (await api(env, 'POST', '/v1/customers', { email: `c${Math.random().toString(36).slice(2, 7)}@example.com` })).body.id as string;

async function authenticate(id: string, secret: string, result: 'success' | 'fail' = 'success') {
  const r = await fetch(`${env.base}/hosted-api/authenticate/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_secret: secret, result }) });
  return (await r.json()) as any;
}

async function ledgerOk() {
  const l = await api(env, 'GET', '/v1/tessera/ledger');
  assert.equal(l.body.unbalanced_groups, 0);
}

describe('SetupIntents and saved cards', () => {
  it('saves a card for a customer and records the attempt', async () => {
    const cus = await customer();
    const si = await api(env, 'POST', '/v1/setup_intents', { customer: cus, payment_method: 'pm_card_visa', confirm: 'true' });
    assert.equal(si.status, 200, JSON.stringify(si.body));
    assert.match(si.body.id, /^seti_/);
    assert.equal(si.body.status, 'succeeded');
    assert.equal(si.body.usage, 'off_session');
    const pms = await api(env, 'GET', `/v1/customers/${cus}/payment_methods`);
    assert.equal(pms.body.data[0].id, si.body.payment_method);
    const att = await api(env, 'GET', '/v1/setup_attempts', { setup_intent: si.body.id });
    assert.equal(att.body.data[0].status, 'succeeded');
    const pk = await api(env, 'GET', `/v1/setup_intents/${si.body.id}`, { client_secret: si.body.client_secret }, {}, env.pk);
    assert.equal(pk.status, 200);
    assert.equal(pk.body.customer, undefined, 'publishable keys see the client view');
  });

  it('declined cards fail setup; chargeCustomerFail sets up but its charges decline', async () => {
    const cus = await customer();
    const bad = await api(env, 'POST', '/v1/setup_intents', { customer: cus, payment_method: 'pm_card_chargeDeclined', confirm: 'true' });
    assert.equal(bad.status, 402);
    assert.equal(bad.body.error.code, 'card_declined');
    assert.equal(bad.body.error.setup_intent.status, 'requires_payment_method');
    const ok = await api(env, 'POST', '/v1/setup_intents', { customer: cus, payment_method: 'pm_card_chargeCustomerFail', confirm: 'true' });
    assert.equal(ok.body.status, 'succeeded');
    const pay = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', customer: cus, payment_method: ok.body.payment_method, off_session: 'true', confirm: 'true' });
    assert.equal(pay.status, 402);
    assert.equal(pay.body.error.decline_code, 'generic_decline');
  });

  it('3155: authenticates once at setup, then charges off-session without the customer', async () => {
    const cus = await customer();
    // Without setup, an off-session payment cannot authenticate.
    const direct = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', customer: cus, payment_method: 'pm_card_authenticationRequiredOnSetup', off_session: 'true', confirm: 'true' });
    assert.equal(direct.status, 402);
    assert.equal(direct.body.error.code, 'authentication_required');
    assert.equal(direct.body.error.payment_intent.status, 'requires_payment_method');

    const si = await api(env, 'POST', '/v1/setup_intents', { customer: cus, payment_method: 'pm_card_authenticationRequiredOnSetup', confirm: 'true', return_url: 'https://example.com/saved' });
    assert.equal(si.body.status, 'requires_action');
    assert.match(si.body.next_action.redirect_to_url.url, /\/authenticate\/seti_/);
    const done = await authenticate(si.body.id, si.body.client_secret);
    assert.equal(done.status, 'succeeded');
    assert.match(done.return_url, /redirect_status=succeeded/);
    const pay = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', customer: cus, payment_method: si.body.payment_method, off_session: 'true', confirm: 'true' });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.equal(pay.body.status, 'succeeded');
  });

  it('3184: always needs authentication, even after setup', async () => {
    const cus = await customer();
    const si = await api(env, 'POST', '/v1/setup_intents', { customer: cus, payment_method: 'pm_card_authenticationRequired', confirm: 'true' });
    await authenticate(si.body.id, si.body.client_secret);
    const pay = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', customer: cus, payment_method: si.body.payment_method, off_session: 'true', confirm: 'true' });
    assert.equal(pay.status, 402);
    assert.equal(pay.body.error.code, 'authentication_required');
    const failed = await api(env, 'POST', '/v1/setup_intents', { payment_method: 'pm_card_authenticationRequired', confirm: 'true' });
    const r = await authenticate(failed.body.id, failed.body.client_secret, 'fail');
    assert.equal(r.status, 'requires_payment_method');
  });

  it('setup_future_usage saves and authenticates the card during an on-session payment', async () => {
    const cus = await customer();
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 1500, currency: 'usd', customer: cus, payment_method: 'pm_card_authenticationRequiredOnSetup', setup_future_usage: 'off_session', confirm: 'true', return_url: 'https://example.com' });
    assert.equal(pi.body.status, 'requires_action');
    const done = await authenticate(pi.body.id, pi.body.client_secret);
    assert.equal(done.status, 'succeeded');
    const pms = await api(env, 'GET', `/v1/customers/${cus}/payment_methods`);
    assert.equal(pms.body.data.length, 1);
    const later = await api(env, 'POST', '/v1/payment_intents', { amount: 900, currency: 'usd', customer: cus, payment_method: pms.body.data[0].id, off_session: 'true', confirm: 'true' });
    assert.equal(later.body.status, 'succeeded');
  });

  it('subscription renewals: a set-up card renews; an always-authenticate card needs action', async () => {
    const product = await api(env, 'POST', '/v1/products', { name: 'Club', default_price_data: { currency: 'usd', unit_amount: 1200, recurring: { interval: 'month' } } });
    const clock = await api(env, 'POST', '/v1/test_helpers/test_clocks', { frozen_time: nowSeconds() });
    const run = async (card: string) => {
      const cus = (await api(env, 'POST', '/v1/customers', { email: 'sub@example.com', test_clock: clock.body.id })).body.id;
      const si = await api(env, 'POST', '/v1/setup_intents', { customer: cus, payment_method: card, confirm: 'true' });
      await authenticate(si.body.id, si.body.client_secret);
      const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus, items: [{ price: product.body.default_price }], default_payment_method: si.body.payment_method, trial_period_days: 3 });
      assert.equal(sub.body.status, 'trialing');
      return sub.body.id;
    };
    const good = await run('pm_card_authenticationRequiredOnSetup');
    const always = await run('pm_card_authenticationRequired');
    const adv = await api(env, 'POST', `/v1/test_helpers/test_clocks/${clock.body.id}/advance`, { frozen_time: nowSeconds() + 4 * 86400 });
    assert.equal(adv.status, 200, JSON.stringify(adv.body));
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${good}`)).body.status, 'active');
    const bad = await api(env, 'GET', `/v1/subscriptions/${always}`, { expand: ['latest_invoice'] });
    assert.equal(bad.body.status, 'past_due');
    const evts = await api(env, 'GET', '/v1/events', { type: 'invoice.payment_action_required' });
    assert.ok(evts.body.data.some((e: any) => e.data.object.id === bad.body.latest_invoice.id));
  });

  it('checkout mode=setup saves a card on a new customer', async () => {
    const s = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'setup', success_url: 'https://example.com/ok', customer_email: 'saver@example.com' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.payment_status, 'no_payment_required');
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 12, exp_year: 2034, cvc: '123' } }, {}, env.pk);
    const pay = await fetch(`${env.base}/hosted-api/checkout/${s.body.id}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment_method: pm.body.id, email: 'saver@example.com' }) });
    assert.equal(pay.status, 200, await pay.clone().text());
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`, { expand: ['setup_intent'] });
    assert.equal(done.body.status, 'complete');
    assert.equal(done.body.setup_intent.status, 'succeeded');
    const pms = await api(env, 'GET', `/v1/customers/${done.body.customer}/payment_methods`);
    assert.equal(pms.body.data[0].card.last4, '4242');
  });
});

describe('disputes', () => {
  it('chargeback withdraws funds plus fee, blocks refunds, and a win reinstates the amount', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method: 'pm_card_createDispute', confirm: 'true', description: 'Espresso machine' });
    assert.equal(pi.body.status, 'succeeded');
    const list = await api(env, 'GET', '/v1/disputes', { payment_intent: pi.body.id });
    const dp = list.body.data[0];
    assert.match(dp.id, /^dp_/);
    assert.equal(dp.status, 'needs_response');
    assert.equal(dp.reason, 'fraudulent');
    assert.equal(dp.balance_transactions[0].amount, -5000);
    assert.equal(dp.balance_transactions[0].fee, 1500);
    assert.equal(dp.evidence.product_description, 'Espresso machine');
    const ch = await api(env, 'GET', `/v1/charges/${pi.body.latest_charge}`);
    assert.equal(ch.body.disputed, true);
    const refund = await api(env, 'POST', '/v1/refunds', { payment_intent: pi.body.id });
    assert.equal(refund.status, 400);
    assert.equal(refund.body.error.code, 'charge_disputed');

    const empty = await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { customer_name: '' }, submit: 'true' });
    assert.equal(empty.status, 200, 'customer_email/product_description were prefilled');
    assert.equal(empty.body.status, 'under_review');
    const again = await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { uncategorized_text: 'x' } });
    assert.equal(again.status, 400);

    const pi2 = await api(env, 'POST', '/v1/payment_intents', { amount: 3000, currency: 'usd', payment_method: 'pm_card_createDispute', confirm: 'true' });
    const dp2 = (await api(env, 'GET', '/v1/disputes', { payment_intent: pi2.body.id })).body.data[0];
    const sub = await api(env, 'POST', `/v1/disputes/${dp2.id}`, { evidence: { uncategorized_text: 'winning_evidence', shipping_tracking_number: '1Z999' } });
    assert.equal(sub.body.status, 'under_review');
    assert.equal(sub.body.evidence_details.submission_count, 1);
    await runWorkersOnce();
    const won = await api(env, 'GET', `/v1/disputes/${dp2.id}`);
    assert.equal(won.body.status, 'won');
    assert.equal(won.body.balance_transactions.length, 2);
    assert.equal(won.body.balance_transactions[1].amount, 3000);
    await ledgerOk();
  });

  it('losing evidence loses; close accepts; product_not_received reason', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_createDisputeProductNotReceived', confirm: 'true' });
    const dp = (await api(env, 'GET', '/v1/disputes', { payment_intent: pi.body.id })).body.data[0];
    assert.equal(dp.reason, 'product_not_received');
    await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { uncategorized_text: 'losing_evidence' } });
    await runWorkersOnce();
    assert.equal((await api(env, 'GET', `/v1/disputes/${dp.id}`)).body.status, 'lost');
    const pi2 = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_createDispute', confirm: 'true' });
    const dp2 = (await api(env, 'GET', '/v1/disputes', { payment_intent: pi2.body.id })).body.data[0];
    const closed = await api(env, 'POST', `/v1/disputes/${dp2.id}/close`);
    assert.equal(closed.body.status, 'lost');
  });

  it('inquiries: no funds move until losing evidence escalates them; a refund closes them', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 4000, currency: 'usd', payment_method: 'pm_card_createDisputeInquiry', confirm: 'true' });
    const dp = (await api(env, 'GET', '/v1/disputes', { payment_intent: pi.body.id })).body.data[0];
    assert.equal(dp.status, 'warning_needs_response');
    assert.equal(dp.balance_transactions.length, 0);
    await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { uncategorized_text: 'losing_evidence' } });
    await runWorkersOnce();
    const esc = await api(env, 'GET', `/v1/disputes/${dp.id}`);
    assert.equal(esc.body.status, 'needs_response');
    assert.equal(esc.body.balance_transactions[0].amount, -4000);

    const pi2 = await api(env, 'POST', '/v1/payment_intents', { amount: 4000, currency: 'usd', payment_method: 'pm_card_createDisputeInquiry', confirm: 'true' });
    const dp2 = (await api(env, 'GET', '/v1/disputes', { payment_intent: pi2.body.id })).body.data[0];
    const re = await api(env, 'POST', '/v1/refunds', { payment_intent: pi2.body.id });
    assert.equal(re.status, 200);
    assert.equal((await api(env, 'GET', `/v1/disputes/${dp2.id}`)).body.status, 'warning_closed');
    await ledgerOk();
  });

  it('early fraud warnings become non-actionable after a refund', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: 'pm_card_createIssuerFraudRecord', confirm: 'true' });
    const efws = await api(env, 'GET', '/v1/radar/early_fraud_warnings', { payment_intent: pi.body.id });
    assert.equal(efws.body.data[0].actionable, true);
    assert.equal(efws.body.data[0].fraud_type, 'made_with_stolen_card');
    await api(env, 'POST', '/v1/refunds', { payment_intent: pi.body.id, reason: 'fraudulent' });
    const after = await api(env, 'GET', `/v1/radar/early_fraud_warnings/${efws.body.data[0].id}`);
    assert.equal(after.body.actionable, false);
  });
});

describe('financial reports', () => {
  it('report types, runs and CSV files that reconcile with the balance', async () => {
    const types = await api(env, 'GET', '/v1/reporting/report_types');
    assert.ok(types.body.data.some((t: any) => t.id === 'balance.summary.1'));
    await runWorkersOnce(); // settle everything (delay is 0 in tests)
    await new Promise((r) => setTimeout(r, 1100)); // the window end is exclusive, in whole seconds
    const end = nowSeconds();
    const missingWindow = await api(env, 'POST', '/v1/reporting/report_runs', { report_type: 'balance.summary.1' });
    assert.equal(missingWindow.status, 400);
    const run = await api(env, 'POST', '/v1/reporting/report_runs', { report_type: 'balance.summary.1', parameters: { interval_start: end - 86400, interval_end: end } });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.status, 'pending');
    const item = await api(env, 'POST', '/v1/reporting/report_runs', { report_type: 'balance_change_from_activity.itemized.1', parameters: { interval_start: end - 86400, interval_end: end, columns: ['balance_transaction_id', 'reporting_category', 'net'] } });
    await runWorkersOnce();
    const done = await api(env, 'GET', `/v1/reporting/report_runs/${run.body.id}`);
    assert.equal(done.body.status, 'succeeded');
    assert.equal(done.body.result.object, 'file');
    assert.equal(done.body.result.purpose, 'finance_report_run');
    const res = await fetch(`${env.base}/v1/files/${done.body.result.id}/contents`, { headers: { authorization: `Bearer ${env.sk}` } });
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const lines = (await res.text()).trim().split('\n');
    assert.equal(lines[0], 'category,description,net_amount,currency');
    const ending = Number(lines.find((l) => l.startsWith('ending_balance'))!.split(',')[2]);
    const bal = await api(env, 'GET', '/v1/balance');
    assert.equal(Math.round(ending * 100), bal.body.available.find((b: any) => b.currency === 'usd').amount, 'ending balance matches the available balance');
    const itemized = await api(env, 'GET', `/v1/reporting/report_runs/${item.body.id}`);
    const csv = await (await fetch(`${env.base}/v1/files/${itemized.body.result.id}/contents`, { headers: { authorization: `Bearer ${env.sk}` } })).text();
    assert.equal(csv.split('\n')[0], 'balance_transaction_id,reporting_category,net');
    assert.ok(csv.includes(',dispute,'), 'dispute withdrawals appear as their own category');
  });
});
