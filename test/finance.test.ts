import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); setConfig({ identityProcessingSeconds: 0 }); });
after(async () => { await env.close(); });

const hosted = async (method: string, path: string, body?: any) => {
  const r = await fetch(`${env.base}/hosted-api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
};
async function payingCustomer(email = `f${Math.random()}@example.com`) {
  const c = (await api(env, 'POST', '/v1/customers', { email, name: 'Finn' })).body;
  const pm = await api(env, 'POST', '/v1/payment_methods/pm_card_visa/attach', { customer: c.id });
  await api(env, 'POST', `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: pm.body.id } });
  return c;
}
async function paidInvoice(customer: string, items: [number, number][] = [[2000, 1]]) {
  for (const [amount, qty] of items) {
    const prod = (await api(env, 'POST', '/v1/products', { name: `Item ${amount}` })).body;
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: amount })).body;
    await api(env, 'POST', '/v1/invoiceitems', { customer, price: price.id, quantity: qty });
  }
  const inv = (await api(env, 'POST', '/v1/invoices', { customer, pending_invoice_items_behavior: 'include' })).body;
  const paid = await api(env, 'POST', `/v1/invoices/${inv.id}/pay`);
  assert.equal(paid.body.status, 'paid', JSON.stringify(paid.body));
  return paid.body;
}

describe('customer balance', () => {
  it('applies credit to the next invoice and records every change', async () => {
    const c = await payingCustomer();
    const adj = await api(env, 'POST', `/v1/customers/${c.id}/balance_transactions`, { amount: -1500, currency: 'usd', description: 'Goodwill credit' });
    assert.equal(adj.status, 200, JSON.stringify(adj.body));
    assert.equal(adj.body.type, 'adjustment');
    assert.equal(adj.body.ending_balance, -1500);
    const cus = (await api(env, 'GET', `/v1/customers/${c.id}`)).body;
    assert.equal(cus.balance, -1500);
    assert.equal(cus.currency, 'usd');
    const wrong = await api(env, 'POST', `/v1/customers/${c.id}/balance_transactions`, { amount: 100, currency: 'eur' });
    assert.equal(wrong.status, 400);

    const inv = await paidInvoice(c.id, [[1000, 1]]);
    assert.equal(inv.starting_balance, -1500);
    assert.equal(inv.ending_balance, -500);
    assert.equal(inv.amount_due, 0, 'fully covered by credit');
    assert.equal(inv.amount_paid, 0);
    const inv2 = await paidInvoice(c.id, [[2000, 1]]);
    assert.equal(inv2.starting_balance, -500);
    assert.equal(inv2.amount_paid, 1500);
    assert.equal((await api(env, 'GET', `/v1/customers/${c.id}`)).body.balance, 0);
    const txns = await api(env, 'GET', `/v1/customers/${c.id}/balance_transactions`);
    assert.deepEqual(txns.body.data.map((t: any) => t.type), ['applied_to_invoice', 'applied_to_invoice', 'adjustment']);
    const upd = await api(env, 'POST', `/v1/customers/${c.id}/balance_transactions/${adj.body.id}`, { description: 'Sorry for the outage' });
    assert.equal(upd.body.description, 'Sorry for the outage');
  });

  it('collects a positive balance (amount owed) and gives credit back when an invoice is voided', async () => {
    const c = await payingCustomer();
    await api(env, 'POST', `/v1/customers/${c.id}/balance_transactions`, { amount: 700, currency: 'usd', description: 'Unpaid setup fee' });
    const inv = await paidInvoice(c.id, [[1000, 1]]);
    assert.equal(inv.amount_paid, 1700);
    await api(env, 'POST', `/v1/customers/${c.id}/balance_transactions`, { amount: -400, currency: 'usd' });
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Thing' })).body;
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1000 })).body;
    await api(env, 'POST', '/v1/invoiceitems', { customer: c.id, price: price.id });
    const draft = (await api(env, 'POST', '/v1/invoices', { customer: c.id, pending_invoice_items_behavior: 'include', collection_method: 'send_invoice', days_until_due: 30 })).body;
    const open = (await api(env, 'POST', `/v1/invoices/${draft.id}/finalize`)).body;
    assert.equal(open.amount_due, 600);
    assert.equal((await api(env, 'GET', `/v1/customers/${c.id}`)).body.balance, 0);
    await api(env, 'POST', `/v1/invoices/${draft.id}/void`);
    assert.equal((await api(env, 'GET', `/v1/customers/${c.id}`)).body.balance, -400, 'voiding returns the credit');
  });
});

describe('credit notes', () => {
  it('lowers the amount due of an open invoice, and voids back', async () => {
    const c = await payingCustomer();
    for (const amount of [3000, 1000]) {
      const prod = (await api(env, 'POST', '/v1/products', { name: `P${amount}` })).body;
      const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: amount })).body;
      await api(env, 'POST', '/v1/invoiceitems', { customer: c.id, price: price.id, quantity: 2 });
    }
    const draft = (await api(env, 'POST', '/v1/invoices', { customer: c.id, pending_invoice_items_behavior: 'include', collection_method: 'send_invoice', days_until_due: 14 })).body;
    const inv = (await api(env, 'POST', `/v1/invoices/${draft.id}/finalize`)).body;
    assert.equal(inv.amount_due, 8000);
    const line = inv.lines.data.find((l: any) => l.amount === 6000);
    const preview = await api(env, 'GET', '/v1/credit_notes/preview', { invoice: inv.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line.id, quantity: 1 }] });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.total, 3000);
    const cn = await api(env, 'POST', '/v1/credit_notes', { invoice: inv.id, reason: 'order_change', memo: 'One unit was not delivered', lines: [{ type: 'invoice_line_item', invoice_line_item: line.id, quantity: 1 }] });
    assert.equal(cn.status, 200, JSON.stringify(cn.body));
    assert.equal(cn.body.type, 'pre_payment');
    assert.equal(cn.body.number, `${inv.number}-CN-01`);
    assert.match(cn.body.pdf, /\/credit_notes\/pdf\//);
    let fresh = (await api(env, 'GET', `/v1/invoices/${inv.id}`)).body;
    assert.equal(fresh.amount_due, 5000);
    assert.equal(fresh.pre_payment_credit_notes_amount, 3000);
    const tooMuch = await api(env, 'POST', '/v1/credit_notes', { invoice: inv.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line.id, amount: 3500 }] });
    assert.equal(tooMuch.status, 400, 'cannot credit more than is left on the line');
    const pdf = await fetch(cn.body.pdf);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal((await api(env, 'POST', `/v1/credit_notes/${cn.body.id}/void`)).body.status, 'void');
    fresh = (await api(env, 'GET', `/v1/invoices/${inv.id}`)).body;
    assert.equal(fresh.amount_due, 8000);
    // Crediting everything left marks the invoice paid.
    await api(env, 'POST', '/v1/credit_notes', { invoice: inv.id, amount: 8000 });
    assert.equal((await api(env, 'GET', `/v1/invoices/${inv.id}`)).body.status, 'paid');
  });

  it('refunds and credits a paid invoice, including tax', async () => {
    const c = await payingCustomer();
    const rate = (await api(env, 'POST', '/v1/tax_rates', { display_name: 'VAT', percentage: 20, inclusive: 'false' })).body;
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Course' })).body;
    const price = (await api(env, 'POST', '/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 5000 })).body;
    await api(env, 'POST', '/v1/invoiceitems', { customer: c.id, price: price.id, tax_rates: [rate.id] });
    const draft = (await api(env, 'POST', '/v1/invoices', { customer: c.id, pending_invoice_items_behavior: 'include' })).body;
    const inv = (await api(env, 'POST', `/v1/invoices/${draft.id}/pay`)).body;
    assert.equal(inv.amount_paid, 6000);
    const line = inv.lines.data[0];
    const mismatch = await api(env, 'POST', '/v1/credit_notes', { invoice: inv.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line.id }], refund_amount: 1000 });
    assert.equal(mismatch.status, 400, 'split must add up');
    const cn = await api(env, 'POST', '/v1/credit_notes', { invoice: inv.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line.id, amount: 2500 }], refund_amount: 2000, credit_amount: 1000, expand: ['refunds.refund'] });
    assert.equal(cn.status, 200, JSON.stringify(cn.body));
    assert.equal(cn.body.subtotal, 2500);
    assert.equal(cn.body.tax_amounts[0].amount, 500);
    assert.equal(cn.body.total, 3000);
    assert.equal(cn.body.type, 'post_payment');
    assert.equal(cn.body.refunds[0].amount_refunded, 2000);
    const pi = (await api(env, 'GET', `/v1/payment_intents/${inv.payment_intent}`, { expand: ['latest_charge'] })).body;
    assert.equal(pi.latest_charge.amount_refunded, 2000);
    assert.equal((await api(env, 'GET', `/v1/customers/${c.id}`)).body.balance, -1000);
    const noVoid = await api(env, 'POST', `/v1/credit_notes/${cn.body.id}/void`);
    assert.equal(noVoid.status, 400, 'refunds cannot be undone');
    const credit = await api(env, 'POST', '/v1/credit_notes', { invoice: inv.id, lines: [{ type: 'custom_line_item', description: 'Goodwill', unit_amount: 500, quantity: 1 }] });
    assert.equal(credit.body.total, 500);
    assert.equal((await api(env, 'GET', `/v1/customers/${c.id}`)).body.balance, -1500, 'unspecified split goes to the balance');
    await api(env, 'POST', `/v1/credit_notes/${credit.body.id}/void`);
    assert.equal((await api(env, 'GET', `/v1/customers/${c.id}`)).body.balance, -1000);
    const list = await api(env, 'GET', '/v1/credit_notes', { invoice: inv.id });
    assert.equal(list.body.data.length, 2);
    const draftInv = (await api(env, 'POST', '/v1/invoices', { customer: c.id })).body;
    assert.equal((await api(env, 'POST', '/v1/credit_notes', { invoice: draftInv.id, amount: 100 })).status, 400, 'no credit notes on drafts');
  });
});

describe('shipping', () => {
  it('charges a chosen shipping rate at checkout and taxes it where shipping is taxable', async () => {
    const standard = await api(env, 'POST', '/v1/shipping_rates', { display_name: 'Standard', fixed_amount: { amount: 500, currency: 'usd' }, delivery_estimate: { minimum: { unit: 'business_day', value: 3 }, maximum: { unit: 'business_day', value: 5 } }, tax_behavior: 'exclusive' });
    assert.equal(standard.status, 200, JSON.stringify(standard.body));
    assert.equal(standard.body.tax_code, 'txcd_92010001');
    const s = await api(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', success_url: 'https://example.com/ok', automatic_tax: { enabled: 'true' },
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      shipping_options: [{ shipping_rate: standard.body.id }, { shipping_rate_data: { display_name: 'Express', fixed_amount: { amount: 1500, currency: 'usd' }, tax_behavior: 'exclusive' } }],
      line_items: [{ price_data: { currency: 'usd', unit_amount: 10000, tax_behavior: 'exclusive', product_data: { name: 'Lamp', tax_code: 'txcd_99999999' } }, quantity: 1 }],
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.shipping_cost.shipping_rate, standard.body.id);
    assert.equal(s.body.total_details.amount_shipping, 500);
    await api(env, 'POST', '/v1/tax/registrations', { country: 'US', country_options: { us: { state: 'NY', type: 'state_sales_tax' } }, active_from: 'now' });
    await api(env, 'POST', '/v1/tax/registrations', { country: 'US', country_options: { us: { state: 'CA', type: 'state_sales_tax' } }, active_from: 'now' });
    const bad = await hosted('POST', `/checkout/${s.body.id}/shipping`, { name: 'Ana', address: { line1: '1 Rue', city: 'Paris', country: 'FR' } });
    assert.equal(bad.status, 400);
    const ny = await hosted('POST', `/checkout/${s.body.id}/shipping`, { name: 'Ana', address: { line1: '1 Main St', city: 'New York', state: 'NY', postal_code: '10001', country: 'US' }, shipping_rate: s.body.shipping_options[1].shipping_rate });
    assert.equal(ny.status, 200, JSON.stringify(ny.body));
    const afterNy = (await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`)).body;
    assert.equal(afterNy.total_details.amount_shipping, 1500);
    assert.ok(afterNy.shipping_cost.amount_tax > 0, 'NY taxes shipping');
    assert.equal(afterNy.amount_total, 10000 + 1500 + afterNy.total_details.amount_tax);
    await hosted('POST', `/checkout/${s.body.id}/shipping`, { address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105', country: 'US' } });
    const ca = (await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`)).body;
    assert.equal(ca.shipping_cost.amount_tax, 0, 'CA does not tax separately stated shipping');
    assert.ok(ca.total_details.amount_tax > 0);
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_visa' } });
    const paid = await hosted('POST', `/checkout/${s.body.id}/pay`, { payment_method: pm.body.id, email: 'ana@example.com', name: 'Ana' });
    assert.equal(paid.body.status, 'succeeded', JSON.stringify(paid.body));
    const done = (await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`, { expand: ['payment_intent'] })).body;
    assert.equal(done.payment_intent.amount, ca.amount_total);
    assert.equal(done.payment_intent.shipping.address.state, 'CA');
    assert.equal(done.collected_information.shipping_details.name, 'Ana');
    const legacy = (await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`, undefined, { 'Stripe-Version': '2024-06-20' })).body;
    assert.equal(legacy.shipping_details.address.city, 'San Francisco');
    const off = await api(env, 'POST', `/v1/shipping_rates/${standard.body.id}`, { active: 'false' });
    assert.equal(off.body.active, false);
  });
});

describe('identity', () => {
  it('verifies a document through the hosted page', async () => {
    const s = await api(env, 'POST', '/v1/identity/verification_sessions', { type: 'document', options: { document: { require_matching_selfie: 'true', allowed_types: ['passport', 'driving_license'] } }, provided_details: { email: 'id@example.com' }, return_url: 'https://example.com/done', metadata: { user: '42' } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.status, 'requires_input');
    assert.match(s.body.client_secret, /^vs_.+_secret_/);
    const token = s.body.url.split('/verify/')[1];
    const view = await hosted('GET', `/identity/${token}`);
    assert.deepEqual(view.body.allowed_types, ['passport', 'driving_license']);
    assert.ok(view.body.outcomes.some((o: any) => o.id === 'selfie_face_mismatch'));
    const fail = await hosted('POST', `/identity/${token}/submit`, { first_name: 'Jenny', last_name: 'Rosen', dob: { day: 1, month: 1, year: 1990 }, document_type: 'passport', outcome: 'selfie_face_mismatch' });
    assert.equal(fail.body.status, 'processing');
    await runWorkersOnce();
    let got = (await api(env, 'GET', `/v1/identity/verification_sessions/${s.body.id}`)).body;
    assert.equal(got.status, 'requires_input');
    assert.equal(got.last_error.code, 'selfie_face_mismatch');
    const report = (await api(env, 'GET', `/v1/identity/verification_reports/${got.last_verification_report}`)).body;
    assert.equal(report.selfie.status, 'unverified');
    assert.equal(report.document.status, 'verified');
    await hosted('POST', `/identity/${token}/submit`, { first_name: 'Jenny', last_name: 'Rosen', dob: { day: 1, month: 1, year: 1990 }, document_type: 'passport', outcome: 'verified' });
    await runWorkersOnce();
    got = (await api(env, 'GET', `/v1/identity/verification_sessions/${s.body.id}`)).body;
    assert.equal(got.status, 'verified');
    assert.equal(got.verified_outputs, null, 'only when expanded');
    const exp = (await api(env, 'GET', `/v1/identity/verification_sessions/${s.body.id}`, { expand: ['verified_outputs'] })).body;
    assert.equal(exp.verified_outputs.first_name, 'Jenny');
    assert.equal(exp.verified_outputs.email, 'id@example.com');
    const events = (await api(env, 'GET', '/v1/events', { limit: 20 })).body.data.map((e: any) => e.type);
    assert.ok(events.includes('identity.verification_session.verified'));
    assert.ok(events.includes('identity.verification_session.requires_input'));
    const red = await api(env, 'POST', `/v1/identity/verification_sessions/${s.body.id}/redact`, { expand: ['verified_outputs'] });
    assert.equal(red.body.redaction.status, 'redacted');
    assert.equal(red.body.verified_outputs.first_name, null);
    const reports = await api(env, 'GET', '/v1/identity/verification_reports', { verification_session: s.body.id });
    assert.equal(reports.body.data.length, 2);
    assert.equal(reports.body.data[0].document.first_name, null);
  });

  it('checks an ID number, and cancels', async () => {
    const s = (await api(env, 'POST', '/v1/identity/verification_sessions', { type: 'id_number' })).body;
    const token = s.url.split('/verify/')[1];
    const bad = await hosted('POST', `/identity/${token}/submit`, { first_name: 'A', last_name: 'B', dob: { day: 1, month: 1, year: 1990 }, outcome: 'verified' });
    assert.equal(bad.status, 400, 'needs an ID number');
    await hosted('POST', `/identity/${token}/submit`, { first_name: 'A', last_name: 'B', dob: { day: 1, month: 1, year: 1990 }, id_number: '000000000', outcome: 'id_number_mismatch' });
    await runWorkersOnce();
    const got = (await api(env, 'GET', `/v1/identity/verification_sessions/${s.id}`)).body;
    assert.equal(got.last_error.code, 'id_number_mismatch');
    const c = await api(env, 'POST', `/v1/identity/verification_sessions/${s.id}/cancel`);
    assert.equal(c.body.status, 'canceled');
    assert.equal((await hosted('POST', `/identity/${token}/submit`, { first_name: 'A', last_name: 'B', dob: { day: 1, month: 1, year: 1990 }, id_number: '000000000' })).status, 400);
  });
});
