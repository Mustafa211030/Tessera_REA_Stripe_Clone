import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { ApiError, invalid, unexpectedState } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { int, metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { getBalance } from './balance.ts';
import { insufficientFunds } from './connect/transfers.ts';
import { emit } from './events.ts';
import { post } from './ledger.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/**
 * Carbon removal orders (Climate-style). Orders are paid from the available balance:
 *
 *   open ──(CLIMATE_CONFIRM_SECONDS)──► confirmed ──(test helper)──► delivered
 *     └──────────── cancel (refunds the full amount) ───┘
 *
 * The catalog, suppliers and prices are fictional and the same for every account. Each
 * product's remaining tonnage is its capacity minus all open, confirmed and delivered orders.
 * Fees are 3% of the subtotal, shown separately as amount_fees.
 */

const FEE_RATE = 0.03;

export const SUPPLIERS = [
  { id: 'climsup_basalt_ridge', object: 'climate.supplier', info_url: null, livemode: false, locations: [{ city: 'Reykjanes', country: 'IS', latitude: 63.83, longitude: -22.63, region: null }], name: 'Basalt Ridge Mineralization', removal_pathway: 'enhanced_weathering' },
  { id: 'climsup_kelp_current', object: 'climate.supplier', info_url: null, livemode: false, locations: [{ city: 'Halifax', country: 'CA', latitude: 44.65, longitude: -63.57, region: 'NS' }], name: 'Kelp Current Sinking', removal_pathway: 'biomass_carbon_removal_and_storage' },
  { id: 'climsup_clearsky_dac', object: 'climate.supplier', info_url: null, livemode: false, locations: [{ city: 'Laramie', country: 'US', latitude: 41.31, longitude: -105.59, region: 'WY' }], name: 'Clearsky Direct Air Capture', removal_pathway: 'direct_air_capture' },
];

type ProductDef = { id: string; name: string; delivery_year: number; capacity: number; price: number; suppliers: string[] };
const PRODUCTS: ProductDef[] = [
  { id: 'climsku_tessera_portfolio_2027', name: 'Tessera removal portfolio 2027', delivery_year: 2027, capacity: 25_000, price: 50_000, suppliers: ['climsup_basalt_ridge', 'climsup_kelp_current', 'climsup_clearsky_dac'] },
  { id: 'climsku_direct_air_capture_2028', name: 'Direct air capture 2028', delivery_year: 2028, capacity: 5_000, price: 80_000, suppliers: ['climsup_clearsky_dac'] },
];

const fees = (subtotal: number) => Math.round(subtotal * FEE_RATE);

async function sold(productId: string) {
  const row = await one<{ t: string | null }>(
    "SELECT sum((data->>'metric_tons')::numeric)::text AS t FROM objects WHERE type = 'climate.order' AND data->>'product' = $1 AND data->>'status' <> 'canceled'",
    [productId],
  );
  return Number(row?.t ?? 0);
}

async function presentProduct(d: ProductDef) {
  const available = Math.max(0, Math.round((d.capacity - (await sold(d.id))) * 1000) / 1000);
  return {
    id: d.id, object: 'climate.product', created: 1735689600, current_prices_per_metric_ton: { usd: { amount_fees: fees(d.price), amount_subtotal: d.price, amount_total: d.price + fees(d.price) } },
    delivery_year: d.delivery_year, livemode: false, metric_tons_available: String(available), name: d.name, suppliers: d.suppliers.map((s) => SUPPLIERS.find((x) => x.id === s)!),
  };
}

const listOf = <T>(data: T[], url: string) => ({ object: 'list' as const, data, has_more: false, url });

export async function listProducts() { return listOf(await Promise.all(PRODUCTS.map(presentProduct)), '/v1/climate/products'); }
export async function getProduct(id: string) {
  const d = PRODUCTS.find((p) => p.id === id);
  if (!d) throw new ApiError(404, 'invalid_request_error', `No such climate product: '${id}'`, { param: 'product', code: 'resource_missing' });
  return presentProduct(d);
}
export const listSuppliers = () => listOf(SUPPLIERS, '/v1/climate/suppliers');
export function getSupplier(id: string) {
  const s = SUPPLIERS.find((x) => x.id === id);
  if (!s) throw new ApiError(404, 'invalid_request_error', `No such climate supplier: '${id}'`, { param: 'id', code: 'resource_missing' });
  return s;
}

function txn(type: string, amount: number, source: string, description: string) {
  const now = nowSeconds();
  return {
    id: newId('txn'), object: 'balance_transaction', amount, available_on: now, created: now, currency: 'usd', description, exchange_rate: null,
    fee: 0, fee_details: [], livemode: false, net: amount, reporting_category: 'climate_order', source, status: 'available', type, _network_settled: true,
  };
}

const toTons = (n: number) => String(Math.round(n * 1000) / 1000);

export async function createOrder(ctx: Ctx, p: Params) {
  const product = await getProduct(str(p, 'product', { required: true })!);
  const def = PRODUCTS.find((x) => x.id === product.id)!;
  const currency = (str(p, 'currency') ?? 'usd').toLowerCase();
  if (currency !== 'usd') throw invalid('Carbon removal can only be bought in usd.', 'currency');
  if ((p.metric_tons === undefined) === (p.amount === undefined)) throw invalid('Provide exactly one of metric_tons or amount.', p.amount === undefined ? 'metric_tons' : 'amount');
  let tons: number, subtotal: number, fee: number;
  if (p.metric_tons !== undefined) {
    tons = Number(p.metric_tons);
    if (!Number.isFinite(tons) || tons < 0.001) throw invalid('metric_tons must be at least 0.001 (1 kilogram).', 'metric_tons');
    tons = Math.round(tons * 1000) / 1000;
    subtotal = Math.round(tons * def.price);
    fee = fees(subtotal);
  } else {
    const total = int(p, 'amount', { min: 1 })!;
    subtotal = Math.round(total / (1 + FEE_RATE));
    fee = total - subtotal;
    tons = Math.floor((subtotal / def.price) * 1000) / 1000;
    if (tons < 0.001) throw invalid(`The amount is too small; one kilogram costs ${((def.price + fees(def.price)) / 1000 / 100).toFixed(2)} USD.`, 'amount');
  }
  if (tons > Number(product.metric_tons_available)) throw invalid(`Only ${product.metric_tons_available} metric tons of ${product.name} are available.`, 'metric_tons', 'climate_product_unavailable');
  const total = subtotal + fee;
  const avail = (await getBalance(ctx.accountId)).available.find((b: any) => b.currency === 'usd')?.amount ?? 0;
  if (total > avail) throw insufficientFunds();

  const now = nowSeconds();
  const order: any = {
    id: newId('climorder'), object: 'climate.order', amount_fees: fee, amount_subtotal: subtotal, amount_total: total,
    beneficiary: p.beneficiary?.public_name ? { public_name: String(p.beneficiary.public_name).slice(0, 100) } : null,
    canceled_at: null, cancellation_reason: null, certificate: null, confirmed_at: null, created: now, currency, delayed_at: null, delivered_at: null,
    delivery_details: [], expected_delivery_year: def.delivery_year, livemode: false, metadata: metadata(p), metric_tons: toTons(tons),
    product: product.id, product_substituted_at: null, status: 'open', _token: randomBytes(16).toString('base64url'),
  };
  const t = txn('climate_order_purchase', -total, order.id, `Carbon removal: ${order.metric_tons} t of ${product.name}`);
  await post(ctx.accountId, 'usd', [{ account: 'merchant_available', amount: total }, { account: 'climate_payable', amount: -total }], order.id, `Climate order ${order.id}`);
  await insertObject(ctx.accountId, t);
  order._balance_transaction = t.id;
  await insertObject(ctx.accountId, order);
  await emit(ctx, 'climate.order.created', order);
  return order;
}

export async function updateOrder(ctx: Ctx, id: string, p: Params) {
  const o = await getObject<any>(ctx.accountId, 'climate.order', id, 'climate order');
  if (p.beneficiary !== undefined) o.beneficiary = p.beneficiary === '' || !p.beneficiary?.public_name ? null : { public_name: String(p.beneficiary.public_name).slice(0, 100) };
  o.metadata = metadata(p, o.metadata);
  return saveObject(ctx.accountId, o);
}

export async function cancelOrder(ctx: Ctx, id: string) {
  const o = await getObject<any>(ctx.accountId, 'climate.order', id, 'climate order');
  if (!['open', 'confirmed'].includes(o.status)) throw unexpectedState(`Orders can only be canceled before delivery. This order is ${o.status}.`);
  await post(ctx.accountId, 'usd', [{ account: 'climate_payable', amount: o.amount_total }, { account: 'merchant_available', amount: -o.amount_total }], o.id, `Climate order ${o.id} canceled`);
  await insertObject(ctx.accountId, txn('climate_order_refund', o.amount_total, o.id, 'Carbon removal order canceled'));
  o.status = 'canceled';
  o.canceled_at = nowSeconds();
  o.cancellation_reason = 'requested';
  await saveObject(ctx.accountId, o);
  await emit(ctx, 'climate.order.canceled', o);
  return o;
}

/** Test helper: suppliers deliver the removal; a certificate becomes available. */
export async function deliverOrder(ctx: Ctx, id: string) {
  const o = await getObject<any>(ctx.accountId, 'climate.order', id, 'climate order');
  if (o.status === 'open') await confirm(ctx.accountId, o);
  if (o.status !== 'confirmed') throw unexpectedState(`Only confirmed orders can be delivered. This order is ${o.status}.`);
  const def = PRODUCTS.find((x) => x.id === o.product)!;
  const now = nowSeconds();
  const total = Number(o.metric_tons);
  const shares = def.suppliers.map((_, i) => Math.floor((total / def.suppliers.length) * 1000) / 1000);
  shares[0] = Math.round((total - shares.slice(1).reduce((a, b) => a + b, 0)) * 1000) / 1000;
  o.delivery_details = def.suppliers.map((sid, i) => {
    const s = SUPPLIERS.find((x) => x.id === sid)!;
    return { delivered_at: now, location: s.locations[0], metric_tons: toTons(shares[i]!), registry_url: null, supplier: s };
  }).filter((d) => Number(d.metric_tons) > 0);
  o.status = 'delivered';
  o.delivered_at = now;
  o.certificate = `${ctx.baseUrl}/climate/certificates/${o._token}`;
  // The supplier is paid: the payable clears to cash.
  await post(ctx.accountId, 'usd', [{ account: 'climate_payable', amount: o.amount_total }, { account: 'cash', amount: -o.amount_total }], o.id, `Climate order ${o.id} delivered`);
  await saveObject(ctx.accountId, o);
  await emit(ctx, 'climate.order.delivered', o);
  return o;
}

/** Test helper: a supplier reports a delay; delivery moves out a year. */
export async function delayOrder(ctx: Ctx, id: string) {
  const o = await getObject<any>(ctx.accountId, 'climate.order', id, 'climate order');
  if (!['open', 'confirmed'].includes(o.status)) throw unexpectedState(`Only undelivered orders can be delayed. This order is ${o.status}.`);
  o.expected_delivery_year += 1;
  o.delayed_at = nowSeconds();
  await saveObject(ctx.accountId, o);
  await emit(ctx, 'climate.order.delayed', o);
  return o;
}

async function confirm(accountId: string, o: any) {
  o.status = 'confirmed';
  o.confirmed_at = nowSeconds();
  await saveObject(accountId, o);
}

/** Worker: open orders are confirmed with suppliers after a short delay. */
export async function confirmOrders(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'climate.order' AND data->>'status' = 'open' AND created <= $1 LIMIT 100", [now - config.climateConfirmSeconds]);
  for (const { account_id, data } of rows) await confirm(account_id, data);
  return rows.length;
}

/** Public certificate page data. */
export async function certificate(token: string) {
  const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE type = 'climate.order' AND data->>'_token' = $1", [token]);
  if (!row || row.data.status !== 'delivered') return null;
  const acct = await one<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [row.account_id]);
  const def = PRODUCTS.find((x) => x.id === row.data.product)!;
  return {
    id: row.data.id, beneficiary: row.data.beneficiary?.public_name ?? acct?.data.business_profile?.name ?? acct?.data.settings?.dashboard?.display_name ?? 'A Tessera business',
    metric_tons: row.data.metric_tons, delivered_at: row.data.delivered_at, product: def.name, delivery_details: row.data.delivery_details,
  };
}
