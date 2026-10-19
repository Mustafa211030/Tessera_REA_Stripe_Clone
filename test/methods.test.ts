import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await start();
  setConfig({ bankDebitSeconds: 0 });
});
after(async () => { await env.close(); });

const post = (path: string, body: any) => fetch(`${env.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
const get = (path: string) => fetch(`${env.base}${path}`).then(async (r) => ({ status: r.status, body: await r.json() as any }));
const events = async (type: string) => (await api(env, 'GET', '/v1/events', { type, limit: 100 })).body.data;
const ACCEPT = { mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'test' } } } };

describe('device wallets', () => {
  it('wallet tokens make card payment methods with card.wallet, and skip 3-D Secure', async () => {
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_wallet_authenticationRequired' } }, {}, env.pk);
    assert.equal(pm.status, 200, JSON.stringify(pm.body));
    assert.equal(pm.body.card.wallet.type, 'device_wallet');
    assert.match(pm.body.card.wallet.dynamic_last4, /^\d{4}$/);
    assert.equal(pm.body.card.checks.cvc_check, null);
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: pm.body.id, confirm: 'true' });
    assert.equal(pi.body.status, 'succeeded', 'a 3-D Secure card in a wallet needs no challenge');
    const ch = await api(env, 'GET', `/v1/charges/${pi.body.latest_charge}`);
    assert.equal(ch.body.payment_method_details.card.wallet.type, 'device_wallet');
    const declined = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: (await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_wallet_chargeDeclined' } })).body.id, confirm: 'true' });
    assert.equal(declined.status, 402);
  });
});

describe('ACH Direct Debit', () => {
  it('needs a mandate, verifies with microdeposits, then settles', async () => {
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: '000123456789', account_holder_type: 'individual' }, billing_details: { name: 'Jenny Rosen' } });
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 120000, currency: 'usd', payment_method_types: ['us_bank_account'] });
    assert.equal(pi.body.payment_method_options.us_bank_account.verification_method, 'automatic');
    const noMandate = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/confirm`, { payment_method: pm.body.id });
    assert.equal(noMandate.status, 400);
    assert.equal(noMandate.body.error.param, 'mandate_data');
    const c = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/confirm`, { payment_method: pm.body.id, ...ACCEPT });
    assert.equal(c.body.status, 'requires_action', JSON.stringify(c.body));
    assert.equal(c.body.next_action.type, 'verify_with_microdeposits');
    assert.match(c.body.next_action.verify_with_microdeposits.hosted_verification_url, /\/verify-microdeposits\/pi_/);
    const wrong = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/verify_microdeposits`, { amounts: [10, 11] });
    assert.equal(wrong.body.error.code, 'payment_method_microdeposit_verification_amounts_mismatch');
    assert.match(wrong.body.error.message, /9 verification attempts remaining/);
    const wrongCode = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/verify_microdeposits`, { descriptor_code: 'SM00AA' }, {}, env.pk);
    assert.equal(wrongCode.status, 401, 'publishable keys need the client secret');
    const ok = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/verify_microdeposits`, { descriptor_code: 'sm11aa', client_secret: pi.body.client_secret }, {}, env.pk);
    assert.equal(ok.body.status, 'processing', JSON.stringify(ok.body));
    const pending = await api(env, 'GET', `/v1/charges/${(await api(env, 'GET', `/v1/payment_intents/${pi.body.id}`)).body.latest_charge}`);
    assert.equal(pending.body.status, 'pending');
    assert.equal(pending.body.payment_method_details.type, 'us_bank_account');
    const mandate = await api(env, 'GET', `/v1/mandates/${pending.body.payment_method_details.us_bank_account.mandate}`);
    assert.equal(mandate.body.type, 'single_use');
    assert.equal(mandate.body.customer_acceptance.online.ip_address, '127.0.0.1');
    await runWorkersOnce();
    const done = await api(env, 'GET', `/v1/payment_intents/${pi.body.id}`);
    assert.equal(done.body.status, 'succeeded');
    const ch = await api(env, 'GET', `/v1/charges/${done.body.latest_charge}`, { expand: ['balance_transaction'] });
    assert.equal(ch.body.status, 'succeeded');
    assert.equal(ch.body.balance_transaction.fee, 500, '0.8% of 1,200.00 is capped at 5.00');
    assert.ok((await events('payment_intent.processing')).some((e: any) => e.data.object.id === pi.body.id));
  });

  it('linked accounts verify instantly; failing test accounts fail after processing', async () => {
    const cus = await api(env, 'POST', '/v1/customers', { email: 'ach@example.com', name: 'Ach Buyer' });
    const fcs = await api(env, 'POST', '/v1/financial_connections/sessions', { account_holder: { type: 'customer', customer: cus.body.id }, permissions: ['payment_method'] });
    const linked = await post(`/hosted-api/financial-connections/${fcs.body.client_secret}`, { institution: 'fcinst_insufficient_funds_bank', accounts: ['checking'] });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const pi = await api(env, 'POST', '/v1/payment_intents', {
      amount: 5000, currency: 'usd', customer: cus.body.id, payment_method_types: ['us_bank_account'], confirm: 'true',
      payment_method_data: { type: 'us_bank_account', us_bank_account: { financial_connections_account: linked.body.accounts[0].id } }, payment_method_options: { us_bank_account: { verification_method: 'instant' } }, ...ACCEPT,
    });
    assert.equal(pi.body.status, 'processing', JSON.stringify(pi.body));
    await runWorkersOnce();
    const failed = await api(env, 'GET', `/v1/payment_intents/${pi.body.id}`);
    assert.equal(failed.body.status, 'requires_payment_method');
    assert.equal(failed.body.last_payment_error.code, 'insufficient_funds');
    const manualInstant = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method_types: ['us_bank_account'], payment_method_options: { us_bank_account: { verification_method: 'instant' } }, payment_method: 'pm_usBankAccount', confirm: 'true', ...ACCEPT });
    assert.equal(manualInstant.status, 400);
    const eur = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'eur', payment_method_types: ['us_bank_account'], payment_method: 'pm_usBankAccount', confirm: 'true', ...ACCEPT });
    assert.equal(eur.body.error.code, 'payment_method_currency_mismatch');
  });
});

describe('Pay in 4 (Quartet)', () => {
  it('redirects to approve the plan, then pays the merchant in full', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', {
      amount: 10001, currency: 'usd', payment_method_types: ['quartet'], confirm: 'true', return_url: 'https://shop.example/done',
      payment_method_data: { type: 'quartet', billing_details: { name: 'Jenny Rosen', email: 'jenny@example.com' } },
    });
    assert.equal(pi.body.status, 'requires_action', JSON.stringify(pi.body));
    const url = new URL(pi.body.next_action.redirect_to_url.url);
    assert.match(url.pathname, /^\/quartet\/pi_/);
    const secret = url.searchParams.get('client_secret')!;
    const view = await get(`/hosted-api/quartet/${pi.body.id}?client_secret=${encodeURIComponent(secret)}`);
    assert.deepEqual(view.body.schedule.map((x: any) => x.amount), [2501, 2500, 2500, 2500]);
    assert.equal(view.body.schedule[1].due - view.body.schedule[0].due, 14 * 86400);
    const bad = await post(`/hosted-api/quartet/${pi.body.id}`, { client_secret: 'nope', result: 'approve' });
    assert.equal(bad.status, 404);
    const ok = await post(`/hosted-api/quartet/${pi.body.id}`, { client_secret: secret, result: 'approve' });
    assert.equal(ok.body.status, 'succeeded');
    assert.match(ok.body.return_url, /redirect_status=succeeded/);
    const ch = await api(env, 'GET', `/v1/charges/${(await api(env, 'GET', `/v1/payment_intents/${pi.body.id}`)).body.latest_charge}`, { expand: ['balance_transaction'] });
    assert.equal(ch.body.payment_method_details.quartet.installments.count, 4);
    assert.equal(ch.body.balance_transaction.fee, Math.round(10001 * 0.06) + 30);
  });

  it('enforces amount limits and a return_url; declines go back to requires_payment_method', async () => {
    const small = await api(env, 'POST', '/v1/payment_intents', { amount: 60, currency: 'usd', payment_method_types: ['quartet'], payment_method: 'pm_quartet', confirm: 'true', return_url: 'https://x.example' });
    assert.equal(small.body.error.code, 'amount_too_small');
    const noReturn = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method_types: ['quartet'], payment_method: 'pm_quartet', confirm: 'true' });
    assert.equal(noReturn.body.error.param, 'return_url');
    const missingEmail = await api(env, 'POST', '/v1/payment_methods', { type: 'quartet', billing_details: { name: 'X' } });
    assert.equal(missingEmail.body.error.param, 'billing_details[email]');
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method_types: ['quartet'], payment_method: 'pm_quartet', confirm: 'true', return_url: 'https://x.example' });
    const secret = new URL(pi.body.next_action.redirect_to_url.url).searchParams.get('client_secret')!;
    const no = await post(`/hosted-api/quartet/${pi.body.id}`, { client_secret: secret, result: 'decline' });
    assert.equal(no.body.status, 'requires_payment_method');
    const after = await api(env, 'GET', `/v1/payment_intents/${pi.body.id}`);
    assert.equal(after.body.last_payment_error.code, 'payment_method_provider_decline');
  });
});

describe('payment method settings', () => {
  it('turn methods on for Checkout and automatic payment methods', async () => {
    const list = await api(env, 'GET', '/v1/payment_method_configurations');
    const cfg = list.body.data[0];
    assert.equal(cfg.is_default, true);
    assert.equal(cfg.card.display_preference.value, 'on');
    assert.equal(cfg.us_bank_account.display_preference.value, 'off');
    const before = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', automatic_payment_methods: { enabled: 'true' } });
    assert.deepEqual(before.body.payment_method_types, ['card']);
    const upd = await api(env, 'POST', `/v1/payment_method_configurations/${cfg.id}`, { us_bank_account: { display_preference: { preference: 'on' } }, quartet: { display_preference: { preference: 'on' } } });
    assert.equal(upd.body.quartet.display_preference.value, 'on', JSON.stringify(upd.body));
    const bad = await api(env, 'POST', `/v1/payment_method_configurations/${cfg.id}`, { quartet: { display_preference: { preference: 'maybe' } } });
    assert.equal(bad.status, 400);
    const auto = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', automatic_payment_methods: { enabled: 'true' } });
    assert.deepEqual(auto.body.payment_method_types, ['card', 'us_bank_account', 'quartet']);
    const noRedirect = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'eur', automatic_payment_methods: { enabled: 'true', allow_redirects: 'never' } });
    assert.deepEqual(noRedirect.body.payment_method_types, ['card']);
    const s = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'https://x.example', line_items: [{ price_data: { currency: 'usd', unit_amount: 3000, product_data: { name: 'Lamp' } }, quantity: 1 }] });
    assert.deepEqual(s.body.payment_method_types, ['card', 'us_bank_account', 'quartet']);
    const sub = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'subscription', success_url: 'https://x.example', line_items: [{ price_data: { currency: 'usd', unit_amount: 3000, recurring: { interval: 'month' }, product_data: { name: 'Plan' } }, quantity: 1 }] });
    assert.deepEqual(sub.body.payment_method_types, ['card']);
    const gbpAch = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'https://x.example', payment_method_types: ['card', 'us_bank_account'], line_items: [{ price_data: { currency: 'gbp', unit_amount: 3000, product_data: { name: 'Lamp' } }, quantity: 1 }] });
    assert.equal(gbpAch.body.error.code, 'payment_method_currency_mismatch');
  });
});

describe('Checkout with new methods', () => {
  const session = (extra: any = {}) => api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'https://shop.example/ok', line_items: [{ price_data: { currency: 'usd', unit_amount: 4200, product_data: { name: 'Kettle' } }, quantity: 1 }], ...extra });

  it('bank debits complete the session unpaid, then fire async_payment_succeeded', async () => {
    const s = await session({ payment_method_types: ['card', 'us_bank_account'] });
    const view = await get(`/hosted-api/checkout/${s.body.id}`);
    assert.deepEqual(view.body.payment_method_types, ['card', 'us_bank_account']);
    const noEmail = await post(`/hosted-api/checkout/${s.body.id}/bank_session`, {});
    assert.equal(noEmail.status, 400);
    const bs = await post(`/hosted-api/checkout/${s.body.id}/bank_session`, { email: 'bank.buyer@example.com', name: 'Bank Buyer' });
    assert.match(bs.body.client_secret, /^fcsess_/);
    const linked = await post(`/hosted-api/financial-connections/${bs.body.client_secret}`, { institution: 'fcinst_tessera_test_bank', accounts: ['checking'] });
    const pm = await post(`/hosted-api/checkout/${s.body.id}/payment_method`, { type: 'us_bank_account', financial_connections_account: linked.body.accounts[0].id, email: 'bank.buyer@example.com', name: 'Bank Buyer' });
    assert.equal(pm.body.bank.instant, true, JSON.stringify(pm.body));
    const pay = await post(`/hosted-api/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'bank.buyer@example.com', name: 'Bank Buyer' });
    assert.equal(pay.body.status, 'processing', JSON.stringify(pay.body));
    const mid = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`);
    assert.deepEqual([mid.body.status, mid.body.payment_status], ['complete', 'unpaid']);
    await runWorkersOnce();
    const end = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`);
    assert.equal(end.body.payment_status, 'paid');
    assert.ok((await events('checkout.session.async_payment_succeeded')).some((e: any) => e.data.object.id === s.body.id));
  });

  it('manual bank accounts wait for microdeposits; failures fire async_payment_failed', async () => {
    const s = await session({ payment_method_types: ['us_bank_account'] });
    const pm = await post(`/hosted-api/checkout/${s.body.id}/payment_method`, { type: 'us_bank_account', routing_number: '110000000', account_number: '000111111113', email: 'closed@example.com', name: 'Closed Account' });
    const pay = await post(`/hosted-api/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'closed@example.com', name: 'Closed Account' });
    assert.equal(pay.body.next_action.type, 'verify_with_microdeposits');
    const view = await get(`/hosted-api/checkout/${s.body.id}`);
    assert.equal(view.body.next_action.type, 'verify_with_microdeposits');
    const piId = (await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`)).body.payment_intent;
    const pi = await api(env, 'GET', `/v1/payment_intents/${piId}`);
    const verify = await post(`/hosted-api/microdeposits/${piId}`, { client_secret: pi.body.client_secret, amounts: [45, 32] });
    assert.equal(verify.body.status, 'processing', JSON.stringify(verify.body));
    assert.equal((await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`)).body.status, 'complete');
    await runWorkersOnce();
    assert.ok((await events('checkout.session.async_payment_failed')).some((e: any) => e.data.object.id === s.body.id));
    const pmObj = await api(env, 'GET', `/v1/payment_intents/${piId}`);
    const mandate = await api(env, 'GET', `/v1/mandates/${(await api(env, 'GET', `/v1/charges/${pmObj.body.latest_charge}`)).body.payment_method_details.us_bank_account.mandate}`);
    assert.equal(mandate.body.status, 'inactive', 'a closed account deactivates its mandate');
  });

  it('Pay in 4 from Checkout returns to the page and completes the session', async () => {
    const s = await session({ payment_method_types: ['card', 'quartet'] });
    const card = await post(`/hosted-api/checkout/${s.body.id}/payment_method`, { type: 'card' });
    assert.equal(card.status, 400);
    const pm = await post(`/hosted-api/checkout/${s.body.id}/payment_method`, { type: 'quartet', name: 'Quinn Buyer', email: 'quinn@example.com' });
    const pay = await post(`/hosted-api/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'quinn@example.com', name: 'Quinn Buyer' });
    assert.equal(pay.body.status, 'requires_action');
    const url = new URL(pay.body.next_action.redirect_to_url.url);
    const ok = await post(`/hosted-api/quartet/${url.pathname.split('/')[2]}`, { client_secret: url.searchParams.get('client_secret'), result: 'approve' });
    assert.match(ok.body.return_url, new RegExp(`/pay/${s.body.id}\\?return=1&payment_intent=`));
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`);
    assert.deepEqual([done.body.status, done.body.payment_status], ['complete', 'paid']);
  });

  it('locale and adaptive pricing', async () => {
    const bad = await session({ locale: 'xx' });
    assert.equal(bad.status, 400);
    const s = await session({ locale: 'de', adaptive_pricing: { enabled: 'true' }, payment_method_types: ['card'] });
    const view = await get(`/hosted-api/checkout/${s.body.id}`);
    assert.equal(view.body.locale, 'de');
    const eur = view.body.presentment_options.find((o: any) => o.currency === 'eur');
    assert.equal(eur.amount_total, Math.round(42 * 0.92 * 1.02 * 100));
    const set = await post(`/hosted-api/checkout/${s.body.id}/currency`, { currency: 'eur' });
    assert.equal(set.body.currency_conversion.currency, 'eur');
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_visa' } }, {}, env.pk);
    const pay = await post(`/hosted-api/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'eu@example.com' });
    assert.equal(pay.body.status, 'succeeded', JSON.stringify(pay.body));
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`, { expand: ['payment_intent'] });
    assert.equal(done.body.currency, 'eur');
    assert.equal(done.body.amount_total, eur.amount_total);
    assert.equal(done.body.currency_conversion.source_currency, 'usd');
    assert.equal(done.body.payment_intent.currency, 'eur');
    const inv = await api(env, 'POST', '/v1/customers', { email: 'fr@example.com', preferred_locales: ['fr-FR'] });
    assert.deepEqual(inv.body.preferred_locales, ['fr-FR']);
  });
});

describe('one-click checkout', () => {
  const session = () => api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', payment_method_types: ['card'], success_url: 'https://shop.example/ok', line_items: [{ price_data: { currency: 'usd', unit_amount: 1800, product_data: { name: 'Mug' } }, quantity: 1 }] });

  it('saves a card on opt-in, then signs in with an emailed code and pays', async () => {
    const s1 = await session();
    const none = await post('/hosted-api/oneclick/lookup', { checkout_session: s1.body.id, email: 'oneclick@example.com' });
    assert.equal(none.body.exists, false);
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_mastercard' } }, {}, env.pk);
    const pay = await post(`/hosted-api/checkout/${s1.body.id}/pay`, { payment_method: pm.body.id, email: 'OneClick@example.com', name: 'Olive Click', save_oneclick: true });
    assert.equal(pay.body.oneclick_saved, true, JSON.stringify(pay.body));

    const s2 = await session();
    const look = await post('/hosted-api/oneclick/lookup', { checkout_session: s2.body.id, email: 'oneclick@example.com' });
    assert.equal(look.body.exists, true);
    assert.equal(look.body.masked_email, 'o••••••@example.com');
    const mail = (await api(env, 'GET', '/v1/tessera/emails', { kind: 'verification_code' })).body.data[0];
    const code = /^(\d{6})/.exec(mail.subject)![1]!;
    const wrong = await post('/hosted-api/oneclick/verify', { challenge: look.body.challenge, code: code === '111111' ? '222222' : '111111' });
    assert.equal(wrong.body.error.code, 'verification_code_incorrect');
    const v = await post('/hosted-api/oneclick/verify', { challenge: look.body.challenge, code });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.cards[0].last4, '4444');
    assert.equal(v.body.name, 'Olive Click');
    const reuse = await post('/hosted-api/oneclick/verify', { challenge: look.body.challenge, code });
    assert.equal(reuse.body.error.code, 'verification_expired');
    const pay2 = await post(`/hosted-api/checkout/${s2.body.id}/pay`, { oneclick: { token: v.body.token, card: v.body.cards[0].id } });
    assert.equal(pay2.body.status, 'succeeded', JSON.stringify(pay2.body));
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s2.body.id}`, { expand: ['payment_intent.payment_method'] });
    assert.equal(done.body.payment_intent.payment_method.card.wallet.type, 'oneclick');
    assert.equal(done.body.customer_details.email, 'oneclick@example.com');

    const gone = await post('/hosted-api/oneclick/remove_card', { token: v.body.token, card: v.body.cards[0].id });
    assert.equal(gone.body.deleted, true);
    const after = await post('/hosted-api/oneclick/lookup', { checkout_session: s2.body.id, email: 'oneclick@example.com' });
    assert.equal(after.body.exists, false);
  });
});
