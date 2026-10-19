import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { createAccount } from '../src/domain/accounts.ts';
import { nowSeconds } from '../src/lib/ids.ts';
import { payoutsTick, runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await start();
  setConfig({ payoutInTransitSeconds: 0, payoutArrivalSeconds: 0 });
});
after(async () => { await env.close(); });

const as = (acct: string) => ({ 'Stripe-Account': acct });

/** A custom account with everything provided, so it is enabled immediately. */
const CUSTOM = {
  type: 'custom',
  country: 'US',
  email: 'seller@example.com',
  business_type: 'individual',
  capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
  business_profile: { mcc: '5734', url: 'https://seller.example.com' },
  individual: {
    first_name: 'Jenny', last_name: 'Rosen', email: 'jenny@example.com', phone: '+15555550100',
    dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
    address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105' },
  },
  tos_acceptance: { date: 1700000000, ip: '127.0.0.1' },
  external_account: 'btok_us_verified',
  settings: { payouts: { schedule: { interval: 'manual' } } },
};

async function enabledAccount(extra: Record<string, any> = {}) {
  const r = await api(env, 'POST', '/v1/accounts', { ...CUSTOM, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function ledgerOk() {
  const l = await api(env, 'GET', '/v1/tessera/ledger');
  assert.equal(l.body.unbalanced_groups, 0, 'every ledger group balances, including cross-account groups');
}

describe('connected accounts', () => {
  it('creates a fully provided custom account that is enabled', async () => {
    const a = await enabledAccount();
    assert.match(a.id, /^acct_/);
    assert.equal(a.type, 'custom');
    assert.equal(a.controller.requirement_collection, 'application');
    assert.deepEqual(a.requirements.currently_due, []);
    assert.equal(a.charges_enabled, true);
    assert.equal(a.payouts_enabled, true);
    assert.deepEqual(a.capabilities, { card_payments: 'active', transfers: 'active' });
    assert.equal(a.individual.verification.status, 'verified');
    assert.equal(a.individual.ssn_last_4, undefined, 'sensitive values are never returned');
    assert.equal(a.external_accounts.data[0].last4, '6789');
    assert.equal(a.external_accounts.data[0]._account_number, undefined);
    const list = await api(env, 'GET', '/v1/accounts', { limit: 100 });
    assert.ok(list.body.data.some((x: any) => x.id === a.id));
  });

  it('tracks requirements and identity verification failures', async () => {
    const r = await api(env, 'POST', '/v1/accounts', { type: 'custom', capabilities: { transfers: { requested: 'true' } } });
    assert.equal(r.status, 200);
    assert.ok(r.body.requirements.currently_due.includes('business_type'));
    assert.ok(r.body.requirements.currently_due.includes('external_account'));
    assert.equal(r.body.requirements.disabled_reason, 'requirements.past_due');
    assert.equal(r.body.charges_enabled, false);

    const { external_account, settings, ...noBank } = CUSTOM;
    void external_account; void settings;
    const u = await api(env, 'POST', `/v1/accounts/${r.body.id}`, { ...noBank, type: undefined, capabilities: undefined, individual: { ...CUSTOM.individual, dob: { day: 1, month: 1, year: 1902 } } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(u.body.requirements.currently_due.sort(), ['external_account', 'individual.verification.document']);
    assert.equal(u.body.requirements.errors[0].code, 'verification_failed_keyed_identity');

    const doc = await api(env, 'POST', `/v1/accounts/${r.body.id}`, { individual: { verification: { document: { front: 'file_identity_document_success' } } }, external_account: { object: 'bank_account', country: 'US', currency: 'usd', routing_number: '110000000', account_number: '000123456789' } });
    assert.deepEqual(doc.body.requirements.currently_due, []);
    assert.equal(doc.body.payouts_enabled, true);
    assert.equal(doc.body.capabilities.transfers, 'active');
    assert.equal(doc.body.charges_enabled, false, 'card_payments was not requested');

    const events = await api(env, 'GET', '/v1/events', { type: 'account.updated' }, as(r.body.id));
    assert.ok(events.body.data.length >= 2);
    assert.equal(events.body.data[0].account, r.body.id);
  });

  it('requires capabilities for custom accounts and isolates platforms', async () => {
    const r = await api(env, 'POST', '/v1/accounts', { type: 'custom' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.param, 'capabilities');
    const a = await enabledAccount();
    const other = await createAccount(`other${Date.now()}@example.com`, 'password123', 'Other Platform');
    const denied = await api(env, 'GET', '/v1/balance', undefined, as(a.id), other.secretKey);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'account_invalid');
    const own = await api(env, 'GET', '/v1/account', undefined, as(a.id));
    assert.equal(own.body.id, a.id);
    assert.equal(own.headers.get('stripe-account'), a.id);
  });

  it('runs hosted onboarding for an express account through an account link', async () => {
    const r = await api(env, 'POST', '/v1/accounts', { type: 'express', email: 'x@example.com', capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.controller.stripe_dashboard.type, 'express');
    const early = await api(env, 'POST', `/v1/accounts/${r.body.id}/login_links`);
    assert.equal(early.status, 400);
    const link = await api(env, 'POST', '/v1/account_links', { account: r.body.id, type: 'account_onboarding', refresh_url: 'https://example.com/refresh', return_url: 'https://example.com/return' });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body.object, 'account_link');
    const token = link.body.url.split('/').pop();

    const page = await (await fetch(`${env.base}/hosted-api/connect/onboarding/${token}`)).json() as any;
    assert.equal(page.account.id, r.body.id);
    const { type, capabilities, external_account, tos_acceptance, settings, ...fields } = CUSTOM;
    void type; void capabilities; void tos_acceptance; void settings;
    const sub = await fetch(`${env.base}/hosted-api/connect/onboarding/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, external_account, accept_tos: true }) });
    const done = await sub.json() as any;
    assert.equal(sub.status, 200, JSON.stringify(done));
    assert.equal(done.return_url, 'https://example.com/return');
    const acct = await api(env, 'GET', `/v1/accounts/${r.body.id}`);
    assert.equal(acct.body.details_submitted, true);
    assert.equal(acct.body.charges_enabled, true);
    assert.ok(acct.body.tos_acceptance.date);
    const reused = await fetch(`${env.base}/hosted-api/connect/onboarding/${token}`);
    assert.equal(((await reused.json()) as any).expired, true, 'account links are single use');
    const locked = await api(env, 'POST', `/v1/accounts/${r.body.id}`, { individual: { first_name: 'Changed' } });
    assert.equal(locked.status, 400, 'Tessera-collected fields are locked after onboarding');
    const login = await api(env, 'POST', `/v1/accounts/${r.body.id}/login_links`);
    assert.equal(login.status, 200);
    const dash = await (await fetch(`${env.base}/hosted-api/connect/express/${login.body.url.split('/').pop()}`)).json() as any;
    assert.equal(dash.account.id, r.body.id);
  });
});

describe('charges and transfers', () => {
  it('destination charge: transfer, application fee and both balances', async () => {
    const a = await enabledAccount();
    const pi = await api(env, 'POST', '/v1/payment_intents', {
      amount: 10000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true',
      application_fee_amount: 1230, transfer_data: { destination: a.id }, expand: ['latest_charge'],
    });
    assert.equal(pi.status, 200, JSON.stringify(pi.body));
    assert.equal(pi.body.transfer_group, `group_${pi.body.id}`);
    const ch = pi.body.latest_charge;
    assert.match(ch.transfer, /^tr_/);
    assert.match(ch.application_fee, /^fee_/);
    assert.equal(ch.destination, a.id);

    const tr = await api(env, 'GET', `/v1/transfers/${ch.transfer}`);
    assert.equal(tr.body.amount, 10000);
    assert.equal(tr.body.source_transaction, ch.id);
    const py = await api(env, 'GET', `/v1/charges/${tr.body.destination_payment}`, { expand: ['balance_transaction'] }, as(a.id));
    assert.equal(py.status, 200);
    assert.match(py.body.id, /^py_/);
    assert.equal(py.body.balance_transaction.fee, 1230);
    assert.equal(py.body.balance_transaction.net, 8770);
    assert.equal(py.body.balance_transaction.fee_details[0].type, 'application_fee');

    const fee = await api(env, 'GET', `/v1/application_fees/${ch.application_fee}`);
    assert.equal(fee.body.amount, 1230);
    assert.equal(fee.body.account, a.id);
    assert.equal(fee.body.originating_transaction, ch.id);

    await runWorkersOnce(); // settlement delay is 0 in tests
    const cb = await api(env, 'GET', '/v1/balance', undefined, as(a.id));
    assert.equal(cb.body.available[0].amount, 8770);
    await ledgerOk();
  });

  it('rejects application fees without a Connect target and destinations without capability', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', application_fee_amount: 100 });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Can only apply an application_fee_amount/);
    const pending = await api(env, 'POST', '/v1/accounts', { type: 'custom', capabilities: { transfers: { requested: 'true' } } });
    const d = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', transfer_data: { destination: pending.body.id } });
    assert.equal(d.status, 400);
    assert.equal(d.body.error.code, 'insufficient_capabilities_for_transfer');
    const direct = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd' }, as(pending.body.id));
    assert.equal(direct.status, 400, 'charges are disabled until requirements are met');
  });

  it('direct charge on the connected account with an application fee', async () => {
    const a = await enabledAccount();
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', application_fee_amount: 500, expand: ['latest_charge.balance_transaction'] }, as(a.id));
    assert.equal(pi.status, 200, JSON.stringify(pi.body));
    const ch = pi.body.latest_charge;
    assert.equal(pi.body.application, ch.application);
    assert.match(ch.application, /^ca_/);
    const tesseraFee = Math.round(5000 * 0.029) + 30;
    assert.equal(ch.balance_transaction.fee, tesseraFee + 500);
    assert.equal(ch.balance_transaction.net, 5000 - tesseraFee - 500);
    const fees = await api(env, 'GET', '/v1/application_fees', { charge: ch.id });
    assert.equal(fees.body.data.length, 1);
    assert.equal(fees.body.data[0].amount, 500);
    const platformCharge = await api(env, 'GET', `/v1/charges/${ch.id}`);
    assert.equal(platformCharge.status, 404, 'the charge lives on the connected account');

    // Refund with refund_application_fee: the platform returns its share.
    const re = await api(env, 'POST', '/v1/refunds', { charge: ch.id, amount: 2500, refund_application_fee: 'true' }, as(a.id));
    assert.equal(re.status, 200, JSON.stringify(re.body));
    const fee = await api(env, 'GET', `/v1/application_fees/${fees.body.data[0].id}`);
    assert.equal(fee.body.amount_refunded, 250);
    await ledgerOk();
  });

  it('separate transfers: insufficient funds, available funds, reversal', async () => {
    const a = await enabledAccount();
    const tooMuch = await api(env, 'POST', '/v1/transfers', { amount: 99_000_000, currency: 'usd', destination: a.id });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, 'balance_insufficient');
    // 4000 0000 0000 0077 adds funds straight to the available balance.
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } });
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 20000, currency: 'usd', payment_method: pm.body.id, confirm: 'true' });
    assert.equal(pi.body.status, 'succeeded');
    const tr = await api(env, 'POST', '/v1/transfers', { amount: 7000, currency: 'usd', destination: a.id, transfer_group: 'ORDER_42', metadata: { order: '42' } });
    assert.equal(tr.status, 200, JSON.stringify(tr.body));
    const bal = await api(env, 'GET', '/v1/balance', undefined, as(a.id));
    assert.equal(bal.body.available[0].amount, 7000);

    const rev = await api(env, 'POST', `/v1/transfers/${tr.body.id}/reversals`, { amount: 2000 });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    assert.equal(rev.body.object, 'transfer_reversal');
    const after = await api(env, 'GET', `/v1/transfers/${tr.body.id}`);
    assert.equal(after.body.amount_reversed, 2000);
    assert.equal(after.body.reversed, false);
    const bal2 = await api(env, 'GET', '/v1/balance', undefined, as(a.id));
    assert.equal(bal2.body.available[0].amount, 5000);
    const byGroup = await api(env, 'GET', '/v1/transfers', { transfer_group: 'ORDER_42' });
    assert.equal(byGroup.body.data.length, 1);
    await ledgerOk();
  });

  it('refunding a destination charge reverses the transfer and the fee proportionally', async () => {
    const a = await enabledAccount();
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 10000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', application_fee_amount: 1000, transfer_data: { destination: a.id } });
    await runWorkersOnce();
    const re = await api(env, 'POST', '/v1/refunds', { payment_intent: pi.body.id, amount: 5000, reverse_transfer: 'true', refund_application_fee: 'true' });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.match(re.body.transfer_reversal, /^trr_/);
    const ch = await api(env, 'GET', `/v1/charges/${pi.body.latest_charge}`);
    const tr = await api(env, 'GET', `/v1/transfers/${ch.body.transfer}`);
    assert.equal(tr.body.amount_reversed, 5000);
    const fee = await api(env, 'GET', `/v1/application_fees/${ch.body.application_fee}`);
    assert.equal(fee.body.amount_refunded, 500);
    // Connected account: 9000 net, minus 5000 reversal, plus 500 fee refund.
    const bal = await api(env, 'GET', '/v1/balance', undefined, as(a.id));
    assert.equal(bal.body.available[0].amount, 4500);
    await ledgerOk();
  });
});

describe('payouts', () => {
  it('pays out manually, fails on a bad bank account and can be canceled', async () => {
    const a = await enabledAccount();
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } }, {}, env.sk);
    void pm;
    // Fund the connected account with a direct charge on an available-immediately card.
    const pm2 = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } }, as(a.id));
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 30000, currency: 'usd', payment_method: pm2.body.id, confirm: 'true' }, as(a.id));
    assert.equal(pi.body.status, 'succeeded', JSON.stringify(pi.body));
    const avail = (await api(env, 'GET', '/v1/balance', undefined, as(a.id))).body.available[0].amount;

    const po = await api(env, 'POST', '/v1/payouts', { amount: 10000, currency: 'usd' }, as(a.id));
    assert.equal(po.status, 200, JSON.stringify(po.body));
    assert.equal(po.body.status, 'pending');
    await payoutsTick(nowSeconds() + 1);
    const paid = await api(env, 'GET', `/v1/payouts/${po.body.id}`, undefined, as(a.id));
    assert.equal(paid.body.status, 'paid');

    const tooMuch = await api(env, 'POST', '/v1/payouts', { amount: 99_000_000, currency: 'usd' }, as(a.id));
    assert.equal(tooMuch.body.error.code, 'balance_insufficient');

    const c = await api(env, 'POST', '/v1/payouts', { amount: 1000, currency: 'usd' }, as(a.id));
    const canceled = await api(env, 'POST', `/v1/payouts/${c.body.id}/cancel`, {}, as(a.id));
    assert.equal(canceled.body.status, 'canceled');

    const bad = await api(env, 'POST', `/v1/accounts/${a.id}/external_accounts`, { external_account: 'btok_us_verified_noAccount', default_for_currency: 'true' });
    assert.equal(bad.status, 200, JSON.stringify(bad.body));
    const f = await api(env, 'POST', '/v1/payouts', { amount: 5000, currency: 'usd' }, as(a.id));
    await payoutsTick(nowSeconds() + 1);
    const failed = await api(env, 'GET', `/v1/payouts/${f.body.id}`, undefined, as(a.id));
    assert.equal(failed.body.status, 'failed');
    assert.equal(failed.body.failure_code, 'no_account');
    const bal = await api(env, 'GET', '/v1/balance', undefined, as(a.id));
    assert.equal(bal.body.available[0].amount, avail - 10000, 'failed and canceled payouts return the funds');
    const l = await api(env, 'GET', '/v1/tessera/ledger', undefined, as(a.id));
    assert.equal(l.body.unbalanced_groups, 0);
    assert.equal(l.body.clearing.find((x: any) => x.account === 'payouts_in_transit').balances.usd ?? 0, 0);
  });

  it('rejects manual payouts on an automatic schedule and pays out automatically', async () => {
    const a = await enabledAccount({ settings: { payouts: { schedule: { interval: 'daily' } } } });
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } }, as(a.id));
    await api(env, 'POST', '/v1/payment_intents', { amount: 4000, currency: 'usd', payment_method: pm.body.id, confirm: 'true' }, as(a.id));
    const r = await api(env, 'POST', '/v1/payouts', { amount: 100, currency: 'usd' }, as(a.id));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'payout_schedule_automatic');
    await payoutsTick();
    const list = await api(env, 'GET', '/v1/payouts', undefined, as(a.id));
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].automatic, true);
    assert.equal(list.body.data[0].amount, 4000 - (Math.round(4000 * 0.029) + 30));
  });

  it('pays out the platform balance to its own default bank account', async () => {
    const acct = await api(env, 'GET', '/v1/account');
    assert.equal(acct.body.external_accounts.data.length, 1);
    const po = await api(env, 'POST', '/v1/payouts', { amount: 100, currency: 'usd' });
    assert.equal(po.status, 200, JSON.stringify(po.body));
    assert.equal(po.body.destination, acct.body.external_accounts.data[0].id);
  });
});

describe('connect with billing and checkout', () => {
  it('subscription with application_fee_percent and transfer_data pays the connected account each period', async () => {
    const a = await enabledAccount();
    const product = await api(env, 'POST', '/v1/products', { name: 'Marketplace plan', default_price_data: { currency: 'usd', unit_amount: 10000, recurring: { interval: 'month' } } });
    const cus = await api(env, 'POST', '/v1/customers', { email: 'buyer@example.com', payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } });
    const noTarget = await api(env, 'POST', '/v1/subscriptions', { customer: cus.body.id, items: [{ price: product.body.default_price }], application_fee_percent: 10 });
    assert.equal(noTarget.status, 400);
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus.body.id, items: [{ price: product.body.default_price }], application_fee_percent: 12.5, transfer_data: { destination: a.id }, expand: ['latest_invoice.payment_intent'] });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.status, 'active');
    const inv = sub.body.latest_invoice;
    assert.equal(inv.application_fee_amount, 1250);
    assert.equal(inv.transfer_data.destination, a.id);
    assert.equal(inv.payment_intent.application_fee_amount, 1250);
    const fees = await api(env, 'GET', '/v1/application_fees', { account: a.id });
    assert.equal(fees.body.data[0].amount, 1250);
    await ledgerOk();
  });

  it('checkout session with payment_intent_data creates a destination charge', async () => {
    const a = await enabledAccount();
    const s = await api(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', success_url: 'https://example.com/ok',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 4000, product_data: { name: 'Handmade mug' } } }],
      payment_intent_data: { application_fee_amount: 400, transfer_data: { destination: a.id } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 12, exp_year: 2034, cvc: '123' } }, {}, env.pk);
    const pay = await fetch(`${env.base}/hosted-api/checkout/${s.body.id}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment_method: pm.body.id, email: 'mug@example.com' }) });
    assert.equal(pay.status, 200, await pay.clone().text());
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`, { expand: ['payment_intent.latest_charge'] });
    const ch = done.body.payment_intent.latest_charge;
    assert.match(ch.transfer, /^tr_/);
    assert.equal(done.body.payment_intent.application_fee_amount, 400);
  });
});

describe('connect webhooks', () => {
  it('delivers connected-account events to the platform Connect endpoint with `account`', async () => {
    const received: any[] = [];
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { received.push(JSON.parse(b)); res.end('ok'); });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
    const ep = await api(env, 'POST', '/v1/webhook_endpoints', { url, enabled_events: ['payment_intent.succeeded', 'account.updated'], connect: 'true' });
    assert.equal(ep.body.connect, true);
    const a = await enabledAccount();
    await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' }, as(a.id));
    await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' }); // platform's own: not sent to the Connect endpoint
    await runWorkersOnce();
    srv.close();
    const pis = received.filter((e) => e.type === 'payment_intent.succeeded');
    assert.equal(pis.length, 1);
    assert.equal(pis[0].account, a.id);
    assert.ok(received.some((e) => e.type === 'account.updated' && e.account === a.id));
  });
});
