import { one } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { arr, bool, int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { createSession, parseConsent, parseCustomFields, parseCustomText } from './checkout.ts';
import { diff, emit } from './events.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/**
 * Payment Links: a shareable URL (`/b/<code>`) that opens a fresh Checkout Session each
 * time someone visits it. A link sells catalog prices, in payment mode or (when any price
 * is recurring) subscription mode, and can collect tax, accept promotion codes, limit how
 * many purchases it allows, and either show a confirmation message or redirect afterwards.
 */

const AFTER = ['hosted_confirmation', 'redirect'] as const;

async function parseLineItems(ctx: Ctx, items: any[] | undefined) {
  if (!items?.length) throw missing('line_items');
  if (items.length > 20) throw invalid('A payment link can have at most 20 line items.', 'line_items');
  const out = [];
  let cur: string | null = null;
  let interval: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    const priceId = str(li, 'price', { required: true });
    const price = await getObject<any>(ctx.accountId, 'price', priceId!, 'price', `line_items[${i}][price]`);
    if (!price.active) throw invalid(`The price ${price.id} is not active.`, `line_items[${i}][price]`);
    if (cur && price.currency !== cur) throw invalid('All prices on a payment link must use the same currency.', `line_items[${i}][price]`);
    cur = price.currency;
    if (price.recurring) {
      const iv = `${price.recurring.interval}/${price.recurring.interval_count}`;
      if (interval && iv !== interval) throw invalid('All recurring prices on a payment link must share the same interval.', `line_items[${i}][price]`);
      interval = iv;
    }
    const metered = price.recurring?.usage_type === 'metered';
    if (metered && li.quantity !== undefined) throw invalid('Metered prices cannot have a quantity.', `line_items[${i}][quantity]`);
    const quantity = metered ? null : int(li, 'quantity', { min: 1, max: 999999 }) ?? 1;
    const aq = li.adjustable_quantity;
    const adjustable = aq && (aq.enabled === true || aq.enabled === 'true')
      ? { enabled: true, minimum: int(aq, 'minimum', { min: 0 }) ?? 1, maximum: int(aq, 'maximum', { min: 1, max: 999999 }) ?? 99 }
      : null;
    if (adjustable && metered) throw invalid('Metered prices cannot have an adjustable quantity.', `line_items[${i}][adjustable_quantity]`);
    if (adjustable && (quantity! < adjustable.minimum || quantity! > adjustable.maximum)) throw invalid('quantity must be between adjustable_quantity[minimum] and adjustable_quantity[maximum].', `line_items[${i}][quantity]`);
    const product = await findObject<any>(ctx.accountId, 'product', price.product);
    out.push({
      id: newId('li', 16),
      object: 'item',
      adjustable_quantity: adjustable,
      amount_discount: 0,
      amount_tax: 0,
      currency: price.currency,
      description: product?.name ?? 'Item',
      price: { ...price, _ref: true },
      quantity,
    });
  }
  return { items: out, currency: cur!, recurring: interval !== null };
}

function afterCompletion(p: Params, existing?: any) {
  const ac = p.after_completion;
  if (!ac) return existing ?? { hosted_confirmation: { custom_message: null }, type: 'hosted_confirmation' };
  const type = oneOf(ac, 'type', AFTER);
  if (!type) throw missing('after_completion[type]');
  if (type === 'redirect') {
    const url = str(ac.redirect ?? {}, 'url', { required: true, max: 2048 })!;
    if (!/^https?:\/\//.test(url)) throw invalid('after_completion[redirect][url] must be an http(s) URL.', 'after_completion[redirect][url]');
    return { redirect: { url }, type };
  }
  return { hosted_confirmation: { custom_message: str(ac.hosted_confirmation ?? {}, 'custom_message', { max: 500 }) ?? null }, type };
}

function restrictions(p: Params, existing?: any) {
  if (p.restrictions === '') return null;
  const limit = p.restrictions?.completed_sessions?.limit;
  if (limit === undefined) return existing ?? null;
  const n = int(p.restrictions.completed_sessions, 'limit', { min: 1, max: 10000 })!;
  return { completed_sessions: { count: existing?.completed_sessions?.count ?? 0, limit: n } };
}

export async function createPaymentLink(ctx: Ctx, p: Params) {
  const { items, currency, recurring } = await parseLineItems(ctx, arr(p, 'line_items'));
  const id = newId('plink');
  const code = `test_${base62(14)}`;
  const sd = p.subscription_data ?? {};
  if (!recurring && p.subscription_data) throw invalid('subscription_data can only be used with recurring prices.', 'subscription_data');
  if (recurring && p.payment_intent_data) throw invalid('payment_intent_data cannot be used with recurring prices; use subscription_data.', 'payment_intent_data');
  const link = {
    id,
    object: 'payment_link',
    active: true,
    after_completion: afterCompletion(p),
    allow_promotion_codes: bool(p, 'allow_promotion_codes') ?? false,
    created: nowSeconds(),
    application_fee_amount: int(p, 'application_fee_amount', { min: 0 }) ?? null,
    application_fee_percent: p.application_fee_percent !== undefined ? Number(p.application_fee_percent) : null,
    automatic_tax: { enabled: bool(p.automatic_tax ?? {}, 'enabled') ?? false, liability: null },
    billing_address_collection: oneOf(p, 'billing_address_collection', ['auto', 'required'] as const, 'auto'),
    currency,
    customer_creation: oneOf(p, 'customer_creation', ['always', 'if_required'] as const, 'if_required'),
    livemode: false,
    metadata: metadata(p),
    on_behalf_of: str(p, 'on_behalf_of') ?? null,
    payment_intent_data: p.payment_intent_data ? { description: p.payment_intent_data.description ?? null, metadata: metadata(p.payment_intent_data), transfer_group: p.payment_intent_data.transfer_group ?? null } : null,
    payment_method_types: null,
    restrictions: restrictions(p),
    submit_type: oneOf(p, 'submit_type', ['auto', 'book', 'donate', 'pay'] as const, 'auto'),
    shipping_address_collection: p.shipping_address_collection ? { allowed_countries: (arr(p.shipping_address_collection, 'allowed_countries') ?? []).map(String) } : null,
    shipping_options: [] as { shipping_amount: number; shipping_rate: string }[],
    subscription_data: recurring ? { description: str(sd, 'description') ?? null, metadata: metadata(sd), trial_period_days: int(sd, 'trial_period_days', { min: 1, max: 730 }) ?? null } : null,
    transfer_data: p.transfer_data?.destination ? { amount: int(p.transfer_data, 'amount', { min: 1 }) ?? null, destination: String(p.transfer_data.destination) } : null,
    url: `${ctx.baseUrl}/b/${code}`,
    custom_fields: parseCustomFields(p),
    custom_text: parseCustomText(p),
    consent_collection: parseConsent(p),
    tax_id_collection: { enabled: bool(p.tax_id_collection ?? {}, 'enabled') ?? false, required: oneOf(p.tax_id_collection ?? {}, 'required', ['never', 'if_supported'] as const, 'never') },
    _session_extras: { custom_fields: p.custom_fields, custom_text: p.custom_text, consent_collection: p.consent_collection, tax_id_collection: p.tax_id_collection },
    _code: code,
    _line_items: items,
    _mode: recurring ? 'subscription' : 'payment',
  };
  if (link.application_fee_amount !== null && recurring) throw invalid('Use application_fee_percent for payment links with recurring prices.', 'application_fee_amount');
  if (link.application_fee_percent !== null && !recurring) throw invalid('Use application_fee_amount for one-time payment links.', 'application_fee_percent');
  if ((link.application_fee_amount !== null || link.application_fee_percent !== null) && !ctx.platformAccountId && !link.transfer_data) {
    throw invalid('Application fees need a connected account: pass transfer_data[destination] or use the Stripe-Account header.', 'application_fee_amount');
  }
  if (link.shipping_address_collection && !link.shipping_address_collection.allowed_countries.length) throw missing('shipping_address_collection[allowed_countries]');
  if (p.shipping_options !== undefined) {
    if (recurring) throw invalid('shipping_options can only be used with one-time prices.', 'shipping_options');
    const { resolveShippingOptions } = await import('./shipping.ts');
    link.shipping_options = await resolveShippingOptions(ctx, p, currency);
  }
  await insertObject(ctx.accountId, link);
  await emit(ctx, 'payment_link.created', link);
  return link;
}

export async function updatePaymentLink(ctx: Ctx, id: string, p: Params) {
  const link = await getObject<any>(ctx.accountId, 'payment_link', id, 'payment link');
  const before = structuredClone(link);
  if (p.active !== undefined) link.active = bool(p, 'active');
  if (p.line_items !== undefined) {
    // Only quantities and adjustable quantities of existing items can change.
    for (const [i, spec] of (arr(p, 'line_items') ?? []).entries()) {
      const li = link._line_items.find((x: any) => x.id === spec.id);
      if (!li) throw invalid(`No such line item: '${spec.id}'`, `line_items[${i}][id]`);
      if (spec.quantity !== undefined) li.quantity = int(spec, 'quantity', { min: 1 });
      if (spec.adjustable_quantity) {
        const aq = spec.adjustable_quantity;
        li.adjustable_quantity = aq.enabled === true || aq.enabled === 'true' ? { enabled: true, minimum: int(aq, 'minimum', { min: 0 }) ?? 1, maximum: int(aq, 'maximum', { min: 1 }) ?? 99 } : null;
      }
    }
  }
  if (p.after_completion !== undefined) link.after_completion = afterCompletion(p, link.after_completion);
  if (p.allow_promotion_codes !== undefined) link.allow_promotion_codes = bool(p, 'allow_promotion_codes');
  if (p.automatic_tax?.enabled !== undefined) link.automatic_tax.enabled = bool(p.automatic_tax, 'enabled');
  if (p.billing_address_collection !== undefined) link.billing_address_collection = oneOf(p, 'billing_address_collection', ['auto', 'required'] as const);
  if (p.customer_creation !== undefined) link.customer_creation = oneOf(p, 'customer_creation', ['always', 'if_required'] as const);
  if (p.restrictions !== undefined) link.restrictions = restrictions(p, link.restrictions);
  if (p.subscription_data && link.subscription_data) {
    const sd = p.subscription_data;
    if (sd.trial_period_days !== undefined) link.subscription_data.trial_period_days = sd.trial_period_days === '' ? null : int(sd, 'trial_period_days', { min: 1, max: 730 });
    if (sd.description !== undefined) link.subscription_data.description = sd.description || null;
    link.subscription_data.metadata = metadata(sd, link.subscription_data.metadata);
  }
  link.metadata = metadata(p, link.metadata);
  await saveObject(ctx.accountId, link);
  await emit(ctx, 'payment_link.updated', link, diff(before, link));
  return link;
}

export async function linkLineItems(ctx: Ctx, id: string) {
  const link = await getObject<any>(ctx.accountId, 'payment_link', id, 'payment link');
  const data = await Promise.all(link._line_items.map(async (li: any) => {
    const price = (await findObject<any>(ctx.accountId, 'price', li.price.id)) ?? li.price;
    const { licensedAmount } = await import('./billing/catalog.ts');
    const amt = licensedAmount(price, li.quantity ?? 0);
    return { ...li, price, amount_subtotal: amt, amount_total: amt };
  }));
  return { object: 'list', data, has_more: false, url: `/v1/payment_links/${id}/line_items` };
}

/** Finds the link behind a public `/b/<code>` URL. */
export async function findLinkByCode(code: string) {
  const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE type = 'payment_link' AND data->>'_code' = $1", [code]);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
  return row;
}

/** A visitor opened the link: start a new Checkout Session for it. */
export async function sessionForLink(ctx: Ctx, link: any) {
  if (!link.active) throw new ApiError(400, 'invalid_request_error', 'This link is no longer active.', { code: 'payment_link_inactive' });
  const r = link.restrictions?.completed_sessions;
  if (r && r.count >= r.limit) throw new ApiError(400, 'invalid_request_error', 'This link has reached its purchase limit.', { code: 'payment_link_inactive' });
  const params: Params = {
    mode: link._mode,
    line_items: link._line_items.map((li: any) => ({ price: li.price.id, ...(li.quantity !== null ? { quantity: li.quantity } : {}), ...(li.adjustable_quantity ? { adjustable_quantity: li.adjustable_quantity } : {}) })),
    allow_promotion_codes: link.allow_promotion_codes ? 'true' : 'false',
    automatic_tax: { enabled: link.automatic_tax.enabled ? 'true' : 'false' },
    billing_address_collection: link.billing_address_collection,
    metadata: link.metadata,
    ...(link.shipping_address_collection ? { shipping_address_collection: link.shipping_address_collection } : {}),
    ...(link.shipping_options?.length ? { shipping_options: link.shipping_options.map((o: any) => ({ shipping_rate: o.shipping_rate })) } : {}),
    ...Object.fromEntries(Object.entries(link._session_extras ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')),
  };
  if (link.after_completion.type === 'redirect') params.success_url = link.after_completion.redirect.url;
  if (link._mode === 'subscription' && link.subscription_data) {
    params.subscription_data = { ...(link.subscription_data.trial_period_days ? { trial_period_days: link.subscription_data.trial_period_days } : {}), ...(link.subscription_data.description ? { description: link.subscription_data.description } : {}), metadata: link.subscription_data.metadata };
    if (link.application_fee_percent !== null || link.transfer_data || link.on_behalf_of) {
      Object.assign(params.subscription_data, {
        ...(link.application_fee_percent !== null ? { application_fee_percent: link.application_fee_percent } : {}),
        ...(link.transfer_data ? { transfer_data: link.transfer_data } : {}),
        ...(link.on_behalf_of ? { on_behalf_of: link.on_behalf_of } : {}),
      });
    }
  }
  if (link._mode === 'payment') {
    const pid: any = {};
    if (link.application_fee_amount !== null) pid.application_fee_amount = link.application_fee_amount;
    if (link.transfer_data) pid.transfer_data = { destination: link.transfer_data.destination, ...(link.transfer_data.amount ? { amount: link.transfer_data.amount } : {}) };
    if (link.on_behalf_of) pid.on_behalf_of = link.on_behalf_of;
    if (link.payment_intent_data?.transfer_group) pid.transfer_group = link.payment_intent_data.transfer_group;
    if (Object.keys(pid).length) params.payment_intent_data = pid;
  }
  return createSession(ctx, params, {
    payment_link: link.id,
    custom_message: link.after_completion.type === 'hosted_confirmation' ? link.after_completion.hosted_confirmation.custom_message : null,
    auto_redirect: link.after_completion.type === 'redirect',
  });
}

/** Counts completed purchases; a link that reaches its limit deactivates itself. */
export async function sessionCompleted(ctx: Ctx, linkId: string) {
  const link = await findObject<any>(ctx.accountId, 'payment_link', linkId);
  if (!link) return;
  const r = link.restrictions?.completed_sessions;
  if (!r) return;
  const before = structuredClone(link);
  r.count++;
  if (r.count >= r.limit) link.active = false;
  await saveObject(ctx.accountId, link);
  await emit(ctx, 'payment_link.updated', link, diff(before, link));
}
