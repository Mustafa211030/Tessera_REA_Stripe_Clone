import { config } from '../config.ts';
import { ApiError, CommitThenFail, invalid, unexpectedState } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { bool, currency, int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import * as vault from '../vault/vault.ts';
import { diff, emit } from './events.ts';
import { paymentFailed, paymentSucceeded } from './hooks.ts';
import { recordCapture } from './money.ts';
import { assertSupported, MIN_CHARGE } from './fx.ts';
import { resolvePaymentMethod } from './paymentMethods.ts';
import { afterCapture, applyConnectParams, directFee } from './connect/transfers.ts';
import { afterSuccessfulCapture } from './disputes.ts';
import * as radar from './radar.ts';
import { getObject, insertObject, saveObject } from './store.ts';

const CANCELABLE = ['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'];

/** Supported payment method types: online cards and in-person (Terminal) card_present. */
function listParam(v: any): string[] | null {
  return Array.isArray(v) ? v.map(String) : v && typeof v === 'object' ? Object.values(v).map(String) : null;
}
/** Current API: allowed_payment_method_types; older versions: payment_method_types. */
function methodTypes(p: Params) {
  const types = listParam(p.allowed_payment_method_types) ?? listParam(p.payment_method_types) ?? ['card'];
  for (const t of types) if (!['card', 'card_present', 'customer_balance', 'us_bank_account', 'quartet'].includes(t)) throw invalid(`The payment method type "${t}" is not supported by this platform yet.`, 'payment_method_types');
  return types;
}

export async function createPaymentIntent(ctx: Ctx, p: Params) {
  const amount = int(p, 'amount', { required: true, min: 1, max: 99_999_999 })!;
  const cur = currency(p)!;
  assertSupported(cur);
  if (amount < (MIN_CHARGE[cur] ?? 50)) {
    throw new ApiError(400, 'invalid_request_error', `Amount must be at least ${MIN_CHARGE[cur] ?? 50} ${cur}`, { param: 'amount', code: 'amount_too_small' });
  }
  const customer = str(p, 'customer');
  if (customer) await getObject(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const capture_method = oneOf(p, 'capture_method', ['automatic', 'automatic_async', 'manual'] as const, 'automatic_async')!;
  let types = methodTypes(p);
  const explicitTypes = listParam(p.allowed_payment_method_types) ?? listParam(p.payment_method_types);
  if (!explicitTypes && p.automatic_payment_methods && bool(p.automatic_payment_methods, 'enabled') !== false) {
    // Dynamic payment methods: whatever is turned on in Settings → Payment methods and fits this payment.
    const { eligibleTypes } = await import('./paymentMethodConfigs.ts');
    types = await eligibleTypes(ctx, { currency: cur, amount, mode: 'payment', allowRedirects: p.automatic_payment_methods.allow_redirects !== 'never' });
  }
  const verification = oneOf(p.payment_method_options?.us_bank_account ?? {}, 'verification_method', ['automatic', 'instant', 'microdeposits'] as const, 'automatic');
  const id = newId('pi');
  const pi: any = {
    id,
    object: 'payment_intent',
    amount,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: 0,
    application: null,
    application_fee_amount: null as number | null,
    automatic_payment_methods: p.automatic_payment_methods ? { allow_redirects: 'always', enabled: bool(p.automatic_payment_methods, 'enabled') ?? true } : null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method,
    client_secret: `${id}_secret_${base62(25)}`,
    confirmation_method: oneOf(p, 'confirmation_method', ['automatic', 'manual'] as const, 'automatic'),
    created: nowSeconds(),
    currency: cur,
    customer: customer ?? null,
    description: str(p, 'description', { max: 1000 }) ?? null,
    invoice: str(p, '_invoice') ?? null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: metadata(p),
    next_action: null,
    on_behalf_of: null as string | null,
    payment_method: null,
    payment_method_configuration_details: null,
    payment_method_options: {
      card: { installments: null, mandate_options: null, network: null, request_three_d_secure: p.payment_method_options?.card?.request_three_d_secure ?? 'automatic' },
      ...(types.includes('us_bank_account') ? { us_bank_account: { financial_connections: { permissions: ['payment_method'], prefetch: [] }, mandate_options: {}, verification_method: verification } } : {}),
      ...(types.includes('quartet') ? { quartet: { capture_method: null } } : {}),
    },
    payment_method_types: types,
    allowed_payment_method_types: listParam(p.allowed_payment_method_types) ?? listParam(p.payment_method_types),
    excluded_payment_method_types: null,
    processing: null,
    receipt_email: str(p, 'receipt_email') ?? null,
    review: null,
    setup_future_usage: oneOf(p, 'setup_future_usage', ['on_session', 'off_session'] as const) ?? null,
    shipping: shippingParam(p.shipping),
    statement_descriptor: str(p, 'statement_descriptor', { max: 22 }) ?? null,
    statement_descriptor_suffix: str(p, 'statement_descriptor_suffix', { max: 22 }) ?? null,
    status: 'requires_payment_method',
    transfer_data: null as any,
    transfer_group: str(p, 'transfer_group') ?? null,
    _three_ds_status: null as string | null,
    _charges: [] as string[],
  };
  await applyConnectParams(ctx, pi, p);
  if (p.payment_method) {
    const pm = await resolvePaymentMethod(ctx, String(p.payment_method));
    pi.payment_method = pm.id;
    pi.status = 'requires_confirmation';
  }
  await insertObject(ctx.accountId, pi);
  await emit(ctx, 'payment_intent.created', pi);
  if (bool(p, 'confirm')) return confirmPaymentIntent(ctx, pi.id, p, pi);
  return pi;
}

/** `shipping[name]`, `shipping[address][...]`, optional phone/carrier/tracking_number. */
function shippingParam(sh: any) {
  if (!sh || typeof sh !== 'object') return null;
  if (!sh.name) throw invalid('shipping[name] is required when passing shipping.', 'shipping[name]', 'parameter_missing');
  if (!sh.address?.line1 && !sh.address?.country) throw invalid('shipping[address] is required when passing shipping.', 'shipping[address]', 'parameter_missing');
  const a = sh.address ?? {};
  const f = (v: any) => (v === undefined || v === '' ? null : String(v));
  return { address: { city: f(a.city), country: f(a.country), line1: f(a.line1), line2: f(a.line2), postal_code: f(a.postal_code), state: f(a.state) }, carrier: f(sh.carrier), name: String(sh.name), phone: f(sh.phone), tracking_number: f(sh.tracking_number) };
}

export async function updatePaymentIntent(ctx: Ctx, id: string, p: Params) {
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent');
  if (['succeeded', 'canceled', 'processing'].includes(pi.status)) {
    throw unexpectedState(`This PaymentIntent's status is ${pi.status}, so it can no longer be updated.`);
  }
  const before = structuredClone(pi);
  if (p.amount !== undefined) pi.amount = int(p, 'amount', { min: 1 });
  if (p.currency !== undefined) pi.currency = currency(p);
  if (p.description !== undefined) pi.description = p.description || null;
  if (p.receipt_email !== undefined) pi.receipt_email = p.receipt_email || null;
  if (p.shipping !== undefined) pi.shipping = p.shipping === '' ? null : shippingParam(p.shipping);
  if (p.customer !== undefined) {
    if (p.customer) await getObject(ctx.accountId, 'customer', String(p.customer), 'customer', 'customer');
    pi.customer = p.customer || null;
  }
  if (p.payment_method) {
    const pm = await resolvePaymentMethod(ctx, String(p.payment_method));
    pi.payment_method = pm.id;
    pi.status = 'requires_confirmation';
  }
  pi.metadata = metadata(p, pi.metadata);
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'payment_intent.updated' as string, pi, diff(before, pi));
  return pi;
}

export function chargeSkeleton(pi: any, pm: any) {
  if (pm.type === 'customer_balance') return chargeBase(pi, pm, { customer_balance: {}, type: 'customer_balance' });
  if (pm.type === 'us_bank_account') {
    const b = pm.us_bank_account;
    return chargeBase(pi, pm, { type: 'us_bank_account', us_bank_account: { account_holder_type: b.account_holder_type, account_type: b.account_type, bank_name: b.bank_name, fingerprint: b.fingerprint, last4: b.last4, mandate: pi._mandate ?? null, payment_reference: null, routing_number: b.routing_number } });
  }
  if (pm.type === 'quartet') return chargeBase(pi, pm, { type: 'quartet', quartet: { installments: { count: 4, interval: 'two_weeks' }, reference: `qt_${base62(14)}` } });
  const c = pm.card ?? pm.card_present;
  const base = {
    amount_authorized: null as number | null,
    brand: c.brand,
    country: c.country,
    exp_month: c.exp_month,
    exp_year: c.exp_year,
    fingerprint: c.fingerprint,
    funding: c.funding,
    last4: c.last4,
    network: c.brand,
    network_transaction_id: null as string | null,
  };
  const details: any = pm.type === 'card_present'
    ? {
        card_present: {
          ...base, cardholder_name: c.cardholder_name ?? null, emv_auth_data: '8A023030', generated_card: null, incremental_authorization_supported: false, offline: null, overcapture_supported: false,
          preferred_locales: ['en'], read_method: c.read_method ?? 'contact_emv',
          receipt: { account_type: c.funding === 'debit' ? 'checking' : 'credit', application_cryptogram: base62(16).toUpperCase(), application_preferred_name: `${String(c.brand).toUpperCase()} CREDIT`, authorization_code: String(100000 + Math.floor(Math.random() * 899999)), authorization_response_code: '3030', cardholder_verification_method: c.read_method === 'contactless_emv' ? 'none' : 'offline_pin', dedicated_file_name: 'A0000000031010', terminal_verification_results: '0000008000', transaction_status_information: '6800' },
        },
        type: 'card_present',
      }
    : { card: { ...base, checks: pm.card.checks, three_d_secure: pi._three_ds_status === 'succeeded' ? { authentication_flow: 'challenge', result: 'authenticated', version: '2.2.0' } : null, wallet: pm.card.wallet ?? null }, type: 'card' };
  return chargeBase(pi, pm, details);
}

export function chargeBase(pi: any, pm: any, details: any) {
  return {
    id: newId('ch'),
    object: 'charge',
    amount: pi.amount,
    amount_captured: 0,
    amount_refunded: 0,
    application: pi.application,
    application_fee: null as string | null,
    application_fee_amount: pi.application_fee_amount,
    balance_transaction: null as string | null,
    billing_details: pm.billing_details,
    calculated_statement_descriptor: (pi.statement_descriptor ?? 'TESSERA TEST').toUpperCase(),
    captured: false,
    created: nowSeconds(),
    currency: pi.currency,
    customer: pi.customer,
    description: pi.description,
    destination: null as string | null,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: null as string | null,
    failure_message: null as string | null,
    fraud_details: {},
    livemode: false,
    metadata: pi.metadata,
    on_behalf_of: pi.on_behalf_of,
    outcome: null as any,
    paid: false,
    payment_intent: pi.id,
    payment_method: pm.id,
    payment_method_details: details,
    receipt_email: pi.receipt_email,
    receipt_url: null as string | null,
    refunded: false,
    review: null as string | null,
    status: 'pending',
    transfer: null as string | null,
    transfer_data: pi.transfer_data,
    transfer_group: pi.transfer_group,
    _risk_attributes: null as any,
  };
}

/** Records a failed charge, moves the PI back to requires_payment_method, and returns a deferred 402. */
async function fail(ctx: Ctx, pi: any, pm: any, charge: any, err: { code: string; decline_code?: string; message: string }) {
  charge.status = 'failed';
  charge.failure_code = err.code;
  charge.failure_message = err.message;
  await insertObject(ctx.accountId, charge);
  pi._charges.push(charge.id);
  pi.latest_charge = charge.id;
  pi.status = 'requires_payment_method';
  pi.next_action = null;
  pi.last_payment_error = {
    charge: charge.id,
    code: err.code,
    decline_code: err.decline_code,
    doc_url: `http://localhost/docs/error-codes/${err.code.replace(/_/g, '-')}`,
    message: err.message,
    payment_method: stripInternal(pm),
    type: 'card_error',
  };
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'charge.failed', charge);
  await emit(ctx, 'payment_intent.payment_failed', pi);
  await paymentFailed(ctx, pi);
  return new CommitThenFail(
    new ApiError(402, 'card_error', err.message, {
      code: err.code,
      declineCode: err.decline_code,
      extra: { charge: charge.id, payment_intent: stripInternal(pi), payment_method: stripInternal(pm), request_log_url: null },
    }),
  );
}

/** setup_future_usage: keep the card on the customer and, once authenticated, usable off-session. */
async function saveFutureUsage(ctx: Ctx, pi: any, pm: any, profile: string) {
  if (!pi.setup_future_usage) return;
  let changed = false;
  if (pi.customer && !pm.customer) {
    pm.customer = pi.customer;
    changed = true;
    await emit(ctx, 'payment_method.attached', pm);
  }
  if (pi.setup_future_usage === 'off_session' && !pm._off_session_ok && (profile === 'none' || (profile === 'setup' && pi._three_ds_status === 'succeeded'))) {
    pm._off_session_ok = true;
    changed = true;
  }
  if (changed) await saveObject(ctx.accountId, pm);
}

export function stripInternal<T>(o: T): T {
  if (Array.isArray(o)) return o.map(stripInternal) as T;
  if (!o || typeof o !== 'object') return o;
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = stripInternal(v);
  return out;
}

export async function confirmPaymentIntent(ctx: Ctx, id: string, p: Params, preloaded?: any): Promise<any> {
  const pi = preloaded ?? (await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent'));
  if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
    throw unexpectedState(`This PaymentIntent's status is ${pi.status}, but it must be requires_payment_method, requires_confirmation or requires_action to be confirmed.`);
  }
  // Bank transfers into the customer's cash balance follow their own path (no card network).
  if (p.payment_method_data?.type === 'customer_balance' || (pi.payment_method && (await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method).catch(() => null))?.type === 'customer_balance' && !p.payment_method)) {
    return (await import('./cashBalance.ts')).confirmWithCashBalance(ctx, pi, p);
  }
  if (!p.payment_method && p.payment_method_data?.type && ['card', 'us_bank_account', 'quartet'].includes(String(p.payment_method_data.type))) {
    // Inline payment method details: created now, then used for this confirmation.
    const { createPaymentMethod } = await import('./paymentMethods.ts');
    p = { ...p, payment_method: (await createPaymentMethod(ctx, p.payment_method_data)).id };
  }
  if (p.payment_method) {
    const pmNew = await resolvePaymentMethod(ctx, String(p.payment_method));
    if (pmNew.type === 'customer_balance') return (await import('./cashBalance.ts')).confirmWithCashBalance(ctx, pi, p, pmNew);
    if (pmNew.id !== pi.payment_method) pi._three_ds_status = null;
    pi.payment_method = pmNew.id;
  }
  if (p.receipt_email) pi.receipt_email = String(p.receipt_email);
  if (!pi.payment_method) {
    throw new ApiError(400, 'invalid_request_error', "You cannot confirm this PaymentIntent because it's missing a payment method. Update it with a payment method, then confirm it again.", { code: 'payment_intent_unexpected_state', extra: { payment_intent: stripInternal(pi) } });
  }
  const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method, 'PaymentMethod', 'payment_method');
  if (pm.customer && pi.customer && pm.customer !== pi.customer) throw invalid('The provided PaymentMethod belongs to a different Customer.', 'payment_method');
  if (!(pi.payment_method_types ?? ['card']).includes(pm.type)) {
    throw invalid(`The PaymentMethod provided (${pm.type}) is not allowed for this PaymentIntent. Allowed types: ${(pi.payment_method_types ?? ['card']).join(', ')}.`, 'payment_method', 'payment_intent_incompatible_payment_method');
  }
  pi.last_payment_error = null;
  if (p.return_url) pi._return_url = String(p.return_url);
  if (pm.type === 'us_bank_account') return (await import('./bankDebits.ts')).confirmBankDebit(ctx, pi, pm, p);
  if (pm.type === 'quartet') return (await import('./quartet.ts')).confirmQuartet(ctx, pi, pm, p);

  // Strong customer authentication. Cards that need it get a 3-D Secure redirect when the
  // customer is present; off-session payments cannot authenticate and fail instead.
  const force3ds = pi.payment_method_options?.card?.request_three_d_secure === 'any';
  const offSession = [true, 'true', 'one_off', 'recurring'].includes(p.off_session);
  const profile = pm._auth_profile ?? (pm._three_ds_required ? 'setup' : 'none');
  const needsAuth = force3ds || profile === 'always' || (profile === 'setup' && !pm._off_session_ok);
  if (needsAuth && offSession && pi._three_ds_status !== 'succeeded') {
    const charge = chargeSkeleton(pi, pm);
    charge.outcome = {
      network_status: 'declined_by_network', reason: 'authentication_required', risk_level: 'normal', risk_score: 10, rule: null,
      seller_message: 'The bank declined this off-session payment because the customer needs to authenticate. Bring them back on-session to complete it.', type: 'issuer_declined',
    };
    return fail(ctx, pi, pm, charge, { code: 'authentication_required', decline_code: 'authentication_required', message: 'Your card was declined. This transaction requires authentication.' });
  }
  if (needsAuth && pi._three_ds_status !== 'succeeded') {
    pi.status = 'requires_action';
    const returnUrl = str(p, 'return_url') ?? pi._return_url ?? null;
    pi._return_url = returnUrl;
    pi._three_ds_status = 'pending';
    pi.next_action = {
      type: 'redirect_to_url',
      redirect_to_url: { return_url: returnUrl, url: `${ctx.baseUrl}/authenticate/${pi.id}?client_secret=${encodeURIComponent(pi.client_secret)}` },
    };
    await saveObject(ctx.accountId, pi);
    await emit(ctx, 'payment_intent.requires_action', pi);
    return pi;
  }
  pi.next_action = null;

  const charge = chargeSkeleton(pi, pm);

  // Fraud screening happens before anything reaches the network.
  const decision = await radar.decide(ctx, pi, pm);
  charge._risk_attributes = decision.attributes;
  const ruleRef = decision.rule ? { action: decision.action, id: decision.rule.id, predicate: decision.rule.predicate } : null;
  if (decision.action === 'block') {
    charge.outcome = {
      network_status: 'not_sent_to_network',
      reason: decision.rule?.id === 'rule_default_block_highest' ? 'highest_risk_level' : 'rule',
      risk_level: decision.risk_level,
      risk_score: decision.risk_score,
      rule: ruleRef,
      seller_message: 'Payment was blocked by the fraud rules.',
      type: 'blocked',
    };
    return fail(ctx, pi, pm, charge, { code: 'card_declined', decline_code: 'fraudulent', message: 'Your card was declined.' });
  }

  // Authorization: the vault forwards the card to the (simulated) network.
  const auth = await vault.authorize(pm._vault_token, pi.amount);
  if (!auth.approved) {
    charge.outcome = {
      network_status: auth.network_status,
      reason: auth.decline_code ?? auth.code,
      risk_level: decision.risk_level,
      risk_score: decision.risk_score,
      rule: null,
      seller_message: auth.network_status === 'declined_by_network' ? 'The bank did not return any further details with this decline.' : 'The payment could not be processed.',
      type: auth.network_status === 'declined_by_network' ? 'issuer_declined' : 'invalid',
    };
    return fail(ctx, pi, pm, charge, { code: auth.code, decline_code: auth.decline_code, message: auth.message });
  }

  charge.status = 'succeeded';
  charge.paid = true;
  const pmd = charge.payment_method_details[charge.payment_method_details.type];
  pmd.network_transaction_id = auth.network_transaction_id;
  pmd.amount_authorized = pi.amount;
  charge.receipt_url = `${ctx.baseUrl}/receipts/${charge.id}`;
  charge.outcome = {
    network_status: 'approved_by_network',
    reason: decision.action === 'review' ? 'rule' : null,
    risk_level: decision.risk_level,
    risk_score: decision.risk_score,
    rule: decision.action === 'review' ? ruleRef : null,
    seller_message: decision.action === 'review' ? 'Payment was placed in review by a fraud rule.' : 'Payment complete.',
    type: decision.action === 'review' ? 'manual_review' : 'authorized',
  };
  pi._charges.push(charge.id);
  pi.latest_charge = charge.id;

  const capture = pi.capture_method !== 'manual';
  if (capture) {
    charge.captured = true;
    charge.amount_captured = pi.amount;
    await insertObject(ctx.accountId, charge);
    const txn = await recordCapture(ctx.accountId, charge, pi.amount, pm._bypass_pending, directFee(ctx, pi, pi.amount));
    charge.balance_transaction = txn.id;
    await afterCapture(ctx, pi, charge, pi.amount, txn);
    await saveObject(ctx.accountId, charge);
    pi.status = 'succeeded';
    pi.amount_received = pi.amount;
  } else {
    await insertObject(ctx.accountId, charge);
    pi.status = 'requires_capture';
    pi.amount_capturable = pi.amount;
    pi._capture_before = nowSeconds() + 7 * 86400;
  }

  if (decision.action === 'review') {
    const review = {
      id: newId('prv'),
      object: 'review',
      billing_zip: pm.billing_details?.address?.postal_code ?? null,
      charge: charge.id,
      closed_reason: null,
      created: nowSeconds(),
      ip_address: null,
      livemode: false,
      open: true,
      opened_reason: 'rule',
      payment_intent: pi.id,
      reason: 'rule',
    };
    await insertObject(ctx.accountId, review);
    charge.review = review.id;
    pi.review = review.id;
    await saveObject(ctx.accountId, charge);
    await emit(ctx, 'review.opened', review);
  }

  await saveFutureUsage(ctx, pi, pm, profile);
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'charge.succeeded', charge);
  if (capture) await afterSuccessfulCapture(ctx, pi, charge, pm);
  if (capture) {
    await emit(ctx, 'payment_intent.succeeded', pi);
    await paymentSucceeded(ctx, pi);
  } else await emit(ctx, 'payment_intent.amount_capturable_updated', pi);
  return pi;
}

export async function capturePaymentIntent(ctx: Ctx, id: string, p: Params) {
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent');
  if (pi.status !== 'requires_capture') throw unexpectedState(`This PaymentIntent could not be captured because it has a status of ${pi.status}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`);
  const amount = int(p, 'amount_to_capture', { min: 1 }) ?? pi.amount_capturable;
  if (amount > pi.amount_capturable) throw invalid(`The amount_to_capture must be less than or equal to the capturable amount (${pi.amount_capturable}).`, 'amount_to_capture');
  const charge = await getObject<any>(ctx.accountId, 'charge', pi.latest_charge, 'charge');
  const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method, 'PaymentMethod');
  charge.captured = true;
  charge.amount_captured = amount;
  if (amount < charge.amount) {
    charge.amount_refunded = charge.amount - amount; // uncaptured remainder is released
  }
  const txn = await recordCapture(ctx.accountId, charge, amount, pm._bypass_pending, directFee(ctx, pi, amount));
  charge.balance_transaction = txn.id;
  await afterCapture(ctx, pi, charge, amount, txn);
  await saveObject(ctx.accountId, charge);
  await afterSuccessfulCapture(ctx, pi, charge, pm);
  pi.amount_received = amount;
  pi.amount_capturable = 0;
  pi.status = 'succeeded';
  pi.metadata = metadata(p, pi.metadata);
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'charge.captured', charge);
  await emit(ctx, 'payment_intent.succeeded', pi);
  await paymentSucceeded(ctx, pi);
  return pi;
}

export async function cancelPaymentIntent(ctx: Ctx, id: string, p: Params) {
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent');
  if (!CANCELABLE.includes(pi.status)) throw unexpectedState(`You cannot cancel this PaymentIntent because it has a status of ${pi.status}. Only a PaymentIntent with one of the following statuses may be canceled: ${CANCELABLE.join(', ')}.`);
  const reason = oneOf(p, 'cancellation_reason', ['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'] as const);
  if (pi.status === 'requires_capture' && pi.latest_charge) {
    const charge = await getObject<any>(ctx.accountId, 'charge', pi.latest_charge, 'charge');
    charge.refunded = true;
    charge.amount_refunded = charge.amount;
    await saveObject(ctx.accountId, charge);
    await emit(ctx, 'charge.refunded', charge);
  }
  if (pi._cash_applied) await (await import('./cashBalance.ts')).unapplyFromPayment(ctx, pi);
  pi.status = 'canceled';
  pi.canceled_at = nowSeconds();
  pi.cancellation_reason = reason ?? null;
  pi.amount_capturable = 0;
  pi.next_action = null;
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'payment_intent.canceled', pi);
  return pi;
}

/** Result of the simulated 3-D Secure challenge page. */
export async function completeAuthentication(ctx: Ctx, id: string, clientSecret: string, success: boolean) {
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent');
  if (pi.client_secret !== clientSecret) throw invalid('Invalid client_secret', 'client_secret');
  if (pi.status !== 'requires_action') return pi;
  if (success) {
    pi._three_ds_status = 'succeeded';
    if (pi.confirmation_method === 'manual') {
      pi.status = 'requires_confirmation';
      pi.next_action = null;
      await saveObject(ctx.accountId, pi);
      return pi;
    }
    const r = await confirmPaymentIntent(ctx, pi.id, {}, pi);
    return r instanceof CommitThenFail ? (await getObject<any>(ctx.accountId, 'payment_intent', id)) : r;
  }
  const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method, 'PaymentMethod');
  pi._three_ds_status = 'failed';
  pi.status = 'requires_payment_method';
  pi.next_action = null;
  pi.last_payment_error = {
    code: 'payment_intent_authentication_failure',
    doc_url: 'http://localhost/docs/error-codes/payment-intent-authentication-failure',
    message: 'We are unable to authenticate your payment method. Please choose a different payment method and try again.',
    payment_method: stripInternal(pm),
    type: 'invalid_request_error',
  };
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'payment_intent.payment_failed', pi);
  await paymentFailed(ctx, pi);
  return pi;
}

export const settlementDelay = () => config.settlementDelaySeconds;

/**
 * Success for payment methods that don't go through the card network (cash balance):
 * the charge is captured at once and funds are available immediately.
 */
export async function succeedOffline(ctx: Ctx, pi: any, pm: any, opts: { bypassPending?: boolean; sellerMessage?: string } = {}) {
  const charge = chargeSkeleton(pi, pm);
  charge.status = 'succeeded';
  charge.paid = true;
  charge.captured = true;
  charge.amount_captured = pi.amount;
  charge.receipt_url = `${ctx.baseUrl}/receipts/${charge.id}`;
  charge.outcome = { network_status: 'approved_by_network', reason: null, risk_level: 'not_assessed', risk_score: null as any, rule: null, seller_message: opts.sellerMessage ?? 'Payment complete.', type: 'authorized' };
  pi._charges.push(charge.id);
  pi.latest_charge = charge.id;
  await insertObject(ctx.accountId, charge);
  const txn = await recordCapture(ctx.accountId, charge, pi.amount, opts.bypassPending ?? true, directFee(ctx, pi, pi.amount));
  charge.balance_transaction = txn.id;
  await afterCapture(ctx, pi, charge, pi.amount, txn);
  await saveObject(ctx.accountId, charge);
  pi.status = 'succeeded';
  pi.amount_received = pi.amount;
  pi.next_action = null;
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'charge.succeeded', charge);
  await emit(ctx, 'payment_intent.succeeded', pi);
  await paymentSucceeded(ctx, pi);
  return pi;
}
