import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { runWorkersOnce } from '../src/workers/index.ts';
import { verify } from '../src/domain/webhooks.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

describe('authentication', () => {
  it('rejects missing and invalid keys', async () => {
    const r = await fetch(env.base + '/v1/customers');
    assert.equal(r.status, 401);
    const b: any = await r.json();
    assert.equal(b.error.type, 'authentication_error');
    const r2 = await api(env, 'GET', '/v1/customers', undefined, {}, 'sk_test_nope');
    assert.equal(r2.status, 401);
    assert.equal(r2.body.error.code, 'api_key_invalid');
  });
  it('blocks publishable keys on secret endpoints', async () => {
    const r = await api(env, 'GET', '/v1/customers', undefined, {}, env.pk);
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'secret_key_required');
  });
});

describe('customers and lists', () => {
  it('creates, updates, paginates and expands', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await api(env, 'POST', '/v1/customers', { email: `c${i}@example.com`, metadata: { n: i } });
      assert.equal(r.status, 200);
      assert.match(r.body.id, /^cus_/);
      ids.push(r.body.id);
    }
    const page1 = await api(env, 'GET', '/v1/customers?limit=2');
    assert.equal(page1.body.object, 'list');
    assert.equal(page1.body.data.length, 2);
    assert.equal(page1.body.has_more, true);
    assert.equal(page1.body.data[0].id, ids[4]);
    const page2 = await api(env, 'GET', `/v1/customers?limit=2&starting_after=${page1.body.data[1].id}`);
    assert.equal(page2.body.data[0].id, ids[2]);
    const upd = await api(env, 'POST', `/v1/customers/${ids[0]}`, { name: 'Jane', metadata: { n: '' } });
    assert.equal(upd.body.name, 'Jane');
    assert.deepEqual(upd.body.metadata, {});
    const missing = await api(env, 'GET', '/v1/customers/cus_nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'resource_missing');
  });
});

describe('payments', () => {
  it('runs a successful automatic payment with ledger, fees and balance', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', expand: ['latest_charge'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'succeeded');
    assert.equal(r.body.amount_received, 2000);
    assert.equal(r.body.latest_charge.object, 'charge');
    assert.equal(r.body.latest_charge.outcome.type, 'authorized');
    assert.ok(!('_vault_token' in r.body), 'internal fields are stripped');
    const txn = await api(env, 'GET', `/v1/balance_transactions/${r.body.latest_charge.balance_transaction}`);
    assert.equal(txn.body.fee, Math.round(2000 * 0.029) + 30);
    assert.equal(txn.body.net, 2000 - txn.body.fee);
    await runWorkersOnce();
    const bal = await api(env, 'GET', '/v1/balance');
    assert.equal(bal.body.available.find((b: any) => b.currency === 'usd').amount, txn.body.net);
    const ledger = await api(env, 'GET', '/v1/tessera/ledger');
    assert.equal(ledger.body.unbalanced_groups, 0);
    assert.equal(ledger.body.clearing_zeroed, true);
  });

  it('returns 402 card errors and records the failed charge', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 1500, currency: 'usd', payment_method: 'pm_card_chargeDeclinedInsufficientFunds', confirm: 'true' });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.type, 'card_error');
    assert.equal(r.body.error.decline_code, 'insufficient_funds');
    const pi = await api(env, 'GET', `/v1/payment_intents/${r.body.error.payment_intent.id}`);
    assert.equal(pi.body.status, 'requires_payment_method');
    const ch = await api(env, 'GET', `/v1/charges/${pi.body.latest_charge}`);
    assert.equal(ch.body.status, 'failed');
    assert.equal(ch.body.outcome.type, 'issuer_declined');
  });

  it('manual capture, partial capture and refunds', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', capture_method: 'manual' });
    assert.equal(r.body.status, 'requires_capture');
    assert.equal(r.body.amount_capturable, 5000);
    const cap = await api(env, 'POST', `/v1/payment_intents/${r.body.id}/capture`, { amount_to_capture: 4000 });
    assert.equal(cap.body.status, 'succeeded');
    assert.equal(cap.body.amount_received, 4000);
    const re1 = await api(env, 'POST', '/v1/refunds', { payment_intent: r.body.id, amount: 1000 });
    assert.equal(re1.status, 200);
    assert.equal(re1.body.status, 'succeeded');
    const tooMuch = await api(env, 'POST', '/v1/refunds', { payment_intent: r.body.id, amount: 5000 });
    assert.equal(tooMuch.status, 400);
    const re2 = await api(env, 'POST', '/v1/refunds', { payment_intent: r.body.id });
    assert.equal(re2.body.amount, 3000);
    const ch = await api(env, 'GET', `/v1/charges/${cap.body.latest_charge}`);
    assert.equal(ch.body.refunded, true);
    await runWorkersOnce();
    const ledger = await api(env, 'GET', '/v1/tessera/ledger');
    assert.equal(ledger.body.unbalanced_groups, 0);
    assert.equal(ledger.body.clearing_zeroed, true);
  });

  it('3-D Secure: requires_action, then succeeds after authentication', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 3000, currency: 'usd', payment_method: 'pm_card_authenticationRequired', confirm: 'true', return_url: 'http://example.com/done' });
    assert.equal(r.body.status, 'requires_action');
    assert.equal(r.body.next_action.type, 'redirect_to_url');
    const auth = await fetch(`${env.base}/hosted-api/authenticate/${r.body.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_secret: r.body.client_secret, result: 'success' }) });
    const ab: any = await auth.json();
    assert.equal(ab.status, 'succeeded');
    assert.equal(ab.return_url, 'http://example.com/done');
  });

  it('publishable key + client_secret can tokenize and confirm, nothing else', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 1200, currency: 'usd' });
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242 4242 4242 4242', exp_month: 12, exp_year: 2034, cvc: '123' } }, {}, env.pk);
    assert.equal(pm.status, 200);
    assert.equal(pm.body.card.last4, '4242');
    assert.equal(pm.body.card.checks.cvc_check, 'pass');
    const bad = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/confirm`, { payment_method: pm.body.id }, {}, env.pk);
    assert.equal(bad.status, 401);
    const ok = await api(env, 'POST', `/v1/payment_intents/${pi.body.id}/confirm`, { payment_method: pm.body.id, client_secret: pi.body.client_secret }, {}, env.pk);
    assert.equal(ok.body.status, 'succeeded');
    assert.equal(ok.body.customer, undefined, 'client view hides server-only fields');
    const badCard = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424241', exp_month: 12, exp_year: 2034 } }, {}, env.pk);
    assert.equal(badCard.status, 402);
    assert.equal(badCard.body.error.code, 'incorrect_number');
  });

  it('rejects invalid state transitions', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' });
    const c = await api(env, 'POST', `/v1/payment_intents/${r.body.id}/cancel`);
    assert.equal(c.status, 400);
    assert.equal(c.body.error.code, 'payment_intent_unexpected_state');
    const small = await api(env, 'POST', '/v1/payment_intents', { amount: 10, currency: 'usd' });
    assert.equal(small.body.error.code, 'amount_too_small');
  });
});

describe('idempotency', () => {
  it('replays the first response and rejects different params', async () => {
    const h = { 'Idempotency-Key': `key-${Date.now()}` };
    const a = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' }, h);
    const b = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' }, h);
    assert.equal(a.body.id, b.body.id);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    const c = await api(env, 'POST', '/v1/payment_intents', { amount: 9999, currency: 'usd' }, h);
    assert.equal(c.status, 400);
    assert.equal(c.body.error.type, 'idempotency_error');
    const list = await api(env, 'GET', '/v1/payment_intents?limit=100');
    assert.equal(list.body.data.filter((p: any) => p.id === a.body.id).length, 1);
  });
  it('replays saved card errors too', async () => {
    const h = { 'Idempotency-Key': `decl-${Date.now()}` };
    const a = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: 'pm_card_chargeDeclined', confirm: 'true' }, h);
    const b = await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: 'pm_card_chargeDeclined', confirm: 'true' }, h);
    assert.equal(a.status, 402);
    assert.equal(b.status, 402);
    assert.equal(a.body.error.charge, b.body.error.charge);
  });
});

describe('fraud rules', () => {
  it('default rule blocks highest-risk cards', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', payment_method: 'pm_card_radarBlock', confirm: 'true' });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.decline_code, 'fraudulent');
    const ch = await api(env, 'GET', `/v1/charges/${r.body.error.charge}`);
    assert.equal(ch.body.outcome.type, 'blocked');
    assert.equal(ch.body.outcome.network_status, 'not_sent_to_network');
    assert.equal(ch.body.outcome.risk_level, 'highest');
  });
  it('custom block, review and allow rules with value lists', async () => {
    const bad = await api(env, 'POST', '/v1/radar/rules', { action: 'block', predicate: ':amount_in_usd: >' });
    assert.equal(bad.status, 400);
    await api(env, 'POST', '/v1/radar/rules', { action: 'review', predicate: ":amount_in_usd: > 900 and :card_country: = 'US'" });
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 100000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' });
    assert.equal(r.body.status, 'succeeded');
    assert.match(r.body.review, /^prv_/);
    const approved = await api(env, 'POST', `/v1/reviews/${r.body.review}/approve`);
    assert.equal(approved.body.open, false);
    await api(env, 'POST', '/v1/radar/value_lists', { alias: 'blocked_countries', list_items: ['BR'] });
    await api(env, 'POST', '/v1/radar/rules', { action: 'block', predicate: ':card_country: in @blocked_countries' });
    const br = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', payment_method: 'pm_card_br', confirm: 'true' });
    assert.equal(br.status, 402);
    const gb = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', payment_method: 'pm_card_gb', confirm: 'true' });
    assert.equal(gb.body.status, 'succeeded');
  });
});

describe('versioning', () => {
  it('older versions get embedded charges on PaymentIntents', async () => {
    const r = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' }, { 'Stripe-Version': '2020-08-27' });
    assert.equal(r.body.charges.object, 'list');
    assert.equal(r.body.charges.data.length, 1);
    assert.equal(r.body.amount_details, undefined);
    const now = await api(env, 'GET', `/v1/payment_intents/${r.body.id}`);
    assert.equal(now.body.charges, undefined);
    assert.ok(now.body.amount_details);
  });
});

describe('webhooks', () => {
  it('delivers signed events and retries failures', async () => {
    const received: { body: string; sig: string }[] = [];
    let failFirst = true;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (failFirst) { failFirst = false; res.statusCode = 500; return res.end('nope'); }
        received.push({ body, sig: String(req.headers['stripe-signature']) });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const ep = await api(env, 'POST', '/v1/webhook_endpoints', { url: `http://127.0.0.1:${port}/hook`, enabled_events: ['payment_intent.succeeded'] });
    assert.match(ep.body.secret, /^whsec_/);
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 1100, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true' });
    await runWorkersOnce(); // first attempt fails with 500
    await new Promise((r) => setTimeout(r, 1100));
    await runWorkersOnce(); // retry succeeds
    srv.close();
    assert.equal(received.length, 1);
    const evt = JSON.parse(received[0]!.body);
    assert.equal(evt.type, 'payment_intent.succeeded');
    assert.equal(evt.data.object.id, pi.body.id);
    assert.ok(verify(received[0]!.body, received[0]!.sig, ep.body.secret));
    assert.ok(!verify(received[0]!.body + ' ', received[0]!.sig, ep.body.secret));
    const deliveries = await api(env, 'GET', `/v1/tessera/webhook_endpoints/${ep.body.id}/deliveries`);
    assert.equal(deliveries.body.data[0].status, 'succeeded');
    assert.equal(deliveries.body.data[0].attempts, 2);
  });
});

describe('checkout', () => {
  it('creates a hosted session and completes it', async () => {
    const s = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'http://example.com/ok', line_items: [{ quantity: 2, price_data: { currency: 'usd', unit_amount: 1500, product_data: { name: 'Mug' } } }] });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.amount_total, 3000);
    const view: any = await (await fetch(`${env.base}/hosted-api/checkout/${s.body.id}`)).json();
    assert.equal(view.amount_total, 3000);
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 1, exp_year: 2035, cvc: '314' } }, {}, view.publishable_key);
    const pay: any = await (await fetch(`${env.base}/hosted-api/checkout/${s.body.id}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment_method: pm.body.id, email: 'buyer@example.com' }) })).json();
    assert.equal(pay.status, 'succeeded');
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`);
    assert.equal(done.body.status, 'complete');
    assert.equal(done.body.payment_status, 'paid');
  });
});

describe('restricted keys and rate limits', () => {
  it('enforces per-resource permissions', async () => {
    const { createKey } = await import('../src/domain/accounts.ts');
    const acct = (await api(env, 'GET', '/v1/account')).body.id;
    const rk = await createKey(acct, 'restricted', 'read customers', { customers: 'read' });
    const ok = await api(env, 'GET', '/v1/customers', undefined, {}, rk.token);
    assert.equal(ok.status, 200);
    const no = await api(env, 'POST', '/v1/customers', { email: 'x@example.com' }, {}, rk.token);
    assert.equal(no.status, 403);
    const no2 = await api(env, 'GET', '/v1/payment_intents', undefined, {}, rk.token);
    assert.equal(no2.status, 403);
  });
  it('returns 429 with a reason header when the bucket is empty', async () => {
    const { setConfig } = await import('../src/config.ts');
    const { resetLimits } = await import('../src/platform/ratelimit.ts');
    setConfig({ rateLimitPerSecond: 3 });
    resetLimits();
    const results = await Promise.all(Array.from({ length: 8 }, () => api(env, 'GET', '/v1/balance')));
    const limited = results.filter((r) => r.status === 429);
    assert.ok(limited.length >= 1);
    assert.equal(limited[0]!.headers.get('stripe-rate-limited-reason'), 'global-rate');
    setConfig({ rateLimitPerSecond: 1000 });
    resetLimits();
  });
});
