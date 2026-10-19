import { invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { diff, emit } from './events.ts';
import { getObject, insertObject, saveObject } from './store.ts';

function address(p: any) {
  if (!p || typeof p !== 'object') return null;
  const f = (k: string) => (p[k] === undefined || p[k] === '' ? null : String(p[k]));
  return { city: f('city'), country: f('country'), line1: f('line1'), line2: f('line2'), postal_code: f('postal_code'), state: f('state') };
}

function shipping(sh: any) {
  if (!sh || typeof sh !== 'object') return null;
  if (!sh.name) throw invalid('shipping[name] is required.', 'shipping[name]', 'parameter_missing');
  return { address: address(sh.address), name: String(sh.name), phone: sh.phone ? String(sh.phone) : null };
}

/** preferred_locales: language tags such as de or fr-FR, ordered by preference. */
function localesParam(v: any): string[] | null {
  if (v === undefined) return null;
  const list = v === '' ? [] : Array.isArray(v) ? v.map(String) : typeof v === 'object' ? Object.values(v).map(String) : [String(v)];
  for (const l of list) if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(l)) throw invalid(`Invalid locale: ${l}. Use a language tag such as de or fr-FR.`, 'preferred_locales');
  return list;
}

export async function createCustomer(ctx: Ctx, p: Params) {
  const email = str(p, 'email', { max: 512 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('Invalid email address: ' + email, 'email', 'email_invalid');
  const c = {
    id: newId('cus', 14),
    object: 'customer',
    address: address(p.address),
    balance: 0,
    created: nowSeconds(),
    currency: null,
    default_source: null,
    delinquent: false,
    description: str(p, 'description') ?? null,
    email: email ?? null,
    invoice_prefix: newId('', 8).slice(1).toUpperCase(),
    invoice_settings: { custom_fields: null, default_payment_method: p.invoice_settings?.default_payment_method || null, footer: null, rendering_options: null },
    livemode: false,
    metadata: metadata(p),
    name: str(p, 'name') ?? null,
    phone: str(p, 'phone') ?? null,
    preferred_locales: localesParam(p.preferred_locales) ?? [],
    shipping: shipping(p.shipping),
    tax_exempt: oneOf(p, 'tax_exempt', ['none', 'exempt', 'reverse'] as const, 'none'),
    test_clock: str(p, 'test_clock') ?? null,
  };
  if (c.test_clock) await getObject(ctx.accountId, 'test_helpers.test_clock', c.test_clock, 'test clock', 'test_clock');
  const taxIdData = Array.isArray(p.tax_id_data) ? p.tax_id_data : p.tax_id_data && typeof p.tax_id_data === 'object' ? Object.values(p.tax_id_data) : [];
  const { validateTaxId, createCustomerTaxId } = await import('./taxIds.ts');
  taxIdData.forEach((t: any, i: number) => validateTaxId(String(t?.type ?? ''), String(t?.value ?? ''), `tax_id_data[${i}][value]`));
  await insertObject(ctx.accountId, c);
  await emit(ctx, 'customer.created', c);
  for (const [i, t] of taxIdData.entries()) await createCustomerTaxId(ctx, c.id, t, `tax_id_data[${i}]`);
  return c;
}

export async function updateCustomer(ctx: Ctx, id: string, p: Params) {
  const c = await getObject<any>(ctx.accountId, 'customer', id, 'customer');
  const before = structuredClone(c);
  for (const k of ['email', 'name', 'phone', 'description'] as const) if (p[k] !== undefined) c[k] = p[k] === '' ? null : String(p[k]);
  if (p.address !== undefined) c.address = address(p.address);
  if (p.shipping !== undefined) c.shipping = p.shipping === '' ? null : shipping(p.shipping);
  if (p.tax_exempt !== undefined) c.tax_exempt = oneOf(p, 'tax_exempt', ['none', 'exempt', 'reverse'] as const);
  if (p.preferred_locales !== undefined) c.preferred_locales = localesParam(p.preferred_locales) ?? [];
  if (p.invoice_settings?.default_payment_method !== undefined) c.invoice_settings.default_payment_method = p.invoice_settings.default_payment_method || null;
  c.metadata = metadata(p, c.metadata);
  await saveObject(ctx.accountId, c);
  await emit(ctx, 'customer.updated', c, diff(before, c));
  return c;
}

export async function deleteCustomer(ctx: Ctx, id: string) {
  const c = await getObject<any>(ctx.accountId, 'customer', id, 'customer');
  c.deleted = true;
  await saveObject(ctx.accountId, c);
  await emit(ctx, 'customer.deleted', c);
  return { id, object: 'customer', deleted: true };
}
