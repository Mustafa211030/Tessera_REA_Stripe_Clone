import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Stripe from 'stripe';
import { start, type Env } from './helpers.ts';

/** Compatibility check: the official Stripe Node SDK, pointed at this local server. */
let env: Env;
let client: Stripe;
before(async () => {
  env = await start();
  const port = Number(new URL(env.base).port);
  client = new Stripe(env.sk, { host: '127.0.0.1', port, protocol: 'http', maxNetworkRetries: 1, telemetry: false });
});
after(async () => { await env.close(); });

describe('official SDK compatibility', () => {
  it('customers, payment intents, refunds, lists and auto-pagination', async () => {
    const cus = await client.customers.create({ email: 'sdk@example.com', name: 'SDK User', metadata: { plan: 'pro' } });
    assert.match(cus.id, /^cus_/);
    const pm = await client.paymentMethods.attach('pm_card_visa', { customer: cus.id });
    assert.equal(pm.customer, cus.id);
    const pi = await client.paymentIntents.create({ amount: 4200, currency: 'usd', customer: cus.id, payment_method: pm.id, confirm: true, expand: ['latest_charge'] });
    assert.equal(pi.status, 'succeeded');
    const charge = pi.latest_charge as Stripe.Charge;
    assert.equal(charge.amount, 4200);
    const refund = await client.refunds.create({ payment_intent: pi.id, amount: 200 });
    assert.equal(refund.status, 'succeeded');
    const seen: string[] = [];
    for await (const c of client.charges.list({ limit: 1 })) seen.push(c.id);
    assert.ok(seen.includes(charge.id));
  });

  it('surfaces card errors as StripeCardError', async () => {
    await assert.rejects(
      client.paymentIntents.create({ amount: 1000, currency: 'usd', payment_method: 'pm_card_chargeDeclined', confirm: true }),
      (e: any) => e.type === 'StripeCardError' && e.code === 'card_declined' && e.decline_code === 'generic_decline',
    );
  });

  it('billing: products, prices, subscriptions and invoices', async () => {
    const product = await client.products.create({ name: 'Team plan', default_price_data: { currency: 'usd', unit_amount: 2900, recurring: { interval: 'month' } } });
    const cus = await client.customers.create({ email: 'team@example.com', payment_method: undefined });
    const pm = await client.paymentMethods.attach('pm_card_visa', { customer: cus.id });
    const sub = await client.subscriptions.create({ customer: cus.id, items: [{ price: product.default_price as string, quantity: 2 }], default_payment_method: pm.id, expand: ['latest_invoice'] });
    assert.equal(sub.status, 'active');
    assert.equal((sub.latest_invoice as Stripe.Invoice).amount_paid, 5800);
    const updated = await client.subscriptions.update(sub.id, { trial_end: 'now', cancel_at_period_end: true } as any);
    assert.equal(updated.cancel_at_period_end, true);
    const invoices = await client.invoices.list({ customer: cus.id });
    assert.ok(invoices.data.length >= 1);
    const canceled = await client.subscriptions.cancel(sub.id);
    assert.equal(canceled.status, 'canceled');
  });

  it('connect: accounts, destination charges, transfers and stripeAccount requests', async () => {
    const acct = await client.accounts.create({
      type: 'custom', country: 'US', email: 'seller@example.com', business_type: 'individual',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { mcc: '5734', url: 'https://seller.example.com' },
      individual: { first_name: 'Jenny', last_name: 'Rosen', email: 'jenny@example.com', phone: '+15555550100', dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000', address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105' } },
      tos_acceptance: { date: 1700000000, ip: '127.0.0.1' },
      external_account: 'btok_us_verified',
      settings: { payouts: { schedule: { interval: 'manual' } } },
    });
    assert.equal(acct.charges_enabled, true);
    const pi = await client.paymentIntents.create({ amount: 5000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true, application_fee_amount: 400, transfer_data: { destination: acct.id } });
    assert.equal(pi.status, 'succeeded');
    const transfers = await client.transfers.list({ destination: acct.id });
    assert.equal(transfers.data[0]!.amount, 5000);
    const fees = await client.applicationFees.list();
    assert.ok(fees.data.some((f) => f.amount === 400 && f.account === acct.id));
    const direct = await client.paymentIntents.create({ amount: 3000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true, application_fee_amount: 100 }, { stripeAccount: acct.id });
    assert.equal(direct.status, 'succeeded');
    const bal = await client.balance.retrieve({}, { stripeAccount: acct.id });
    assert.ok(bal.pending[0]!.amount > 0);
    const link = await client.accountLinks.create({ account: acct.id, type: 'account_update', refresh_url: 'https://example.com/r', return_url: 'https://example.com/ok' });
    assert.match(link.url, /\/connect\/onboarding\//);
    const list = await client.accounts.list({ limit: 3 });
    assert.ok(list.data.some((a) => a.id === acct.id));
  });

  it('setup intents, off-session payments, disputes and report runs', async () => {
    const cus = await client.customers.create({ email: 'saved@example.com' });
    const si = await client.setupIntents.create({ customer: cus.id, payment_method: 'pm_card_visa', confirm: true, usage: 'off_session' });
    assert.equal(si.status, 'succeeded');
    const pi = await client.paymentIntents.create({ amount: 1800, currency: 'usd', customer: cus.id, payment_method: si.payment_method as string, off_session: true, confirm: true });
    assert.equal(pi.status, 'succeeded');
    await assert.rejects(
      client.paymentIntents.create({ amount: 1800, currency: 'usd', customer: cus.id, payment_method: 'pm_card_authenticationRequired', off_session: true, confirm: true }),
      (e: any) => e.type === 'StripeCardError' && e.code === 'authentication_required' && e.raw.payment_intent.status === 'requires_payment_method',
    );
    const disputed = await client.paymentIntents.create({ amount: 2600, currency: 'usd', payment_method: 'pm_card_createDispute', confirm: true });
    const disputes = await client.disputes.list({ payment_intent: disputed.id });
    const dp = await client.disputes.update(disputes.data[0]!.id, { evidence: { uncategorized_text: 'winning_evidence' } });
    assert.equal(dp.status, 'under_review');
    const run = await client.reporting.reportRuns.create({ report_type: 'balance.summary.1', parameters: { interval_start: Math.floor(Date.now() / 1000) - 3600, interval_end: Math.floor(Date.now() / 1000) } });
    assert.equal(run.status, 'pending');
  });

  it('tax rates, quotes, portal sessions, tax calculations and exchange rates', async () => {
    const cus = await client.customers.create({ email: 'quote@example.com', name: 'Quote Buyer' });
    const product = await client.products.create({ name: 'Audit', default_price_data: { currency: 'usd', unit_amount: 12000 } });
    const rate = await client.taxRates.create({ display_name: 'VAT', percentage: 20, inclusive: false });
    const q = await client.quotes.create({ customer: cus.id, line_items: [{ price: product.default_price as string, quantity: 1 }], default_tax_rates: [rate.id] });
    assert.equal(q.amount_total, 14400);
    const fin = await client.quotes.finalizeQuote(q.id);
    assert.equal(fin.status, 'open');
    const acc = await client.quotes.accept(q.id);
    assert.equal(acc.status, 'accepted');
    const sess = await client.billingPortal.sessions.create({ customer: cus.id, return_url: 'https://example.com' });
    assert.match(sess.url, /\/portal\//);
    await client.tax.registrations.create({ country: 'GB', country_options: { gb: { type: 'standard' } }, active_from: 'now' });
    const calc = await client.tax.calculations.create({ currency: 'gbp', line_items: [{ amount: 1000, reference: 'a' }], customer_details: { address: { country: 'GB' }, address_source: 'billing' } });
    assert.equal(calc.tax_amount_exclusive, 200);
    const fx = await (client as any).exchangeRates.retrieve('usd');
    assert.equal(fx.rates.gbp, 0.79);
  });

  it('meters, tiered prices, promotion codes, payment links and schedules', async () => {
    const meter = await client.billing.meters.create({ display_name: 'Tokens', event_name: 'sdk_tokens', default_aggregation: { formula: 'sum' } });
    assert.equal(meter.status, 'active');
    const product = await client.products.create({ name: 'LLM' });
    const metered = await client.prices.create({ product: product.id, currency: 'usd', unit_amount: 1, recurring: { interval: 'month', usage_type: 'metered', meter: meter.id } });
    const tiered = await client.prices.create({ product: product.id, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'volume', tiers: [{ up_to: 5, unit_amount: 1000 }, { up_to: 'inf', unit_amount: 800 }], recurring: { interval: 'month' } });
    assert.equal(tiered.tiers?.length, 2);
    const cus = await client.customers.create({ email: 'meter@example.com' });
    await client.paymentMethods.attach('pm_card_visa', { customer: cus.id });
    const sub = await client.subscriptions.create({ customer: cus.id, items: [{ price: metered.id }, { price: tiered.id, quantity: 6 }], default_payment_method: (await client.paymentMethods.list({ customer: cus.id })).data[0]!.id });
    assert.equal(sub.status, 'active');
    const ev = await client.billing.meterEvents.create({ event_name: 'sdk_tokens', payload: { stripe_customer_id: cus.id, value: '1234' } });
    assert.equal(ev.event_name, 'sdk_tokens');
    const coupon = await client.coupons.create({ percent_off: 20, duration: 'once' });
    const promo = await client.promotionCodes.create({ promotion: { type: 'coupon', coupon: coupon.id }, code: 'SDK20' });
    assert.equal(promo.code, 'SDK20');
    assert.equal(promo.promotion.coupon, coupon.id);
    const link = await client.paymentLinks.create({ line_items: [{ price: tiered.id, quantity: 1 }], allow_promotion_codes: true });
    assert.match(link.url, /\/b\/test_/);
    const items = await client.paymentLinks.listLineItems(link.id);
    assert.equal(items.data[0]!.quantity, 1);
    const sched = await client.subscriptionSchedules.create({ customer: cus.id, start_date: Math.floor(Date.now() / 1000) + 86400, phases: [{ items: [{ price: tiered.id, quantity: 1 }], duration: { interval: 'month', interval_count: 2 } }] });
    assert.equal(sched.phases[0]!.end_date - sched.phases[0]!.start_date > 58 * 86400, true);
    assert.equal(sched.status, 'not_started');
    const rel = await client.subscriptionSchedules.cancel(sched.id);
    assert.equal(rel.status, 'canceled');
  });

  it('customer balance, credit notes, shipping rates and identity', async () => {
    const cus = await client.customers.create({ email: 'cn@example.com' });
    const pm = await client.paymentMethods.attach('pm_card_visa', { customer: cus.id });
    await client.customers.update(cus.id, { invoice_settings: { default_payment_method: pm.id } });
    const txn = await client.customers.createBalanceTransaction(cus.id, { amount: -300, currency: 'usd' });
    assert.equal(txn.ending_balance, -300);
    const list = await client.customers.listBalanceTransactions(cus.id);
    assert.equal(list.data.length, 1);
    const product = await client.products.create({ name: 'Widget', default_price_data: { currency: 'usd', unit_amount: 2000 } });
    await client.invoiceItems.create({ customer: cus.id, pricing: { price: product.default_price as string } });
    const inv = await client.invoices.create({ customer: cus.id, pending_invoice_items_behavior: 'include' });
    const paid = await client.invoices.pay(inv.id);
    assert.equal(paid.amount_paid, 1700);
    const preview = await client.creditNotes.preview({ invoice: inv.id, lines: [{ type: 'invoice_line_item', invoice_line_item: paid.lines.data[0]!.id, amount: 500 }], refund_amount: 500 });
    assert.equal(preview.total, 500);
    const cn = await client.creditNotes.create({ invoice: inv.id, lines: [{ type: 'invoice_line_item', invoice_line_item: paid.lines.data[0]!.id, amount: 500 }], refund_amount: 500, reason: 'product_unsatisfactory' });
    assert.equal(cn.status, 'issued');
    const rate = await client.shippingRates.create({ display_name: 'Ground', type: 'fixed_amount', fixed_amount: { amount: 700, currency: 'usd' } });
    assert.equal(rate.fixed_amount?.amount, 700);
    const vs = await client.identity.verificationSessions.create({ type: 'document' });
    assert.equal(vs.status, 'requires_input');
    const canceled = await client.identity.verificationSessions.cancel(vs.id);
    assert.equal(canceled.status, 'canceled');
  });

  it('terminal readers, issuing cards and authorizations, top-ups', async () => {
    const loc = await client.terminal.locations.create({ display_name: 'HQ', address: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001', country: 'US' } });
    const reader = await client.terminal.readers.create({ registration_code: 'simulated-s700', location: loc.id });
    const pi = await client.paymentIntents.create({ amount: 1200, currency: 'usd', allowed_payment_method_types: ['card_present'] });
    await client.terminal.readers.processPaymentIntent(reader.id, { payment_intent: pi.id });
    const done = await client.testHelpers.terminal.readers.presentPaymentMethod(reader.id);
    assert.equal(done.action?.status, 'succeeded');
    assert.equal((await client.paymentIntents.retrieve(pi.id)).status, 'succeeded');
    await client.topups.create({ amount: 5000, currency: 'usd', destination_balance: 'issuing' } as any);
    const ch = await client.issuing.cardholders.create({ name: 'Ada', type: 'individual', billing: { address: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001', country: 'US' } } });
    const card = await client.issuing.cards.create({ cardholder: ch.id, currency: 'usd', type: 'virtual', status: 'active' });
    const auth = await client.testHelpers.issuing.authorizations.create({ card: card.id, amount: 1000 });
    assert.equal(auth.approved, true);
    const cap = await client.testHelpers.issuing.authorizations.capture(auth.id);
    assert.equal(cap.status, 'closed');
    const txns = await client.issuing.transactions.list({ card: card.id });
    assert.equal(txns.data[0]!.amount, -1000);
  });

  it('treasury, issuing disputes and cash balances', async () => {
    const fa = await client.treasury.financialAccounts.create({ supported_currencies: ['usd'], features: { inbound_transfers: { ach: { requested: true } }, financial_addresses: { aba: { requested: true } } } });
    assert.equal(fa.status, 'open');
    const pm = await client.paymentMethods.create({ type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: '000123456789', account_holder_type: 'individual' }, billing_details: { name: 'Jenny Rosen' } });
    const ibt = await client.treasury.inboundTransfers.create({ financial_account: fa.id, amount: 1000, currency: 'usd', origin_payment_method: pm.id });
    const done = await client.testHelpers.treasury.inboundTransfers.succeed(ibt.id);
    assert.equal(done.status, 'succeeded');
    const back = await client.treasury.financialAccounts.retrieve(fa.id);
    assert.equal(back.balance.cash.usd, 1000);
    const cus = await client.customers.create({ email: 'cash@example.com' });
    const fi = await client.customers.createFundingInstructions(cus.id, { currency: 'usd', funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } });
    assert.equal(fi.bank_transfer.type, 'us_bank_transfer');
    await client.testHelpers.customers.fundCashBalance(cus.id, { amount: 2500, currency: 'usd' });
    const cb = await client.customers.retrieveCashBalance(cus.id);
    assert.equal(cb.available?.usd, 2500);
  });

  it('files, file links, persons and instant payouts', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa3c1e5a00000000049454e44ae426082', 'hex');
    const file = await client.files.create({ purpose: 'dispute_evidence', file: { data: png, name: 'receipt.png', type: 'application/octet-stream' } });
    assert.equal(file.type, 'png');
    assert.equal(file.size, png.length);
    const link = await client.fileLinks.create({ file: file.id });
    assert.equal(link.expired, false);
    assert.equal((await fetch(link.url!)).status, 200);
    const acct = await client.accounts.create({ type: 'custom', country: 'US', business_type: 'company', capabilities: { transfers: { requested: true } } });
    const person = await client.accounts.createPerson(acct.id, { first_name: 'Jenny', last_name: 'Rosen', relationship: { representative: true, title: 'CEO' } });
    assert.match(person.id, /^person_/);
    const persons = await client.accounts.listPersons(acct.id, { relationship: { representative: true } });
    assert.equal(persons.data[0]!.id, person.id);
    const card = await client.accounts.createExternalAccount(acct.id, { external_account: 'tok_visa_debit' });
    assert.equal(card.object, 'card');
    const del = await client.accounts.deletePerson(acct.id, person.id);
    assert.equal(del.deleted, true);
  });

  it('climate orders and financial connections', async () => {
    await client.paymentIntents.create({ amount: 100_000, currency: 'usd', payment_method: 'pm_card_bypassPending', confirm: true });
    const products = await client.climate.products.list();
    const order = await client.climate.orders.create({ product: products.data[0]!.id, metric_tons: '0.1' as any });
    assert.equal(order.status, 'open');
    const canceled = await client.climate.orders.cancel(order.id);
    assert.equal(canceled.status, 'canceled');
    const suppliers = await client.climate.suppliers.list();
    assert.ok(suppliers.data.length >= 1);
    const cus = await client.customers.create({ email: 'fc@example.com' });
    const session = await client.financialConnections.sessions.create({ account_holder: { type: 'customer', customer: cus.id }, permissions: ['balances', 'payment_method'] });
    assert.match(session.client_secret!, /_secret_/);
    const listed = await client.financialConnections.accounts.list({ session: session.id });
    assert.equal(listed.data.length, 0);
  });

  it('tax IDs, search and pause_collection', async () => {
    const cus = await client.customers.create({ email: 'sdk-search@example.com', name: 'Search Me', metadata: { plan: 'sdk-search' } });
    const tid = await client.customers.createTaxId(cus.id, { type: 'eu_vat', value: 'DE123456789' });
    assert.equal(tid.country, 'DE');
    const ids = await client.customers.listTaxIds(cus.id);
    assert.equal(ids.data.length, 1);
    const found = await client.customers.search({ query: 'metadata["plan"]:"sdk-search"' });
    assert.equal(found.data[0]!.id, cus.id);
    const auto: string[] = [];
    for await (const c of client.customers.search({ query: 'email~"sdk-search"', limit: 1 })) auto.push(c.id);
    assert.deepEqual(auto, [cus.id]);
    await client.paymentIntents.create({ amount: 4321, currency: 'usd', customer: cus.id, payment_method: 'pm_card_visa', confirm: true });
    const ch = await client.charges.search({ query: `customer:"${cus.id}" AND amount:4321` });
    assert.equal(ch.data.length, 1);
    await client.paymentMethods.attach('pm_card_visa', { customer: cus.id }).then((pm) => client.customers.update(cus.id, { invoice_settings: { default_payment_method: pm.id } }));
    const price = await client.prices.create({ currency: 'usd', unit_amount: 900, recurring: { interval: 'month' }, product_data: { name: 'SDK pause' } });
    const sub = await client.subscriptions.create({ customer: cus.id, items: [{ price: price.id }] });
    const paused = await client.subscriptions.update(sub.id, { pause_collection: { behavior: 'mark_uncollectible' } });
    assert.equal(paused.pause_collection?.behavior, 'mark_uncollectible');
    const resumed = await client.subscriptions.update(sub.id, { pause_collection: '' as any });
    assert.equal(resumed.pause_collection, null);
  });

  it('bank debits, microdeposits, mandates and payment method configurations', async () => {
    const cfgs = await client.paymentMethodConfigurations.list();
    assert.equal(cfgs.data[0]!.is_default, true);
    const pi = await client.paymentIntents.create({
      amount: 2500, currency: 'usd', payment_method_types: ['us_bank_account'], confirm: true,
      payment_method_data: { type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: '000123456789', account_holder_type: 'individual' }, billing_details: { name: 'SDK Bank' } },
      mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'sdk' } } },
    } as any);
    assert.equal(pi.next_action?.type, 'verify_with_microdeposits');
    const verified = await client.paymentIntents.verifyMicrodeposits(pi.id, { amounts: [32, 45] });
    assert.equal(verified.status, 'processing');
    const charge = await client.charges.retrieve(verified.latest_charge as string);
    const mandate = await client.mandates.retrieve(charge.payment_method_details!.us_bank_account!.mandate as string);
    assert.equal(mandate.status, 'active');
  });

  it('verifies our webhook signatures with the SDK helper', async () => {
    const { sign } = await import('../src/domain/webhooks.ts');
    const payload = JSON.stringify({ id: 'evt_test', object: 'event', type: 'ping' });
    const header = sign(payload, 'whsec_test_secret');
    const evt = client.webhooks.constructEvent(payload, header, 'whsec_test_secret');
    assert.equal(evt.id, 'evt_test');
  });
});
