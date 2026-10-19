import { ApiError, invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import * as vault from '../vault/vault.ts';
import { emit } from './events.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/** Well-known test payment method / token shortcuts mapped to test card numbers. */
export const TEST_PAYMENT_METHODS: Record<string, string> = {
  pm_card_visa: '4242424242424242',
  pm_card_visa_debit: '4000056655665556',
  pm_card_mastercard: '5555555555554444',
  pm_card_amex: '378282246310005',
  pm_card_discover: '6011111111111117',
  pm_card_chargeDeclined: '4000000000000002',
  pm_card_chargeDeclinedInsufficientFunds: '4000000000009995',
  pm_card_chargeDeclinedLostCard: '4000000000009987',
  pm_card_chargeDeclinedStolenCard: '4000000000009979',
  pm_card_chargeDeclinedExpiredCard: '4000000000000069',
  pm_card_chargeDeclinedIncorrectCvc: '4000000000000127',
  pm_card_chargeDeclinedProcessingError: '4000000000000119',
  pm_card_authenticationRequired: '4000002760003184',
  pm_card_authenticationRequiredOnSetup: '4000002500003155',
  pm_card_authenticationRequiredSetupForOffSession: '4000002500003155',
  pm_card_authenticationRequiredChargeDeclinedInsufficientFunds: '4000008260003178',
  pm_card_threeDSecure2Required: '4000000000003220',
  pm_card_chargeCustomerFail: '4000000000000341',
  pm_card_createDispute: '4000000000000259',
  pm_card_createDisputeProductNotReceived: '4000000000002685',
  pm_card_createDisputeInquiry: '4000000000001976',
  pm_card_createIssuerFraudRecord: '4000000000005423',
  pm_card_cvcCheckFail: '4000000000000101',
  pm_card_radarBlock: '4100000000000019',
  pm_card_riskLevelElevated: '4000000000009235',
  pm_card_bypassPending: '4000000000000077',
  pm_card_br: '4000000760000002',
  pm_card_gb: '4000008260000000',
  tok_visa: '4242424242424242',
  tok_mastercard: '5555555555554444',
  tok_chargeDeclined: '4000000000000002',
  tok_createDispute: '4000000000000259',
};

/**
 * Simulated device wallet tokens: what the wallet sheet hands back after the customer confirms on
 * their device. Wallet cards carry a device cryptogram, so they never need 3-D Secure.
 */
export const WALLET_TOKENS: Record<string, string> = {
  tok_wallet_visa: '4242424242424242',
  tok_wallet_mastercard: '5555555555554444',
  tok_wallet_amex: '378282246310005',
  tok_wallet_authenticationRequired: '4000002760003184',
  tok_wallet_chargeDeclined: '4000000000000002',
};

/** Payment method types the API accepts, beyond in-person and cash balance. */
export const ONLINE_TYPES = ['card', 'us_bank_account', 'quartet'] as const;

function cardError(code: string, message: string, param: string) {
  return new ApiError(402, 'card_error', message, { code, param });
}

async function buildFromCard(ctx: Ctx, card: { number: string; exp_month: number; exp_year: number; cvc?: string }, p: Params, wallet: any = null) {
  const t = await vault.tokenize(card);
  if (!t.ok) throw cardError(t.code, t.message, t.param);
  return buildFromToken(ctx, t, p, wallet);
}

/** Saved vault data for a card: what a one-click profile keeps so the card can be reused anywhere. */
export type VaultCard = { token: string; brand: string; country: string; exp_month: number; exp_year: number; fingerprint: string; funding: string; last4: string; cvc_check?: string | null; three_d_secure_required: boolean; auth_profile: string; dispute_profile: any; risk_hint: any; bypass_pending: boolean };

export async function buildFromToken(ctx: Ctx, t: VaultCard, p: Params, wallet: any = null) {
  const bd = p.billing_details ?? {};
  const pm = {
    id: newId('pm'),
    object: 'payment_method',
    allow_redisplay: 'unspecified',
    billing_details: {
      address: { city: bd.address?.city ?? null, country: bd.address?.country ?? null, line1: bd.address?.line1 ?? null, line2: bd.address?.line2 ?? null, postal_code: bd.address?.postal_code ?? null, state: bd.address?.state ?? null },
      email: bd.email ?? null,
      name: bd.name ?? null,
      phone: bd.phone ?? null,
    },
    card: {
      brand: t.brand,
      checks: { address_line1_check: null, address_postal_code_check: bd.address?.postal_code ? 'pass' : null, cvc_check: wallet ? null : t.cvc_check ?? null },
      country: t.country,
      display_brand: t.brand,
      exp_month: t.exp_month,
      exp_year: t.exp_year,
      fingerprint: t.fingerprint,
      funding: t.funding,
      last4: t.last4,
      networks: { available: [t.brand], preferred: null },
      three_d_secure_usage: { supported: true },
      wallet,
    },
    created: nowSeconds(),
    customer: null as string | null,
    livemode: false,
    metadata: metadata(p),
    type: 'card',
    // Internal fields (leading underscore) are stripped from every API response.
    _vault_token: t.token,
    // Device wallets authenticate the customer on the device (cryptogram), so no 3-D Secure.
    _three_ds_required: wallet?.type === 'device_wallet' ? false : t.three_d_secure_required,
    _auth_profile: wallet?.type === 'device_wallet' ? 'none' : t.auth_profile,
    _dispute_profile: t.dispute_profile,
    _off_session_ok: false,
    _risk_hint: t.risk_hint,
    _bypass_pending: t.bypass_pending,
  };
  await insertObject(ctx.accountId, pm);
  return pm;
}

/** The vault fields of a card payment method (for one-click profiles). */
export function vaultCardOf(pm: any): VaultCard | null {
  if (pm?.type !== 'card' || !pm._vault_token) return null;
  const c = pm.card;
  return { token: pm._vault_token, brand: c.brand, country: c.country, exp_month: c.exp_month, exp_year: c.exp_year, fingerprint: c.fingerprint, funding: c.funding, last4: c.last4, cvc_check: null, three_d_secure_required: pm._three_ds_required, auth_profile: pm._auth_profile, dispute_profile: pm._dispute_profile, risk_hint: pm._risk_hint, bypass_pending: pm._bypass_pending };
}

const dynamicLast4 = () => String(1000 + Math.floor(Math.random() * 9000));

/** Pay in 4 with Quartet (a fictional buy-now-pay-later provider): needs the shopper's name and email. */
async function buildQuartet(ctx: Ctx, p: Params) {
  const bd = p.billing_details ?? {};
  if (!bd.email) throw invalid('billing_details[email] is required for quartet payment methods.', 'billing_details[email]', 'parameter_missing');
  if (!bd.name) throw invalid('billing_details[name] is required for quartet payment methods.', 'billing_details[name]', 'parameter_missing');
  const pm = {
    id: newId('pm'), object: 'payment_method', allow_redisplay: 'unspecified',
    billing_details: { address: { city: bd.address?.city ?? null, country: bd.address?.country ?? null, line1: bd.address?.line1 ?? null, line2: bd.address?.line2 ?? null, postal_code: bd.address?.postal_code ?? null, state: bd.address?.state ?? null }, email: String(bd.email), name: String(bd.name), phone: bd.phone ?? null },
    created: nowSeconds(), customer: null as string | null, livemode: false, metadata: metadata(p), quartet: {}, type: 'quartet',
  };
  await insertObject(ctx.accountId, pm);
  return pm;
}

/**
 * A card read by a Terminal reader (chip, contactless or swipe): a `card_present` payment method.
 * In-person cards are verified by the chip/PIN, so 3-D Secure never applies.
 */
export async function buildCardPresent(ctx: Ctx, number: string, opts: { read_method?: string; cardholder_name?: string | null } = {}) {
  const t = await vault.tokenize({ number, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3, cvc: '123' });
  if (!t.ok) throw cardError(t.code, t.message, 'card_present[number]');
  const pm = {
    id: newId('pm'),
    object: 'payment_method',
    allow_redisplay: 'unspecified',
    billing_details: { address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null }, email: null, name: opts.cardholder_name ?? null, phone: null },
    card_present: {
      brand: t.brand, brand_product: null, cardholder_name: opts.cardholder_name ?? null, country: t.country, description: null, exp_month: t.exp_month, exp_year: t.exp_year,
      fingerprint: t.fingerprint, funding: t.funding, issuer: null, last4: t.last4, networks: { available: [t.brand], preferred: null }, offline: null,
      preferred_locales: ['en'], read_method: opts.read_method ?? 'contact_emv', wallet: { type: 'unknown' },
    },
    created: nowSeconds(),
    customer: null as string | null,
    livemode: false,
    metadata: {},
    type: 'card_present',
    _vault_token: t.token,
    _three_ds_required: false,
    _auth_profile: 'none',
    _dispute_profile: t.dispute_profile,
    _off_session_ok: false,
    _risk_hint: t.risk_hint,
    _bypass_pending: t.bypass_pending,
  };
  await insertObject(ctx.accountId, pm);
  return pm;
}

/** ACH test bank accounts (routing 110000000): the account number decides the outcome of debits. */
export const ACH_TEST_OUTCOMES: Record<string, { code: string; message: string }> = {
  '000111111116': { code: 'no_account', message: 'The bank account could not be located.' },
  '000111111113': { code: 'account_closed', message: 'The bank account has been closed.' },
  '000222222227': { code: 'insufficient_funds', message: 'The bank account has insufficient funds.' },
  '000333333335': { code: 'debit_not_authorized', message: 'The customer has notified their bank that this debit was not authorized.' },
};

/** A US bank account (ACH) payment method, used by Treasury money movements. */
export async function buildBankAccount(ctx: Ctx, p: Params) {
  let b = p.us_bank_account ?? {};
  let fcaId: string | null = null;
  let bd0 = p.billing_details ?? {};
  if (b.financial_connections_account) {
    // A bank account the customer linked with Financial Connections.
    const { bankDetailsFor } = await import('./financialConnections.ts');
    fcaId = String(b.financial_connections_account);
    const d = await bankDetailsFor(ctx, fcaId);
    b = { ...b, routing_number: d.routing, account_number: d.number, account_type: d.subcategory === 'savings' ? 'savings' : 'checking' };
    if (!bd0.name) bd0 = { ...bd0, name: d.owner };
    p = { ...p, billing_details: bd0 };
  }
  const routing = String(b.routing_number ?? '').trim();
  const account = String(b.account_number ?? '').trim();
  if (!/^\d{9}$/.test(routing)) throw invalid('Routing number must have 9 digits.', 'us_bank_account[routing_number]', 'routing_number_invalid');
  if (!/^\d{4,17}$/.test(account)) throw invalid('Account number must have 4 to 17 digits.', 'us_bank_account[account_number]', 'account_number_invalid');
  const bd = p.billing_details ?? {};
  if (!bd.name) throw invalid('billing_details[name] is required for us_bank_account payment methods.', 'billing_details[name]', 'parameter_missing');
  const { createHash } = await import('node:crypto');
  const pm = {
    id: newId('pm'),
    object: 'payment_method',
    allow_redisplay: 'unspecified',
    billing_details: { address: { city: bd.address?.city ?? null, country: bd.address?.country ?? null, line1: bd.address?.line1 ?? null, line2: null, postal_code: bd.address?.postal_code ?? null, state: bd.address?.state ?? null }, email: bd.email ?? null, name: String(bd.name), phone: bd.phone ?? null },
    created: nowSeconds(),
    customer: null as string | null,
    livemode: false,
    metadata: metadata(p),
    type: 'us_bank_account',
    us_bank_account: {
      account_holder_type: b.account_holder_type === 'company' ? 'company' : 'individual', account_type: b.account_type === 'savings' ? 'savings' : 'checking',
      bank_name: routing === '110000000' ? 'TESSERA TEST BANK' : 'TEST BANK', financial_connections_account: fcaId,
      fingerprint: createHash('sha256').update(`${routing}:${account}`).digest('hex').slice(0, 16), last4: account.slice(-4), networks: { preferred: 'ach', supported: ['ach', 'us_domestic_wire'] },
      routing_number: routing, status_details: null,
    },
    _account_number: account,
  };
  await insertObject(ctx.accountId, pm);
  return pm;
}

export async function createPaymentMethod(ctx: Ctx, p: Params) {
  const type = str(p, 'type', { required: true });
  if (type === 'us_bank_account') return buildBankAccount(ctx, p);
  if (type === 'quartet') return buildQuartet(ctx, p);
  if (type !== 'card') throw invalid(`The payment method type "${type}" is not supported by this platform yet.`, 'type');
  if (p.card?.token && WALLET_TOKENS[p.card.token]) {
    return buildFromCard(ctx, { number: WALLET_TOKENS[p.card.token]!, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3 }, p, { type: 'device_wallet', dynamic_last4: dynamicLast4(), device_wallet: {} });
  }
  if (p.card?.token) {
    const num = TEST_PAYMENT_METHODS[p.card.token];
    if (!num) throw invalid(`No such token: '${p.card.token}'`, 'card[token]');
    return buildFromCard(ctx, { number: num, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3, cvc: '123' }, p);
  }
  const card = p.card;
  if (!card || typeof card !== 'object') throw missing('card');
  if (!card.number) throw missing('card[number]');
  if (!card.exp_month) throw missing('card[exp_month]');
  if (!card.exp_year) throw missing('card[exp_year]');
  return buildFromCard(ctx, { number: String(card.number), exp_month: Number(card.exp_month), exp_year: Number(card.exp_year), cvc: card.cvc }, p);
}

/** Resolve a payment_method param: an existing pm_ id, or a test shortcut such as pm_card_visa. */
export async function resolvePaymentMethod(ctx: Ctx, id: string, param = 'payment_method') {
  const existing = await findObject<any>(ctx.accountId, 'payment_method', id);
  if (existing) return existing;
  if (id === 'pm_quartet') return buildQuartet(ctx, { billing_details: { name: 'Jenny Rosen', email: 'jenny.rosen@example.com' } });
  if (id === 'pm_usBankAccount') return buildBankAccount(ctx, { us_bank_account: { routing_number: '110000000', account_number: '000123456789' }, billing_details: { name: 'Jenny Rosen' } });
  const num = TEST_PAYMENT_METHODS[id];
  if (num) return buildFromCard(ctx, { number: num, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3, cvc: '123' }, {});
  throw new ApiError(404, 'invalid_request_error', `No such PaymentMethod: '${id}'`, { param, code: 'resource_missing' });
}

export async function attachPaymentMethod(ctx: Ctx, id: string, p: Params) {
  const customer = str(p, 'customer', { required: true })!;
  await getObject(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const pm = await resolvePaymentMethod(ctx, id, 'id');
  if (pm.customer && pm.customer !== customer) throw invalid('This PaymentMethod is already attached to a different Customer.', 'customer');
  pm.customer = customer;
  await saveObject(ctx.accountId, pm);
  await emit(ctx, 'payment_method.attached', pm);
  return pm;
}

export async function detachPaymentMethod(ctx: Ctx, id: string) {
  const pm = await getObject<any>(ctx.accountId, 'payment_method', id, 'PaymentMethod');
  if (!pm.customer) throw invalid('The payment method you provided is not attached to a customer so detachment is impossible.', 'payment_method');
  pm.customer = null;
  await saveObject(ctx.accountId, pm);
  await emit(ctx, 'payment_method.detached', pm);
  return pm;
}
