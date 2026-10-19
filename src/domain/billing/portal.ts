import { one, query, transaction } from '../../db/index.ts';
import { ApiError, invalid, missing } from '../../lib/errors.ts';
import { base62, newId, nowSeconds } from '../../lib/ids.ts';
import { arr, bool, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { getAccount } from '../accounts.ts';
import { updateCustomer } from '../customers.ts';
import { emit } from '../events.ts';
import { detachPaymentMethod } from '../paymentMethods.ts';
import { createSetupIntent } from '../setupIntents.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { cancelSubscription, previewUpcoming, updateSubscription } from './subscriptions.ts';
import { licensedAmount, priceSummary } from './catalog.ts';

/**
 * Customer portal: a hosted page where a customer manages their own billing.
 *
 * A `billing_portal.configuration` decides what the customer may do (update their details,
 * see invoices, change payment methods, cancel or switch plans). The platform creates a
 * short-lived `billing_portal.session` for one customer and redirects them to its `url`.
 * Every action in the portal goes through the same domain code as the API, so it emits
 * the usual events (customer.updated, customer.subscription.updated, ...).
 */

const LIVE = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];

function defaultFeatures() {
  return {
    customer_update: { allowed_updates: ['email', 'address', 'name', 'phone'], enabled: true },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] }, enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
    subscription_update: { default_allowed_updates: ['price', 'quantity'], enabled: false, products: [] as any[], proration_behavior: 'create_prorations' },
  };
}

async function applyConfig(ctx: Ctx, cfg: any, p: Params) {
  if (p.business_profile) for (const k of ['headline', 'privacy_policy_url', 'terms_of_service_url']) if (p.business_profile[k] !== undefined) cfg.business_profile[k] = p.business_profile[k] || null;
  if (p.default_return_url !== undefined) cfg.default_return_url = p.default_return_url || null;
  if (p.active !== undefined) cfg.active = bool(p, 'active');
  const f = p.features ?? {};
  if (f.customer_update) {
    if (f.customer_update.enabled !== undefined) cfg.features.customer_update.enabled = bool(f.customer_update, 'enabled');
    const au = arr(f.customer_update, 'allowed_updates');
    if (au) cfg.features.customer_update.allowed_updates = au.map(String).filter((x) => ['email', 'address', 'name', 'phone', 'shipping', 'tax_id'].includes(x));
  }
  for (const k of ['invoice_history', 'payment_method_update'] as const) if (f[k]?.enabled !== undefined) cfg.features[k].enabled = bool(f[k], 'enabled');
  if (f.subscription_cancel) {
    const sc = f.subscription_cancel;
    if (sc.enabled !== undefined) cfg.features.subscription_cancel.enabled = bool(sc, 'enabled');
    if (sc.mode !== undefined) cfg.features.subscription_cancel.mode = oneOf(sc, 'mode', ['at_period_end', 'immediately'] as const);
    if (sc.proration_behavior !== undefined) cfg.features.subscription_cancel.proration_behavior = oneOf(sc, 'proration_behavior', ['none', 'create_prorations', 'always_invoice'] as const);
  }
  if (f.subscription_update) {
    const su = f.subscription_update;
    if (su.enabled !== undefined) cfg.features.subscription_update.enabled = bool(su, 'enabled');
    if (su.proration_behavior !== undefined) cfg.features.subscription_update.proration_behavior = oneOf(su, 'proration_behavior', ['none', 'create_prorations', 'always_invoice'] as const);
    const dau = arr(su, 'default_allowed_updates');
    if (dau) cfg.features.subscription_update.default_allowed_updates = dau.map(String).filter((x) => ['price', 'quantity', 'promotion_code'].includes(x));
    const products = arr(su, 'products');
    if (products) {
      cfg.features.subscription_update.products = [];
      for (const pr of products) {
        const product = await getObject<any>(ctx.accountId, 'product', String(pr.product), 'product', 'features[subscription_update][products][][product]');
        const prices = (arr(pr, 'prices') ?? []).map(String);
        for (const id of prices) {
          const price = await getObject<any>(ctx.accountId, 'price', id, 'price', 'features[subscription_update][products][][prices]');
          if (price.product !== product.id || price.type !== 'recurring') throw invalid(`Price ${id} must be a recurring price of ${product.id}.`, 'features[subscription_update][products]');
        }
        cfg.features.subscription_update.products.push({ product: product.id, prices });
      }
    }
    if (cfg.features.subscription_update.enabled && !cfg.features.subscription_update.products.length) {
      throw invalid('To enable subscription updates, list the products (and prices) customers can switch between.', 'features[subscription_update][products]');
    }
  }
  cfg.metadata = metadata(p, cfg.metadata);
  cfg.updated = nowSeconds();
}

export async function createConfiguration(ctx: Ctx, p: Params) {
  const now = nowSeconds();
  const existingDefault = await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'billing_portal.configuration' AND (data->>'is_default')::boolean", [ctx.accountId]);
  const cfg: any = {
    id: newId('bpc'), object: 'billing_portal.configuration', active: true, application: null,
    business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
    created: now, default_return_url: null, features: defaultFeatures(), is_default: !existingDefault, livemode: false,
    login_page: { enabled: false, url: null }, metadata: {}, updated: now,
  };
  await applyConfig(ctx, cfg, p);
  await insertObject(ctx.accountId, cfg);
  await emit(ctx, 'billing_portal.configuration.created', cfg);
  return cfg;
}

export async function updateConfiguration(ctx: Ctx, id: string, p: Params) {
  const cfg = await getObject<any>(ctx.accountId, 'billing_portal.configuration', id, 'billing portal configuration');
  await applyConfig(ctx, cfg, p);
  await saveObject(ctx.accountId, cfg);
  await emit(ctx, 'billing_portal.configuration.updated', cfg);
  return cfg;
}

/** The default configuration; created with sensible defaults the first time it is needed. */
export async function defaultConfiguration(ctx: Ctx) {
  const row = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'billing_portal.configuration' AND (data->>'is_default')::boolean", [ctx.accountId]);
  return row?.data ?? createConfiguration(ctx, {});
}

export async function createPortalSession(ctx: Ctx, p: Params) {
  const customer = await getObject<any>(ctx.accountId, 'customer', str(p, 'customer', { required: true })!, 'customer', 'customer');
  if (customer.deleted) throw invalid('This customer has been deleted.', 'customer');
  const cfg = p.configuration ? await getObject<any>(ctx.accountId, 'billing_portal.configuration', String(p.configuration), 'billing portal configuration', 'configuration') : await defaultConfiguration(ctx);
  if (!cfg.active) throw invalid('This configuration is inactive.', 'configuration');
  const returnUrl = str(p, 'return_url') ?? cfg.default_return_url;
  if (!returnUrl) throw missing('return_url');
  let flow: any = null;
  if (p.flow_data) {
    const type = oneOf(p.flow_data, 'type', ['payment_method_update', 'subscription_cancel', 'subscription_update'] as const);
    if (!type) throw missing('flow_data[type]');
    const subId = p.flow_data[type]?.subscription;
    if (type !== 'payment_method_update') {
      if (!subId) throw missing(`flow_data[${type}][subscription]`);
      const sub = await getObject<any>(ctx.accountId, 'subscription', String(subId), 'subscription', `flow_data[${type}][subscription]`);
      if (sub.customer !== customer.id) throw invalid('The subscription belongs to a different customer.', `flow_data[${type}][subscription]`);
    }
    flow = {
      after_completion: { hosted_confirmation: null, redirect: p.flow_data.after_completion?.redirect?.return_url ? { return_url: p.flow_data.after_completion.redirect.return_url } : null, type: p.flow_data.after_completion?.type ?? 'portal_homepage' },
      payment_method_update: null, subscription_cancel: type === 'subscription_cancel' ? { subscription: subId, retention: null } : null,
      subscription_update: type === 'subscription_update' ? { subscription: subId } : null, subscription_update_confirm: null, type,
    };
  }
  const now = nowSeconds();
  const token = base62(40);
  const session = {
    id: newId('bps'), object: 'billing_portal.session', configuration: cfg.id, created: now, customer: customer.id, flow,
    livemode: false, locale: str(p, 'locale') ?? null, on_behalf_of: str(p, 'on_behalf_of') ?? null, return_url: returnUrl,
    url: `${ctx.baseUrl}/portal/${token}`, _token: token, _expires: now + 3600,
  };
  await insertObject(ctx.accountId, session);
  await emit(ctx, 'billing_portal.session.created', session);
  return session;
}

// ---------------------------------------------------------------- hosted portal

export async function findPortalSession(token: string) {
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'billing_portal.session' AND data->>'_token' = $1", [token]);
  if (!row || row.data._expires < nowSeconds()) throw new ApiError(404, 'invalid_request_error', 'This portal link has expired. Return to the merchant and open the billing portal again.', { code: 'portal_session_expired' });
  return row;
}

/** Everything the portal page shows, filtered by the configuration's features. */
export async function portalView(ctx: Ctx, session: any) {
  const cfg = await getObject<any>(ctx.accountId, 'billing_portal.configuration', session.configuration);
  const c = await getObject<any>(ctx.accountId, 'customer', session.customer);
  const acct = await getAccount(ctx.accountId);
  const subs = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription' AND data->>'customer' = $2 ORDER BY seq DESC", [ctx.accountId, c.id])).map((r) => r.data).filter((s) => LIVE.includes(s.status));
  const productName = async (id: string) => (await findObject<any>(ctx.accountId, 'product', id))?.name ?? 'Plan';
  const subscriptions = [];
  for (const s of subs) {
    const latest = s.latest_invoice ? await findObject<any>(ctx.accountId, 'invoice', s.latest_invoice) : null;
    subscriptions.push({
      id: s.id, status: s.status, pay_url: latest?.status === 'open' ? latest.hosted_invoice_url : null, cancel_at_period_end: s.cancel_at_period_end, current_period_end: s.current_period_end, trial_end: s.trial_end, currency: s.currency,
      items: await Promise.all(s.items.data.map(async (it: any) => ({ id: it.id, price: it.price.id, product: it.price.product, name: await productName(it.price.product), unit_amount: it.price.unit_amount, amount: licensedAmount(it.price, it.quantity ?? 0), summary: priceSummary(it.price), metered: it.price.recurring.usage_type === 'metered', interval: it.price.recurring.interval, interval_count: it.price.recurring.interval_count, quantity: it.quantity }))),
      discount: s.discount ? { name: s.discount.coupon.name ?? s.discount.coupon.id, percent_off: s.discount.coupon.percent_off, amount_off: s.discount.coupon.amount_off } : null,
    });
  }
  const pms = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'payment_method' AND data->>'customer' = $2 AND data->>'type' = 'card' ORDER BY seq DESC", [ctx.accountId, c.id])).map((r) => r.data);
  const invoices = cfg.features.invoice_history.enabled
    ? (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'invoice' AND data->>'customer' = $2 AND data->>'status' IN ('open', 'paid', 'uncollectible') ORDER BY seq DESC LIMIT 24", [ctx.accountId, c.id])).map((r) => r.data)
    : [];
  const plans = [];
  if (cfg.features.subscription_update.enabled) {
    for (const pr of cfg.features.subscription_update.products) {
      const name = await productName(pr.product);
      for (const id of pr.prices) {
        const price = await findObject<any>(ctx.accountId, 'price', id);
        if (price?.active) plans.push({ price: id, product: pr.product, name, unit_amount: price.unit_amount, summary: priceSummary(price), metered: price.recurring.usage_type === 'metered', currency: price.currency, interval: price.recurring.interval, interval_count: price.recurring.interval_count });
      }
    }
  }
  return {
    business: { name: acct?.business_profile?.name ?? acct?.settings?.dashboard?.display_name ?? 'Merchant', ...cfg.business_profile },
    return_url: session.return_url,
    flow: session.flow,
    features: cfg.features,
    customer: { name: c.name, email: c.email, phone: c.phone, address: c.address, default_payment_method: c.invoice_settings?.default_payment_method ?? null },
    subscriptions,
    plans,
    payment_methods: pms.map((pm) => ({ id: pm.id, brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year })),
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency, created: i.status_transitions.finalized_at ?? i.created, hosted_invoice_url: i.hosted_invoice_url, invoice_pdf: i.invoice_pdf })),
  };
}

async function ownSub(ctx: Ctx, session: any, subId: string) {
  const sub = await getObject<any>(ctx.accountId, 'subscription', subId, 'subscription');
  if (sub.customer !== session.customer) throw new ApiError(404, 'invalid_request_error', 'No such subscription.', { code: 'resource_missing' });
  return sub;
}

export async function portalAction(ctx: Ctx, session: any, action: string, b: any) {
  const cfg = await getObject<any>(ctx.accountId, 'billing_portal.configuration', session.configuration);
  const f = cfg.features;
  const deny = (what: string) => new ApiError(403, 'permission_error', `The billing portal doesn't allow ${what}.`);
  switch (action) {
    case 'customer': {
      if (!f.customer_update.enabled) throw deny('updating customer details');
      const p: any = {};
      for (const k of ['name', 'email', 'phone', 'address']) if (b[k] !== undefined && f.customer_update.allowed_updates.includes(k)) p[k] = b[k];
      return updateCustomer(ctx, session.customer, p);
    }
    case 'cancel': {
      if (!f.subscription_cancel.enabled) throw deny('canceling subscriptions');
      const sub = await ownSub(ctx, session, String(b.subscription));
      const reason = f.subscription_cancel.cancellation_reason.enabled && f.subscription_cancel.cancellation_reason.options.includes(b.reason) ? b.reason : null;
      if (f.subscription_cancel.mode === 'immediately') {
        await cancelSubscription(ctx, sub.id, {});
      } else {
        await updateSubscription(ctx, sub.id, { cancel_at_period_end: 'true', proration_behavior: 'none' });
      }
      const s = await getObject<any>(ctx.accountId, 'subscription', sub.id);
      s.cancellation_details = { ...s.cancellation_details, feedback: reason, comment: b.comment ? String(b.comment).slice(0, 500) : null };
      return saveObject(ctx.accountId, s);
    }
    case 'renew': {
      const sub = await ownSub(ctx, session, String(b.subscription));
      return updateSubscription(ctx, sub.id, { cancel_at_period_end: 'false', proration_behavior: 'none' });
    }
    case 'preview':
    case 'update': {
      if (!f.subscription_update.enabled) throw deny('changing plans');
      const sub = await ownSub(ctx, session, String(b.subscription));
      if (!['active', 'trialing'].includes(sub.status)) throw invalid('Pay the outstanding invoice before changing this plan.', 'subscription', 'subscription_payment_required');
      const allowed = new Set(f.subscription_update.products.flatMap((x: any) => x.prices));
      const price = String(b.price ?? sub.items.data[0].price.id);
      if (!allowed.has(price) && price !== sub.items.data[0].price.id) throw deny(`switching to ${price}`);
      const target = await getObject<any>(ctx.accountId, 'price', price);
      const metered = target.recurring?.usage_type === 'metered';
      const quantity = metered ? undefined : f.subscription_update.default_allowed_updates.includes('quantity') ? Math.max(1, Number(b.quantity ?? sub.items.data[0].quantity ?? 1)) : sub.items.data[0].quantity ?? 1;
      const params: any = { items: [{ id: sub.items.data[0].id, price, ...(quantity === undefined ? {} : { quantity }) }], proration_behavior: f.subscription_update.proration_behavior, cancel_at_period_end: 'false' };
      if (b.promotion_code) {
        if (!f.subscription_update.default_allowed_updates.includes('promotion_code')) throw deny('applying promotion codes');
        const { findByCode } = await import('./promotions.ts');
        params.promotion_code = (await findByCode(ctx, String(b.promotion_code))).id;
      }
      if (action === 'update') return updateSubscription(ctx, sub.id, params);
      // Dry run: apply the change with prorations, read the upcoming invoice, then roll back.
      let preview: any;
      const ROLLBACK = new Error('rollback');
      try {
        await transaction(async () => {
          await updateSubscription(ctx, sub.id, { ...params, proration_behavior: f.subscription_update.proration_behavior === 'none' ? 'none' : 'create_prorations' });
          preview = await previewUpcoming(ctx, sub.id);
          throw ROLLBACK;
        });
      } catch (e) {
        if (e !== ROLLBACK) throw e;
      }
      const prorations = preview.lines.data.filter((l: any) => l.proration).reduce((s: number, l: any) => s + l.amount, 0);
      return { amount_due_next: preview.amount_due, prorations, due_now: f.subscription_update.proration_behavior === 'always_invoice' ? Math.max(0, prorations) : 0, currency: preview.currency, next_payment_attempt: preview.next_payment_attempt };
    }
    case 'setup_card': {
      if (!f.payment_method_update.enabled) throw deny('updating payment methods');
      const si = await createSetupIntent(ctx, { customer: session.customer, usage: 'off_session', metadata: { billing_portal_session: session.id } });
      return { client_secret: si.client_secret };
    }
    case 'default_card': {
      if (!f.payment_method_update.enabled) throw deny('updating payment methods');
      const pm = await getObject<any>(ctx.accountId, 'payment_method', String(b.payment_method), 'PaymentMethod');
      if (pm.customer !== session.customer) throw invalid('That card is not saved on this customer.', 'payment_method');
      await updateCustomer(ctx, session.customer, { invoice_settings: { default_payment_method: pm.id } });
      // Live subscriptions follow the new default card, as in the hosted portal.
      const subs = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription' AND data->>'customer' = $2", [ctx.accountId, session.customer])).map((r) => r.data).filter((s) => LIVE.includes(s.status));
      for (const s of subs) { s.default_payment_method = pm.id; await saveObject(ctx.accountId, s); }
      return { ok: true };
    }
    case 'remove_card': {
      if (!f.payment_method_update.enabled) throw deny('updating payment methods');
      const pm = await getObject<any>(ctx.accountId, 'payment_method', String(b.payment_method), 'PaymentMethod');
      if (pm.customer !== session.customer) throw invalid('That card is not saved on this customer.', 'payment_method');
      const c = await getObject<any>(ctx.accountId, 'customer', session.customer);
      if (c.invoice_settings?.default_payment_method === pm.id) throw invalid('Make another card the default before removing this one.', 'payment_method');
      return detachPaymentMethod(ctx, pm.id);
    }
    default:
      throw new ApiError(404, 'invalid_request_error', 'Unknown portal action.');
  }
}
