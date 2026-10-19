import { query } from '../db/index.ts';
import { ApiError, CommitThenFail, invalid, missing } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { arr, bool, currency, int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { getAccount } from './accounts.ts';
import { intervalLabel } from './billing/invoices.ts';
import { discountAmount, licensedAmount, priceSummary } from './billing/catalog.ts';
import { createSubscription } from './billing/subscriptions.ts';
import { createCustomer } from './customers.ts';
import { emit } from './events.ts';
import { confirmPaymentIntent, createPaymentIntent, updatePaymentIntent } from './paymentIntents.ts';
import { priceLines, taxRateIds } from './tax.ts';
import { applyConnectParams, billingConnectParams } from './connect/transfers.ts';
import { attachPaymentMethod } from './paymentMethods.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';
import { onPaymentFailed, onPaymentSucceeded } from './hooks.ts';
import { convert, rate, RATES_PER_USD, ZERO_DECIMAL } from './fx.ts';

/** Languages the hosted payment page is translated into (`auto` follows the browser). */
export const LOCALES = ['auto', 'en', 'de', 'fr', 'es', 'ja'] as const;
/** Adaptive pricing: the customer pays this much over the reference rate when paying in their own currency. */
export const CONVERSION_MARKUP = 0.02;

/** Hosted payment page sessions: mode=payment (one-time) or mode=subscription. */
/** Options only Tessera itself sets (payment links), never read from API params. */
export type SessionInternal = { payment_link?: string; custom_message?: string | null; auto_redirect?: boolean; sub_extra?: Record<string, any> };

export async function createSession(ctx: Ctx, p: Params, internal: SessionInternal = {}) {
  const mode = oneOf(p, 'mode', ['payment', 'subscription', 'setup'] as const);
  if (!mode) throw missing('mode');
  const success_url = str(p, 'success_url', { required: !internal.payment_link }) ?? null;
  const items = arr(p, 'line_items') ?? [];
  if (mode === 'setup' && items.length) throw invalid('line_items cannot be used in setup mode.', 'line_items');
  if (mode !== 'setup' && !items.length) throw missing('line_items');
  let cur: string | undefined;
  const line_items: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    let qty = int(li, 'quantity', { min: 1 }) ?? 1;
    let price: any;
    let name: string;
    if (li.price) {
      price = await getObject<any>(ctx.accountId, 'price', String(li.price), 'price', `line_items[${i}][price]`);
      if (!price.active) throw invalid(`The price ${price.id} is not active.`, `line_items[${i}][price]`);
      name = (await findObject<any>(ctx.accountId, 'product', price.product))?.name ?? 'Item';
    } else if (li.price_data) {
      const pd = li.price_data;
      const unit = int(pd, 'unit_amount', { required: true, min: 0 })!;
      const c = currency(pd, 'currency')!;
      name = pd.product_data?.name ?? 'Item';
      price = { id: null, object: 'price', currency: c, unit_amount: unit, recurring: pd.recurring ? { interval: pd.recurring.interval, interval_count: Number(pd.recurring.interval_count ?? 1) } : null, tax_behavior: oneOf(pd, 'tax_behavior', ['inclusive', 'exclusive', 'unspecified'] as const, 'unspecified'), type: pd.recurring ? 'recurring' : 'one_time', product_data: { name, tax_code: pd.product_data?.tax_code ?? null } };
    } else throw invalid('Each line item needs a price or price_data.', `line_items[${i}]`);
    if (price.recurring?.usage_type === 'metered') {
      if (li.quantity !== undefined) throw invalid('Line items with metered prices cannot have a quantity.', `line_items[${i}][quantity]`);
      qty = 0;
    }
    if (mode === 'payment' && price.type === 'recurring') throw invalid('You must use mode=subscription for recurring prices.', `line_items[${i}][price]`);
    if (cur && price.currency !== cur) throw invalid('All line items must use the same currency.', `line_items[${i}]`);
    cur = price.currency;
    line_items.push({
      id: newId('li', 16),
      object: 'item',
      amount_subtotal: licensedAmount(price, qty),
      amount_total: licensedAmount(price, qty),
      currency: price.currency,
      description: name,
      price,
      quantity: price.recurring?.usage_type === 'metered' ? null : qty,
      amount_discount: 0,
      amount_tax: 0,
      _interval: intervalLabel(price),
      _tax_rates: (await taxRateIds(ctx, li, 'tax_rates')) ?? [],
      _adjustable: adjustable(li, i, qty),
    });
  }
  if (mode === 'subscription' && !line_items.some((l) => l.price.type === 'recurring')) throw invalid('mode=subscription needs at least one recurring price.', 'line_items');
  const amount_total = line_items.reduce((s, li) => s + li.amount_total, 0);
  if (mode === 'setup') cur = currency(p, 'currency', false) ?? 'usd';
  const id = `cs_test_${base62(58)}`;
  const account = await getAccount(ctx.accountId);
  const session = {
    id,
    object: 'checkout.session',
    amount_subtotal: amount_total,
    amount_total,
    cancel_url: str(p, 'cancel_url')?.replace('{CHECKOUT_SESSION_ID}', id) ?? null,
    client_reference_id: str(p, 'client_reference_id') ?? null,
    created: nowSeconds(),
    currency: cur!,
    customer: str(p, 'customer') ?? null,
    customer_details: null as any,
    customer_email: str(p, 'customer_email') ?? null,
    expires_at: nowSeconds() + 24 * 3600,
    invoice: null as string | null,
    livemode: false,
    metadata: metadata(p),
    mode,
    payment_intent: null as string | null,
    payment_method_types: ['card'] as string[],
    payment_method_options: null as any,
    locale: oneOf(p, 'locale', LOCALES, 'auto')!,
    adaptive_pricing: { enabled: bool(p.adaptive_pricing ?? {}, 'enabled') ?? false },
    currency_conversion: null as null | { amount_subtotal: number; amount_total: number; fx_rate: string; source_currency: string },
    payment_status: mode === 'setup' ? 'no_payment_required' : 'unpaid',
    status: 'open',
    setup_intent: null as string | null,
    subscription: null as string | null,
    subscription_data: p.subscription_data && (p.subscription_data.trial_period_days || p.subscription_data.description || p.subscription_data.metadata) ? { trial_period_days: p.subscription_data.trial_period_days ? Number(p.subscription_data.trial_period_days) : null, description: p.subscription_data.description ?? null, metadata: metadata(p.subscription_data) } : null,
    success_url: success_url?.replace('{CHECKOUT_SESSION_ID}', id) ?? null,
    url: `${ctx.baseUrl}/pay/${id}`,
    automatic_tax: { enabled: bool(p.automatic_tax ?? {}, 'enabled') ?? false, liability: null, status: null as string | null },
    billing_address_collection: oneOf(p, 'billing_address_collection', ['auto', 'required'] as const, 'auto'),
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    allow_promotion_codes: bool(p, 'allow_promotion_codes') ?? false,
    discounts: [] as { coupon: string; promotion_code: string | null }[],
    shipping_address_collection: shippingCollection(p),
    shipping_options: [] as { shipping_amount: number; shipping_rate: string }[],
    shipping_cost: null as any,
    collected_information: { shipping_details: null as any },
    payment_link: internal.payment_link ?? null,
    custom_fields: parseCustomFields(p),
    custom_text: parseCustomText(p),
    consent_collection: parseConsent(p),
    consent: null as null | { promotions: string | null; terms_of_service: string | null },
    tax_id_collection: { enabled: bool(p.tax_id_collection ?? {}, 'enabled') ?? false, required: oneOf(p.tax_id_collection ?? {}, 'required', ['never', 'if_supported'] as const, 'never') },
    _custom_message: internal.custom_message ?? null,
    _auto_redirect: !!internal.auto_redirect,
    _sub_extra: internal.sub_extra ?? null,
    _line_items: line_items,
    _merchant_name: account?.business_profile?.name ?? account?.settings?.dashboard?.display_name ?? 'Merchant',
    _terms_url: account?.business_profile?.url ?? null,
    // Connect: carried onto the PaymentIntent or subscription created at payment time.
    _pi_connect: mode === 'payment' ? connectSubset(p.payment_intent_data) : null,
    _sub_connect: mode === 'subscription' ? await billingConnectParams(ctx, p.subscription_data ?? {}, { percent: true }) : null,
  };
  if (session._pi_connect) {
    const probe: any = { id: 'pi_probe', amount: amount_total, transfer_group: null, statement_descriptor: null };
    await applyConnectParams(ctx, probe, session._pi_connect);
  }
  if (session.customer) {
    const c = await getObject<any>(ctx.accountId, 'customer', session.customer, 'customer', 'customer');
    if (c.address) session.customer_details = { address: c.address, email: c.email, name: c.name };
  }
  if (session.automatic_tax.enabled && !session.shipping_address_collection) session.billing_address_collection = 'required';
  if (p.shipping_options !== undefined) {
    if (mode !== 'payment') throw invalid('shipping_options can only be used in payment mode.', 'shipping_options');
    const { resolveShippingOptions } = await import('./shipping.ts');
    session.shipping_options = await resolveShippingOptions(ctx, p, cur!);
    if (session.shipping_options.length) session.shipping_cost = { shipping_rate: session.shipping_options[0]!.shipping_rate } as any;
  }
  if (session.shipping_address_collection && mode === 'setup') throw invalid('shipping_address_collection cannot be used in setup mode.', 'shipping_address_collection');
  const d0 = arr(p, 'discounts')?.[0];
  if (d0) {
    if (session.allow_promotion_codes) throw invalid('You may only specify one of these parameters: allow_promotion_codes, discounts.', 'discounts');
    if (mode === 'setup') throw invalid('discounts cannot be used in setup mode.', 'discounts');
    if (d0.promotion_code) {
      const { validatePromotion } = await import('./billing/promotions.ts');
      const promo = await getObject<any>(ctx.accountId, 'promotion_code', String(d0.promotion_code), 'promotion code', 'discounts[0][promotion_code]');
      await validatePromotion(ctx, promo, { customer: session.customer, amount: amount_total, currency: cur, param: 'discounts[0][promotion_code]' });
      session.discounts = [{ coupon: (await import('./billing/promotions.ts')).couponOf(promo), promotion_code: promo.id }];
    } else if (d0.coupon) {
      const c = await getObject<any>(ctx.accountId, 'coupon', String(d0.coupon), 'coupon', 'discounts[0][coupon]');
      if (!c.valid || c.deleted) throw invalid(`Coupon expired: ${c.id}`, 'discounts[0][coupon]', 'coupon_expired');
      session.discounts = [{ coupon: c.id, promotion_code: null }];
    }
  }
  if (session.adaptive_pricing.enabled && mode !== 'payment') throw invalid('adaptive_pricing can only be used with mode=payment.', 'adaptive_pricing[enabled]');
  await retotal(ctx, session);
  // Payment methods: an explicit list, or whatever Settings → Payment methods turns on that fits.
  const { checkTypes, eligibleTypes } = await import('./paymentMethodConfigs.ts');
  const explicit = arr(p, 'payment_method_types')?.map(String);
  session.payment_method_types = explicit?.length ? checkTypes(explicit, { currency: cur!, amount: session.amount_total, mode }) : await eligibleTypes(ctx, { currency: cur!, amount: session.amount_total, mode });
  (session as any)._methods_explicit = !!explicit?.length;
  if (session.payment_method_types.includes('us_bank_account')) {
    const vm = oneOf(p.payment_method_options?.us_bank_account ?? {}, 'verification_method', ['automatic', 'instant'] as const, 'automatic');
    session.payment_method_options = { us_bank_account: { financial_connections: { permissions: ['payment_method'] }, verification_method: vm } };
  }
  await insertObject(ctx.accountId, session);
  return session;
}

// ---------------------------------------------------------------- adaptive pricing

/** Currencies a customer may switch to, with the converted total (reference rate + markup). */
export function presentmentOptions(s: any) {
  if (!s.adaptive_pricing?.enabled || s.mode !== 'payment') return [];
  return Object.keys(RATES_PER_USD).filter((c) => c !== s.currency).map((c) => ({ currency: c, ...converted(s, c) }));
}

function converted(s: any, to: string) {
  const fx = Number((rate(s.currency, to) * (1 + CONVERSION_MARKUP)).toFixed(6));
  const conv = (minor: number) => {
    const major = ZERO_DECIMAL.has(s.currency) ? minor : minor / 100;
    return Math.round(ZERO_DECIMAL.has(to) ? major * fx : major * fx * 100);
  };
  return { amount_total: conv(s.amount_total), amount_subtotal: conv(s.amount_subtotal), fx_rate: String(fx) };
}

/** The customer picks the currency to pay in (or back to the merchant's own). */
export async function setSessionCurrency(ctx: Ctx, id: string, cur: string) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  if (!s.adaptive_pricing?.enabled) throw invalid('This Checkout Session does not offer local currencies.', 'currency');
  const c = String(cur ?? '').toLowerCase();
  if (!c || c === s.currency) s.currency_conversion = null;
  else {
    if (!RATES_PER_USD[c]) throw invalid(`Unsupported currency: ${c}.`, 'currency');
    s.currency_conversion = { ...converted(s, c), source_currency: s.currency, _presentment: c } as any;
  }
  await saveObject(ctx.accountId, s);
  return s;
}

const presentment = (s: any) => (s.currency_conversion ? { currency: s.currency_conversion._presentment as string, amount: s.currency_conversion.amount_total as number } : { currency: s.currency as string, amount: s.amount_total as number });

// ---------------------------------------------------------------- asynchronous payment methods

/** A bank debit was submitted for this session's PaymentIntent: the session completes, unpaid for now. */
export async function onPaymentProcessing(ctx: Ctx, pi: any) {
  const s = await findObject<any>(ctx.accountId, 'checkout.session', pi.metadata.checkout_session);
  if (!s || s.status !== 'open') return;
  s.status = 'complete';
  s.payment_status = 'unpaid';
  s._async_payment = true;
  await saveObject(ctx.accountId, s);
  await emit(ctx, 'checkout.session.completed', s);
  if (s.payment_link) await (await import('./paymentLinks.ts')).sessionCompleted(ctx, s.payment_link);
}

onPaymentSucceeded(async (ctx, pi) => {
  const sid = pi.metadata?.checkout_session;
  if (!sid || pi.invoice) return;
  const s = await findObject<any>(ctx.accountId, 'checkout.session', sid);
  if (!s || s.mode !== 'payment') return;
  if (s.status === 'open') return completeIfPaid(ctx, s, pi);
  if (s.status === 'complete' && s.payment_status === 'unpaid' && s._async_payment) {
    s.payment_status = 'paid';
    await saveObject(ctx.accountId, s);
    await emit(ctx, 'checkout.session.async_payment_succeeded', s);
  }
});

onPaymentFailed(async (ctx, pi) => {
  const sid = pi.metadata?.checkout_session;
  if (!sid || pi.invoice) return;
  const s = await findObject<any>(ctx.accountId, 'checkout.session', sid);
  if (s?.status === 'complete' && s.payment_status === 'unpaid' && s._async_payment && !s._async_failed) {
    s._async_failed = true;
    await saveObject(ctx.accountId, s);
    await emit(ctx, 'checkout.session.async_payment_failed', s);
  }
});

// ---------------------------------------------------------------- custom fields and consent

const FIELD_TYPES = ['text', 'numeric', 'dropdown'] as const;

/** custom_fields[]: up to three extra inputs (text, numeric or dropdown) shown on the page. */
export function parseCustomFields(p: Params) {
  const raw = arr(p, 'custom_fields') ?? [];
  if (raw.length > 3) throw invalid('You can add at most 3 custom fields.', 'custom_fields');
  const keys = new Set<string>();
  return raw.map((f: any, i: number) => {
    const at = `custom_fields[${i}]`;
    const key = str(f, 'key', { required: true })!;
    if (!/^[A-Za-z0-9]{1,200}$/.test(key)) throw invalid('custom field keys may contain only letters and numbers (up to 200).', `${at}[key]`);
    if (keys.has(key)) throw invalid(`Duplicate custom field key: ${key}.`, `${at}[key]`);
    keys.add(key);
    const label = f.label?.custom;
    if (!label) throw missing(`${at}[label][custom]`);
    if (String(label).length > 50) throw invalid('Custom field labels can be at most 50 characters.', `${at}[label][custom]`);
    const type = oneOf(f, 'type', FIELD_TYPES);
    if (!type) throw missing(`${at}[type]`);
    const out: any = { key, label: { custom: String(label), type: 'custom' }, optional: bool(f, 'optional') ?? false, type, dropdown: null, numeric: null, text: null };
    const lim = (o: any, max: number) => {
      const min = o?.minimum_length !== undefined ? Number(o.minimum_length) : null;
      const mx = o?.maximum_length !== undefined ? Number(o.maximum_length) : null;
      if (min !== null && (!Number.isInteger(min) || min < 1 || min > max)) throw invalid(`minimum_length must be between 1 and ${max}.`, `${at}[${type}][minimum_length]`);
      if (mx !== null && (!Number.isInteger(mx) || mx < 1 || mx > max || (min !== null && mx < min))) throw invalid(`maximum_length must be between minimum_length and ${max}.`, `${at}[${type}][maximum_length]`);
      return { default_value: o?.default_value ? String(o.default_value) : null, maximum_length: mx, minimum_length: min, value: null };
    };
    if (type === 'text') out.text = lim(f.text, 255);
    if (type === 'numeric') out.numeric = lim(f.numeric, 255);
    if (type === 'dropdown') {
      const opts = arr(f.dropdown ?? {}, 'options') ?? [];
      if (!opts.length || opts.length > 200) throw invalid('A dropdown needs between 1 and 200 options.', `${at}[dropdown][options]`);
      const options = opts.map((o: any, j: number) => {
        if (!o?.label || !o?.value) throw invalid('Each option needs a label and a value.', `${at}[dropdown][options][${j}]`);
        if (!/^[A-Za-z0-9]{1,100}$/.test(String(o.value))) throw invalid('Option values may contain only letters and numbers.', `${at}[dropdown][options][${j}][value]`);
        return { label: String(o.label).slice(0, 100), value: String(o.value) };
      });
      out.dropdown = { default_value: f.dropdown?.default_value ?? null, options, value: null };
    }
    return out;
  });
}

export function parseCustomText(p: Params) {
  const t = p.custom_text ?? {};
  const msg = (k: string) => (t[k]?.message ? { message: String(t[k].message).slice(0, 1200) } : null);
  return { after_submit: msg('after_submit'), shipping_address: msg('shipping_address'), submit: msg('submit'), terms_of_service_acceptance: msg('terms_of_service_acceptance') };
}

export function parseConsent(p: Params) {
  const c = p.consent_collection;
  if (!c || typeof c !== 'object') return null;
  return {
    payment_method_reuse_agreement: null,
    promotions: oneOf(c, 'promotions', ['auto', 'none'] as const) ?? null,
    terms_of_service: oneOf(c, 'terms_of_service', ['required', 'none'] as const) ?? null,
  };
}

/** Validates what the customer entered, before any payment is attempted. */
function collectInputs(s: any, p: { custom_fields?: Record<string, string>; consent?: { promotions?: boolean; terms_of_service?: boolean } }) {
  const given = p.custom_fields ?? {};
  for (const f of s.custom_fields ?? []) {
    const raw = given[f.key];
    const v = raw === undefined || raw === null ? '' : String(raw).trim();
    const label = f.label.custom;
    if (!v) {
      if (!f.optional) throw invalid(`${label} is required.`, `custom_fields[${f.key}]`, 'custom_field_missing');
      continue;
    }
    const spec = f[f.type];
    if (f.type === 'numeric' && !/^\d+$/.test(v)) throw invalid(`${label} must contain only digits.`, `custom_fields[${f.key}]`);
    if (f.type === 'dropdown' && !spec.options.some((o: any) => o.value === v)) throw invalid(`Choose one of the options for ${label}.`, `custom_fields[${f.key}]`);
    if (f.type !== 'dropdown') {
      if (spec.minimum_length && v.length < spec.minimum_length) throw invalid(`${label} must be at least ${spec.minimum_length} characters.`, `custom_fields[${f.key}]`);
      if (spec.maximum_length && v.length > spec.maximum_length) throw invalid(`${label} can be at most ${spec.maximum_length} characters.`, `custom_fields[${f.key}]`);
    }
    spec.value = v;
  }
  const cc = s.consent_collection;
  if (cc) {
    if (cc.terms_of_service === 'required' && !p.consent?.terms_of_service) throw invalid('Agree to the terms of service to continue.', 'consent[terms_of_service]', 'terms_of_service_required');
    s.consent = {
      promotions: cc.promotions === 'auto' ? (p.consent?.promotions ? 'opt_in' : 'opt_out') : null,
      terms_of_service: cc.terms_of_service === 'required' ? 'accepted' : null,
    };
  }
}

/** Hosted page: the customer entered (or cleared) a business tax ID. */
export async function setSessionTaxId(ctx: Ctx, id: string, t: { type?: string; value?: string }) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  if (!s.tax_id_collection?.enabled) throw invalid("This checkout doesn't collect tax IDs.", 'tax_id');
  const ids: any[] = [];
  if (t.value) {
    const { validateTaxId } = await import('./taxIds.ts');
    const v = validateTaxId(String(t.type ?? 'eu_vat'), String(t.value), 'tax_id[value]');
    ids.push({ type: String(t.type ?? 'eu_vat'), value: v.value });
  }
  s.customer_details = { ...(s.customer_details ?? {}), tax_ids: ids, tax_exempt: 'none' };
  await retotal(ctx, s);
  await saveObject(ctx.accountId, s);
  return s;
}

/** Saves tax IDs entered on the page to the customer (once). */
async function persistTaxIds(ctx: Ctx, s: any, customerId: string) {
  const ids: any[] = s.customer_details?.tax_ids ?? [];
  if (!ids.length) return;
  const { createCustomerTaxId, customerTaxIds } = await import('./taxIds.ts');
  const have = new Set((await customerTaxIds(ctx.accountId, customerId)).map((t: any) => `${t.type}:${t.value}`));
  for (const t of ids) if (!have.has(`${t.type}:${t.value}`)) await createCustomerTaxId(ctx, customerId, t);
}

function shippingCollection(p: Params) {
  const c = p.shipping_address_collection;
  if (!c) return null;
  const countries = arr(c, 'allowed_countries');
  if (!countries?.length) throw missing('shipping_address_collection[allowed_countries]');
  for (const [i, x] of countries.entries()) if (!/^[A-Z]{2}$/.test(String(x))) throw invalid(`'${x}' is not a two-letter country code.`, `shipping_address_collection[allowed_countries][${i}]`);
  return { allowed_countries: countries.map(String) };
}

/** Hosted page: shipping address and/or the chosen shipping option. */
export async function setSessionShipping(ctx: Ctx, id: string, b: { name?: string; address?: any; shipping_rate?: string }) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  if (b.address) {
    if (!s.shipping_address_collection) throw invalid("This checkout doesn't collect a shipping address.", 'address');
    const country = String(b.address.country ?? '').toUpperCase();
    if (!s.shipping_address_collection.allowed_countries.includes(country)) throw invalid(`We don't ship to ${country || 'that country'}.`, 'address[country]', 'shipping_country_not_allowed');
    const f = (k: string) => (b.address[k] ? String(b.address[k]) : null);
    s.collected_information = { shipping_details: { name: b.name ? String(b.name) : s.collected_information?.shipping_details?.name ?? null, address: { city: f('city'), country, line1: f('line1'), line2: f('line2'), postal_code: f('postal_code'), state: f('state')?.toUpperCase() ?? null } } };
  }
  if (b.shipping_rate) {
    if (!s.shipping_options.some((o: any) => o.shipping_rate === b.shipping_rate)) throw invalid('That shipping option is not offered on this checkout.', 'shipping_rate');
    s.shipping_cost = { shipping_rate: b.shipping_rate };
  }
  await retotal(ctx, s);
  await saveObject(ctx.accountId, s);
  return s;
}

function adjustable(li: any, i: number, qty: number) {
  const a = li.adjustable_quantity;
  if (!a || !(a.enabled === true || a.enabled === 'true')) return null;
  const min = int(a, 'minimum', { min: 0 }) ?? 0;
  const max = int(a, 'maximum', { min: 1, max: 999999 }) ?? 99;
  if (min > max) throw invalid('adjustable_quantity[minimum] must be less than or equal to adjustable_quantity[maximum].', `line_items[${i}][adjustable_quantity][minimum]`);
  if (qty < min || qty > max) throw invalid('The quantity must be between the adjustable minimum and maximum.', `line_items[${i}][quantity]`);
  return { enabled: true, minimum: min, maximum: max };
}

/** Hosted page: the customer changed the quantity of an adjustable line item. */
export async function setSessionQuantity(ctx: Ctx, id: string, lineId: string, quantity: number) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  const l = s._line_items.find((x: any) => x.id === lineId);
  if (!l?._adjustable) throw invalid("This item's quantity can't be changed.", 'quantity');
  if (!Number.isInteger(quantity) || quantity < l._adjustable.minimum || quantity > l._adjustable.maximum) throw invalid(`Choose a quantity between ${l._adjustable.minimum} and ${l._adjustable.maximum}.`, 'quantity');
  l.quantity = quantity;
  l.amount_subtotal = licensedAmount(l.price, quantity);
  await retotal(ctx, s);
  await saveObject(ctx.accountId, s);
  return s;
}

/** Recomputes tax and totals; automatic tax needs the customer's address. */
async function retotal(ctx: Ctx, s: any) {
  // Tax follows the shipping address when goods are shipped, else the billing address.
  const address = s.collected_information?.shipping_details?.address ?? s.customer_details?.address ?? null;
  const ship = s.shipping_cost?.shipping_rate ? await findObject<any>(ctx.accountId, 'shipping_rate', s.shipping_cost.shipping_rate) : null;
  const customer = s.customer ? await findObject<any>(ctx.accountId, 'customer', s.customer) : null;
  const subtotal = s._line_items.reduce((a: number, l: any) => a + l.amount_subtotal, 0);
  const coupon = s.discounts?.[0] ? await findObject<any>(ctx.accountId, 'coupon', s.discounts[0].coupon) : null;
  const off = coupon ? discountAmount({ coupon, end: null }, subtotal, s.currency, nowSeconds(), true) : 0;
  const inputs: any[] = s._line_items.map((l: any) => ({
    amount: l.amount_subtotal, tax_rates: l._tax_rates, price: l.price.id ?? l.price, tax_behavior: l.price.tax_behavior, tax_code: l.price.product_data?.tax_code,
  }));
  if (ship) inputs.push({ amount: ship.fixed_amount.amount, discountable: false, tax_rates: [], price: null, tax_behavior: ship.tax_behavior, tax_code: ship.tax_code });
  const enteredIds = s.customer_details?.tax_ids?.length ? s.customer_details.tax_ids.map((t: any) => ({ ...t, verification: { status: 'pending' } })) : undefined;
  const priced = await priceLines(ctx, inputs, { discountTotal: off, automatic: s.automatic_tax.enabled, customer: { id: customer?.id, address, tax_exempt: customer?.tax_exempt ?? 'none', _tax_ids: enteredIds } });
  s._reverse_charge = priced.lines.some((l) => l.reasons.includes('reverse_charge'));
  if (ship) {
    const t = priced.lines[inputs.length - 1]!.tax_amounts;
    const exclusive = t.filter((x) => !x.inclusive).reduce((a, b) => a + b.amount, 0);
    s.shipping_cost = { amount_subtotal: ship.fixed_amount.amount, amount_tax: t.reduce((a, b) => a + b.amount, 0), amount_total: ship.fixed_amount.amount + exclusive, shipping_rate: ship.id, taxes: t.map((x) => ({ amount: x.amount, rate: x.tax_rate, taxability_reason: x.taxability_reason, taxable_amount: x.taxable_amount })) };
  }
  s._line_items.forEach((l: any, i: number) => {
    const t = priced.lines[i]!.tax_amounts;
    l.amount_tax = t.reduce((x, y) => x + y.amount, 0);
    l.amount_discount = priced.lines[i]!.discount;
    l.discounts = l.amount_discount && coupon ? [{ amount: l.amount_discount, discount: { coupon: coupon.id, promotion_code: s.discounts[0].promotion_code } }] : [];
    l.amount_total = l.amount_subtotal - l.amount_discount + t.filter((x) => !x.inclusive).reduce((a, b) => a + b.amount, 0);
    l.taxes = t.map((x) => ({ amount: x.amount, rate: x.tax_rate, taxability_reason: x.taxability_reason, taxable_amount: x.taxable_amount }));
  });
  s.amount_subtotal = s._line_items.reduce((a: number, l: any) => a + l.amount_subtotal, 0);
  s.amount_total = priced.total;
  s.total_details.amount_shipping = ship ? ship.fixed_amount.amount : 0;
  s.total_details.amount_tax = priced.tax;
  s.total_details.amount_discount = priced.discount;
  s._discount_label = coupon ? { name: coupon.name ?? coupon.id, code: s.discounts[0].promotion_code ? (await findObject<any>(ctx.accountId, 'promotion_code', s.discounts[0].promotion_code))?.code ?? null : null, amount: priced.discount, percent_off: coupon.percent_off } : null;
  s.automatic_tax.status = priced.automatic_status;
  const rates = [];
  for (const t of priced.total_tax_amounts) {
    const r = await findObject<any>(ctx.accountId, 'tax_rate', t.tax_rate);
    rates.push({ display_name: r?.display_name ?? 'Tax', percentage: r?.percentage ?? 0, jurisdiction: r?.jurisdiction ?? null, inclusive: t.inclusive, amount: t.amount, reverse_charge: t.taxability_reason === 'reverse_charge' });
  }
  s._tax_lines = rates;
  if (s.currency_conversion?._presentment) s.currency_conversion = { ...converted(s, s.currency_conversion._presentment), source_currency: s.currency, _presentment: s.currency_conversion._presentment };
  if (s.shipping_options?.length) {
    const { estimateLabel } = await import('./shipping.ts');
    s._shipping_view = [];
    for (const o of s.shipping_options) {
      const r = await findObject<any>(ctx.accountId, 'shipping_rate', o.shipping_rate);
      s._shipping_view.push({ id: o.shipping_rate, display_name: r?.display_name ?? 'Shipping', amount: o.shipping_amount, estimate: estimateLabel(r?.delivery_estimate) });
    }
  }
  return s;
}

/** Hosted page: the customer entered a billing address, so tax can be calculated. */
/** Hosted page: the customer typed a promotion code (or cleared it with an empty code). */
export async function applySessionCode(ctx: Ctx, id: string, code: string) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  if (!s.allow_promotion_codes) throw invalid('This checkout does not accept promotion codes.', 'promotion_code');
  if (!code?.trim()) {
    s.discounts = [];
  } else {
    const { findByCode, validatePromotion } = await import('./billing/promotions.ts');
    const promo = await findByCode(ctx, code);
    const subtotal = s._line_items.reduce((a: number, l: any) => a + l.amount_subtotal, 0);
    await validatePromotion(ctx, promo, { customer: s.customer, amount: subtotal, currency: s.currency });
    s.discounts = [{ coupon: (await import('./billing/promotions.ts')).couponOf(promo), promotion_code: promo.id }];
  }
  await retotal(ctx, s);
  await saveObject(ctx.accountId, s);
  return s;
}

export async function setSessionAddress(ctx: Ctx, id: string, address: any) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  if (!address?.country) throw invalid('Choose a country.', 'address[country]');
  s.customer_details = { ...(s.customer_details ?? {}), address: { city: address.city ?? null, country: String(address.country).toUpperCase(), line1: address.line1 ?? null, line2: null, postal_code: address.postal_code ?? null, state: address.state ? String(address.state).toUpperCase() : null } };
  await retotal(ctx, s);
  await saveObject(ctx.accountId, s);
  return s;
}

function connectSubset(d: any) {
  if (!d || typeof d !== 'object') return null;
  const out: any = {};
  for (const k of ['application_fee_amount', 'transfer_data', 'on_behalf_of', 'transfer_group']) if (d[k] !== undefined && d[k] !== '') out[k] = d[k];
  return Object.keys(out).length ? out : null;
}

export async function lineItems(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  return { object: 'list', data: s._line_items, has_more: false, url: `/v1/checkout/sessions/${id}/line_items` };
}

export async function expireSession(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`Only open sessions can be expired; this session is ${s.status}.`, 'session');
  s.status = 'expired';
  await saveObject(ctx.accountId, s);
  await emit(ctx, 'checkout.session.expired', s);
  return s;
}

/** Public view for the hosted page (no secrets). */
export function publicView(s: any) {
  return {
    id: s.id,
    mode: s.mode,
    amount_total: s.amount_total,
    currency: s.currency,
    customer_email: s.customer_email,
    amount_subtotal: s.amount_subtotal,
    amount_tax: s.total_details?.amount_tax ?? 0,
    automatic_tax: s.automatic_tax ?? { enabled: false, status: null },
    billing_address_collection: s.billing_address_collection ?? 'auto',
    address: s.customer_details?.address ?? null,
    tax_lines: s._tax_lines ?? [],
    allow_promotion_codes: !!s.allow_promotion_codes,
    shipping: s.shipping_address_collection ? { allowed_countries: s.shipping_address_collection.allowed_countries, details: s.collected_information?.shipping_details ?? null } : null,
    shipping_options: s._shipping_view ?? [],
    shipping_cost: s.shipping_cost?.amount_total !== undefined ? { amount: s.shipping_cost.amount_subtotal, rate: s.shipping_cost.shipping_rate } : null,
    discount: s._discount_label ?? null,
    custom_message: s._custom_message ?? null,
    line_items: s._line_items.map((l: any) => ({ id: l.id, description: l.description, quantity: l.quantity, amount_subtotal: l.amount_subtotal, amount_total: l.amount_total, currency: l.currency, interval: l._interval || null, adjustable: l._adjustable ?? null, metered: l.price.recurring?.usage_type === 'metered', unit: l.price.recurring?.usage_type === 'metered' ? priceSummaryOf(l.price) : null })),
    auto_redirect: !!s._auto_redirect,
    payment_link: s.payment_link ?? null,
    merchant_name: s._merchant_name,
    status: s.status,
    payment_status: s.payment_status,
    cancel_url: s.cancel_url,
    success_url: s.success_url,
    trial_period_days: s.subscription_data?.trial_period_days ?? null,
    custom_fields: (s.custom_fields ?? []).map((f: any) => ({ key: f.key, label: f.label.custom, type: f.type, optional: f.optional, options: f.dropdown?.options ?? null, default_value: f[f.type]?.default_value ?? null, minimum_length: f[f.type]?.minimum_length ?? null, maximum_length: f[f.type]?.maximum_length ?? null })),
    consent_collection: s.consent_collection ?? null,
    custom_text: s.custom_text ?? null,
    terms_url: s._terms_url ?? null,
    tax_id_collection: s.tax_id_collection ?? { enabled: false },
    tax_ids: s.customer_details?.tax_ids ?? [],
    reverse_charge: !!s._reverse_charge,
    payment_method_types: s.payment_method_types ?? ['card'],
    bank_verification: s.payment_method_options?.us_bank_account?.verification_method ?? null,
    locale: s.locale ?? 'auto',
    adaptive_pricing: !!s.adaptive_pricing?.enabled,
    presentment_options: presentmentOptions(s).map((o) => ({ currency: o.currency, amount_total: o.amount_total })),
    currency_conversion: s.currency_conversion ? { currency: s.currency_conversion._presentment, amount_total: s.currency_conversion.amount_total, amount_subtotal: s.currency_conversion.amount_subtotal, fx_rate: s.currency_conversion.fx_rate, source_currency: s.currency_conversion.source_currency } : null,
    async_payment: s._async_payment ? { payment_status: s.payment_status, failed: !!s._async_failed } : null,
  };
}

const priceSummaryOf = (price: any) => { try { return priceSummary(price); } catch { return null; } };

async function findOrCreateCustomer(ctx: Ctx, s: any, email?: string, name?: string) {
  if (s.customer) return getObject<any>(ctx.accountId, 'customer', s.customer);
  if (email) {
    const row = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'customer' AND lower(data->>'email') = $2 ORDER BY seq DESC LIMIT 1", [ctx.accountId, email.toLowerCase()]);
    if (row[0] && !row[0].data.deleted) return row[0].data;
  }
  return createCustomer(ctx, { email, name });
}

/** Called by the hosted page after its card element tokenized the card. */
export async function paySession(ctx: Ctx, id: string, p: { payment_method: string; email?: string; name?: string; custom_fields?: Record<string, string>; consent?: { promotions?: boolean; terms_of_service?: boolean }; client?: { ip?: string; user_agent?: string } }) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw invalid(`This Checkout Session is ${s.status}.`, 'session');
  if (s.expires_at < nowSeconds()) throw invalid('This Checkout Session has expired.', 'session');
  collectInputs(s, p);
  s.customer_details = { ...(s.customer_details ?? {}), email: p.email ?? s.customer_email, name: p.name ?? null };
  if (s.tax_id_collection?.enabled && s.tax_id_collection.required === 'if_supported' && !s.customer_details.tax_ids?.length && s.mode !== 'setup') {
    throw invalid('Enter your business tax ID to continue.', 'tax_id', 'tax_id_required');
  }
  if (s.customer_details.tax_ids?.length && !s.customer && s.mode === 'payment') {
    // A business purchase with a tax ID creates (or finds) a customer to hold it.
    const c = await findOrCreateCustomer(ctx, s, p.email, p.name);
    s.customer = c.id;
    await persistTaxIds(ctx, s, c.id);
  } else if (s.customer_details.tax_ids?.length && s.customer && s.mode === 'payment') await persistTaxIds(ctx, s, s.customer);
  await saveObject(ctx.accountId, s);
  if (s.mode !== 'setup' && s.automatic_tax?.enabled && s.automatic_tax.status !== 'complete') {
    throw invalid('Enter a billing address (country, and state for the US and Canada) so tax can be calculated.', 'address', 'customer_tax_location_invalid');
  }

  if (s.discounts?.[0]?.promotion_code && s.mode !== 'setup') {
    // Re-check now that we know who is paying (first-time-customer and customer-specific codes).
    const { validatePromotion } = await import('./billing/promotions.ts');
    const promo = await getObject<any>(ctx.accountId, 'promotion_code', s.discounts[0].promotion_code);
    const known = s.customer ?? (p.email ? (await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'customer' AND lower(data->>'email') = $2 ORDER BY seq DESC LIMIT 1", [ctx.accountId, p.email.toLowerCase()]))[0]?.id : null);
    await validatePromotion(ctx, promo, { customer: known ?? null, amount: s.amount_subtotal, currency: s.currency });
  }
  if (s.shipping_address_collection && !s.collected_information?.shipping_details?.address?.line1) throw invalid('Enter a shipping address.', 'shipping_details', 'shipping_address_required');
  if (s.mode === 'subscription') return paySubscriptionSession(ctx, s, p);
  if (s.mode === 'setup') return paySetupSession(ctx, s, p);

  const pm = await getObject<any>(ctx.accountId, 'payment_method', p.payment_method, 'PaymentMethod', 'payment_method');
  if (!(s.payment_method_types ?? ['card']).includes(pm.type)) throw invalid(`This Checkout Session does not accept ${pm.type} payments.`, 'payment_method', 'payment_intent_incompatible_payment_method');
  if (pm.type === 'us_bank_account' && !s.customer && p.email) {
    // Bank debits are always tied to a customer (the mandate and the linked account belong to them).
    const c = await findOrCreateCustomer(ctx, s, p.email, p.name);
    s.customer = c.id;
    await saveObject(ctx.accountId, s);
  }
  const charge = presentment(s);
  let pi: any;
  if (s.payment_intent) {
    pi = await getObject<any>(ctx.accountId, 'payment_intent', s.payment_intent);
    // The address (and so the tax), or the currency the customer pays in, may have changed since the last attempt.
    if ((pi.amount !== charge.amount || pi.currency !== charge.currency) && pi.status === 'requires_payment_method') pi = await updatePaymentIntent(ctx, pi.id, { amount: charge.amount, currency: charge.currency });
  } else {
    pi = await createPaymentIntent(ctx, { amount: charge.amount, currency: charge.currency, payment_method_types: s.payment_method_types, ...(s.payment_method_options ? { payment_method_options: s.payment_method_options } : {}), customer: s.customer ?? undefined, receipt_email: p.email ?? s.customer_email ?? undefined, description: s._line_items.map((l: any) => l.description).join(', ').slice(0, 200), metadata: { checkout_session: s.id }, ...(s._pi_connect ?? {}), ...(s.collected_information?.shipping_details ? { shipping: { name: s.collected_information.shipping_details.name ?? p.name ?? 'Customer', address: s.collected_information.shipping_details.address } } : {}) });
    s.payment_intent = pi.id;
    await saveObject(ctx.accountId, s);
  }
  const result = await confirmPaymentIntent(ctx, pi.id, {
    payment_method: p.payment_method, return_url: `${ctx.baseUrl}/pay/${s.id}?return=1`,
    ...(pm.type === 'us_bank_account' ? { mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: p.client?.ip ?? '127.0.0.1', user_agent: p.client?.user_agent ?? 'Tessera Checkout' } } } } : {}),
  });
  if (result instanceof CommitThenFail) return result;
  if (result.status === 'succeeded') await completeIfPaid(ctx, s, result);
  return { session: s, payment_intent: result };
}

/** mode=setup: save the card (SetupIntent, off-session usage) on a found-or-created customer. */
async function paySetupSession(ctx: Ctx, s: any, p: { payment_method: string; email?: string; name?: string }) {
  const { confirmSetupIntent, createSetupIntent } = await import('./setupIntents.ts');
  const customer = await findOrCreateCustomer(ctx, s, p.email, p.name);
  s.customer = customer.id;
  let si: any;
  if (s.setup_intent) si = await getObject<any>(ctx.accountId, 'setup_intent', s.setup_intent);
  if (!si || si.status === 'succeeded' || si.status === 'canceled') {
    si = await createSetupIntent(ctx, { customer: customer.id, usage: 'off_session', metadata: { checkout_session: s.id } });
    s.setup_intent = si.id;
  }
  await saveObject(ctx.accountId, s);
  const r = await confirmSetupIntent(ctx, si.id, { payment_method: p.payment_method, return_url: `${ctx.baseUrl}/pay/${s.id}?return=1` });
  if (r instanceof CommitThenFail) return r;
  if (r.status === 'succeeded') await completeSetup(ctx, s);
  return { session: s, payment_intent: r };
}

export async function completeSetup(ctx: Ctx, s: any) {
  if (s.status !== 'open') return s;
  s.status = 'complete';
  await saveObject(ctx.accountId, s);
  await emit(ctx, 'checkout.session.completed', s);
  if (s.payment_link) await (await import('./paymentLinks.ts')).sessionCompleted(ctx, s.payment_link);
  return s;
}

async function paySubscriptionSession(ctx: Ctx, s: any, p: { payment_method: string; email?: string; name?: string }) {
  if (s.subscription) {
    // A previous attempt failed or needed authentication: retry the open first invoice.
    const sub = await getObject<any>(ctx.accountId, 'subscription', s.subscription);
    const { payInvoice } = await import('./billing/invoices.ts');
    await attachPaymentMethod(ctx, p.payment_method, { customer: sub.customer }).catch(() => undefined);
    sub.default_payment_method = p.payment_method;
    await saveObject(ctx.accountId, sub);
    const r = await payInvoice(ctx, await getObject(ctx.accountId, 'invoice', sub.latest_invoice), { payment_method: p.payment_method, throwOnFailure: true });
    if (r instanceof CommitThenFail) return r;
    return subscriptionResult(ctx, s, sub.id);
  }
  const customer = await findOrCreateCustomer(ctx, s, p.email, p.name);
  await attachPaymentMethod(ctx, p.payment_method, { customer: customer.id });
  s.customer = customer.id;
  await persistTaxIds(ctx, s, customer.id);
  if (s.customer_details?.address && (s.automatic_tax?.enabled || !customer.address)) {
    const { updateCustomer } = await import('./customers.ts');
    await updateCustomer(ctx, customer.id, { address: s.customer_details.address });
  }
  if (s.collected_information?.shipping_details) {
    const { updateCustomer } = await import('./customers.ts');
    await updateCustomer(ctx, customer.id, { shipping: { name: s.collected_information.shipping_details.name ?? p.name ?? 'Customer', address: s.collected_information.shipping_details.address } });
  }
  const recurring = s._line_items.filter((l: any) => l.price.type === 'recurring');
  const items = [];
  for (const l of recurring) {
    items.push(l.price.id ? { price: l.price.id, ...(l.quantity === null ? {} : { quantity: l.quantity }), tax_rates: l._tax_rates } : { price_data: { currency: l.price.currency, unit_amount: l.price.unit_amount, recurring: l.price.recurring, tax_behavior: l.price.tax_behavior, product_data: { name: l.description } }, quantity: l.quantity, tax_rates: l._tax_rates });
  }
  for (const l of s._line_items.filter((x: any) => x.price.type !== 'recurring')) {
    const { createInvoiceItem } = await import('./billing/invoices.ts');
    await createInvoiceItem(ctx, { customer: customer.id, amount: l.amount_subtotal, currency: l.currency, description: l.description, tax_rates: l._tax_rates, discountable: 'true' });
  }
  const sub = await createSubscription(ctx, { customer: customer.id, items, default_payment_method: p.payment_method, trial_period_days: s.subscription_data?.trial_period_days ?? undefined, description: s.subscription_data?.description ?? undefined, metadata: { ...(s.subscription_data?.metadata ?? {}), checkout_session: s.id }, automatic_tax: { enabled: s.automatic_tax?.enabled ? 'true' : 'false' }, ...(s._sub_connect ?? {}), ...discountParams(s), ...(s._sub_extra ?? {}) });
  if (sub instanceof CommitThenFail) return sub;
  s.subscription = sub.id;
  s.invoice = sub.latest_invoice;
  await saveObject(ctx.accountId, s);
  return subscriptionResult(ctx, s, sub.id);
}

async function subscriptionResult(ctx: Ctx, s: any, subId: string) {
  const sub = await getObject<any>(ctx.accountId, 'subscription', subId);
  const inv = await getObject<any>(ctx.accountId, 'invoice', sub.latest_invoice);
  const pi = inv.payment_intent ? await findObject<any>(ctx.accountId, 'payment_intent', inv.payment_intent) : null;
  if (['active', 'trialing'].includes(sub.status)) {
    await completeIfPaid(ctx, s, pi ?? { status: 'succeeded' });
    return { session: s, payment_intent: pi ?? { status: 'succeeded', next_action: null } };
  }
  if (pi?.status === 'requires_action') {
    pi._return_url = `${ctx.baseUrl}/pay/${s.id}?return=1`;
    pi.next_action.redirect_to_url.return_url = pi._return_url;
    await saveObject(ctx.accountId, pi);
    return { session: s, payment_intent: pi };
  }
  const err = pi?.last_payment_error;
  return new CommitThenFail(new ApiError(402, 'card_error', err?.message ?? 'Your card was declined.', { code: err?.code ?? 'card_declined', declineCode: err?.decline_code }));
}

const discountParams = (s: any) => (s.discounts?.[0] ? (s.discounts[0].promotion_code ? { promotion_code: s.discounts[0].promotion_code } : { coupon: s.discounts[0].coupon }) : {});

export async function completeIfPaid(ctx: Ctx, s: any, pi: any) {
  if (pi.status !== 'succeeded' || s.status === 'complete') return;
  // The payment hook may already have completed it (this copy can be stale).
  const fresh = await findObject<any>(ctx.accountId, 'checkout.session', s.id);
  if (fresh?.status === 'complete') { Object.assign(s, fresh); return; }
  if (s.mode === 'payment' && s.discounts?.[0]) {
    // One-time payments redeem the code here (subscriptions redeem it when the subscription is created).
    const { redeemCoupon } = await import('./billing/catalog.ts');
    const custId = s.customer ?? pi.customer ?? null;
    if (s.discounts[0].promotion_code) {
      const promo = await getObject<any>(ctx.accountId, 'promotion_code', s.discounts[0].promotion_code);
      promo.times_redeemed++;
      if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) promo.active = false;
      await saveObject(ctx.accountId, promo);
    }
    await redeemCoupon(ctx, s.discounts[0].coupon, { customer: custId }, nowSeconds()).catch(() => undefined);
  }
  s.status = 'complete';
  s.payment_status = s.mode === 'subscription' && s.amount_total > 0 && s.subscription_data?.trial_period_days ? 'no_payment_required' : 'paid';
  if (s.currency_conversion?._presentment && pi.currency === s.currency_conversion._presentment) {
    // Adaptive pricing: the session reports what the customer paid; currency_conversion keeps the source.
    s.amount_total = s.currency_conversion.amount_total;
    s.amount_subtotal = s.currency_conversion.amount_subtotal;
    s.currency = s.currency_conversion._presentment;
  }
  await saveObject(ctx.accountId, s);
  await emit(ctx, 'checkout.session.completed', s);
  if (s.payment_link) await (await import('./paymentLinks.ts')).sessionCompleted(ctx, s.payment_link);
}
