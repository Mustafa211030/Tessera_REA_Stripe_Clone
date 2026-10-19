import { query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { nowSeconds } from '../lib/ids.ts';
import type { Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { QUARTET_LIMITS } from './quartet.ts';
import { insertObject, saveObject } from './store.ts';

/**
 * Payment method configuration (Settings → Payment methods).
 *
 * Every account has one default configuration. Checkout Sessions without
 * `payment_method_types`, and PaymentIntents with `automatic_payment_methods[enabled]`,
 * offer every method that is turned on here and fits the payment (currency, amount, mode).
 *
 *   card             cards typed into the card element
 *   device_wallet    simulated phone wallets (a "Wallet" button; cards with card.wallet)
 *   oneclick         Tessera one-click checkout: saved details for returning customers
 *   us_bank_account  ACH Direct Debit (instant verification or microdeposits)
 *   quartet          Pay in 4 with Quartet, a fictional buy-now-pay-later provider
 */
export const METHODS = {
  card: { label: 'Cards', description: 'Visa, Mastercard, American Express and Discover typed into the card form.', defaultOn: true },
  device_wallet: { label: 'Device wallets', description: 'Customers pay with a card saved in their phone or browser wallet (simulated sheet in test mode).', defaultOn: true },
  oneclick: { label: 'One-click checkout', description: 'Returning customers confirm with a code sent by email and pay with saved details.', defaultOn: true },
  us_bank_account: { label: 'ACH Direct Debit', description: 'US bank accounts, verified instantly with Financial Connections or with microdeposits. USD only; settles in a few days.', defaultOn: false },
  quartet: { label: 'Pay in 4 (Quartet)', description: 'Customers split purchases into 4 interest-free payments every two weeks. You are paid in full up front.', defaultOn: false },
} as const;
export type Method = keyof typeof METHODS;

const pref = (on: boolean, available = true) => ({ available, display_preference: { overridable: null, preference: on ? 'on' : 'off', value: on ? 'on' : 'off' } });

async function stored(accountId: string) {
  const row = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'payment_method_configuration' ORDER BY seq LIMIT 1", [accountId]);
  return row[0]?.data ?? null;
}

export async function getConfig(ctx: Ctx) {
  const existing = await stored(ctx.accountId);
  if (existing) return existing;
  const cfg: any = {
    id: `pmc_${ctx.accountId.replace(/^acct_/, '').slice(0, 20)}${String(nowSeconds()).slice(-4)}`, object: 'payment_method_configuration',
    active: true, application: null, is_default: true, livemode: false, name: 'Default', parent: null,
  };
  for (const [k, m] of Object.entries(METHODS)) cfg[k] = pref(m.defaultOn);
  await insertObject(ctx.accountId, cfg);
  return cfg;
}

export async function isOn(ctx: Ctx, m: Method) {
  return (await getConfig(ctx))[m]?.display_preference?.value === 'on';
}

export async function listConfigs(ctx: Ctx) {
  const cfg = await getConfig(ctx);
  return { object: 'list', data: [cfg], has_more: false, url: '/v1/payment_method_configurations' };
}

export async function retrieveConfig(ctx: Ctx, id: string) {
  const cfg = await getConfig(ctx);
  if (cfg.id !== id) throw new ApiError(404, 'invalid_request_error', `No such payment method configuration: '${id}'`, { param: 'id', code: 'resource_missing' });
  return cfg;
}

export async function updateConfig(ctx: Ctx, id: string, p: Params) {
  const cfg = await retrieveConfig(ctx, id);
  const before = JSON.parse(JSON.stringify(cfg));
  if (p.name !== undefined) cfg.name = String(p.name).slice(0, 100);
  for (const k of Object.keys(METHODS) as Method[]) {
    const v = p[k]?.display_preference?.preference;
    if (v === undefined) continue;
    if (!['on', 'off', 'none'].includes(String(v))) throw invalid(`${k}[display_preference][preference] must be one of on, off, none.`, `${k}[display_preference][preference]`);
    const on = v === 'on' || (v === 'none' && METHODS[k].defaultOn);
    cfg[k] = pref(on);
    cfg[k].display_preference.preference = String(v);
  }
  for (const k of Object.keys(p)) if (!['name', 'id', 'active', ...Object.keys(METHODS)].includes(k)) throw invalid(`Received unknown parameter: ${k}`, k, 'parameter_unknown');
  await saveObject(ctx.accountId, cfg);
  await emit(ctx, 'payment_method_configuration.updated' as string, cfg, before);
  return cfg;
}

/** Payment method types that can be offered for a payment, given what is turned on. */
export async function eligibleTypes(ctx: Ctx, f: { currency: string; amount: number; mode: 'payment' | 'subscription' | 'setup'; allowRedirects?: boolean }) {
  const cfg = await getConfig(ctx);
  const on = (m: Method) => cfg[m]?.display_preference?.value === 'on';
  const types: string[] = [];
  if (on('card') || on('device_wallet') || on('oneclick')) types.push('card');
  if (on('us_bank_account') && f.currency === 'usd' && f.mode === 'payment') types.push('us_bank_account');
  const lim = QUARTET_LIMITS[f.currency];
  if (on('quartet') && f.allowRedirects !== false && f.mode === 'payment' && lim && f.amount >= lim[0] && f.amount <= lim[1]) types.push('quartet');
  if (!types.length) throw invalid('No payment methods are turned on for this payment. Turn methods on in Settings → Payment methods, or pass payment_method_types.', 'payment_method_types', 'payment_method_unavailable');
  return types;
}

/** Validates an explicit `payment_method_types` list for a Checkout Session. */
export function checkTypes(types: string[], f: { currency: string; amount: number; mode: string }) {
  for (const t of types) {
    if (!['card', 'us_bank_account', 'quartet'].includes(t)) throw invalid(`The payment method type "${t}" is invalid. Supported types: card, us_bank_account, quartet.`, 'payment_method_types');
    if (t === 'us_bank_account' && f.currency !== 'usd') throw invalid('us_bank_account only supports usd.', 'payment_method_types', 'payment_method_currency_mismatch');
    if (t === 'us_bank_account' && f.mode !== 'payment') throw invalid('us_bank_account can only be used with mode=payment in Checkout.', 'payment_method_types');
    if (t === 'quartet') {
      const lim = QUARTET_LIMITS[f.currency];
      if (!lim) throw invalid(`quartet does not support ${f.currency}. Supported currencies: ${Object.keys(QUARTET_LIMITS).join(', ')}.`, 'payment_method_types', 'payment_method_currency_mismatch');
      if (f.mode !== 'payment') throw invalid('quartet can only be used with mode=payment.', 'payment_method_types');
    }
  }
  return types;
}
