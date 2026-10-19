import { ApiError, CommitThenFail, invalid, unexpectedState } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import * as vault from '../vault/vault.ts';
import { applicationId } from './connect/accounts.ts';
import { emit } from './events.ts';
import { stripInternal } from './paymentIntents.ts';
import { resolvePaymentMethod } from './paymentMethods.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/**
 * SetupIntents save a card for later without charging it.
 *
 *   requires_payment_method → requires_confirmation → [requires_action] → succeeded
 *                                                  └─ card check declines → requires_payment_method
 *
 * Confirming runs a zero-amount check through the vault and, for cards that need strong
 * customer authentication, a 3-D Secure challenge. With usage=off_session a successful setup
 * marks the card as authenticated for future off-session payments (renewals, saved-card
 * charges), which is what lets 4000 0025 0000 3155 be charged later without the customer.
 */

const CONFIRMABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

export async function createSetupIntent(ctx: Ctx, p: Params) {
  const customer = str(p, 'customer');
  if (customer) await getObject(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const id = newId('seti');
  const si: any = {
    id,
    object: 'setup_intent',
    application: ctx.platformAccountId ? applicationId(ctx.platformAccountId) : null,
    automatic_payment_methods: p.automatic_payment_methods ? { allow_redirects: 'always', enabled: true } : null,
    cancellation_reason: null,
    client_secret: `${id}_secret_${base62(25)}`,
    created: nowSeconds(),
    customer: customer ?? null,
    description: str(p, 'description', { max: 1000 }) ?? null,
    flow_directions: null,
    last_setup_error: null,
    latest_attempt: null as string | null,
    livemode: false,
    mandate: null,
    metadata: metadata(p),
    next_action: null as any,
    on_behalf_of: str(p, 'on_behalf_of') ?? null,
    payment_method: null as string | null,
    payment_method_configuration_details: null,
    payment_method_options: { card: { mandate_options: null, network: null, request_three_d_secure: p.payment_method_options?.card?.request_three_d_secure ?? 'automatic' } },
    payment_method_types: ['card'],
    single_use_mandate: null,
    status: 'requires_payment_method',
    usage: oneOf(p, 'usage', ['on_session', 'off_session'] as const, 'off_session'),
    _three_ds_status: null as string | null,
    _return_url: str(p, 'return_url') ?? null,
  };
  if (p.payment_method) {
    const pm = await resolvePaymentMethod(ctx, String(p.payment_method));
    si.payment_method = pm.id;
    si.status = 'requires_confirmation';
  }
  await insertObject(ctx.accountId, si);
  await emit(ctx, 'setup_intent.created', si);
  if (p.confirm === 'true' || p.confirm === true) return confirmSetupIntent(ctx, id, p, si);
  return si;
}

export async function updateSetupIntent(ctx: Ctx, id: string, p: Params) {
  const si = await getObject<any>(ctx.accountId, 'setup_intent', id, 'setup_intent');
  if (!CONFIRMABLE.includes(si.status)) throw unexpectedState(`You cannot update this SetupIntent because it has a status of ${si.status}.`);
  if (p.customer !== undefined) {
    if (p.customer) await getObject(ctx.accountId, 'customer', String(p.customer), 'customer', 'customer');
    si.customer = p.customer || null;
  }
  if (p.description !== undefined) si.description = p.description || null;
  if (p.payment_method) {
    const pm = await resolvePaymentMethod(ctx, String(p.payment_method));
    si.payment_method = pm.id;
    si.status = 'requires_confirmation';
    si._three_ds_status = null;
  }
  si.metadata = metadata(p, si.metadata);
  await saveObject(ctx.accountId, si);
  return si;
}

export async function confirmSetupIntent(ctx: Ctx, id: string, p: Params, preloaded?: any): Promise<any> {
  const si = preloaded ?? (await getObject<any>(ctx.accountId, 'setup_intent', id, 'setup_intent'));
  if (!CONFIRMABLE.includes(si.status)) throw unexpectedState(`This SetupIntent's status is ${si.status}, but it must be requires_payment_method, requires_confirmation or requires_action to be confirmed.`);
  if (p.payment_method) {
    const pmNew = await resolvePaymentMethod(ctx, String(p.payment_method));
    if (pmNew.id !== si.payment_method) si._three_ds_status = null;
    si.payment_method = pmNew.id;
  }
  if (p.return_url) si._return_url = String(p.return_url);
  if (!si.payment_method) {
    throw new ApiError(400, 'invalid_request_error', "You cannot confirm this SetupIntent because it's missing a payment method. Update it with a payment method, then confirm it again.", { code: 'setup_intent_unexpected_state', extra: { setup_intent: stripInternal(si) } });
  }
  const pm = await getObject<any>(ctx.accountId, 'payment_method', si.payment_method, 'PaymentMethod', 'payment_method');
  if (pm.customer && si.customer && pm.customer !== si.customer) throw invalid('The provided PaymentMethod belongs to a different Customer.', 'payment_method');
  si.last_setup_error = null;

  const attempt: any = {
    id: newId('setatt'),
    object: 'setup_attempt',
    application: si.application,
    attach_to_self: false,
    created: nowSeconds(),
    customer: si.customer,
    flow_directions: null,
    livemode: false,
    on_behalf_of: si.on_behalf_of,
    payment_method: pm.id,
    payment_method_details: { card: { brand: pm.card.brand, checks: pm.card.checks, country: pm.card.country, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year, fingerprint: pm.card.fingerprint, funding: pm.card.funding, last4: pm.card.last4, network: pm.card.brand, three_d_secure: null as any, wallet: null }, type: 'card' },
    setup_error: null as any,
    setup_intent: si.id,
    status: 'processing',
    usage: si.usage,
  };
  si.latest_attempt = attempt.id;

  // Cards with an authentication profile are challenged when they are set up.
  const profile = pm._auth_profile ?? (pm._three_ds_required ? 'setup' : 'none');
  const force = si.payment_method_options?.card?.request_three_d_secure === 'any';
  if ((profile !== 'none' || force) && si._three_ds_status !== 'succeeded') {
    si.status = 'requires_action';
    si._three_ds_status = 'pending';
    si.next_action = {
      type: 'redirect_to_url',
      redirect_to_url: { return_url: si._return_url, url: `${ctx.baseUrl}/authenticate/${si.id}?client_secret=${encodeURIComponent(si.client_secret)}` },
    };
    attempt.status = 'requires_action';
    await insertObject(ctx.accountId, attempt);
    await saveObject(ctx.accountId, si);
    await emit(ctx, 'setup_intent.requires_action', si);
    return si;
  }
  si.next_action = null;
  if (si._three_ds_status === 'succeeded') attempt.payment_method_details.card.three_d_secure = { authentication_flow: 'challenge', result: 'authenticated', version: '2.2.0' };

  // Zero-amount card check through the vault.
  const check = await vault.authorize(pm._vault_token, 0);
  if (!check.approved || pm.card.checks.cvc_check === 'fail') {
    const err = check.approved
      ? { code: 'incorrect_cvc', decline_code: 'incorrect_cvc', message: "Your card's security code is incorrect." }
      : { code: check.code, decline_code: check.decline_code, message: check.message };
    si.status = 'requires_payment_method';
    si.last_setup_error = { code: err.code, decline_code: err.decline_code, doc_url: `http://localhost/docs/error-codes/${err.code.replace(/_/g, '-')}`, message: err.message, payment_method: stripInternal(pm), type: 'card_error' };
    attempt.status = 'failed';
    attempt.setup_error = si.last_setup_error;
    await insertObject(ctx.accountId, attempt);
    await saveObject(ctx.accountId, si);
    await emit(ctx, 'setup_intent.setup_failed', si);
    return new CommitThenFail(new ApiError(402, 'card_error', err.message, { code: err.code, declineCode: err.decline_code, extra: { setup_intent: stripInternal(si), payment_method: stripInternal(pm) } }));
  }

  si.status = 'succeeded';
  attempt.status = 'succeeded';
  if (si.customer && !pm.customer) {
    pm.customer = si.customer;
    await emit(ctx, 'payment_method.attached', pm);
  }
  if (si.usage === 'off_session' && profile !== 'always') pm._off_session_ok = true;
  await saveObject(ctx.accountId, pm);
  await insertObject(ctx.accountId, attempt);
  await saveObject(ctx.accountId, si);
  await emit(ctx, 'setup_intent.succeeded', si);
  return si;
}

export async function cancelSetupIntent(ctx: Ctx, id: string, p: Params) {
  const si = await getObject<any>(ctx.accountId, 'setup_intent', id, 'setup_intent');
  if (!CONFIRMABLE.includes(si.status)) throw unexpectedState(`You cannot cancel this SetupIntent because it has a status of ${si.status}. Only a SetupIntent with one of the following statuses may be canceled: ${CONFIRMABLE.join(', ')}.`);
  si.status = 'canceled';
  si.cancellation_reason = oneOf(p, 'cancellation_reason', ['abandoned', 'requested_by_customer', 'duplicate'] as const) ?? null;
  si.next_action = null;
  await saveObject(ctx.accountId, si);
  await emit(ctx, 'setup_intent.canceled', si);
  return si;
}

/** Result of the simulated 3-D Secure challenge for a SetupIntent. */
export async function completeSetupAuthentication(ctx: Ctx, id: string, clientSecret: string, success: boolean) {
  const si = await getObject<any>(ctx.accountId, 'setup_intent', id, 'setup_intent');
  if (si.client_secret !== clientSecret) throw invalid('Invalid client_secret', 'client_secret');
  if (si.status !== 'requires_action') return si;
  if (success) {
    si._three_ds_status = 'succeeded';
    const r = await confirmSetupIntent(ctx, si.id, {}, si);
    return r instanceof CommitThenFail ? getObject<any>(ctx.accountId, 'setup_intent', id) : r;
  }
  const pm = await getObject<any>(ctx.accountId, 'payment_method', si.payment_method, 'PaymentMethod');
  si._three_ds_status = 'failed';
  si.status = 'requires_payment_method';
  si.next_action = null;
  si.last_setup_error = {
    code: 'setup_intent_authentication_failure',
    doc_url: 'http://localhost/docs/error-codes/setup-intent-authentication-failure',
    message: 'We are unable to authenticate your payment method. Please choose a different payment method and try again.',
    payment_method: stripInternal(pm),
    type: 'invalid_request_error',
  };
  await saveObject(ctx.accountId, si);
  await emit(ctx, 'setup_intent.setup_failed', si);
  return si;
}

/** Appends the redirect parameters a return_url receives after authentication. */
export function returnUrlFor(si: any) {
  if (!si._return_url) return null;
  const u = new URL(si._return_url);
  u.searchParams.set('setup_intent', si.id);
  u.searchParams.set('setup_intent_client_secret', si.client_secret);
  u.searchParams.set('redirect_status', si.status === 'succeeded' ? 'succeeded' : 'failed');
  return u.toString();
}
