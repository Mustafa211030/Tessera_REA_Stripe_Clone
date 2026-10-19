import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

async function ledgerOk() {
  const l = await api(env, 'GET', '/v1/tessera/ledger');
  assert.equal(l.body.unbalanced_groups, 0);
}
const hosted = async (method: string, path: string, body?: any) => {
  const r = await fetch(`${env.base}/hosted-api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
};

describe('multi-currency and FX', () => {
  it('converts a EUR charge into USD with the rate and a conversion fee', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 10000, currency: 'eur', payment_method: 'pm_card_visa', confirm: 'true', expand: ['latest_charge.balance_transaction'] });
    assert.equal(pi.status, 200, JSON.stringify(pi.body));
    const txn = pi.body.latest_charge.balance_transaction;
    assert.equal(txn.currency, 'usd');
    const rate = Number((1 / 0.92).toFixed(6));
    assert.equal(txn.exchange_rate, rate);
    assert.equal(txn.amount, Math.round(100 * rate * 100));
    assert.equal(txn.fee, Math.round(txn.amount * 0.039) + 30, '2.9% + 30 plus 1% conversion');
    const re = await api(env, 'POST', '/v1/refunds', { payment_intent: pi.body.id, amount: 5000, expand: ['balance_transaction'] });
    assert.equal(re.body.balance_transaction.currency, 'usd');
    assert.equal(re.body.balance_transaction.amount, -Math.round(50 * rate * 100));
    await ledgerOk();
  });

  it('settles EUR in EUR once the account has a EUR bank account', async () => {
    const acct = await api(env, 'GET', '/v1/account');
    const ba = await api(env, 'POST', `/v1/accounts/${acct.body.id}/external_accounts`, { external_account: { object: 'bank_account', country: 'DE', currency: 'eur', account_number: '000123456789' } });
    assert.equal(ba.status, 200, JSON.stringify(ba.body));
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 2000, currency: 'eur', payment_method: 'pm_card_visa', confirm: 'true', expand: ['latest_charge.balance_transaction'] });
    const txn = pi.body.latest_charge.balance_transaction;
    assert.equal(txn.currency, 'eur');
    assert.equal(txn.exchange_rate, null);
    assert.equal(txn.fee, Math.round(2000 * 0.029) + 30);
    await runWorkersOnce();
    const bal = await api(env, 'GET', '/v1/balance');
    assert.ok(bal.body.available.some((b: any) => b.currency === 'eur' && b.amount > 0));
  });

  it('adds 1.5% for international cards, exposes rates and rejects unknown currencies', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 10000, currency: 'usd', payment_method: 'pm_card_gb', confirm: 'true', expand: ['latest_charge.balance_transaction'] });
    assert.equal(pi.body.latest_charge.balance_transaction.fee, Math.round(10000 * 0.044) + 30);
    const fx = await api(env, 'GET', '/v1/exchange_rates/usd');
    assert.equal(fx.body.object, 'exchange_rate');
    assert.equal(fx.body.rates.eur, 0.92);
    const bad = await api(env, 'POST', '/v1/payment_intents', { amount: 1000, currency: 'xyz' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.param, 'currency');
    const jpy = await api(env, 'POST', '/v1/payment_intents', { amount: 1500, currency: 'jpy', payment_method: 'pm_card_visa', confirm: 'true', expand: ['latest_charge.balance_transaction'] });
    assert.equal(jpy.body.latest_charge.balance_transaction.amount, Math.round((1500 / 151.2) * 100), 'zero-decimal currencies convert correctly');
  });
});

describe('tax', () => {
  it('manual exclusive and inclusive tax rates on invoices', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'tax@example.com' })).body.id;
    const vat = await api(env, 'POST', '/v1/tax_rates', { display_name: 'VAT', percentage: 20, inclusive: 'false', country: 'GB' });
    const gst = await api(env, 'POST', '/v1/tax_rates', { display_name: 'GST', percentage: 10, inclusive: 'true' });
    assert.match(vat.body.id, /^txr_/);
    const imm = await api(env, 'POST', `/v1/tax_rates/${vat.body.id}`, { percentage: 5 });
    assert.equal(imm.status, 400, 'percentage is immutable');
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus, amount: 10000, currency: 'usd', description: 'Consulting', tax_rates: [vat.body.id] });
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus, amount: 1100, currency: 'usd', description: 'Book', tax_rates: [gst.body.id] });
    const inv = await api(env, 'POST', '/v1/invoices', { customer: cus, pending_invoice_items_behavior: 'include' });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    assert.equal(inv.body.subtotal, 11100);
    assert.equal(inv.body.tax, 2000 + 100);
    assert.equal(inv.body.total, 13100, 'exclusive VAT is added; inclusive GST is already in the price');
    assert.equal(inv.body.total_excluding_tax, 11000);
    assert.equal(inv.body.total_tax_amounts.length, 2);
    const book = inv.body.lines.data.find((l: any) => l.description === 'Book');
    assert.deepEqual(book.tax_amounts.map((t: any) => [t.amount, t.inclusive, t.taxable_amount]), [[100, true, 1000]]);
    const fin = await api(env, 'POST', `/v1/invoices/${inv.body.id}/finalize`);
    assert.match(fin.body.invoice_pdf, /\/invoices\/pdf\/in_/);
    const pdf = await fetch(fin.body.invoice_pdf.replace(/^https?:\/\/[^/]+/, env.base));
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal((await pdf.text()).slice(0, 5), '%PDF-');
  });

  it('automatic tax: registrations, location, product tax codes and exemptions', async () => {
    const digital = await api(env, 'POST', '/v1/products', { name: 'App', default_price_data: { currency: 'usd', unit_amount: 10000, tax_behavior: 'exclusive' } });
    const physical = await api(env, 'POST', '/v1/products', { name: 'Mug', tax_code: 'txcd_99999999', default_price_data: { currency: 'usd', unit_amount: 10000, tax_behavior: 'exclusive' } });
    const invoiceFor = async (address: any, product: any, extra: any = {}) => {
      const cus = (await api(env, 'POST', '/v1/customers', { email: 'auto@example.com', address, ...extra })).body.id;
      await api(env, 'POST', '/v1/invoiceitems', { customer: cus, price: product.body.default_price });
      return (await api(env, 'POST', '/v1/invoices', { customer: cus, pending_invoice_items_behavior: 'include', automatic_tax: { enabled: 'true' } })).body;
    };
    const ny = { country: 'US', state: 'NY', postal_code: '10001', line1: '1 Main St', city: 'New York' };
    let inv = await invoiceFor(ny, digital);
    assert.equal(inv.automatic_tax.status, 'complete');
    assert.equal(inv.tax, 0, 'not registered in New York yet');
    const reg = await api(env, 'POST', '/v1/tax/registrations', { country: 'US', country_options: { us: { state: 'NY', type: 'state_sales_tax' } }, active_from: 'now' });
    assert.equal(reg.body.status, 'active');
    await api(env, 'POST', '/v1/tax/registrations', { country: 'US', country_options: { us: { state: 'CA', type: 'state_sales_tax' } } });
    inv = await invoiceFor(ny, digital);
    assert.equal(inv.tax, 400, 'New York 4%');
    assert.equal(inv.total, 10400);
    const rate = await api(env, 'GET', `/v1/tax_rates/${inv.total_tax_amounts[0].tax_rate}`);
    assert.equal(rate.body.jurisdiction, 'New York');
    const ca = { country: 'US', state: 'CA', postal_code: '94103' };
    assert.equal((await invoiceFor(ca, digital)).tax, 0, 'California does not tax digital services');
    assert.equal((await invoiceFor(ca, physical)).tax, 725, 'physical goods are taxed at 7.25%');
    assert.equal((await invoiceFor(ca, physical, { tax_exempt: 'exempt' })).tax, 0);
    const nowhere = await invoiceFor(null, digital);
    assert.equal(nowhere.automatic_tax.status, 'requires_location_inputs');
    const fin = await api(env, 'POST', `/v1/invoices/${nowhere.id}/finalize`);
    assert.equal(fin.body.error.code, 'customer_tax_location_invalid');
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'noaddr@example.com' })).body.id;
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus, items: [{ price: (await api(env, 'POST', '/v1/prices', { product: digital.body.id, currency: 'usd', unit_amount: 500, recurring: { interval: 'month' } })).body.id }], automatic_tax: { enabled: 'true' } });
    assert.equal(sub.status, 400);
    assert.equal(sub.body.error.code, 'customer_tax_location_invalid');
  });

  it('tax calculations API: VAT, inclusive prices, reverse charge and transactions', async () => {
    await api(env, 'POST', '/v1/tax/registrations', { country: 'DE', country_options: { de: { type: 'standard' } } });
    const calc = await api(env, 'POST', '/v1/tax/calculations', {
      currency: 'eur', customer_details: { address: { country: 'DE', postal_code: '10115' }, address_source: 'billing' },
      line_items: [{ amount: 10000, reference: 'sku-1' }, { amount: 11900, reference: 'sku-2', tax_behavior: 'inclusive' }],
    });
    assert.equal(calc.status, 200, JSON.stringify(calc.body));
    assert.equal(calc.body.tax_amount_exclusive, 1900);
    assert.equal(calc.body.tax_amount_inclusive, 1900);
    assert.equal(calc.body.amount_total, 10000 + 1900 + 11900);
    assert.equal(calc.body.tax_breakdown[0].tax_rate_details.percentage_decimal, '19.0000');
    const items = await api(env, 'GET', `/v1/tax/calculations/${calc.body.id}/line_items`);
    assert.equal(items.body.data[1].tax_breakdown[0].jurisdiction.display_name, 'Germany');
    const rc = await api(env, 'POST', '/v1/tax/calculations', { currency: 'eur', customer_details: { address: { country: 'DE' }, taxability_override: 'reverse_charge' }, line_items: [{ amount: 5000 }] });
    assert.equal(rc.body.tax_amount_exclusive, 0);
    assert.equal(rc.body.tax_breakdown[0].taxability_reason, 'reverse_charge');
    const tx = await api(env, 'POST', '/v1/tax/transactions/create_from_calculation', { calculation: calc.body.id, reference: 'order_1' });
    assert.equal(tx.body.object, 'tax.transaction');
    const dup = await api(env, 'POST', '/v1/tax/transactions/create_from_calculation', { calculation: calc.body.id, reference: 'order_1' });
    assert.equal(dup.status, 400);
  });

  it('checkout with automatic tax charges the tax for the address the customer enters', async () => {
    const s = await api(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', success_url: 'https://example.com', automatic_tax: { enabled: 'true' },
      line_items: [{ quantity: 2, price_data: { currency: 'usd', unit_amount: 2500, tax_behavior: 'exclusive', product_data: { name: 'Tote bag', tax_code: 'txcd_99999999' } } }],
    });
    assert.equal(s.body.automatic_tax.status, 'requires_location_inputs');
    assert.equal(s.body.billing_address_collection, 'required');
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 12, exp_year: 2034, cvc: '123' } }, {}, env.pk);
    const early = await hosted('POST', `/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'tote@example.com' });
    assert.equal(early.status, 400, 'an address is needed first');
    const view = await hosted('POST', `/checkout/${s.body.id}/address`, { address: { country: 'US', state: 'CA', postal_code: '94103' } });
    assert.equal(view.body.amount_tax, 363);
    assert.equal(view.body.amount_total, 5363);
    const pm2 = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 12, exp_year: 2034, cvc: '123' } }, {}, env.pk);
    const paid = await hosted('POST', `/checkout/${s.body.id}/pay`, { payment_method: pm2.body.id, email: 'tote@example.com' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const done = await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`, { expand: ['payment_intent'] });
    assert.equal(done.body.payment_intent.amount, 5363);
    assert.equal(done.body.total_details.amount_tax, 363);
  });
});

describe('quotes', () => {
  it('one-time quote: totals with coupon and tax, finalize, PDF, accept into a paid-ready invoice', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'buyer@example.com', name: 'Grace Hopper', address: { country: 'US', state: 'NY', line1: '1 Main St', city: 'New York', postal_code: '10001' } })).body.id;
    const product = await api(env, 'POST', '/v1/products', { name: 'Implementation', default_price_data: { currency: 'usd', unit_amount: 50000 } });
    const coupon = await api(env, 'POST', '/v1/coupons', { percent_off: 10, duration: 'once' });
    const rate = await api(env, 'POST', '/v1/tax_rates', { display_name: 'Sales tax', percentage: 8, inclusive: 'false' });
    const q = await api(env, 'POST', '/v1/quotes', { customer: cus, line_items: [{ price: product.body.default_price, quantity: 2 }], discounts: [{ coupon: coupon.body.id }], default_tax_rates: [rate.body.id], header: 'Onboarding package', expires_at: Math.floor(Date.now() / 1000) + 7 * 86400 });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.status, 'draft');
    assert.equal(q.body.amount_subtotal, 100000);
    assert.equal(q.body.total_details.amount_discount, 10000);
    assert.equal(q.body.total_details.amount_tax, 7200);
    assert.equal(q.body.amount_total, 97200);
    const draftPdf = await fetch(`${env.base}/v1/quotes/${q.body.id}/pdf`, { headers: { authorization: `Bearer ${env.sk}` } });
    assert.equal(draftPdf.status, 400);
    const fin = await api(env, 'POST', `/v1/quotes/${q.body.id}/finalize`);
    assert.equal(fin.body.status, 'open');
    assert.match(fin.body.number, /^QT-/);
    const upd = await api(env, 'POST', `/v1/quotes/${q.body.id}`, { description: 'x' });
    assert.equal(upd.status, 400);
    const pdf = await fetch(`${env.base}/v1/quotes/${q.body.id}/pdf`, { headers: { authorization: `Bearer ${env.sk}` } });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    assert.ok(bytes.startsWith('%PDF-1.4') && bytes.includes('Onboarding package') && bytes.trimEnd().endsWith('%%EOF'));
    const items = await api(env, 'GET', `/v1/quotes/${q.body.id}/line_items`);
    assert.equal(items.body.data[0].amount_total, 97200);
    const acc = await api(env, 'POST', `/v1/quotes/${q.body.id}/accept`);
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.status, 'accepted');
    const inv = await api(env, 'GET', `/v1/invoices/${acc.body.invoice}`);
    assert.equal(inv.body.status, 'open');
    assert.equal(inv.body.total, 97200, 'the invoice matches the quote');
  });

  it('recurring quote with trial: upfront excludes the trial period; acceptance starts the subscription', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'sub@example.com', payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } })).body;
    const plan = await api(env, 'POST', '/v1/products', { name: 'Team plan', default_price_data: { currency: 'usd', unit_amount: 9900, recurring: { interval: 'month' } } });
    const setup = await api(env, 'POST', '/v1/products', { name: 'Setup fee', default_price_data: { currency: 'usd', unit_amount: 20000 } });
    const q = await api(env, 'POST', '/v1/quotes', { customer: cus.id, line_items: [{ price: plan.body.default_price, quantity: 3 }, { price: setup.body.default_price }], subscription_data: { trial_period_days: 14 } });
    assert.equal(q.body.computed.recurring.amount_total, 29700);
    assert.equal(q.body.computed.recurring.interval, 'month');
    assert.equal(q.body.amount_total, 20000, 'only the setup fee is due upfront during the trial');
    const upfront = await api(env, 'GET', `/v1/quotes/${q.body.id}/computed_upfront_line_items`);
    assert.equal(upfront.body.data.length, 1);
    await api(env, 'POST', `/v1/quotes/${q.body.id}/finalize`);
    const acc = await api(env, 'POST', `/v1/quotes/${q.body.id}/accept`);
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const sub = await api(env, 'GET', `/v1/subscriptions/${acc.body.subscription}`);
    assert.equal(sub.body.status, 'trialing');
    assert.equal(sub.body.items.data[0].quantity, 3);
    const c2 = await api(env, 'POST', '/v1/quotes', { customer: cus.id, line_items: [{ price: setup.body.default_price }] });
    assert.equal((await api(env, 'POST', `/v1/quotes/${c2.body.id}/cancel`)).body.status, 'canceled');
    assert.equal((await api(env, 'POST', `/v1/quotes/${c2.body.id}/accept`)).status, 400);
  });
});

describe('customer portal', () => {
  it('sessions open a hosted portal limited by the configuration', async () => {
    const basic = await api(env, 'POST', '/v1/products', { name: 'Basic', default_price_data: { currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } } });
    const pro = await api(env, 'POST', '/v1/prices', { product: basic.body.id, currency: 'usd', unit_amount: 3000, recurring: { interval: 'month' } });
    const cfg = await api(env, 'POST', '/v1/billing_portal/configurations', {
      business_profile: { headline: 'Manage your plan' },
      features: { subscription_update: { enabled: 'true', proration_behavior: 'create_prorations', products: [{ product: basic.body.id, prices: [basic.body.default_price, pro.body.id] }] }, subscription_cancel: { enabled: 'true', mode: 'at_period_end' } },
    });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'portal@example.com', payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } })).body;
    const sub = await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: basic.body.default_price }] });
    assert.equal(sub.body.status, 'active');
    const noReturn = await api(env, 'POST', '/v1/billing_portal/sessions', { customer: cus.id, configuration: cfg.body.id });
    assert.equal(noReturn.status, 400);
    const sess = await api(env, 'POST', '/v1/billing_portal/sessions', { customer: cus.id, configuration: cfg.body.id, return_url: 'https://example.com/account' });
    assert.equal(sess.body.object, 'billing_portal.session');
    const token = sess.body.url.split('/').pop();
    const view = await hosted('GET', `/portal/${token}`);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.business.headline, 'Manage your plan');
    assert.equal(view.body.subscriptions[0].items[0].name, 'Basic');
    assert.equal(view.body.plans.length, 2);
    assert.equal(view.body.invoices.length, 1);

    const preview = await hosted('POST', `/portal/${token}/preview`, { subscription: sub.body.id, price: pro.body.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.prorations > 0);
    const still = await api(env, 'GET', `/v1/subscriptions/${sub.body.id}`);
    assert.equal(still.body.items.data[0].price.id, basic.body.default_price, 'the preview was rolled back');
    const up = await hosted('POST', `/portal/${token}/update`, { subscription: sub.body.id, price: pro.body.id });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal((await api(env, 'GET', `/v1/subscriptions/${sub.body.id}`)).body.items.data[0].price.id, pro.body.id);

    const cancel = await hosted('POST', `/portal/${token}/cancel`, { subscription: sub.body.id, reason: 'too_expensive' });
    assert.equal(cancel.body.cancel_at_period_end, true);
    assert.equal(cancel.body.cancellation_details.feedback, 'too_expensive');
    const renew = await hosted('POST', `/portal/${token}/renew`, { subscription: sub.body.id });
    assert.equal(renew.body.cancel_at_period_end, false);
    const card = await hosted('POST', `/portal/${token}/setup_card`, {});
    assert.match(card.body.client_secret, /^seti_.*_secret_/);
    const upd = await hosted('POST', `/portal/${token}/customer`, { name: 'Portal User', email: 'new@example.com' });
    assert.equal(upd.body.name, 'Portal User');

    const locked = await api(env, 'POST', '/v1/billing_portal/configurations', { features: { customer_update: { enabled: 'false' }, subscription_cancel: { enabled: 'false' } } });
    const s2 = await api(env, 'POST', '/v1/billing_portal/sessions', { customer: cus.id, configuration: locked.body.id, return_url: 'https://example.com' });
    const t2 = s2.body.url.split('/').pop();
    assert.equal((await hosted('POST', `/portal/${t2}/cancel`, { subscription: sub.body.id })).status, 403);
    assert.equal((await hosted('POST', `/portal/${t2}/customer`, { name: 'x' })).status, 403);
    const other = (await api(env, 'POST', '/v1/customers', { email: 'other@example.com' })).body.id;
    const otherSub = await hosted('POST', `/portal/${token}/renew`, { subscription: other });
    assert.equal(otherSub.status, 404);
  });
});
