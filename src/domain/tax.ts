import { one, query } from '../db/index.ts';
import { invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { arr, bool, currency, int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/**
 * Tax.
 *
 * Manual tax rates (`tax_rates`, inclusive or exclusive) can be put on invoice lines,
 * subscription items, quotes and checkout line items, or set as defaults.
 *
 * Automatic tax is a simplified Stripe Tax:
 *  - Taxes are collected only where the account has an active `tax.registration`.
 *  - The jurisdiction is the customer's address (destination-based), and the rates come from
 *    the reference table below (state sales tax, VAT, GST/HST/PST/QST, JCT, ...).
 *  - Product tax codes decide taxability (txcd_00000000 nontaxable, txcd_10000000 digital
 *    services by default, txcd_99999999 physical goods; California does not tax digital
 *    services). Customers can be `exempt` or `reverse` charge.
 *  - Price `tax_behavior` decides whether tax is inside the price (inclusive) or added on.
 * Each automatic jurisdiction gets a real tax_rate object, so invoices reference them like
 * manual rates.
 */

type Component = { tax_type: string; pct: number; level: 'country' | 'state' | 'province'; display: string; jurisdiction: string };

const US_STATES: Record<string, [string, number]> = {
  CA: ['California', 7.25], NY: ['New York', 4], TX: ['Texas', 6.25], WA: ['Washington', 6.5], FL: ['Florida', 6], IL: ['Illinois', 6.25],
  MA: ['Massachusetts', 6.25], PA: ['Pennsylvania', 6], NJ: ['New Jersey', 6.625], GA: ['Georgia', 4], CO: ['Colorado', 2.9], AZ: ['Arizona', 5.6],
  OR: ['Oregon', 0], DE: ['Delaware', 0], MT: ['Montana', 0], NH: ['New Hampshire', 0], AK: ['Alaska', 0],
};
const VAT: Record<string, [string, number]> = {
  DE: ['Germany', 19], FR: ['France', 20], NL: ['Netherlands', 21], IE: ['Ireland', 23], ES: ['Spain', 21], IT: ['Italy', 22], BE: ['Belgium', 21],
  AT: ['Austria', 20], SE: ['Sweden', 25], DK: ['Denmark', 25], PL: ['Poland', 23], PT: ['Portugal', 23], FI: ['Finland', 25.5],
  GB: ['United Kingdom', 20], CH: ['Switzerland', 8.1], NO: ['Norway', 25], MX: ['Mexico', 16],
};
export const EU = new Set(['DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'BE', 'AT', 'SE', 'DK', 'PL', 'PT', 'FI']);
const CA_HST: Record<string, number> = { ON: 13, NS: 15, NB: 15, NL: 15, PE: 15 };
const CA_PST: Record<string, [string, number]> = { BC: ['PST', 7], QC: ['QST', 9.975], SK: ['PST', 6], MB: ['RST', 7] };
const GST: Record<string, [string, number, string]> = { AU: ['GST', 10, 'Australia'], NZ: ['GST', 15, 'New Zealand'], SG: ['GST', 9, 'Singapore'], JP: ['JCT', 10, 'Japan'], IN: ['IGST', 18, 'India'] };
/** US states that do not tax electronically supplied services. */
const DIGITAL_EXEMPT_STATES = new Set(['CA']);
export const DEFAULT_TAX_CODE = 'txcd_10000000';
const SHIPPING_EXEMPT_STATES = new Set(['CA', 'MA', 'MD', 'NV', 'VA']);

function components(country: string, state: string | null): Component[] {
  if (country === 'US') {
    const s = state ? US_STATES[state] : undefined;
    return s ? [{ tax_type: 'sales_tax', pct: s[1], level: 'state', display: 'Sales Tax', jurisdiction: s[0] }] : [];
  }
  if (country === 'CA') {
    if (state && CA_HST[state]) return [{ tax_type: 'hst', pct: CA_HST[state]!, level: 'province', display: 'HST', jurisdiction: state }];
    const out: Component[] = [{ tax_type: 'gst', pct: 5, level: 'country', display: 'GST', jurisdiction: 'Canada' }];
    if (state && CA_PST[state]) out.push({ tax_type: CA_PST[state]![0].toLowerCase(), pct: CA_PST[state]![1], level: 'province', display: CA_PST[state]![0], jurisdiction: state });
    return out;
  }
  if (VAT[country]) return [{ tax_type: 'vat', pct: VAT[country]![1], level: 'country', display: 'VAT', jurisdiction: VAT[country]![0] }];
  if (GST[country]) return [{ tax_type: GST[country]![0].toLowerCase(), pct: GST[country]![1], level: 'country', display: GST[country]![0], jurisdiction: GST[country]![2] }];
  return [];
}

// ---------------------------------------------------------------- tax rates

export async function createTaxRate(ctx: Ctx, p: Params) {
  const display = str(p, 'display_name', { required: true, max: 50 })!;
  const pct = Number(p.percentage);
  if (p.percentage === undefined || p.percentage === '') throw missing('percentage');
  if (!(pct >= 0 && pct <= 100)) throw invalid('percentage must be between 0 and 100.', 'percentage');
  const inclusive = bool(p, 'inclusive');
  if (inclusive === undefined) throw missing('inclusive');
  const rate = {
    id: newId('txr'),
    object: 'tax_rate',
    active: bool(p, 'active') ?? true,
    country: str(p, 'country')?.toUpperCase() ?? null,
    created: nowSeconds(),
    description: str(p, 'description') ?? null,
    display_name: display,
    effective_percentage: pct,
    flat_amount: null,
    inclusive,
    jurisdiction: str(p, 'jurisdiction') ?? null,
    jurisdiction_level: null,
    livemode: false,
    metadata: metadata(p),
    percentage: pct,
    rate_type: 'percentage',
    state: str(p, 'state')?.toUpperCase() ?? null,
    tax_type: oneOf(p, 'tax_type', ['amusement_tax', 'communications_tax', 'gst', 'hst', 'igst', 'jct', 'lease_tax', 'pst', 'qst', 'retail_delivery_fee', 'rst', 'sales_tax', 'service_tax', 'vat'] as const) ?? null,
  };
  await insertObject(ctx.accountId, rate);
  await emit(ctx, 'tax_rate.created', rate);
  return rate;
}

/** Percentage and inclusive are immutable, as on the public API. */
export async function updateTaxRate(ctx: Ctx, id: string, p: Params) {
  const rate = await getObject<any>(ctx.accountId, 'tax_rate', id, 'tax rate');
  for (const k of ['percentage', 'inclusive']) if (p[k] !== undefined) throw invalid(`${k} cannot be changed. Create a new tax rate instead.`, k);
  if (p.active !== undefined) rate.active = bool(p, 'active');
  for (const k of ['display_name', 'description', 'jurisdiction', 'country', 'state'] as const) if (p[k] !== undefined) rate[k] = p[k] === '' ? null : String(p[k]);
  rate.metadata = metadata(p, rate.metadata);
  await saveObject(ctx.accountId, rate);
  await emit(ctx, 'tax_rate.updated', rate);
  return rate;
}

export async function loadRates(ctx: Ctx, ids: string[] | undefined, param: string) {
  const out = [];
  for (const id of ids ?? []) {
    const r = await findObject<any>(ctx.accountId, 'tax_rate', String(id));
    if (!r) throw invalid(`No such tax rate: '${id}'`, param, 'resource_missing');
    out.push(r);
  }
  return out;
}

/** Validates a tax_rates[] param and returns the ids. */
export async function taxRateIds(ctx: Ctx, p: Params, key: string) {
  const list = arr(p, key);
  if (list === undefined) return undefined;
  if (list.length > 5) throw invalid('You can apply at most 5 tax rates.', key);
  const rates = await loadRates(ctx, list.map(String), key);
  for (const r of rates) if (!r.active) throw invalid(`Tax rate ${r.id} is inactive.`, key);
  return rates.map((r) => r.id as string);
}

// ---------------------------------------------------------------- registrations

export async function createRegistration(ctx: Ctx, p: Params) {
  const country = str(p, 'country', { required: true })!.toUpperCase();
  const opts = p.country_options?.[country.toLowerCase()] ?? {};
  const state = opts.state ? String(opts.state).toUpperCase() : null;
  if (country === 'US' && !state) throw missing(`country_options[us][state]`);
  if (country === 'US' && !US_STATES[state!]) throw invalid(`Unsupported state: ${state}.`, 'country_options[us][state]');
  if (country !== 'US' && !components(country, null).length && !EU.has(country)) throw invalid(`Tax collection in ${country} is not simulated.`, 'country');
  const type = String(opts.type ?? (country === 'US' ? 'state_sales_tax' : 'standard'));
  const now = nowSeconds();
  const activeFrom = p.active_from === 'now' || p.active_from === undefined ? now : int(p, 'active_from')!;
  const reg = {
    id: newId('taxreg'),
    object: 'tax.registration',
    active_from: activeFrom,
    country,
    country_options: { [country.toLowerCase()]: { type, ...(state ? { state } : {}) } },
    created: now,
    expires_at: int(p, 'expires_at') ?? null,
    livemode: false,
    status: activeFrom > now ? 'scheduled' : 'active',
  };
  await insertObject(ctx.accountId, reg);
  return reg;
}

export async function updateRegistration(ctx: Ctx, id: string, p: Params) {
  const reg = await getObject<any>(ctx.accountId, 'tax.registration', id, 'tax registration');
  if (p.expires_at !== undefined) {
    reg.expires_at = p.expires_at === 'now' ? nowSeconds() : int(p, 'expires_at') ?? null;
    if (reg.expires_at && reg.expires_at <= nowSeconds()) reg.status = 'expired';
  }
  await saveObject(ctx.accountId, reg);
  return reg;
}

async function registered(accountId: string, country: string, state: string | null) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'tax.registration' AND data->>'status' = 'active'", [accountId]);
  return rows.some(({ data: r }) => {
    if (r.country === country) return country !== 'US' || r.country_options.us?.state === state;
    // An EU One-Stop-Shop registration covers every EU member state.
    return EU.has(country) && EU.has(r.country) && r.country_options[r.country.toLowerCase()]?.type === 'oss_union';
  });
}

// ---------------------------------------------------------------- engine

export type Location = { country: string; state: string | null; postal_code: string | null; source: string };

export function locate(customer: any, override?: any): Location | null {
  const a = override ?? customer?.shipping?.address ?? customer?.address;
  if (!a?.country) return null;
  const country = String(a.country).toUpperCase();
  const state = a.state ? String(a.state).toUpperCase() : null;
  if ((country === 'US' || country === 'CA') && !state) return null;
  return { country, state, postal_code: a.postal_code ?? null, source: override ? 'billing_address' : customer?.shipping?.address ? 'shipping_destination' : 'billing_address' };
}

type LineTax = { reason: string; inclusive: boolean; parts: { comp: Component; amount: number }[]; taxable: number; tax: number };

/** Tax for one amount at one location. `amount` already includes inclusive tax when inclusive. */
export async function taxFor(accountId: string, loc: Location, amount: number, opts: { inclusive: boolean; tax_code?: string | null; exempt?: string }): Promise<LineTax> {
  const comps = components(loc.country, loc.state);
  const none = (reason: string): LineTax => ({ reason, inclusive: opts.inclusive, parts: [], taxable: 0, tax: 0 });
  const code = opts.tax_code ?? DEFAULT_TAX_CODE;
  if (!(await registered(accountId, loc.country, loc.state))) return none('not_collecting');
  if (opts.exempt === 'exempt') return none('customer_exempt');
  if (opts.exempt === 'reverse' && (EU.has(loc.country) || loc.country === 'GB')) {
    // Reverse charge: the customer accounts for VAT, so the line carries zero-amount tax.
    const rated = comps.filter((c) => c.pct > 0);
    return { reason: 'reverse_charge', inclusive: opts.inclusive, parts: rated.map((comp) => ({ comp, amount: 0 })), taxable: amount, tax: 0 };
  }
  if (code === 'txcd_00000000') return none('product_exempt');
  // Separately stated shipping charges are not taxed in some states (e.g. California).
  if (loc.country === 'US' && code.startsWith('txcd_9201') && SHIPPING_EXEMPT_STATES.has(loc.state ?? '')) return none('not_subject_to_tax');
  if (loc.country === 'US' && code.startsWith('txcd_10') && DIGITAL_EXEMPT_STATES.has(loc.state ?? '')) return none('not_subject_to_tax');
  const taxed = comps.filter((c) => c.pct > 0);
  if (!taxed.length) return none('not_subject_to_tax');
  return split(amount, taxed, opts.inclusive, 'standard_rated');
}

function split(amount: number, comps: Component[], inclusive: boolean, reason: string): LineTax {
  const total = comps.reduce((s, c) => s + c.pct, 0);
  const base = inclusive ? amount - Math.round((amount * total) / (100 + total)) : amount;
  const parts = comps.map((comp) => ({ comp, amount: Math.round((base * comp.pct) / 100) }));
  // Inclusive: the tax parts must add up exactly to what is inside the price.
  if (inclusive) {
    const inside = amount - base;
    const diff = inside - parts.reduce((s, x) => s + x.amount, 0);
    if (parts.length) parts[parts.length - 1]!.amount += diff;
  }
  return { reason, inclusive, parts, taxable: base, tax: parts.reduce((s, x) => s + x.amount, 0) };
}

/** Finds or creates the tax_rate object that represents an automatic jurisdiction. */
async function autoRate(ctx: Ctx, loc: Location, comp: Component, inclusive: boolean) {
  const key = `${loc.country}:${comp.level === 'country' ? '' : loc.state}:${comp.tax_type}:${comp.pct}:${inclusive}`;
  const row = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'tax_rate' AND data->>'_auto_key' = $2", [ctx.accountId, key]);
  if (row) return row.data;
  const rate = {
    id: newId('txr'), object: 'tax_rate', active: true, country: loc.country, created: nowSeconds(), description: null,
    display_name: comp.display, effective_percentage: comp.pct, flat_amount: null, inclusive, jurisdiction: comp.jurisdiction,
    jurisdiction_level: comp.level === 'country' ? 'country' : 'state', livemode: false, metadata: {}, percentage: comp.pct, rate_type: 'percentage',
    state: comp.level === 'country' ? null : loc.state, tax_type: comp.tax_type, _auto_key: key,
  };
  await insertObject(ctx.accountId, rate);
  return rate;
}

// ---------------------------------------------------------------- pricing a set of lines

export type PriceLineInput = { amount: number; discountable?: boolean; tax_rates?: string[] | null; price?: any; tax_behavior?: string; tax_code?: string | null };
export type PricedLine = { discount: number; tax_amounts: { amount: number; inclusive: boolean; tax_rate: string; taxability_reason: string; taxable_amount: number }[]; amount_excluding_tax: number; reasons: string[] };

/**
 * Discount allocation plus manual or automatic tax for a set of lines.
 * Discounts are split across discountable lines in proportion to their amounts; tax is
 * computed on what remains, per line and per rate, with half-up rounding.
 */
export async function priceLines(ctx: Ctx, lines: PriceLineInput[], opts: { discountTotal?: number; defaultTaxRates?: string[] | null; automatic?: boolean; customer?: any; address?: any }) {
  const discountTotal = opts.discountTotal ?? 0;
  const eligible = lines.map((l, i) => ({ i, amt: l.discountable !== false && l.amount > 0 ? l.amount : 0 }));
  const base = eligible.reduce((s, x) => s + x.amt, 0);
  const shares = lines.map(() => 0);
  if (discountTotal && base) {
    let left = discountTotal;
    const idx = eligible.filter((x) => x.amt > 0);
    idx.forEach((x, k) => {
      const share = k === idx.length - 1 ? left : Math.round((discountTotal * x.amt) / base);
      shares[x.i] = Math.min(share, x.amt);
      left -= shares[x.i]!;
    });
  }
  const loc = opts.automatic ? locate(opts.customer, opts.address) : null;
  let exempt = opts.customer?.tax_exempt;
  if (loc && exempt !== 'exempt') {
    const { reverseChargeApplies } = await import('./taxIds.ts');
    if (await reverseChargeApplies(ctx.accountId, opts.customer, loc.country, opts.customer?._tax_ids)) exempt = 'reverse';
  }
  const priced: PricedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const taxable = l.amount - shares[i]!;
    const out: PricedLine = { discount: shares[i]!, tax_amounts: [], amount_excluding_tax: taxable, reasons: [] };
    const price = typeof l.price === 'string' ? await findObject<any>(ctx.accountId, 'price', l.price) : l.price;
    if (opts.automatic) {
      if (loc && taxable > 0) {
        const product = price?.product ? await findObject<any>(ctx.accountId, 'product', typeof price.product === 'string' ? price.product : price.product.id) : null;
        const inclusive = (l.tax_behavior ?? price?.tax_behavior) === 'inclusive';
        const t = await taxFor(ctx.accountId, loc, taxable, { inclusive, tax_code: l.tax_code ?? product?.tax_code ?? null, exempt });
        out.reasons.push(t.reason);
        for (const part of t.parts) {
          const rate = await autoRate(ctx, loc, part.comp, inclusive);
          out.tax_amounts.push({ amount: part.amount, inclusive, tax_rate: rate.id, taxability_reason: t.reason, taxable_amount: t.taxable });
        }
        if (inclusive) out.amount_excluding_tax = taxable - t.tax;
      }
    } else {
      const ids = l.tax_rates?.length ? l.tax_rates : opts.defaultTaxRates ?? [];
      const rates = await loadRates(ctx, ids, 'tax_rates');
      const inc = rates.filter((r) => r.inclusive);
      const exc = rates.filter((r) => !r.inclusive);
      const incTotal = inc.reduce((s, r) => s + r.percentage, 0);
      const exBase = taxable - Math.round((taxable * incTotal) / (100 + incTotal));
      let incLeft = taxable - exBase;
      inc.forEach((r, k) => {
        const amt = k === inc.length - 1 ? incLeft : Math.round((exBase * r.percentage) / 100);
        incLeft -= amt;
        out.tax_amounts.push({ amount: amt, inclusive: true, tax_rate: r.id, taxability_reason: 'standard_rated', taxable_amount: exBase });
      });
      for (const r of exc) out.tax_amounts.push({ amount: Math.round((exBase * r.percentage) / 100), inclusive: false, tax_rate: r.id, taxability_reason: 'standard_rated', taxable_amount: exBase });
      out.amount_excluding_tax = exBase;
    }
    priced.push(out);
  }
  const all = priced.flatMap((p) => p.tax_amounts);
  const exclusiveTax = all.filter((t) => !t.inclusive).reduce((s, t) => s + t.amount, 0);
  const inclusiveTax = all.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0);
  const byRate = new Map<string, { amount: number; inclusive: boolean; tax_rate: string; taxability_reason: string; taxable_amount: number }>();
  for (const t of all) {
    const e = byRate.get(t.tax_rate) ?? { ...t, amount: 0, taxable_amount: 0 };
    e.amount += t.amount;
    e.taxable_amount += t.taxable_amount;
    byRate.set(t.tax_rate, e);
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const totalDiscount = shares.reduce((s, x) => s + x, 0);
  return {
    lines: priced,
    subtotal,
    discount: totalDiscount,
    tax: exclusiveTax + inclusiveTax,
    exclusiveTax,
    inclusiveTax,
    total: subtotal - totalDiscount + exclusiveTax,
    total_tax_amounts: [...byRate.values()],
    automatic_status: opts.automatic ? (loc ? 'complete' : 'requires_location_inputs') : null,
    location: loc,
  };
}

// ---------------------------------------------------------------- Tax Calculations API

export async function createCalculation(ctx: Ctx, p: Params) {
  const cur = currency(p)!;
  const items = arr(p, 'line_items');
  if (!items?.length) throw missing('line_items');
  const cd = p.customer_details ?? {};
  let customer: any = null;
  if (p.customer) customer = await getObject<any>(ctx.accountId, 'customer', String(p.customer), 'customer', 'customer');
  const address = cd.address ?? customer?.address;
  const loc = locate(customer, address);
  if (!loc) throw invalid('Provide customer_details[address] with a country (and a state for the US and Canada) so the tax location can be determined.', 'customer_details[address]', 'customer_tax_location_invalid');
  let exempt = cd.taxability_override === 'customer_exempt' ? 'exempt' : cd.taxability_override === 'reverse_charge' ? 'reverse' : customer?.tax_exempt;
  const givenIds = arr(cd, 'tax_ids')?.map((t: any) => ({ type: String(t.type), value: String(t.value), verification: { status: 'pending' } }));
  if (!exempt || exempt === 'none') {
    const { reverseChargeApplies } = await import('./taxIds.ts');
    if (await reverseChargeApplies(ctx.accountId, customer, loc.country, givenIds?.length ? givenIds : undefined)) exempt = 'reverse';
  }
  const id = newId('taxcalc');
  const lineItems = [];
  const breakdown = new Map<string, any>();
  let exclusive = 0;
  let inclusive = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const amount = int(it, 'amount', { required: true, min: 0 })!;
    const behavior = oneOf(it, 'tax_behavior', ['inclusive', 'exclusive'] as const, 'exclusive')!;
    const t = await taxFor(ctx.accountId, loc, amount, { inclusive: behavior === 'inclusive', tax_code: it.tax_code ?? null, exempt });
    if (t.inclusive) inclusive += t.tax; else exclusive += t.tax;
    const parts = t.parts.length ? t.parts : [{ comp: null as any, amount: 0 }];
    lineItems.push({
      id: newId('tax_li', 18), object: 'tax.calculation_line_item', amount, amount_tax: t.tax, livemode: false, product: it.product ?? null,
      quantity: int(it, 'quantity', { min: 1 }) ?? 1, reference: str(it, 'reference') ?? `L${i + 1}`, tax_behavior: behavior, tax_code: it.tax_code ?? DEFAULT_TAX_CODE,
      tax_breakdown: parts.map((x) => ({
        amount: x.amount, jurisdiction: x.comp ? { country: loc.country, display_name: x.comp.jurisdiction, level: x.comp.level, state: x.comp.level === 'country' ? null : loc.state } : null,
        sourcing: 'destination', tax_rate_details: x.comp ? { display_name: x.comp.display, percentage_decimal: x.comp.pct.toFixed(4), tax_type: x.comp.tax_type } : null,
        taxability_reason: t.reason, taxable_amount: x.comp ? t.taxable : 0,
      })),
    });
    for (const x of parts) {
      const key = `${x.comp?.tax_type ?? 'none'}:${x.comp?.pct ?? 0}:${t.reason}:${t.inclusive}`;
      const b = breakdown.get(key) ?? {
        amount: 0, inclusive: t.inclusive, taxability_reason: t.reason, taxable_amount: 0,
        tax_rate_details: { country: loc.country, flat_amount: null, percentage_decimal: (x.comp?.pct ?? 0).toFixed(4), rate_type: 'percentage', state: loc.state, tax_type: x.comp?.tax_type ?? null },
      };
      b.amount += x.amount;
      b.taxable_amount += x.comp ? t.taxable : amount;
      breakdown.set(key, b);
    }
  }
  const subtotal = lineItems.reduce((s, l) => s + l.amount, 0);
  const calc = {
    id,
    object: 'tax.calculation',
    amount_total: subtotal + exclusive,
    created: nowSeconds(),
    currency: cur,
    customer: customer?.id ?? null,
    customer_details: { address: { country: loc.country, state: loc.state, postal_code: loc.postal_code }, address_source: cd.address_source ?? 'billing', ip_address: null, tax_ids: [], taxability_override: cd.taxability_override ?? 'none' },
    expires_at: nowSeconds() + 90 * 86400,
    livemode: false,
    ship_from_details: null,
    shipping_cost: null,
    tax_amount_exclusive: exclusive,
    tax_amount_inclusive: inclusive,
    tax_breakdown: [...breakdown.values()],
    tax_date: nowSeconds(),
    _line_items: lineItems,
  };
  await insertObject(ctx.accountId, calc);
  return calc;
}

export async function calculationLineItems(ctx: Ctx, id: string) {
  const c = await getObject<any>(ctx.accountId, 'tax.calculation', id, 'tax calculation');
  return { object: 'list', data: c._line_items, has_more: false, url: `/v1/tax/calculations/${id}/line_items` };
}

/** Records a calculation as a committed transaction (what gets reported to tax authorities). */
export async function createTransactionFromCalculation(ctx: Ctx, p: Params) {
  const calcId = str(p, 'calculation', { required: true })!;
  const reference = str(p, 'reference', { required: true })!;
  const c = await getObject<any>(ctx.accountId, 'tax.calculation', calcId, 'tax calculation', 'calculation');
  if (await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'tax.transaction' AND data->>'reference' = $2", [ctx.accountId, reference])) {
    throw invalid(`A transaction with reference '${reference}' already exists.`, 'reference', 'tax_transaction_reference_taken');
  }
  const tx = {
    id: newId('tax'), object: 'tax.transaction', created: nowSeconds(), currency: c.currency, customer: c.customer, customer_details: c.customer_details,
    line_items: { object: 'list', data: c._line_items.map((l: any) => ({ ...l, object: 'tax.transaction_line_item', type: 'transaction' })), has_more: false, url: '' },
    livemode: false, metadata: metadata(p), posted_at: nowSeconds(), reference, reversal: null, ship_from_details: null, shipping_cost: null, tax_date: c.tax_date, type: 'transaction',
  };
  await insertObject(ctx.accountId, tx);
  return tx;
}

export const supportedJurisdictions = () => ({
  us_states: Object.fromEntries(Object.entries(US_STATES).map(([k, v]) => [k, v[1]])),
  vat: Object.fromEntries(Object.entries(VAT).map(([k, v]) => [k, v[1]])),
  canada: { gst: 5, hst: CA_HST, pst: Object.fromEntries(Object.entries(CA_PST).map(([k, v]) => [k, v[1]])) },
  other: Object.fromEntries(Object.entries(GST).map(([k, v]) => [k, v[1]])),
});
