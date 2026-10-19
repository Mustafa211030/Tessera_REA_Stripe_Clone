import { query } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { bool, metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { findObject, getObject, insertObject, listObjects, saveObject } from './store.ts';

/**
 * Entitlements: which features a customer may use, derived from what they pay for.
 *
 *   feature            a capability your app checks, by lookup_key (e.g. "api-access")
 *   product feature    attaches a feature to a product
 *   active entitlement a feature a customer has right now, because one of their subscriptions
 *                      that is active, trialing or past due contains a product with that feature
 *
 * Whenever a customer's set of active entitlements changes (a subscription starts, changes or
 * ends, or a product's features change), `entitlements.active_entitlement_summary.updated` is
 * sent with the full new set, so an app can update access from one event.
 */
const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'];

// ---------------------------------------------------------------- features

export async function createFeature(ctx: Ctx, p: Params) {
  const name = str(p, 'name', { required: true, max: 80 })!;
  const lookup_key = str(p, 'lookup_key', { required: true, max: 80 })!;
  if (!/^[A-Za-z0-9_.:-]+$/.test(lookup_key)) throw invalid('lookup_key can contain letters, digits and _ . : - only.', 'lookup_key');
  const dup = await query("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'entitlements.feature' AND data->>'lookup_key' = $2", [ctx.accountId, lookup_key]);
  if (dup.length) throw invalid(`A feature with lookup_key '${lookup_key}' already exists.`, 'lookup_key', 'resource_already_exists');
  const f = { id: newId('feat', 20), object: 'entitlements.feature', active: true, created: nowSeconds(), livemode: false, lookup_key, metadata: metadata(p), name };
  await insertObject(ctx.accountId, f);
  return f;
}

export async function updateFeature(ctx: Ctx, id: string, p: Params) {
  const f = await getObject<any>(ctx.accountId, 'entitlements.feature', id, 'feature');
  if (p.name !== undefined) f.name = str(p, 'name', { max: 80 });
  if (p.metadata !== undefined) f.metadata = metadata(p, f.metadata);
  if (p.active !== undefined) {
    const was = f.active;
    f.active = bool(p, 'active') ?? f.active;
    await saveObject(ctx.accountId, f);
    if (was !== f.active) await refreshAll(ctx);
    return f;
  }
  await saveObject(ctx.accountId, f);
  return f;
}

export async function listFeatures(ctx: Ctx, p: Params) {
  const filters = [];
  if (p.lookup_key) filters.push({ field: 'lookup_key', value: String(p.lookup_key) });
  if (p.archived !== undefined) filters.push({ field: 'active', value: String(!(p.archived === true || p.archived === 'true')) });
  return listObjects(ctx.accountId, 'entitlements.feature', '/v1/entitlements/features', p, filters);
}

// ---------------------------------------------------------------- product features

export async function attachFeature(ctx: Ctx, productId: string, p: Params) {
  await getObject(ctx.accountId, 'product', productId, 'product');
  const featureId = str(p, 'entitlement_feature');
  if (!featureId) throw missing('entitlement_feature');
  const feature = await getObject<any>(ctx.accountId, 'entitlements.feature', featureId, 'feature', 'entitlement_feature');
  const existing = (await productFeatures(ctx.accountId, productId)).find((x) => x._feature === featureId);
  if (existing) throw invalid(`This feature is already attached to ${productId}.`, 'entitlement_feature', 'resource_already_exists');
  const pf = { id: newId('prodft', 20), object: 'product_feature', created: nowSeconds(), entitlement_feature: feature, livemode: false, _product: productId, _feature: featureId };
  await insertObject(ctx.accountId, pf);
  await refreshProduct(ctx, productId);
  return view(ctx, pf);
}

async function productFeatures(accountId: string, productId: string) {
  return (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'product_feature' AND data->>'_product' = $2 ORDER BY seq", [accountId, productId])).map((r) => r.data);
}

/** A product feature always shows the feature as it is now. */
async function view(ctx: Ctx, pf: any) {
  return { ...pf, entitlement_feature: (await findObject(ctx.accountId, 'entitlements.feature', pf._feature)) ?? pf.entitlement_feature };
}

export async function listProductFeatures(ctx: Ctx, productId: string) {
  await getObject(ctx.accountId, 'product', productId, 'product');
  const data = await Promise.all((await productFeatures(ctx.accountId, productId)).map((pf) => view(ctx, pf)));
  return { object: 'list', data, has_more: false, url: `/v1/products/${productId}/features` };
}

export async function detachFeature(ctx: Ctx, productId: string, id: string) {
  const pf = await getObject<any>(ctx.accountId, 'product_feature', id, 'product feature');
  if (pf._product !== productId) throw new ApiError(404, 'invalid_request_error', `No such product feature: '${id}'`, { code: 'resource_missing', param: 'id' });
  await query("DELETE FROM objects WHERE account_id = $1 AND id = $2 AND type = 'product_feature'", [ctx.accountId, id]);
  await refreshProduct(ctx, productId);
  return { id, object: 'product_feature', deleted: true };
}

// ---------------------------------------------------------------- active entitlements

/** Features the customer has now: active features on products of their live subscriptions. */
async function computeFor(accountId: string, customer: string) {
  const subs = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'subscription' AND data->>'customer' = $2", [accountId, customer]);
  const products = new Set<string>();
  for (const { data: s } of subs) if (ENTITLED_STATUSES.includes(s.status)) for (const it of s.items?.data ?? []) if (it.price?.product) products.add(it.price.product);
  const out = new Map<string, any>();
  for (const prod of products) {
    for (const pf of await productFeatures(accountId, prod)) {
      const f = await findObject<any>(accountId, 'entitlements.feature', pf._feature);
      if (f?.active && !out.has(f.id)) out.set(f.id, f);
    }
  }
  return [...out.values()].sort((a, b) => a.lookup_key.localeCompare(b.lookup_key));
}

const entitlementObject = (customer: string, f: any) => ({
  // Ids are stable per customer and feature, so a client can diff the list between events.
  id: `ent_${Buffer.from(`${customer}:${f.id}`).toString('base64url').slice(-24)}`, object: 'entitlements.active_entitlement', feature: f.id, livemode: false, lookup_key: f.lookup_key,
});

export async function listActive(ctx: Ctx, p: Params) {
  const customer = str(p, 'customer');
  if (!customer) throw missing('customer');
  await getObject(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const data = (await computeFor(ctx.accountId, customer)).map((f) => entitlementObject(customer, f));
  return { object: 'list', data, has_more: false, url: '/v1/entitlements/active_entitlements' };
}

export async function getActive(ctx: Ctx, id: string, p: Params) {
  const customers = p.customer ? [String(p.customer)] : (await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'customer'", [ctx.accountId])).map((r) => r.id);
  for (const c of customers) {
    const hit = (await computeFor(ctx.accountId, c)).map((f) => entitlementObject(c, f)).find((e) => e.id === id);
    if (hit) return hit;
  }
  throw new ApiError(404, 'invalid_request_error', `No such active entitlement: '${id}'`, { code: 'resource_missing', param: 'id' });
}

/** Recomputes one customer's entitlements; sends the summary event when the set changed. */
export async function refreshCustomer(ctx: Ctx, customerId: string) {
  const c = await findObject<any>(ctx.accountId, 'customer', customerId);
  if (!c) return;
  const now = (await computeFor(ctx.accountId, customerId)).map((f) => entitlementObject(customerId, f));
  const key = now.map((e) => e.lookup_key).join(',');
  if ((c._entitlements_key ?? '') === key) return;
  c._entitlements_key = key;
  await saveObject(ctx.accountId, c);
  await emit(ctx, 'entitlements.active_entitlement_summary.updated', {
    object: 'entitlements.active_entitlement_summary', customer: customerId, livemode: false,
    entitlements: { object: 'list', data: now, has_more: false, url: '/v1/entitlements/active_entitlements' },
  } as any);
}

async function refreshProduct(ctx: Ctx, productId: string) {
  const subs = await query<{ customer: string }>("SELECT DISTINCT data->>'customer' AS customer FROM objects WHERE account_id = $1 AND type = 'subscription' AND data::text LIKE $2", [ctx.accountId, `%${productId}%`]);
  for (const s of subs) await refreshCustomer(ctx, s.customer);
}

async function refreshAll(ctx: Ctx) {
  const subs = await query<{ customer: string }>("SELECT DISTINCT data->>'customer' AS customer FROM objects WHERE account_id = $1 AND type = 'subscription'", [ctx.accountId]);
  for (const s of subs) await refreshCustomer(ctx, s.customer);
}

/** Called for every event: subscription changes can change entitlements. */
export async function afterEvent(ctx: Ctx, type: string, object: any) {
  if (!type.startsWith('customer.subscription.') || !object?.customer) return;
  await refreshCustomer(ctx, object.customer);
}
