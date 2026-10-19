import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { verify } from '../src/domain/webhooks.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

describe('terminal', () => {
  it('takes an in-person payment on a simulated reader', async () => {
    const loc = await api(env, 'POST', '/v1/terminal/locations', { display_name: 'Main Street shop', address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } });
    assert.equal(loc.status, 200, JSON.stringify(loc.body));
    const bad = await api(env, 'POST', '/v1/terminal/readers', { registration_code: 'nope', location: loc.body.id });
    assert.equal(bad.status, 400);
    const reader = await api(env, 'POST', '/v1/terminal/readers', { registration_code: 'simulated-wpe', location: loc.body.id, label: 'Front counter' });
    assert.equal(reader.body.device_type, 'simulated_wisepos_e');
    assert.equal(reader.body.status, 'online');
    const token = await api(env, 'POST', '/v1/terminal/connection_tokens', { location: loc.body.id });
    assert.match(token.body.secret, /^pst_test_/);

    const online = (await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'usd' })).body;
    assert.equal((await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/process_payment_intent`, { payment_intent: online.id })).status, 400, 'needs card_present');

    const pi = (await api(env, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method_types: ['card_present'], capture_method: 'manual' })).body;
    const shown = await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/set_reader_display`, { type: 'cart', cart: { currency: 'usd', line_items: [{ amount: 2500, description: 'Latte', quantity: 1 }], total: 2500 } });
    assert.equal(shown.body.action.status, 'succeeded');
    const proc = await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/process_payment_intent`, { payment_intent: pi.id, process_config: { tipping: { amount_eligible: 2500 } } });
    assert.equal(proc.body.action.status, 'in_progress');
    const busy = await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/set_reader_display`, { type: 'cart', cart: { currency: 'usd', total: 1 } });
    assert.equal(busy.status, 409);
    const done = await api(env, 'POST', `/v1/test_helpers/terminal/readers/${reader.body.id}/present_payment_method`, { amount_tip: 300 });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.action.status, 'succeeded');
    const after = (await api(env, 'GET', `/v1/payment_intents/${pi.id}`, { expand: ['latest_charge', 'payment_method'] })).body;
    assert.equal(after.status, 'requires_capture');
    assert.equal(after.amount, 2800);
    assert.equal(after.amount_details.tip.amount, 300);
    assert.equal(after.payment_method.type, 'card_present');
    assert.equal(after.latest_charge.payment_method_details.type, 'card_present');
    assert.equal(after.latest_charge.payment_method_details.card_present.read_method, 'contact_emv');
    const cap = await api(env, 'POST', `/v1/payment_intents/${pi.id}/capture`);
    assert.equal(cap.body.status, 'succeeded');

    // Declined card, then a refund through the reader.
    const pi2 = (await api(env, 'POST', '/v1/payment_intents', { amount: 900, currency: 'usd', payment_method_types: ['card_present'], capture_method: 'automatic' })).body;
    await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/process_payment_intent`, { payment_intent: pi2.id });
    const declined = await api(env, 'POST', `/v1/test_helpers/terminal/readers/${reader.body.id}/present_payment_method`, { card_present: { number: '4000000000000002' } });
    assert.equal(declined.body.action.status, 'failed');
    assert.equal(declined.body.action.failure_code, 'card_declined');
    assert.equal((await api(env, 'GET', `/v1/payment_intents/${pi2.id}`)).body.status, 'requires_payment_method');
    const ref = await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/refund_payment`, { payment_intent: pi.id, amount: 500 });
    assert.equal(ref.body.action.type, 'refund_payment');
    const refunded = await api(env, 'POST', `/v1/test_helpers/terminal/readers/${reader.body.id}/present_payment_method`);
    assert.equal(refunded.body.action.status, 'succeeded');
    assert.match(refunded.body.action.refund_payment.refund, /^re_/);
    await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/process_payment_intent`, { payment_intent: pi2.id });
    const canceled = await api(env, 'POST', `/v1/terminal/readers/${reader.body.id}/cancel_action`);
    assert.equal(canceled.body.action.failure_code, 'canceled');
    const events = (await api(env, 'GET', '/v1/events', { limit: 30 })).body.data.map((e: any) => e.type);
    assert.ok(events.includes('terminal.reader.action_succeeded'));
    assert.ok(events.includes('terminal.reader.action_failed'));
    assert.equal((await api(env, 'DELETE', `/v1/terminal/readers/${reader.body.id}`)).body.deleted, true);
  });
});

describe('issuing', () => {
  async function setup(controls?: any) {
    const ch = await api(env, 'POST', '/v1/issuing/cardholders', { name: 'Jenny Rosen', email: 'jenny@example.com', type: 'individual', billing: { address: { line1: '1 Main St', city: 'SF', state: 'CA', postal_code: '94111', country: 'US' } } });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const card = await api(env, 'POST', '/v1/issuing/cards', { cardholder: ch.body.id, currency: 'usd', type: 'virtual', status: 'active', ...(controls ? { spending_controls: controls } : {}) });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    return { ch: ch.body, card: card.body };
  }
  const authorize = (card: string, amount: number, category = 'eating_places_restaurants') =>
    api(env, 'POST', '/v1/test_helpers/issuing/authorizations', { card, amount, merchant_data: { category, name: 'Rocket Rides' } });

  it('funds the balance, approves within controls, holds and captures', async () => {
    const { card } = await setup({ spending_limits: [{ amount: 5000, interval: 'daily' }], blocked_categories: ['airlines_air_carriers'] });
    assert.equal(card.number, null, 'number only when expanded');
    assert.equal(card.cardholder.object, 'issuing.cardholder');
    const full = (await api(env, 'GET', `/v1/issuing/cards/${card.id}`, { expand: ['number', 'cvc'] })).body;
    assert.match(full.number, /^4\d{15}$/);
    assert.equal(full.number.slice(-4), card.last4);

    const broke = await authorize(card.id, 1000);
    assert.equal(broke.body.approved, false);
    assert.equal(broke.body.request_history[0].reason, 'insufficient_funds');

    const tu = await api(env, 'POST', '/v1/topups', { amount: 10000, currency: 'usd', destination_balance: 'issuing', description: 'Fund cards' });
    assert.equal(tu.body.status, 'succeeded');
    let bal = (await api(env, 'GET', '/v1/balance')).body;
    assert.equal(bal.issuing.available[0].amount, 10000);

    const ok = await authorize(card.id, 3000);
    assert.equal(ok.body.approved, true, JSON.stringify(ok.body.request_history));
    assert.equal(ok.body.status, 'pending');
    assert.equal(ok.body.request_history[0].reason, 'card_active');
    bal = (await api(env, 'GET', '/v1/balance')).body;
    assert.equal(bal.issuing.available[0].amount, 7000, 'held');
    const over = await authorize(card.id, 2500);
    assert.equal(over.body.request_history[0].reason, 'spending_controls', 'daily limit');
    const blocked = await authorize(card.id, 100, 'airlines_air_carriers');
    assert.equal(blocked.body.approved, false);

    const cap = await api(env, 'POST', `/v1/test_helpers/issuing/authorizations/${ok.body.id}/capture`, { capture_amount: 2800 });
    assert.equal(cap.body.status, 'closed');
    bal = (await api(env, 'GET', '/v1/balance')).body;
    assert.equal(bal.issuing.available[0].amount, 7200, 'hold released, 2,800 spent');
    const txns = (await api(env, 'GET', '/v1/issuing/transactions', { card: card.id })).body.data;
    assert.equal(txns[0].amount, -2800);
    assert.equal(txns[0].type, 'capture');
    const refund = await api(env, 'POST', `/v1/test_helpers/issuing/transactions/${txns[0].id}/refund`, { refund_amount: 800 });
    assert.equal(refund.body.amount, 800);
    bal = (await api(env, 'GET', '/v1/balance')).body;
    assert.equal(bal.issuing.available[0].amount, 8000);

    const a2 = await authorize(card.id, 1000);
    const rev = await api(env, 'POST', `/v1/test_helpers/issuing/authorizations/${a2.body.id}/reverse`);
    assert.equal(rev.body.status, 'reversed');
    const a3 = await authorize(card.id, 500);
    const inc = await api(env, 'POST', `/v1/test_helpers/issuing/authorizations/${a3.body.id}/increment`, { increment_amount: 200 });
    assert.equal(inc.body.amount, 700);
    const exp = await api(env, 'POST', `/v1/test_helpers/issuing/authorizations/${a3.body.id}/expire`);
    assert.equal(exp.body.status, 'expired');
    assert.equal((await api(env, 'GET', '/v1/balance')).body.issuing.available[0].amount, 8000);
    const health = await api(env, 'GET', '/v1/tessera/ledger');
    assert.equal(health.body.unbalanced_groups, 0);

    await api(env, 'POST', `/v1/issuing/cards/${card.id}`, { status: 'inactive' });
    assert.equal((await authorize(card.id, 100)).body.request_history[0].reason, 'card_inactive');
    const cancel = await api(env, 'POST', `/v1/issuing/cards/${card.id}`, { status: 'canceled', cancellation_reason: 'lost' });
    assert.equal(cancel.body.status, 'canceled');
    assert.equal((await api(env, 'POST', `/v1/issuing/cards/${card.id}`, { status: 'active' })).status, 400);
  });

  it('asks a real-time webhook endpoint to approve or decline', async () => {
    const { card } = await setup();
    await api(env, 'POST', '/v1/topups', { amount: 20000, currency: 'usd', destination_balance: 'issuing' });
    let mode: 'approve' | 'decline' | 'partial' | 'slow' = 'approve';
    let lastSigOk = false;
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastSigOk = verify(body, String(req.headers['stripe-signature']), secret);
        const evt = JSON.parse(body);
        assert.equal(evt.type, 'issuing_authorization.request');
        assert.ok(evt.data.object.pending_request.amount > 0);
        if (mode === 'slow') { setTimeout(() => res.end('{"approved":true}'), 600); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(mode === 'partial' ? { approved: true, amount: 1500 } : { approved: mode === 'approve' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const ep = await api(env, 'POST', '/v1/webhook_endpoints', { url: `http://127.0.0.1:${port}/issuing`, enabled_events: ['issuing_authorization.request'] });
    const secret = ep.body.secret;
    try {
      const yes = await authorize(card.id, 2000);
      assert.equal(yes.body.approved, true);
      assert.equal(yes.body.request_history[0].reason, 'webhook_approved');
      assert.ok(lastSigOk, 'request is signed');
      mode = 'decline';
      const no = await authorize(card.id, 2000);
      assert.equal(no.body.request_history[0].reason, 'webhook_declined');
      mode = 'partial';
      const part = await api(env, 'POST', '/v1/test_helpers/issuing/authorizations', { card: card.id, amount: 4000, is_amount_controllable: 'true', merchant_data: { category: 'automated_fuel_dispensers' } });
      assert.equal(part.body.amount, 1500, 'partial approval for amount-controllable authorizations');
      mode = 'slow';
      setConfig({ issuingWebhookTimeoutMs: 200 });
      const late = await authorize(card.id, 100);
      assert.equal(late.body.request_history[0].reason, 'webhook_timeout');
    } finally {
      setConfig({ issuingWebhookTimeoutMs: 2000 });
      await api(env, 'DELETE', `/v1/webhook_endpoints/${ep.body.id}`);
      server.close();
    }
  });
});
