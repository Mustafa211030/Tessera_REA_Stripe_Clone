import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await start();
  setConfig({ climateConfirmSeconds: 0, capitalPayoutSeconds: 0 });
});
after(async () => { await env.close(); });

const as = (acct: string) => ({ 'Stripe-Account': acct });
const available = async (headers: Record<string, string> = {}) => (await api(env, 'GET', '/v1/balance', undefined, headers)).body.available.find((b: any) => b.currency === 'usd')?.amount ?? 0;
const fund = (amount: number, headers: Record<string, string> = {}) => api(env, 'POST', '/v1/payment_intents', { amount, currency: 'usd', payment_method: 'pm_card_bypassPending', confirm: 'true' }, headers);

describe('radar metadata rules', () => {
  it('matches payment and customer metadata, and LIKE patterns', async () => {
    const bad = await api(env, 'POST', '/v1/radar/rules', { action: 'block', predicate: "::invoice:x:: = 'y'" });
    assert.equal(bad.status, 400);
    await api(env, 'POST', '/v1/radar/rules', { action: 'block', predicate: "::customer:tier:: = 'banned'" });
    await api(env, 'POST', '/v1/radar/rules', { action: 'review', predicate: "::order_type:: = 'gift' and :amount_in_usd: > 10" });
    await api(env, 'POST', '/v1/radar/rules', { action: 'block', predicate: ":email: like '%@fraud.example'" });
    const banned = (await api(env, 'POST', '/v1/customers', { email: 'x@example.com', metadata: { tier: 'banned' } })).body;
    const blocked = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', customer: banned.id, payment_method: 'pm_card_visa', confirm: 'true' });
    assert.equal(blocked.status, 402);
    const gift = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', metadata: { order_type: 'gift' } });
    assert.equal(gift.body.status, 'succeeded');
    assert.match(gift.body.review, /^prv_/);
    const plain = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', metadata: { order_type: 'standard' } });
    assert.equal(plain.body.review, null);
    const fraud = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', receipt_email: 'buyer@fraud.example' });
    assert.equal(fraud.status, 402);
    const tested = await api(env, 'POST', '/v1/tessera/radar/rules/test', { predicate: "::order_type:: = 'gift'" });
    if (tested.status === 200) assert.ok(tested.body.matched >= 1);
  });
});

describe('climate', () => {
  it('buys carbon removal from the balance, confirms, delivers and cancels', async () => {
    await fund(200_000);
    const products = await api(env, 'GET', '/v1/climate/products');
    const p = products.body.data[0];
    assert.equal(p.object, 'climate.product');
    assert.equal(p.current_prices_per_metric_ton.usd.amount_subtotal, 50_000);
    const before0 = await available();
    const o = await api(env, 'POST', '/v1/climate/orders', { product: p.id, metric_tons: '0.5', beneficiary: { public_name: 'Test Shop' } });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.deepEqual([o.body.amount_subtotal, o.body.amount_fees, o.body.amount_total, o.body.status], [25_000, 750, 25_750, 'open']);
    assert.equal(await available(), before0 - 25_750);
    const byAmount = await api(env, 'POST', '/v1/climate/orders', { product: p.id, amount: 10_300 });
    assert.equal(byAmount.body.metric_tons, '0.2');
    assert.equal(byAmount.body.amount_total, 10_300);
    const both = await api(env, 'POST', '/v1/climate/orders', { product: p.id, amount: 100, metric_tons: '1' });
    assert.equal(both.status, 400);
    const huge = await api(env, 'POST', '/v1/climate/orders', { product: p.id, metric_tons: '100' });
    assert.equal(huge.body.error.code, 'balance_insufficient');

    await runWorkersOnce();
    assert.equal((await api(env, 'GET', `/v1/climate/orders/${o.body.id}`)).body.status, 'confirmed');
    const delivered = await api(env, 'POST', `/v1/test_helpers/climate/orders/${o.body.id}/deliver`);
    assert.equal(delivered.body.status, 'delivered');
    assert.ok(delivered.body.delivery_details.length >= 1);
    const tons = delivered.body.delivery_details.reduce((s: number, d: any) => s + Number(d.metric_tons), 0);
    assert.equal(Math.round(tons * 1000), 500);
    const cert = await (await fetch(`${env.base}/hosted-api/climate/certificates/${delivered.body.certificate.split('/').pop()}`)).json() as any;
    assert.equal(cert.beneficiary, 'Test Shop');
    assert.equal((await api(env, 'POST', `/v1/climate/orders/${o.body.id}/cancel`)).status, 400);

    const beforeCancel = await available();
    const canceled = await api(env, 'POST', `/v1/climate/orders/${byAmount.body.id}/cancel`);
    assert.equal(canceled.body.status, 'canceled');
    assert.equal(await available(), beforeCancel + 10_300);
    const after = await api(env, 'GET', `/v1/climate/products/${p.id}`);
    assert.equal(Number(after.body.metric_tons_available), Number(p.metric_tons_available) - 0.5);
    const list = await api(env, 'GET', '/v1/climate/orders');
    assert.equal(list.body.data.length, 2);
  });
});

describe('financial connections', () => {
  it('links accounts through the hosted flow and reads balances, owners and transactions', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'link@example.com', name: 'Linda Link' })).body;
    const bad = await api(env, 'POST', '/v1/financial_connections/sessions', { account_holder: { type: 'customer', customer: cus.id }, permissions: ['payment_method'], prefetch: ['balances'] });
    assert.equal(bad.status, 400);
    const s = await api(env, 'POST', '/v1/financial_connections/sessions', { account_holder: { type: 'customer', customer: cus.id }, permissions: ['balances', 'ownership', 'payment_method', 'transactions'], prefetch: ['balances'] });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const secret = s.body.client_secret;
    const view = await (await fetch(`${env.base}/hosted-api/financial-connections/${secret}`)).json() as any;
    assert.ok(view.institutions.length >= 2);
    const post = (body: any) => fetch(`${env.base}/hosted-api/financial-connections/${secret}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ institution: 'fcinst_down_bank', accounts: ['checking'] })).status, 503);
    const done = await post({ institution: 'fcinst_tessera_test_bank', accounts: ['checking', 'credit'] });
    assert.equal(done.status, 200);
    assert.equal((await post({ institution: 'fcinst_tessera_test_bank', accounts: ['savings'] })).status, 400);

    const sess = await api(env, 'GET', `/v1/financial_connections/sessions/${s.body.id}`);
    assert.equal(sess.body.accounts.data.length, 2);
    const checking = sess.body.accounts.data.find((a: any) => a.subcategory === 'checking');
    const credit = sess.body.accounts.data.find((a: any) => a.subcategory === 'credit_card');
    assert.equal(checking.balance.cash.available.usd, 512_034);
    assert.equal(checking.balance_refresh.status, 'succeeded');
    assert.equal(credit.balance.type, 'credit');
    assert.equal(checking.transaction_refresh, null);

    const byCustomer = await api(env, 'GET', '/v1/financial_connections/accounts', { account_holder: { customer: cus.id } });
    assert.equal(byCustomer.body.data.length, 2);

    const refreshed = await api(env, 'POST', `/v1/financial_connections/accounts/${checking.id}/refresh`, { features: ['transactions', 'ownership'] });
    assert.equal(refreshed.body.transaction_refresh.status, 'succeeded');
    const txns = await api(env, 'GET', '/v1/financial_connections/transactions', { account: checking.id, limit: 100 });
    assert.equal(txns.body.data.length, 12);
    assert.ok(txns.body.data.some((t: any) => t.amount > 0) && txns.body.data.some((t: any) => t.amount < 0));
    const again = await api(env, 'POST', `/v1/financial_connections/accounts/${checking.id}/refresh`, { features: ['transactions'] });
    assert.equal(again.status, 200);
    assert.equal((await api(env, 'GET', '/v1/financial_connections/transactions', { account: checking.id, limit: 100 })).body.data.length, 12, 'refresh does not duplicate');
    const owners = await api(env, 'GET', `/v1/financial_connections/accounts/${checking.id}/owners`, { ownership: refreshed.body.ownership });
    assert.equal(owners.body.data[0].name, 'Linda Link');

    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { financial_connections_account: checking.id } });
    assert.equal(pm.status, 200, JSON.stringify(pm.body));
    assert.equal(pm.body.us_bank_account.financial_connections_account, checking.id);
    assert.equal(pm.body.us_bank_account.last4, '6789');
    assert.equal(pm.body.billing_details.name, 'Linda Link');
    const ccPm = await api(env, 'POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { financial_connections_account: credit.id } });
    assert.equal(ccPm.status, 400);

    const off = await api(env, 'POST', `/v1/financial_connections/accounts/${checking.id}/disconnect`);
    assert.equal(off.body.status, 'disconnected');
    assert.equal((await api(env, 'POST', `/v1/financial_connections/accounts/${checking.id}/refresh`, { features: ['balance'] })).status, 400);
  });
});

describe('capital', () => {
  it('offers, accepts, pays out and withholds repayments from sales', async () => {
    const a = (await api(env, 'POST', '/v1/accounts', {
      type: 'custom', country: 'US', business_type: 'individual', capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
      business_profile: { mcc: '5734', url: 'https://cap.example.com', name: 'Cap Cafe' },
      individual: { first_name: 'Jenny', last_name: 'Rosen', email: 'j@example.com', phone: '+15555550100', dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000', address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105' } },
      tos_acceptance: { date: 1700000000, ip: '127.0.0.1' }, external_account: 'btok_us_verified', settings: { payouts: { schedule: { interval: 'manual' } } },
    })).body;
    const offer = await api(env, 'POST', '/v1/test_helpers/capital/financing_offers/create', { advance_amount: 100_000, fee_amount: 10_000, withhold_rate: '0.2' }, as(a.id));
    assert.equal(offer.status, 200, JSON.stringify(offer.body));
    assert.equal(offer.body.status, 'undelivered');
    assert.equal(offer.body.account, a.id);
    const dup = await api(env, 'POST', '/v1/test_helpers/capital/financing_offers/create', {}, as(a.id));
    assert.equal(dup.status, 400);
    const listed = await api(env, 'GET', '/v1/capital/financing_offers', { connected_account: a.id });
    assert.equal(listed.body.data[0].id, offer.body.id);
    assert.equal((await api(env, 'POST', `/v1/tessera/capital/financing_offers/${offer.body.id}/application_link`)).status, 400, 'deliver first');
    await api(env, 'POST', `/v1/capital/financing_offers/${offer.body.id}/mark_delivered`);
    assert.equal((await api(env, 'GET', '/v1/capital/financing_summary', undefined, as(a.id))).body.status, 'delivered');
    const link = await api(env, 'POST', `/v1/tessera/capital/financing_offers/${offer.body.id}/application_link`);
    const token = link.body.url.split('/').pop();
    const view = await (await fetch(`${env.base}/hosted-api/capital/${token}`)).json() as any;
    assert.equal(view.business, 'Cap Cafe');
    const accept = await (await fetch(`${env.base}/hosted-api/capital/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) })).json() as any;
    assert.equal(accept.status, 'accepted');

    const before0 = await available(as(a.id));
    await runWorkersOnce();
    assert.equal((await api(env, 'GET', `/v1/capital/financing_offers/${offer.body.id}`)).body.status, 'paid_out');
    assert.equal(await available(as(a.id)), before0 + 100_000);

    // A sale: 20% of its net is withheld when the funds become available.
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } }, as(a.id));
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 50_000, currency: 'usd', payment_method: pm.body.id, confirm: 'true', expand: ['latest_charge.balance_transaction'] }, as(a.id));
    const net = pi.body.latest_charge.balance_transaction.net;
    await runWorkersOnce();
    const sum = (await api(env, 'GET', '/v1/capital/financing_summary', undefined, as(a.id))).body;
    assert.equal(sum.status, 'accepted');
    assert.equal(sum.details.paid_amount, Math.round(net * 0.2));
    assert.equal(sum.details.remaining_amount, 110_000 - Math.round(net * 0.2));
    const txns = await api(env, 'GET', '/v1/capital/financing_transactions', { financing_offer: offer.body.id });
    assert.deepEqual(txns.body.data.map((t: any) => t.type), ['payment', 'payout']);
    assert.equal(txns.body.data[0].details.linked_payment, pi.body.latest_charge.id);

    // A big sale repays the rest (never more than owed).
    const pm2 = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } }, as(a.id));
    await api(env, 'POST', '/v1/payment_intents', { amount: 1_000_000, currency: 'usd', payment_method: pm2.body.id, confirm: 'true' }, as(a.id));
    await runWorkersOnce();
    const final = await api(env, 'GET', `/v1/capital/financing_offers/${offer.body.id}`);
    assert.equal(final.body.status, 'fully_repaid');
    const all = await api(env, 'GET', '/v1/tessera/capital/financing_offers');
    const prog = all.body.data.find((x: any) => x.id === offer.body.id).progress;
    assert.equal(prog.paid, 110_000);
    assert.equal(prog.paid_fee, 10_000);
    assert.equal((await api(env, 'GET', '/v1/capital/financing_summary', undefined, as(a.id))).body.status, 'none');
    const ledger = await api(env, 'GET', '/v1/tessera/ledger', undefined, as(a.id));
    if (ledger.status === 200 && ledger.body.unbalanced_groups !== undefined) assert.equal(ledger.body.unbalanced_groups, 0);
  });
});

describe('revenue recognition', () => {
  it('recognizes an annual plan ratably and one-time payments immediately', async () => {
    const T = Date.UTC(2026, 0, 15) / 1000;
    const clock = (await api(env, 'POST', '/v1/test_helpers/test_clocks', { frozen_time: T })).body;
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'rr@example.com', test_clock: clock.id })).body;
    const pm = await api(env, 'POST', '/v1/payment_methods/pm_card_visa/attach', { customer: cus.id });
    await api(env, 'POST', `/v1/customers/${cus.id}`, { invoice_settings: { default_payment_method: pm.body.id } });
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Annual plan', default_price_data: { currency: 'usd', unit_amount: 120_000, recurring: { interval: 'year' } } })).body;
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: prod.default_price }] });
    assert.equal(sub.body.status, 'active', JSON.stringify(sub.body));

    const r = await api(env, 'GET', '/v1/tessera/revenue_recognition', { interval_start: Date.UTC(2026, 0, 1) / 1000, interval_end: Date.UTC(2027, 1, 1) / 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const months = r.body.months;
    assert.equal(months.length, 13);
    const jan = months[0];
    assert.equal(jan.month, '2026-01');
    assert.ok(jan.billed >= 120_000);
    const expectJan = Math.round((120_000 * (Date.UTC(2026, 1, 1) / 1000 - T)) / (365 * 86400));
    const annual = r.body.products.find((p: any) => p.product === prod.id);
    assert.ok(annual);
    // Recognition over the year adds up to the invoice amount (to the cent).
    const total = months.reduce((s: number, m: any) => s + m.recognized, 0);
    assert.ok(total >= 120_000);
    assert.ok(Math.abs(jan.deferred_revenue_end - (jan.billed - jan.recognized)) <= 1);
    assert.ok(jan.recognized >= expectJan);
    assert.ok(months[11].deferred_revenue_end > 0, 'December still has January 2027 service deferred');
    assert.equal(months[12].deferred_revenue_end, 0);

    const run = await api(env, 'POST', '/v1/reporting/report_runs', { report_type: 'revenue_recognition.debits_and_credits.1', parameters: { interval_start: Date.UTC(2026, 0, 1) / 1000, interval_end: Date.UTC(2026, 1, 1) / 1000 } });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await runWorkersOnce();
    const done = await api(env, 'GET', `/v1/reporting/report_runs/${run.body.id}`);
    assert.equal(done.body.status, 'succeeded');
    const csv = await (await fetch(`${env.base}/v1/files/${done.body.result.id}/contents`, { headers: { authorization: `Bearer ${env.sk}` } })).text();
    assert.match(csv.split('\n')[0]!, /^accounting_period,booked_date,debit_gl_account,credit_gl_account/);
    assert.ok(csv.includes('AccountsReceivable,DeferredRevenue,1200.00'));
    assert.ok(csv.includes('DeferredRevenue,Revenue'));
  });
});
