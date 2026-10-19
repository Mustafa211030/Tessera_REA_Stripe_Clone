import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await start();
  setConfig({ taxIdVerifySeconds: 0 });
});
after(async () => { await env.close(); });

const DAY = 86400;
const DE = { line1: 'Unter den Linden 1', city: 'Berlin', postal_code: '10117', country: 'DE' };

describe('tax IDs', () => {
  it('validates formats, verifies asynchronously and lists per customer', async () => {
    const bad = await api(env, 'POST', '/v1/customers', { email: 'b@example.com', tax_id_data: [{ type: 'eu_vat', value: 'DE12' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'tax_id_invalid');
    assert.equal(bad.body.error.param, 'tax_id_data[0][value]');
    const cus = await api(env, 'POST', '/v1/customers', { name: 'Berlin GmbH', email: 'b@example.de', address: DE, tax_id_data: [{ type: 'eu_vat', value: 'de 123 456 789' }] });
    assert.equal(cus.status, 200, JSON.stringify(cus.body));
    const list = await api(env, 'GET', `/v1/customers/${cus.body.id}/tax_ids`);
    assert.equal(list.body.data.length, 1);
    const t = list.body.data[0];
    assert.deepEqual([t.type, t.value, t.country, t.verification.status], ['eu_vat', 'DE123456789', 'DE', 'pending']);
    await runWorkersOnce();
    const v = await api(env, 'GET', `/v1/customers/${cus.body.id}/tax_ids/${t.id}`);
    assert.equal(v.body.verification.status, 'verified');
    assert.equal(v.body.verification.verified_name, 'BERLIN GMBH');

    const un = await api(env, 'POST', `/v1/customers/${cus.body.id}/tax_ids`, { type: 'eu_vat', value: 'FRAB111111111' });
    assert.equal(un.status, 200, JSON.stringify(un.body));
    const ein = await api(env, 'POST', `/v1/customers/${cus.body.id}/tax_ids`, { type: 'us_ein', value: '12-3456789' });
    assert.equal(ein.body.verification.status, 'unavailable');
    await runWorkersOnce();
    assert.equal((await api(env, 'GET', `/v1/tax_ids/${un.body.id}`)).body.verification.status, 'unverified');
    const wrongPrefix = await api(env, 'POST', `/v1/customers/${cus.body.id}/tax_ids`, { type: 'eu_vat', value: 'US123456789' });
    assert.equal(wrongPrefix.status, 400);
    const del = await api(env, 'DELETE', `/v1/customers/${cus.body.id}/tax_ids/${ein.body.id}`);
    assert.deepEqual(del.body, { id: ein.body.id, object: 'tax_id', deleted: true });
    const self = await api(env, 'POST', '/v1/tax_ids', { type: 'gb_vat', value: 'GB123456789', owner: { type: 'self' } });
    assert.equal(self.body.owner.type, 'self');
    assert.equal(self.body.customer, null);
    const own = await api(env, 'GET', '/v1/tax_ids', { owner: { type: 'self' } });
    assert.deepEqual(own.body.data.map((x: any) => x.id), [self.body.id]);
  });

  it('reverse-charges EU business customers with a VAT number', async () => {
    await api(env, 'POST', '/v1/tax/registrations', { country: 'DE', country_options: { de: { type: 'standard' } } });
    const mk = async (taxIds: any[]) => {
      const c = (await api(env, 'POST', '/v1/customers', { name: 'Kunde', email: `k${Math.random()}@example.de`, address: DE, ...(taxIds.length ? { tax_id_data: taxIds } : {}) })).body;
      await runWorkersOnce();
      await api(env, 'POST', '/v1/invoiceitems', { customer: c.id, amount: 10000, currency: 'eur', description: 'Consulting' });
      const inv = (await api(env, 'POST', '/v1/invoices', { customer: c.id, pending_invoice_items_behavior: 'include', automatic_tax: { enabled: 'true' }, collection_method: 'send_invoice', days_until_due: 30 })).body;
      return (await api(env, 'POST', `/v1/invoices/${inv.id}/finalize`)).body;
    };
    const b2c = await mk([]);
    assert.equal(b2c.tax, 1900);
    const b2b = await mk([{ type: 'eu_vat', value: 'DE987654321' }]);
    assert.equal(b2b.tax, 0);
    assert.equal(b2b.total, 10000);
    assert.equal(b2b.total_tax_amounts[0].taxability_reason, 'reverse_charge');
    assert.deepEqual(b2b.customer_tax_ids, [{ type: 'eu_vat', value: 'DE987654321' }]);
    const unverified = await mk([{ type: 'eu_vat', value: 'DE111111111' }]);
    assert.equal(unverified.tax, 1900, 'an unverified number is charged VAT');

    const calc = await api(env, 'POST', '/v1/tax/calculations', { currency: 'eur', customer_details: { address: { country: 'DE' }, tax_ids: [{ type: 'eu_vat', value: 'DE123456789' }] }, line_items: [{ amount: 5000 }] });
    assert.equal(calc.body.tax_amount_exclusive, 0);
    assert.equal(calc.body.tax_breakdown[0].taxability_reason, 'reverse_charge');
    const pdf = await fetch(b2b.invoice_pdf);
    assert.equal(pdf.status, 200);
  });
});

describe('invoice payment plans', () => {
  it('splits an invoice into installments and pays them one at a time', async () => {
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'plan@example.com' })).body;
    await api(env, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 30000, currency: 'usd', description: 'Kitchen fit-out' });
    const charged = (await api(env, 'POST', '/v1/invoices', { customer: cus.id, pending_invoice_items_behavior: 'exclude' })).body;
    const notSend = await api(env, 'POST', `/v1/invoices/${charged.id}`, { amounts_due: [{ amount: 100, days_until_due: 0 }, { amount: 100, days_until_due: 30 }] });
    assert.equal(notSend.status, 400);

    const inv = await api(env, 'POST', '/v1/invoices', {
      customer: cus.id, pending_invoice_items_behavior: 'include', collection_method: 'send_invoice', days_until_due: 60,
      amounts_due: [{ amount: 10000, days_until_due: 0, description: 'Deposit' }, { amount: 10000, days_until_due: 30 }, { amount: 9000, days_until_due: 60 }],
    });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    const mismatch = await api(env, 'POST', `/v1/invoices/${inv.body.id}/finalize`);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'invoice_amounts_due_mismatch');
    await api(env, 'POST', `/v1/invoices/${inv.body.id}`, { amounts_due: [{ amount: 10000, days_until_due: 0, description: 'Deposit' }, { amount: 10000, days_until_due: 30 }, { amount: 10000, days_until_due: 60 }] });
    const fin = (await api(env, 'POST', `/v1/invoices/${inv.body.id}/finalize`)).body;
    assert.equal(fin.amounts_due.length, 3);
    assert.equal(fin.amounts_due[0].description, 'Deposit');
    assert.equal(fin.amounts_due[1].due_date - fin.amounts_due[0].due_date, 30 * DAY);
    assert.equal(fin.due_date, fin.amounts_due[2].due_date);

    await runWorkersOnce(); // the deposit is due now → invoice.overdue
    const overdue = await api(env, 'GET', '/v1/events', { type: 'invoice.overdue' });
    assert.ok(overdue.body.data.some((e: any) => e.data.object.id === fin.id));

    const p1 = await api(env, 'POST', `/v1/tessera/invoices/${fin.id}/pay_installment`, { payment_method: 'pm_card_visa' });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.body.status, 'open');
    assert.equal(p1.body.amount_paid, 10000);
    assert.equal(p1.body.amount_remaining, 20000);
    assert.equal(p1.body.amounts_due[0].status, 'paid');
    const declined = await api(env, 'POST', `/v1/tessera/invoices/${fin.id}/pay_installment`, { payment_method: 'pm_card_chargeDeclined' });
    assert.equal(declined.status, 402);
    await api(env, 'POST', `/v1/tessera/invoices/${fin.id}/pay_installment`, { payment_method: 'pm_card_visa' });
    const rest = await api(env, 'POST', `/v1/invoices/${fin.id}/pay`, { payment_method: 'pm_card_visa' });
    assert.equal(rest.body.status, 'paid');
    assert.equal(rest.body.amount_paid, 30000);
    assert.ok(rest.body.amounts_due.every((a: any) => a.status === 'paid'));
    const pis = await api(env, 'GET', '/v1/payment_intents', { customer: cus.id, limit: 10 });
    assert.deepEqual(pis.body.data.filter((p: any) => p.status === 'succeeded').map((p: any) => p.amount).sort(), [10000, 10000, 10000]);

    const hosted = await (await fetch(`${env.base}/hosted-api/invoices/${fin.id}`)).json() as any;
    assert.equal(hosted.amounts_due.length, 3);
  });
});

describe('pause collection', () => {
  it('keeps renewal invoices as drafts, marks them uncollectible, and resumes on schedule', async () => {
    const T0 = Date.UTC(2026, 2, 1) / 1000;
    const clock = (await api(env, 'POST', '/v1/test_helpers/test_clocks', { frozen_time: T0 })).body;
    const cus = (await api(env, 'POST', '/v1/customers', { email: 'pause@example.com', test_clock: clock.id })).body;
    const pm = await api(env, 'POST', '/v1/payment_methods/pm_card_visa/attach', { customer: cus.id });
    await api(env, 'POST', `/v1/customers/${cus.id}`, { invoice_settings: { default_payment_method: pm.body.id } });
    const prod = (await api(env, 'POST', '/v1/products', { name: 'Box', default_price_data: { currency: 'usd', unit_amount: 2000, recurring: { interval: 'month' } } })).body;
    const sub = (await api(env, 'POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: prod.default_price }] })).body;
    const bad = await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: 'sleep' } });
    assert.equal(bad.status, 400);
    const paused = await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: 'keep_as_draft' } });
    assert.deepEqual(paused.body.pause_collection, { behavior: 'keep_as_draft', resumes_at: null });
    assert.equal(paused.body.status, 'active');

    await api(env, 'POST', `/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: T0 + 32 * DAY });
    let s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    let inv = (await api(env, 'GET', `/v1/invoices/${s.latest_invoice}`)).body;
    assert.equal(inv.status, 'draft');
    assert.equal(s.status, 'active');

    const resumesAt = T0 + 75 * DAY;
    await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: 'mark_uncollectible', resumes_at: resumesAt } });
    await api(env, 'POST', `/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: T0 + 62 * DAY });
    s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    inv = (await api(env, 'GET', `/v1/invoices/${s.latest_invoice}`)).body;
    assert.equal(inv.status, 'uncollectible');

    await api(env, 'POST', `/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: T0 + 93 * DAY });
    s = (await api(env, 'GET', `/v1/subscriptions/${sub.id}`)).body;
    assert.equal(s.pause_collection, null);
    inv = (await api(env, 'GET', `/v1/invoices/${s.latest_invoice}`)).body;
    assert.equal(inv.status, 'paid');

    await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: 'void' } });
    const resumed = await api(env, 'POST', `/v1/subscriptions/${sub.id}`, { pause_collection: '' });
    assert.equal(resumed.body.pause_collection, null);
  });
});

describe('checkout custom fields, consent and tax IDs', () => {
  it('collects fields and consent, and reverse-charges a business VAT number', async () => {
    const s = await api(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', success_url: 'http://example.com/ok', automatic_tax: { enabled: 'true' }, tax_id_collection: { enabled: 'true' },
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 10000, product_data: { name: 'Espresso machine' } } }],
      custom_fields: [
        { key: 'engraving', label: { type: 'custom', custom: 'Engraving text' }, type: 'text', text: { maximum_length: 20 } },
        { key: 'color', label: { type: 'custom', custom: 'Color' }, type: 'dropdown', dropdown: { options: [{ label: 'Steel', value: 'steel' }, { label: 'Copper', value: 'copper' }] } },
        { key: 'ref', label: { type: 'custom', custom: 'PO number' }, type: 'numeric', optional: 'true' },
      ],
      consent_collection: { terms_of_service: 'required', promotions: 'auto' },
      custom_text: { submit: { message: 'We ship within 2 days.' } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.custom_fields.length, 3);
    const tooMany = await api(env, 'POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'http://e.com', line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 100, product_data: { name: 'x' } } }], custom_fields: [1, 2, 3, 4].map((i) => ({ key: `k${i}`, label: { type: 'custom', custom: 'L' }, type: 'text' })) });
    assert.equal(tooMany.status, 400);

    const H = (path: string, body?: any) => fetch(`${env.base}/hosted-api/checkout/${s.body.id}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(async (r) => ({ status: r.status, body: await r.json() as any }));
    let view = (await H('')).body;
    assert.equal(view.custom_fields[1].options.length, 2);
    assert.equal(view.consent_collection.terms_of_service, 'required');
    await H('/address', { address: { country: 'DE', postal_code: '10117' } });
    view = (await H('')).body;
    assert.equal(view.amount_tax, 1900);
    const badVat = await H('/tax_id', { type: 'eu_vat', value: 'DE1' });
    assert.equal(badVat.status, 400);
    view = (await H('/tax_id', { type: 'eu_vat', value: 'DE123456789' })).body;
    assert.equal(view.amount_tax, 0);
    assert.equal(view.reverse_charge, true);
    assert.equal(view.amount_total, 10000);

    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4242424242424242', exp_month: 1, exp_year: 2035, cvc: '314' } }, {}, view.publishable_key);
    const noTerms = await H('/pay', { payment_method: pm.body.id, email: 'buyer@example.de', custom_fields: { engraving: 'Hi', color: 'steel' } });
    assert.equal(noTerms.status, 400);
    assert.equal(noTerms.body.error.code, 'terms_of_service_required');
    const missingField = await H('/pay', { payment_method: pm.body.id, email: 'buyer@example.de', custom_fields: { color: 'steel' }, consent: { terms_of_service: true } });
    assert.equal(missingField.body.error.code, 'custom_field_missing');
    const badOption = await H('/pay', { payment_method: pm.body.id, email: 'buyer@example.de', custom_fields: { engraving: 'Hi', color: 'gold' }, consent: { terms_of_service: true } });
    assert.equal(badOption.status, 400);
    const paid = await H('/pay', { payment_method: pm.body.id, email: 'buyer@example.de', name: 'Anna', custom_fields: { engraving: 'For Anna', color: 'copper', ref: '4500' }, consent: { terms_of_service: true, promotions: true } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'succeeded');

    const done = (await api(env, 'GET', `/v1/checkout/sessions/${s.body.id}`)).body;
    assert.equal(done.status, 'complete');
    assert.equal(done.amount_total, 10000);
    assert.equal(done.custom_fields.find((f: any) => f.key === 'engraving').text.value, 'For Anna');
    assert.equal(done.custom_fields.find((f: any) => f.key === 'color').dropdown.value, 'copper');
    assert.equal(done.custom_fields.find((f: any) => f.key === 'ref').numeric.value, '4500');
    assert.deepEqual(done.consent, { promotions: 'opt_in', terms_of_service: 'accepted' });
    assert.deepEqual(done.customer_details.tax_ids, [{ type: 'eu_vat', value: 'DE123456789' }]);
    assert.ok(done.customer);
    const ids = await api(env, 'GET', `/v1/customers/${done.customer}/tax_ids`);
    assert.equal(ids.body.data[0].value, 'DE123456789');

    const price = (await api(env, 'POST', '/v1/prices', { currency: 'usd', unit_amount: 1500, product_data: { name: 'Sticker' } })).body;
    const link = await api(env, 'POST', '/v1/payment_links', { line_items: [{ price: price.id, quantity: 1 }], custom_fields: [{ key: 'nickname', label: { type: 'custom', custom: 'Nickname' }, type: 'text' }], consent_collection: { terms_of_service: 'required' } });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body.custom_fields[0].key, 'nickname');
    const ls = await fetch(link.body.url, { redirect: 'manual' });
    const sid = /\/pay\/(cs_test_[A-Za-z0-9]+)/.exec(ls.headers.get('location') ?? '')?.[1];
    assert.ok(sid, 'payment link redirects to a session');
    const lsv = (await api(env, 'GET', `/v1/checkout/sessions/${sid}`)).body;
    assert.equal(lsv.custom_fields[0].label.custom, 'Nickname');
    assert.equal(lsv.consent_collection.terms_of_service, 'required');
  });
});

describe('search', () => {
  it('supports exact, substring, numeric, metadata, negation, OR and pagination', async () => {
    const tag = `t${Date.now()}`;
    const c1 = (await api(env, 'POST', '/v1/customers', { email: `ana.${tag}@example.com`, name: 'Ana Search', metadata: { tier: 'gold', tag } })).body;
    const c2 = (await api(env, 'POST', '/v1/customers', { email: `bo.${tag}@example.com`, name: 'Bo Search', metadata: { tier: 'silver', tag } })).body;
    for (const amount of [1500, 2500, 9900]) await api(env, 'POST', '/v1/payment_intents', { amount, currency: 'usd', customer: c1.id, payment_method: 'pm_card_visa', confirm: 'true', metadata: { tag } });
    const S = (res: string, query: string, extra: any = {}) => api(env, 'GET', `/v1/${res}/search`, { query, ...extra });

    const exact = await S('customers', `email:"ana.${tag}@example.com"`);
    assert.deepEqual(exact.body.data.map((c: any) => c.id), [c1.id]);
    assert.equal(exact.body.object, 'search_result');
    const sub = await S('customers', `email~"${tag}"`);
    assert.equal(sub.body.data.length, 2);
    const meta = await S('customers', `metadata["tag"]:"${tag}" AND -metadata["tier"]:"gold"`);
    assert.deepEqual(meta.body.data.map((c: any) => c.id), [c2.id]);
    const or = await S('customers', `name:"Ana Search" OR name:"Bo Search"`);
    assert.ok(or.body.data.length >= 2);

    const big = await S('charges', `metadata["tag"]:"${tag}" AND amount>2000`);
    assert.deepEqual(big.body.data.map((c: any) => c.amount).sort(), [2500, 9900]);
    const brand = await S('charges', `payment_method_details.card.brand:"visa" AND customer:"${c1.id}" AND status:"succeeded"`);
    assert.equal(brand.body.data.length, 3);
    const pis = await S('payment_intents', `customer:"${c1.id}" AND amount<=2500`, { 'expand[]': 'total_count' });
    assert.equal(pis.body.total_count, 2);

    const p1 = await S('charges', `metadata["tag"]:"${tag}"`, { limit: 2 });
    assert.equal(p1.body.data.length, 2);
    assert.equal(p1.body.has_more, true);
    const p2 = await S('charges', `metadata["tag"]:"${tag}"`, { limit: 2, page: p1.body.next_page });
    assert.equal(p2.body.data.length, 1);
    assert.equal(p2.body.has_more, false);
    assert.equal(p2.body.next_page, null);

    for (const q of ['color:"red"', 'amount>"x"', 'email:"a" AND name:"b" OR name:"c"', 'name~"ab"', 'name:unquoted', 'AND email:"x"', 'email:"x" AND']) {
      const r = await S(q.startsWith('amount') ? 'charges' : 'customers', q);
      assert.equal(r.status, 400, `${q} should be rejected`);
    }
    const nulls = await S('customers', `customer:null`).catch(() => null);
    void nulls;
    const noPhone = await S('customers', `phone:null AND email~"${tag}"`);
    assert.equal(noPhone.body.data.length, 2);
  });
});
