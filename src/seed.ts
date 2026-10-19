import { config } from './config.ts';
import { closeDb, one, openDb, query, transaction } from './db/index.ts';
import { createAccount } from './domain/accounts.ts';
import { accountCtx, addExternalAccount, connectedCtx, createConnectedAccount, loadAccount, upgradeAccounts } from './domain/connect/accounts.ts';
import { createPerson } from './domain/connect/persons.ts';
import { createRegistration } from './domain/tax.ts';
import { closeVault, openVault } from './vault/vault.ts';
import { join } from 'node:path';

/**
 * Creates a demo account (demo@tessera.local / tessera-demo) if it does not exist yet,
 * plus two connected accounts so the Connect pages have something to show.
 */
await openDb(join(config.dataDir, 'pg'));
await openVault(join(config.dataDir, 'vault'));
await upgradeAccounts();
const email = 'demo@tessera.local';
const existing = await one<{ account_id: string }>('SELECT account_id FROM users WHERE email = $1', [email]);
let accountId = existing?.account_id;
if (existing) {
  console.log(`Demo account already exists: ${email}`);
} else {
  const r = await createAccount(email, 'tessera-demo', 'Demo Coffee Co.');
  accountId = r.account.id;
  console.log(`Created demo account\n  email:    ${email}\n  password: tessera-demo\n  secret:   ${r.secretKey}\n  publish:  ${r.publishableKey}`);
}
if (!(await one('SELECT 1 FROM accounts WHERE platform = $1', [accountId]))) {
  const ctx = accountCtx(accountId!);
  await transaction(async () => {
    await createConnectedAccount(ctx, {
      type: 'custom', country: 'US', email: 'roaster@example.com', business_type: 'individual',
      capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
      business_profile: { name: 'Hilltop Roasters', mcc: '5499', url: 'https://hilltop.example.com' },
      individual: { first_name: 'Jenny', last_name: 'Rosen', email: 'roaster@example.com', phone: '+15555550100', dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000', address: { line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103' } },
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' },
      external_account: 'btok_us_verified',
      settings: { payouts: { schedule: { interval: 'manual' } } },
    });
    await createConnectedAccount(ctx, {
      type: 'express', country: 'US', email: 'barista@example.com',
      business_profile: { name: 'Morning Pour Cart' },
      capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
    });
  });
  console.log('Created connected accounts: Hilltop Roasters (custom, enabled) and Morning Pour Cart (express, needs onboarding)');
}
if (!(await one("SELECT 1 FROM accounts WHERE platform = $1 AND data->>'business_type' = 'company'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  await transaction(async () => {
    const co = await createConnectedAccount(ctx, {
      type: 'custom', country: 'US', email: 'studio@example.com', business_type: 'company',
      capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
      business_profile: { name: 'Tidewater Ceramics', mcc: '5970', url: 'https://tidewater.example.com' },
      company: { name: 'Tidewater Ceramics LLC', tax_id: '000000000', phone: '+15555550100', address: { line1: '1 Harbor Way', city: 'Oakland', state: 'CA', postal_code: '94607' } },
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' },
      external_account: 'btok_us_verified',
      settings: { payouts: { schedule: { interval: 'manual' } } },
    });
    // Representative added; the second owner and the owners confirmation are left for the demo.
    await createPerson(ctx, co.id, {
      first_name: 'Maya', last_name: 'Ortiz', email: 'maya@example.com', phone: '+15555550111', dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
      address: { line1: '1 Harbor Way', city: 'Oakland', state: 'CA', postal_code: '94607' },
      relationship: { representative: 'true', executive: 'true', owner: 'true', percent_ownership: '60', title: 'Founder' },
    });
    const hill = await one<{ id: string }>("SELECT id FROM accounts WHERE platform = $1 AND data->>'email' = 'roaster@example.com'", [accountId]);
    if (hill) {
      const acct = await loadAccount(hill.id);
      if (!acct.external_accounts.data.some((x: any) => x.object === 'card')) await addExternalAccount(connectedCtx(ctx, hill.id), acct, 'tok_visa_debit');
    }
  });
  console.log('Created connected account: Tidewater Ceramics (company, needs owners) and a debit card for Instant Payouts on Hilltop Roasters');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'tax.registration'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  await transaction(async () => {
    for (const state of ['CA', 'NY']) await createRegistration(ctx, { country: 'US', country_options: { us: { state, type: 'state_sales_tax' } }, active_from: 'now' });
  });
  console.log('Added tax registrations: US-CA and US-NY (automatic tax collects there)');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'billing.meter'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  const { createMeter } = await import('./domain/billing/meters.ts');
  const { createCoupon } = await import('./domain/billing/catalog.ts');
  const { createPromotionCode } = await import('./domain/billing/promotions.ts');
  await transaction(async () => {
    await createMeter(ctx, { display_name: 'API requests', event_name: 'api_requests', default_aggregation: { formula: 'sum' } });
    const coupon = await createCoupon(ctx, { id: 'WELCOME10', name: 'Welcome 10%', percent_off: '10', duration: 'once' });
    await createPromotionCode(ctx, { promotion: { type: 'coupon', coupon: coupon.id }, code: 'WELCOME10' });
  });
  console.log('Added a usage meter (api_requests) and the promotion code WELCOME10');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'shipping_rate'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  const { createShippingRate } = await import('./domain/shipping.ts');
  await transaction(async () => {
    await createShippingRate(ctx, { display_name: 'Standard', fixed_amount: { amount: '500', currency: 'usd' }, tax_behavior: 'exclusive', delivery_estimate: { minimum: { unit: 'business_day', value: '3' }, maximum: { unit: 'business_day', value: '5' } } });
    await createShippingRate(ctx, { display_name: 'Express', fixed_amount: { amount: '1500', currency: 'usd' }, tax_behavior: 'exclusive', delivery_estimate: { minimum: { unit: 'business_day', value: '1' }, maximum: { unit: 'business_day', value: '2' } } });
  });
  console.log('Added shipping rates: Standard ($5) and Express ($15)');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'terminal.location'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  const terminal = await import('./domain/terminal.ts');
  const issuing = await import('./domain/issuing.ts');
  await transaction(async () => {
    const loc = await terminal.createLocation(ctx, { display_name: 'Demo Coffee Co. - Market St', address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105', country: 'US' } });
    await terminal.registerReader(ctx, { registration_code: 'simulated-wpe', location: loc.id, label: 'Front counter' });
    await issuing.createTopup(ctx, { amount: '100000', currency: 'usd', destination_balance: 'issuing', description: 'Initial Issuing funds' });
    const ch = await issuing.createCardholder(ctx, { name: 'Jenny Rosen', email: 'jenny@example.com', type: 'individual', billing: { address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105', country: 'US' } } });
    await issuing.createCard(ctx, { cardholder: ch.id, currency: 'usd', type: 'virtual', status: 'active', spending_controls: { spending_limits: [{ amount: '50000', interval: 'monthly' }] } });
  });
  console.log('Added a Terminal location with a simulated reader, and an Issuing card with $1,000 of funds');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'treasury.financial_account'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  const treasury = await import('./domain/treasury.ts');
  await transaction(async () => {
    const fa = await treasury.createFinancialAccount(ctx, { supported_currencies: ['usd'], nickname: 'Operating account' });
    await treasury.receivedCredit(ctx, { financial_account: fa.id, amount: 250000, network: 'ach', description: 'Opening deposit' });
  });
  console.log('Added a Treasury financial account with $2,500');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'capital.financing_offer'", [accountId]))) {
  const ctx = accountCtx(accountId!);
  const capital = await import('./domain/capital.ts');
  const hill = await one<{ id: string }>("SELECT id FROM accounts WHERE platform = $1 AND data->>'email' = 'roaster@example.com'", [accountId]);
  if (hill) {
    await transaction(async () => {
      const o = await capital.createTestOffer({ ...ctx, accountId: hill.id, platformAccountId: accountId! }, { advance_amount: 750000, fee_amount: 75000, withhold_rate: '0.12' });
      await capital.markDelivered(ctx, o.id);
    });
    console.log('Added a $7,500 Capital financing offer for Hilltop Roasters (delivered, ready to accept)');
  }
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'customer' AND data->>'email' = 'orders@northwind.example'", [accountId]))) {
  // Revenue recognition demo: an annual and a monthly plan that started four months ago.
  const ctx = accountCtx(accountId!);
  const clocks = await import('./domain/billing/clocks.ts');
  const catalog = await import('./domain/billing/catalog.ts');
  const subs = await import('./domain/billing/subscriptions.ts');
  const { createCustomer } = await import('./domain/customers.ts');
  const { attachPaymentMethod } = await import('./domain/paymentMethods.ts');
  await transaction(async () => {
    const start = Math.floor(Date.now() / 1000) - 120 * 86400;
    const clock = await clocks.createClock(ctx, { frozen_time: start, name: 'Northwind (revenue demo)' });
    const cus = await createCustomer(ctx, { name: 'Northwind Cafe', email: 'orders@northwind.example', test_clock: clock.id });
    const pm = await attachPaymentMethod(ctx, 'pm_card_visa', { customer: cus.id });
    const annual = await catalog.createProduct(ctx, { name: 'Wholesale membership (annual)', default_price_data: { currency: 'usd', unit_amount: 240000, recurring: { interval: 'year' } } });
    const monthly = await catalog.createProduct(ctx, { name: 'Bean subscription (monthly)', default_price_data: { currency: 'usd', unit_amount: 4900, recurring: { interval: 'month' } } });
    await subs.createSubscription(ctx, { customer: cus.id, default_payment_method: pm.id, items: [{ price: annual.default_price }] });
    await subs.createSubscription(ctx, { customer: cus.id, default_payment_method: pm.id, items: [{ price: monthly.default_price }] });
    const c = await clocks.setClockTime(ctx, clock.id, { frozen_time: Math.floor(Date.now() / 1000) - 60 });
    await subs.runBilling(ctx, c.id, c.frozen_time);
  });
  console.log('Added Northwind Cafe with annual and monthly plans (four months of revenue recognition history)');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'customer' AND data->>'email' = 'einkauf@berlin-roastery.example'", [accountId]))) {
  // B2B demo: an EU business with a VAT number (reverse charge) paying an invoice in installments.
  const ctx = accountCtx(accountId!);
  const { createCustomer } = await import('./domain/customers.ts');
  const invoices = await import('./domain/billing/invoices.ts');
  const { createRegistration } = await import('./domain/tax.ts');
  const { getObject } = await import('./domain/store.ts');
  await transaction(async () => {
    if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'tax.registration' AND data->>'country' = 'DE'", [accountId]))) {
      await createRegistration(ctx, { country: 'DE', country_options: { de: { type: 'standard' } }, active_from: 'now' });
    }
    const cus = await createCustomer(ctx, {
      name: 'Berlin Roastery GmbH', email: 'einkauf@berlin-roastery.example', address: { line1: 'Kastanienallee 12', city: 'Berlin', postal_code: '10435', country: 'DE' },
      tax_id_data: [{ type: 'eu_vat', value: 'DE123456789' }],
    });
    await invoices.createInvoiceItem(ctx, { customer: cus.id, amount: '360000', currency: 'eur', description: 'Commercial roaster installation' });
    const inv = await invoices.createInvoice(ctx, {
      customer: cus.id, pending_invoice_items_behavior: 'include', collection_method: 'send_invoice', days_until_due: 60, automatic_tax: { enabled: 'true' },
      amounts_due: [{ amount: '120000', days_until_due: '0', description: 'Deposit' }, { amount: '120000', days_until_due: '30' }, { amount: '120000', days_until_due: '60' }],
    });
    await invoices.finalizeInvoice(ctx, await getObject(ctx.accountId, 'invoice', inv.id));
  });
  console.log('Added Berlin Roastery GmbH (EU VAT, reverse charge) with a three-part payment plan invoice');
}
if (!(await one("SELECT 1 FROM users WHERE email = 'support@tessera.local'"))) {
  // Team demo: two more people with other roles (same password as the demo owner).
  const { hashPassword } = await import('./domain/accounts.ts');
  const { audit } = await import('./domain/team.ts');
  const { newId, nowSeconds } = await import('./lib/ids.ts');
  await transaction(async () => {
    for (const [email, role, name] of [['support@tessera.local', 'support', 'Sam Support'], ['analyst@tessera.local', 'analyst', 'Ana Analyst']] as const) {
      await query('INSERT INTO users (id, email, password_hash, account_id, created, role, name) VALUES ($1,$2,$3,$4,$5,$6,$7)', [newId('usr', 16), email, hashPassword('tessera-demo'), accountId, nowSeconds(), role, name]);
      await audit(accountId!, { email: 'demo@tessera.local' }, 'team.member_joined', email, { role });
    }
    const { createSchedule } = await import('./domain/scheduledReports.ts');
    await createSchedule(accountCtx(accountId!), { kind: 'sql', name: 'Weekly gross volume', interval: 'weekly', sql: "SELECT date_trunc('week', created)::date AS week, count(*) AS payments, sum(amount) / 100.0 AS gross FROM charges WHERE status = 'succeeded' GROUP BY 1 ORDER BY 1 DESC" });
  });
  console.log('Added team members support@tessera.local (Support) and analyst@tessera.local (Analyst), password tessera-demo, and a weekly scheduled SQL report');
}
if (!(await one("SELECT 1 FROM oneclick_profiles WHERE email = 'jenny.rosen@example.com'"))) {
  // Payment methods: everything on, plus one example payment for each new method and a one-click profile.
  const ctx = accountCtx(accountId!);
  const { getConfig, updateConfig } = await import('./domain/paymentMethodConfigs.ts');
  const { createPaymentIntent, confirmPaymentIntent } = await import('./domain/paymentIntents.ts');
  const { createPaymentMethod } = await import('./domain/paymentMethods.ts');
  const { saveCard } = await import('./domain/oneclick.ts');
  const { decide } = await import('./domain/quartet.ts');
  const { createCustomer } = await import('./domain/customers.ts');
  await transaction(async () => {
    const cfg = await getConfig(ctx);
    await updateConfig(ctx, cfg.id, { us_bank_account: { display_preference: { preference: 'on' } }, quartet: { display_preference: { preference: 'on' } } });
    const cus = await createCustomer(ctx, { name: 'Dana Debit', email: 'dana.debit@example.com', preferred_locales: ['en'] });
    const bank = await createPaymentIntent(ctx, { amount: '18900', currency: 'usd', customer: cus.id, payment_method_types: ['us_bank_account'], description: 'Espresso grinder (ACH)' });
    const bankPm = await createPaymentMethod(ctx, { type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: '000123456789' }, billing_details: { name: 'Dana Debit', email: 'dana.debit@example.com' } });
    (bankPm as any)._verified = true;
    await (await import('./domain/store.ts')).saveObject(ctx.accountId, bankPm);
    await confirmPaymentIntent(ctx, bank.id, { payment_method: bankPm.id, mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'seed' } } } });
    const bnpl = await createPaymentIntent(ctx, { amount: '32000', currency: 'usd', payment_method_types: ['quartet'], description: 'Pour-over kit (Pay in 4)' });
    const q = await confirmPaymentIntent(ctx, bnpl.id, { payment_method_data: { type: 'quartet', billing_details: { name: 'Quinn Quartet', email: 'quinn@example.com' } }, return_url: 'http://localhost:4242/payments' });
    await decide(q.id, q.client_secret, true, 'http://localhost:4242');
    const wallet = await createPaymentMethod(ctx, { type: 'card', card: { token: 'tok_wallet_visa' }, billing_details: { name: 'Wally Wallet', email: 'wally@example.com' } });
    await createPaymentIntent(ctx, { amount: '1250', currency: 'usd', payment_method: wallet.id, confirm: 'true', description: 'Latte (device wallet)' });
    const card = await createPaymentMethod(ctx, { type: 'card', card: { token: 'tok_visa' }, billing_details: { name: 'Jenny Rosen', email: 'jenny.rosen@example.com' } });
    await saveCard(ctx, card.id, 'jenny.rosen@example.com', 'Jenny Rosen');
  });
  console.log('Turned on ACH Direct Debit and Pay in 4; added an ACH payment, a Pay in 4 payment, a device wallet payment, and a one-click profile for jenny.rosen@example.com (code 000000 in test mode)');
}
if (!(await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'entitlements.feature'", [accountId]))) {
  // Billing depth: smart retries, features on the plans (entitlements), and billing credits.
  const ctx = accountCtx(accountId!);
  const retries = await import('./domain/billing/retries.ts');
  const ent = await import('./domain/entitlements.ts');
  const credits = await import('./domain/billing/credits.ts');
  await transaction(async () => {
    await retries.updateSettings(ctx, { retry: { mode: 'smart', max_attempts: 8, window_days: 14 }, after_failure: { subscription: 'unpaid', invoice: 'open' } });
    const products = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'product'", [accountId]);
    const byName = (n: string) => products.find((r) => r.data.name === n)?.data;
    const wholesale = await ent.createFeature(ctx, { name: 'Wholesale pricing', lookup_key: 'wholesale-pricing' });
    const beans = await ent.createFeature(ctx, { name: 'Monthly bean delivery', lookup_key: 'bean-delivery' });
    const support = await ent.createFeature(ctx, { name: 'Priority support', lookup_key: 'priority-support' });
    const annual = byName('Wholesale membership (annual)'), monthly = byName('Bean subscription (monthly)');
    if (annual) { await ent.attachFeature(ctx, annual.id, { entitlement_feature: wholesale.id }); await ent.attachFeature(ctx, annual.id, { entitlement_feature: support.id }); }
    if (monthly) await ent.attachFeature(ctx, monthly.id, { entitlement_feature: beans.id });
    const cus = (await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'customer' AND data->>'email' = 'orders@northwind.example'", [accountId]))?.data;
    if (cus) {
      await credits.createGrant(ctx, { customer: cus.id, name: 'Welcome credit', category: 'promotional', priority: 10, amount: { type: 'monetary', monetary: { currency: 'usd', value: 2500 } }, applicability_config: { scope: { price_type: 'metered' } } });
      await credits.createGrant(ctx, { customer: cus.id, name: 'Prepaid roasting hours', category: 'paid', amount: { type: 'monetary', monetary: { currency: 'usd', value: 20000 } }, applicability_config: { scope: { price_type: 'metered' } } });
    }
  });
  console.log('Turned on smart retries (unpaid after the last retry); added features wholesale-pricing, bean-delivery and priority-support to the plans, and $225 of billing credits for Northwind Cafe');
}
await closeDb();
await closeVault();
