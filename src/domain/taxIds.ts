import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { getObject, insertObject, listObjects, saveObject } from './store.ts';
import { EU } from './tax.ts';

/**
 * Tax IDs for customers (and the account itself), with format validation and simulated
 * government verification for EU VAT, UK VAT and Australian ABN numbers:
 *
 *   pending ──(TAX_ID_VERIFY_SECONDS)──► verified | unverified | unavailable
 *
 * Test values: a number containing 111111111 is unverified, 222222222 is unavailable; any
 * other well-formed number verifies. Other types are format-checked only (unavailable).
 *
 * Reverse charge: a business customer in the EU or UK with a VAT number that isn't
 * unverified, buying from a seller based in another country, pays no VAT; invoices and
 * Checkout show a zero tax line with taxability_reason=reverse_charge.
 */

const EU_PREFIX: Record<string, string> = {
  AT: 'AT', BE: 'BE', BG: 'BG', CY: 'CY', CZ: 'CZ', DE: 'DE', DK: 'DK', EE: 'EE', EL: 'GR', ES: 'ES', FI: 'FI', FR: 'FR', HR: 'HR', HU: 'HU',
  IE: 'IE', IT: 'IT', LT: 'LT', LU: 'LU', LV: 'LV', MT: 'MT', NL: 'NL', PL: 'PL', PT: 'PT', RO: 'RO', SE: 'SE', SI: 'SI', SK: 'SK', XI: 'GB',
};
const EU_FORMATS: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/, BE: /^BE[01]\d{9}$/, DE: /^DE\d{9}$/, DK: /^DK\d{8}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/, FR: /^FR[A-Z0-9]{2}\d{9}$/,
  IE: /^IE\d{7}[A-W][A-I]?$|^IE\d[A-Z+*]\d{5}[A-W]$/, IT: /^IT\d{11}$/, NL: /^NL\d{9}B\d{2}$/, PL: /^PL\d{10}$/, PT: /^PT\d{9}$/, SE: /^SE\d{12}$/,
};

type TypeDef = { country: string | null; format: RegExp; example: string; verifies?: boolean; keepPunctuation?: boolean };
export const TYPES: Record<string, TypeDef> = {
  eu_vat: { country: null, format: /^[A-Z]{2}[A-Z0-9+*]{2,13}$/, example: 'DE123456789', verifies: true },
  gb_vat: { country: 'GB', format: /^GB(\d{9}|\d{12})$/, example: 'GB123456789', verifies: true },
  au_abn: { country: 'AU', format: /^\d{11}$/, example: '12345678912', verifies: true },
  us_ein: { country: 'US', format: /^\d{2}-\d{7}$/, example: '12-3456789', keepPunctuation: true },
  ca_bn: { country: 'CA', format: /^\d{9}$/, example: '123456789' },
  ch_vat: { country: 'CH', format: /^CHE-\d{3}\.\d{3}\.\d{3} (MWST|TVA|IVA)$/, example: 'CHE-123.456.789 MWST', keepPunctuation: true },
  no_vat: { country: 'NO', format: /^\d{9}MVA$/, example: '123456789MVA' },
  in_gst: { country: 'IN', format: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, example: '12ABCDE3456FGZH' },
  jp_cn: { country: 'JP', format: /^\d{13}$/, example: '1234567891234' },
  br_cnpj: { country: 'BR', format: /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, example: '01.234.456/5432-10', keepPunctuation: true },
  mx_rfc: { country: 'MX', format: /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/, example: 'ABC010203AB9' },
  nz_gst: { country: 'NZ', format: /^\d{8,9}$/, example: '123456789' },
  sg_uen: { country: 'SG', format: /^\d{8,9}[A-Z]$/, example: '123456789F' },
  za_vat: { country: 'ZA', format: /^4\d{9}$/, example: '4123456789' },
};

function normalize(type: string, raw: string) {
  const def = TYPES[type]!;
  const v = raw.trim().toUpperCase();
  return def.keepPunctuation ? v.replace(/\s+/g, ' ') : v.replace(/[\s.\-]/g, '');
}

export function validateTaxId(type: string, raw: string, param = 'value') {
  const def = TYPES[type];
  if (!def) throw invalid(`Invalid tax ID type: ${type}. Supported: ${Object.keys(TYPES).join(', ')}.`, 'type');
  const value = normalize(type, raw);
  let country = def.country;
  if (type === 'eu_vat') {
    const prefix = value.slice(0, 2);
    country = EU_PREFIX[prefix] ?? null;
    if (!country) throw invalid(`EU VAT numbers start with a member-state prefix (for example DE or FR); '${prefix}' isn't one.`, param, 'tax_id_invalid');
    const f = EU_FORMATS[prefix];
    if ((f && !f.test(value)) || !def.format.test(value)) throw invalid(`Invalid value for eu_vat: '${raw}'. For ${prefix}, use the format ${f ? exampleFor(prefix) : `${prefix} followed by the number`}.`, param, 'tax_id_invalid');
  } else if (!def.format.test(value)) {
    throw invalid(`Invalid value for ${type}: '${raw}'. Expected a value like ${def.example}.`, param, 'tax_id_invalid');
  }
  return { value, country: country! };
}

const exampleFor = (prefix: string) => ({ AT: 'ATU12345678', BE: 'BE0123456789', DE: 'DE123456789', DK: 'DK12345678', ES: 'ESA1234567Z', FI: 'FI12345678', FR: 'FRAB123456789', IE: 'IE1234567AB', IT: 'IT12345678912', NL: 'NL123456789B01', PL: 'PL1234567890', PT: 'PT123456789', SE: 'SE123456789123' } as Record<string, string>)[prefix] ?? prefix;

function taxIdObject(type: string, value: string, country: string, owner: any) {
  const verifies = TYPES[type]!.verifies;
  return {
    id: newId('txi'), object: 'tax_id', country, created: nowSeconds(), customer: owner.type === 'customer' ? owner.customer : null, livemode: false,
    owner: { ...owner, application: null }, type, value,
    verification: { status: verifies ? 'pending' : 'unavailable', verified_address: null, verified_name: null },
  };
}

async function createFor(ctx: Ctx, owner: any, p: Params, param = '') {
  const type = str(p, 'type', { required: true })!;
  const raw = str(p, 'value', { required: true })!;
  const { value, country } = validateTaxId(type, raw, param ? `${param}[value]` : "value");
  if (owner.type === 'customer') {
    const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM objects WHERE account_id = $1 AND type = 'tax_id' AND data->>'customer' = $2", [ctx.accountId, owner.customer]);
    if ((n?.n ?? 0) >= 25) throw invalid('A customer can have at most 25 tax IDs.', 'value');
  }
  const t = taxIdObject(type, value, country, owner);
  await insertObject(ctx.accountId, t as any);
  if (owner.type === 'customer') await emit(ctx, 'customer.tax_id.created', t as any);
  return t;
}

export async function createCustomerTaxId(ctx: Ctx, customerId: string, p: Params, param = '') {
  const c = await getObject<any>(ctx.accountId, 'customer', customerId, 'customer', 'customer');
  if (c.deleted) throw invalid(`No such customer: '${customerId}'`, 'customer', 'resource_missing');
  return createFor(ctx, { type: 'customer', customer: customerId }, p, param);
}

/** POST /v1/tax_ids: owner[type]=customer|self|account. */
export async function createTaxId(ctx: Ctx, p: Params) {
  const o = p.owner ?? { type: 'self' };
  const type = String(o.type ?? 'self');
  if (type === 'customer') {
    if (!o.customer) throw missing('owner[customer]');
    return createCustomerTaxId(ctx, String(o.customer), p);
  }
  if (type === 'self') return createFor(ctx, { type: 'self' }, p);
  if (type === 'account') {
    if (!o.account) throw missing('owner[account]');
    return createFor(ctx, { type: 'account', account: String(o.account) }, p);
  }
  throw invalid('owner[type] must be customer, self or account.', 'owner[type]');
}

export async function getTaxId(ctx: Ctx, id: string, customer?: string) {
  const t = await getObject<any>(ctx.accountId, 'tax_id', id, 'tax_id');
  if (customer && t.customer !== customer) throw new ApiError(404, 'invalid_request_error', `No such tax_id: '${id}'`, { param: 'id', code: 'resource_missing' });
  return t;
}

export async function deleteTaxId(ctx: Ctx, id: string, customer?: string) {
  const t = await getTaxId(ctx, id, customer);
  await query("DELETE FROM objects WHERE account_id = $1 AND id = $2 AND type = 'tax_id'", [ctx.accountId, id]);
  if (t.customer) await emit(ctx, 'customer.tax_id.deleted', { ...t, deleted: true });
  return { id: t.id, object: 'tax_id', deleted: true };
}

export async function listTaxIds(ctx: Ctx, p: Params, customer?: string) {
  const filters: { field: string; value: string }[] = [];
  if (customer) filters.push({ field: 'customer', value: customer });
  else if (p.owner?.type === 'customer' && p.owner.customer) filters.push({ field: 'customer', value: String(p.owner.customer) });
  else if (p.owner?.type === 'self') filters.push({ field: 'owner.type', value: 'self' });
  const list = await listObjects(ctx.accountId, 'tax_id', customer ? `/v1/customers/${customer}/tax_ids` : '/v1/tax_ids', { ...p, limit: p.limit ?? 10 }, filters.filter((f) => !f.field.includes('.')));
  if (filters.some((f) => f.field === 'owner.type')) list.data = list.data.filter((t: any) => t.owner?.type === 'self');
  return list;
}

/** Worker: pending verifications resolve after a short delay. */
export async function verifyTaxIds(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'tax_id' AND data->'verification'->>'status' = 'pending' AND created <= $1 LIMIT 100", [now - config.taxIdVerifySeconds]);
  for (const { account_id, data: t } of rows) {
    const status = t.value.includes('111111111') ? 'unverified' : t.value.includes('222222222') ? 'unavailable' : 'verified';
    let name: string | null = null;
    if (status === 'verified' && t.customer) {
      const c = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2 AND type = 'customer'", [account_id, t.customer]);
      name = (c?.data.name ?? 'Registered business').toUpperCase();
    }
    const prev = structuredClone(t.verification);
    t.verification = { status, verified_address: status === 'verified' ? `REGISTERED ADDRESS, ${t.country}` : null, verified_name: status === 'verified' ? name ?? 'REGISTERED BUSINESS' : null };
    await saveObject(account_id, t);
    if (t.customer) await emit(accountCtx(account_id), 'customer.tax_id.updated', t, { verification: prev });
  }
  return rows.length;
}

/** The customer's tax IDs as {type, value} pairs (invoice snapshot). */
export async function customerTaxIds(accountId: string, customerId: string) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'tax_id' AND data->>'customer' = $2 ORDER BY seq", [accountId, customerId]);
  return rows.map((r) => r.data);
}

/**
 * Whether reverse charge applies: a VAT-registered business customer in the EU or UK
 * buying from a seller based elsewhere. `override` lets Checkout pass a number entered on
 * the page before a customer exists.
 */
export async function reverseChargeApplies(accountId: string, customer: any, country: string, override?: { type: string; value: string }[]) {
  if (!(EU.has(country) || country === 'GB')) return false;
  const ids = override ?? (customer?.id ? await customerTaxIds(accountId, customer.id) : []);
  const vat = ids.find((t: any) => (t.type === 'eu_vat' || t.type === 'gb_vat') && t.verification?.status !== 'unverified');
  if (!vat) return false;
  const seller = await one<{ country: string | null }>("SELECT data->>'country' AS country FROM accounts WHERE id = $1", [accountId]);
  return (seller?.country ?? 'US') !== country;
}
