import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); setConfig({ treasurySettleSeconds: 0, disputeReviewSeconds: 0 }); });
after(async () => { await env.close(); });

const ledgerOk = async () => {
  const l = await api(env, 'GET', '/v1/tessera/ledger');
  assert.equal(l.body.unbalanced_groups, 0);
};
const bank = (account = '000123456789') => api(env, 'POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: account, account_holder_type: 'company' }, billing_details: { name: 'Rocket Rides' } });

describe('treasury', () => {
  it('moves money in, out and between financial accounts', async () => {
    const fa = await api(env, 'POST', '/v1/treasury/financial_accounts', { supported_currencies: ['usd'], nickname: 'Operating', features: { financial_addresses: { aba: { requested: 'true' } }, inbound_transfers: { ach: { requested: 'true' } }, outbound_payments: { ach: { requested: 'true' } }, outbound_transfers: { ach: { requested: 'true' } }, intra_stripe_flows: { requested: 'true' } } });
    assert.equal(fa.status, 200, JSON.stringify(fa.body));
    assert.equal(fa.body.financial_addresses[0].aba.routing_number, '110000000');
    assert.equal(fa.body.financial_addresses[0].aba.account_number, null);
    const withNumber = await api(env, 'GET', `/v1/treasury/financial_accounts/${fa.body.id}`, { expand: ['financial_addresses.aba.account_number'] });
    assert.match(withNumber.body.financial_addresses[0].aba.account_number, /^\d{12}$/);
    const pm = (await bank()).body;
    assert.equal(pm.type, 'us_bank_account');

    const ibt = await api(env, 'POST', '/v1/treasury/inbound_transfers', { financial_account: fa.body.id, amount: 50000, currency: 'usd', origin_payment_method: pm.id, description: 'Funding' });
    assert.equal(ibt.status, 200, JSON.stringify(ibt.body));
    assert.equal(ibt.body.status, 'processing');
    let bal = (await api(env, 'GET', `/v1/treasury/financial_accounts/${fa.body.id}`)).body.balance;
    assert.deepEqual([bal.cash.usd, bal.inbound_pending.usd], [0, 50000]);
    await runWorkersOnce();
    bal = (await api(env, 'GET', `/v1/treasury/financial_accounts/${fa.body.id}`)).body.balance;
    assert.deepEqual([bal.cash.usd, bal.inbound_pending.usd], [50000, 0]);
    assert.equal((await api(env, 'GET', `/v1/treasury/inbound_transfers/${ibt.body.id}`)).body.status, 'succeeded');

    const badPm = (await bank('000222222227')).body;
    const bad = await api(env, 'POST', '/v1/treasury/inbound_transfers', { financial_account: fa.body.id, amount: 1000, currency: 'usd', origin_payment_method: badPm.id });
    await runWorkersOnce();
    const failed = (await api(env, 'GET', `/v1/treasury/inbound_transfers/${bad.body.id}`)).body;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure_details.code, 'insufficient_funds');

    const vendor = (await bank('000000004321')).body;
    const obp = await api(env, 'POST', '/v1/treasury/outbound_payments', { financial_account: fa.body.id, amount: 12000, currency: 'usd', destination_payment_method: vendor.id, description: 'Invoice 42' });
    assert.equal(obp.status, 200, JSON.stringify(obp.body));
    bal = (await api(env, 'GET', `/v1/treasury/financial_accounts/${fa.body.id}`)).body.balance;
    assert.deepEqual([bal.cash.usd, bal.outbound_pending.usd], [38000, 12000]);
    const tooMuch = await api(env, 'POST', '/v1/treasury/outbound_payments', { financial_account: fa.body.id, amount: 99999, currency: 'usd', destination_payment_method: vendor.id });
    assert.equal(tooMuch.body.error.code, 'insufficient_funds');
    const posted = await api(env, 'POST', `/v1/test_helpers/treasury/outbound_payments/${obp.body.id}/post`);
    assert.equal(posted.body.status, 'posted');
    const ret = await api(env, 'POST', `/v1/test_helpers/treasury/outbound_payments/${obp.body.id}/return`, { returned_details: { code: 'account_closed' } });
    assert.equal(ret.body.status, 'returned');
    bal = (await api(env, 'GET', `/v1/treasury/financial_accounts/${fa.body.id}`)).body.balance;
    assert.equal(bal.cash.usd, 50000, 'returned money comes back');

    const obt = await api(env, 'POST', '/v1/treasury/outbound_transfers', { financial_account: fa.body.id, amount: 5000, currency: 'usd', destination_payment_method: pm.id });
    const canceled = await api(env, 'POST', `/v1/treasury/outbound_transfers/${obt.body.id}/cancel`);
    assert.equal(canceled.body.status, 'canceled');

    const savings = (await api(env, 'POST', '/v1/treasury/financial_accounts', { supported_currencies: ['usd'], nickname: 'Savings' })).body;
    const intra = await api(env, 'POST', '/v1/treasury/outbound_payments', { financial_account: fa.body.id, amount: 20000, currency: 'usd', destination_payment_method_data: { type: 'financial_account', financial_account: savings.id } });
    assert.equal(intra.body.status, 'posted', JSON.stringify(intra.body));
    assert.equal((await api(env, 'GET', `/v1/treasury/financial_accounts/${savings.id}`)).body.balance.cash.usd, 20000);
    const rcs = await api(env, 'GET', '/v1/treasury/received_credits', { financial_account: savings.id });
    assert.equal(rcs.body.data[0].network, 'stripe');

    const rc = await api(env, 'POST', '/v1/test_helpers/treasury/received_credits', { financial_account: fa.body.id, amount: 7000, currency: 'usd', network: 'ach' });
    assert.equal(rc.body.status, 'succeeded');
    const rd = await api(env, 'POST', '/v1/test_helpers/treasury/received_debits', { financial_account: fa.body.id, amount: 1000000, currency: 'usd', network: 'ach' });
    assert.equal(rd.body.failure_code, 'insufficient_funds');
    const txns = await api(env, 'GET', '/v1/treasury/transactions', { financial_account: fa.body.id, limit: 50 });
    assert.ok(txns.body.data.some((t: any) => t.flow_type === 'inbound_transfer' && t.status === 'posted'));
    const entries = await api(env, 'GET', '/v1/treasury/transaction_entries', { transaction: ibt.body.transaction });
    assert.equal(entries.body.data.length, 2, 'pending, then settled');
    assert.equal((await api(env, 'POST', `/v1/treasury/financial_accounts/${savings.id}/close`)).status, 400, 'cannot close with money in it');
    await ledgerOk();
  });
});

describe('issuing disputes', () => {
  it('wins a dispute and reinstates the funds', async () => {
    await api(env, 'POST', '/v1/topups', { amount: 10000, currency: 'usd', destination_balance: 'issuing' });
    const ch = (await api(env, 'POST', '/v1/issuing/cardholders', { name: 'Dee', billing: { address: { line1: '1 Main', city: 'SF', state: 'CA', postal_code: '94111', country: 'US' } } })).body;
    const card = (await api(env, 'POST', '/v1/issuing/cards', { cardholder: ch.id, currency: 'usd', type: 'virtual', status: 'active' })).body;
    const buy = async (amount: number) => {
      const a = (await api(env, 'POST', '/v1/test_helpers/issuing/authorizations', { card: card.id, amount, merchant_data: { category: 'electronics_stores', name: 'Gadget Hut' } })).body;
      await api(env, 'POST', `/v1/test_helpers/issuing/authorizations/${a.id}/capture`);
      return (await api(env, 'GET', '/v1/issuing/transactions', { card: card.id })).body.data[0];
    };
    const t1 = await buy(4000);
    const d = await api(env, 'POST', '/v1/issuing/disputes', { transaction: t1.id, evidence: { reason: 'not_received', not_received: { explanation: 'Package never arrived', expected_at: 1700000000 } } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.status, 'unsubmitted');
    assert.equal((await api(env, 'POST', '/v1/issuing/disputes', { transaction: t1.id })).status, 400, 'one dispute per transaction');
    const sub = await api(env, 'POST', `/v1/issuing/disputes/${d.body.id}/submit`);
    assert.equal(sub.body.status, 'submitted');
    await runWorkersOnce();
    const won = (await api(env, 'GET', `/v1/issuing/disputes/${d.body.id}`)).body;
    assert.equal(won.status, 'won');
    assert.equal((await api(env, 'GET', '/v1/balance')).body.issuing.available[0].amount, 10000);
    const t2 = await buy(1000);
    const d2 = (await api(env, 'POST', '/v1/issuing/disputes', { transaction: t2.id, evidence: { reason: 'other', other: { explanation: 'losing_evidence' } } })).body;
    await api(env, 'POST', `/v1/issuing/disputes/${d2.id}/submit`);
    await runWorkersOnce();
    assert.equal((await api(env, 'GET', `/v1/issuing/disputes/${d2.id}`)).body.status, 'lost');
    await ledgerOk();
  });
});

describe('billing thresholds', () => {
  it('invoices early when usage crosses a threshold', async () => {
    const meter = (await api(env, 'POST', '/v1/billing/meters', { display_name: 'GB', event_name: 'gb_stored', default_aggregation: { formula: 'sum' } })).body;
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Storage' })).body;
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 100, recurring: { interval: 'month', usage_type: 'metered', meter: meter.id } })).body;
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'thresh@example.com' })).body;
    const pm = await api(env, 'POST', '/v1/payment_methods/pm_card_visa/attach', { customer: cus.id });
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, default_payment_method: pm.body.id, items: [{ price: price.id }], billing_thresholds: { amount_gte: 5000 } });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.billing_thresholds.amount_gte, 5000);
    const send = (v: number) => api(env, 'POST', '/v1/billing/meter_events', { event_name: 'gb_stored', payload: { stripe_customer_id: cus.id, value: String(v) } });
    await send(30);
    assert.equal((await api(env, 'GET', '/v1/invoices', { subscription: sub.body.id })).body.data.length, 1);
    await send(25);
    const invs = (await api(env, 'GET', '/v1/invoices', { subscription: sub.body.id })).body.data;
    assert.equal(invs.length, 2);
    assert.equal(invs[0].billing_reason, 'subscription_threshold');
    assert.equal(invs[0].amount_paid, 5500);
    await send(10);
    assert.equal((await api(env, 'GET', '/v1/invoices', { subscription: sub.body.id })).body.data.length, 2, 'usage counter starts again after a threshold invoice');
    const up = await api(env, 'GET', '/v1/invoices/upcoming', { subscription: sub.body.id });
    assert.equal(up.body.amount_due, 1000);
    const nonMetered = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 500, recurring: { interval: 'month' } })).body.id, billing_thresholds: { usage_gte: 5 } }] });
    assert.equal(nonMetered.status, 400);
  });
});

describe('customer cash balance', () => {
  it('pays from the balance, waits for funds, reconciles and refunds back', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'wire@example.com', name: 'Wire Co' })).body;
    const fi = await api(env, 'POST', `/v1/customers/${cus.id}/funding_instructions`, { currency: 'usd', funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } });
    assert.equal(fi.status, 200, JSON.stringify(fi.body));
    assert.equal(fi.body.bank_transfer.financial_addresses[0].aba.routing_number, '110000000');
    await api(env, 'POST', `/v1/test_helpers/customers/${cus.id}/fund_cash_balance`, { amount: 3000, currency: 'usd' });
    assert.equal((await api(env, 'GET', `/v1/customers/${cus.id}/cash_balance`)).body.available.usd, 3000);

    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', customer: cus.id, allowed_payment_method_types: ['customer_balance'], payment_method_data: { type: 'customer_balance' }, payment_method_options: { customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } } }, confirm: 'true' });
    assert.equal(pi.status, 200, JSON.stringify(pi.body));
    assert.equal(pi.body.status, 'succeeded');
    const big = await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', customer: cus.id, allowed_payment_method_types: ['customer_balance'], payment_method_data: { type: 'customer_balance' }, confirm: 'true' });
    assert.equal(big.body.status, 'requires_action');
    assert.equal(big.body.next_action.type, 'display_bank_transfer_instructions');
    assert.equal(big.body.next_action.display_bank_transfer_instructions.amount_remaining, 4000, 'the remaining $10 was applied');
    await api(env, 'POST', `/v1/test_helpers/customers/${cus.id}/fund_cash_balance`, { amount: 4500, currency: 'usd', reference: big.body.next_action.display_bank_transfer_instructions.reference });
    assert.equal((await api(env, 'GET', `/v1/payment_intents/${big.body.id}`)).body.status, 'succeeded');
    assert.equal((await api(env, 'GET', `/v1/customers/${cus.id}/cash_balance`)).body.available.usd, 500);
    const re = await api(env, 'POST', '/v1/refunds', { payment_intent: pi.body.id, amount: 700 });
    assert.equal(re.body.destination_details.type, 'customer_cash_balance');
    assert.equal((await api(env, 'GET', `/v1/customers/${cus.id}/cash_balance`)).body.available.usd, 1200);
    const pending = (await api(env, 'POST', '/v1/payment_intents', { amount: 5000, currency: 'usd', customer: cus.id, allowed_payment_method_types: ['customer_balance'], payment_method_data: { type: 'customer_balance' }, confirm: 'true' })).body;
    assert.equal((await api(env, 'GET', `/v1/customers/${cus.id}/cash_balance`)).body.available.usd ?? 0, 0);
    await api(env, 'POST', `/v1/payment_intents/${pending.id}/cancel`);
    assert.equal((await api(env, 'GET', `/v1/customers/${cus.id}/cash_balance`)).body.available.usd, 1200, 'cancel returns applied funds');
    const txns = (await api(env, 'GET', `/v1/customers/${cus.id}/cash_balance_transactions`, { limit: 20 })).body.data.map((t: any) => t.type);
    for (const t of ['funded', 'applied_to_payment', 'refunded_from_payment', 'unapplied_from_payment']) assert.ok(txns.includes(t), t);
    await runWorkersOnce();
    await ledgerOk();
  });
});
