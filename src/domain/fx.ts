import { invalid } from '../lib/errors.ts';
import { getAccount } from './accounts.ts';

/**
 * Currencies and foreign exchange.
 *
 * Presentment currency: what the customer pays in (PaymentIntent.currency).
 * Settlement currency: what lands in the balance. A charge settles in its presentment
 * currency when the account has a bank account for that currency (or it is the default
 * currency); otherwise it is converted to the account's default currency at the current
 * rate, the balance transaction carries `exchange_rate`, and a 1% conversion fee applies.
 *
 * Rates are a fixed reference table (units per 1 USD), so tests and demos are repeatable.
 */
export const RATES_PER_USD: Record<string, number> = {
  usd: 1, eur: 0.92, gbp: 0.79, cad: 1.37, aud: 1.52, nzd: 1.66, jpy: 151.2, inr: 83.4, sgd: 1.35,
  chf: 0.88, sek: 10.6, nok: 10.7, dkk: 6.87, mxn: 18.2, brl: 5.6, hkd: 7.8, pln: 3.98,
};
export const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp']);
export const MIN_CHARGE: Record<string, number> = { usd: 50, eur: 50, gbp: 30, cad: 50, aud: 50, nzd: 50, jpy: 50, inr: 50, sgd: 50, chf: 50, sek: 300, nok: 300, dkk: 250, mxn: 1000, brl: 50, hkd: 400, pln: 200 };

export const SUPPORTED_CURRENCIES = Object.keys(RATES_PER_USD);

export function assertSupported(cur: string, param = 'currency') {
  if (!RATES_PER_USD[cur]) throw invalid(`Invalid currency: ${cur}. Supported currencies: ${SUPPORTED_CURRENCIES.join(', ')}.`, param);
}

const toMajor = (minor: number, cur: string) => (ZERO_DECIMAL.has(cur) ? minor : minor / 100);
const toMinor = (major: number, cur: string) => Math.round(ZERO_DECIMAL.has(cur) ? major : major * 100);

/** Rate to multiply a `from` major amount by to get `to` major units. */
export function rate(from: string, to: string) {
  if (from === to) return 1;
  return Number((RATES_PER_USD[to]! / RATES_PER_USD[from]!).toFixed(6));
}

export function convert(minor: number, from: string, to: string) {
  if (from === to) return minor;
  return toMinor(toMajor(minor, from) * rate(from, to), to);
}

/** The currency a charge in `presentment` settles in for this account. */
export async function settlementCurrency(accountId: string, presentment: string) {
  const acct = await getAccount(accountId);
  const def = acct?.default_currency ?? 'usd';
  if (presentment === def) return presentment;
  const hasBank = acct?.external_accounts?.data?.some((b: any) => b.currency === presentment);
  return hasBank ? presentment : def;
}

/**
 * Processing fee in settlement currency, with the published US pricing structure:
 * 2.9% + 30 (fixed part in the settlement currency's minor units, scaled for zero-decimal),
 * +1.5% for international cards, +1% when the charge is converted.
 */
export function processingFee(settledAmount: number, settleCur: string, opts: { international?: boolean; converted?: boolean } = {}) {
  const pct = 0.029 + (opts.international ? 0.015 : 0) + (opts.converted ? 0.01 : 0);
  const fixed = ZERO_DECIMAL.has(settleCur) ? Math.round(30 * (RATES_PER_USD[settleCur]! / 100)) : convertFixed(settleCur);
  return Math.round(settledAmount * pct) + fixed;
}

function convertFixed(cur: string) {
  // 30 cents in USD; the same nominal 30 minor units for the major currencies, as on local price lists.
  return ['usd', 'eur', 'gbp', 'cad', 'aud', 'nzd', 'sgd', 'chf'].includes(cur) ? 30 : convert(30, 'usd', cur);
}

export function exchangeRateObject(base: string) {
  assertSupported(base, 'currency');
  return { id: base, object: 'exchange_rate', rates: Object.fromEntries(SUPPORTED_CURRENCIES.filter((c) => c !== base).map((c) => [c, rate(base, c)])) };
}
