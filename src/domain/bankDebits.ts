import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { ApiError, CommitThenFail, invalid, unexpectedState } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { afterCapture, directFee } from './connect/transfers.ts';
import { emit } from './events.ts';
import { paymentFailed, paymentSucceeded } from './hooks.ts';
import { recordCapture } from './money.ts';
import { ACH_TEST_OUTCOMES } from './paymentMethods.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/**
 * ACH Direct Debit for PaymentIntents (`us_bank_account`).
 *
 *  1. A mandate records the customer's authorization (mandate_data[customer_acceptance]).
 *  2. Verification: accounts linked with Financial Connections are verified instantly; others
 *     get two microdeposits (test: amounts 32 and 45, or descriptor code SM11AA) and the
 *     PaymentIntent waits in requires_action / verify_with_microdeposits.
 *  3. The debit is submitted: the PaymentIntent is `processing` and the charge `pending`.
 *  4. After BANK_DEBIT_SECONDS the (simulated) ACH network answers. The test account number
 *     decides: 000222222227 insufficient funds, 000111111113 closed, 000111111116 no account,
 *     000333333335 not authorized; anything else succeeds and the funds are captured.
 */
export const MICRODEPOSIT_AMOUNTS = [32, 45];
export const DESCRIPTOR_CODE = 'SM11AA';
const MAX_ATTEMPTS = 10;

const MANDATE_REQUIRED = 'This PaymentIntent requires a mandate, but no existing mandate was found. Collect mandate acceptance from the customer and try again, providing acceptance data in the mandate_data parameter.';

export async function createMandate(ctx: Ctx, pm: any, acceptance: any, type: 'multi_use' | 'single_use', amount?: { amount: number; currency: string }) {
  const kind = acceptance?.type === 'offline' ? 'offline' : 'online';
  const mandate = {
    id: newId('mandate'), object: 'mandate', created: nowSeconds(),
    customer_acceptance: {
      accepted_at: Number(acceptance?.accepted_at ?? nowSeconds()), type: kind,
      ...(kind === 'online' ? { online: { ip_address: acceptance?.online?.ip_address ?? '127.0.0.1', user_agent: acceptance?.online?.user_agent ?? 'Tessera.js' } } : { offline: {} }),
    },
    livemode: false, multi_use: type === 'multi_use' ? {} : undefined, single_use: type === 'single_use' ? amount ?? null : undefined,
    payment_method: pm.id, payment_method_details: { type: 'us_bank_account', us_bank_account: { collection_method: 'paper' } },
    status: 'active', type,
  };
  if (type === 'multi_use') delete (mandate as any).single_use; else delete (mandate as any).multi_use;
  await insertObject(ctx.accountId, mandate);
  pm._mandate = mandate.id;
  await saveObject(ctx.accountId, pm);
  return mandate;
}

export async function getMandate(ctx: Ctx, id: string) {
  return getObject<any>(ctx.accountId, 'mandate', id, 'mandate');
}

export async function confirmBankDebit(ctx: Ctx, pi: any, pm: any, p: Params) {
  if (pi.currency !== 'usd') throw invalid('us_bank_account payments must be in usd.', 'currency', 'payment_method_currency_mismatch');
  if (pi.capture_method === 'manual') throw invalid('us_bank_account payments do not support capture_method=manual.', 'capture_method');
  if (pm._verification_failed) throw invalid('This bank account could not be verified. Use a different payment method.', 'payment_method', 'payment_method_microdeposit_verification_attempts_exceeded');
  let mandate: any = null;
  if (p.mandate) mandate = await getObject<any>(ctx.accountId, 'mandate', String(p.mandate), 'mandate', 'mandate');
  else if (p.mandate_data?.customer_acceptance) mandate = await createMandate(ctx, pm, p.mandate_data.customer_acceptance, pi.setup_future_usage ? 'multi_use' : 'single_use', { amount: pi.amount, currency: pi.currency });
  else if (pm._mandate) mandate = await findObject<any>(ctx.accountId, 'mandate', pm._mandate);
  if (!mandate || mandate.status !== 'active' || (mandate.type === 'single_use' && mandate._used)) throw invalid(MANDATE_REQUIRED, 'mandate_data');
  pi._mandate = mandate.id;
  if (pi.setup_future_usage && pi.customer && !pm.customer) {
    pm.customer = pi.customer;
    await saveObject(ctx.accountId, pm);
    await emit(ctx, 'payment_method.attached', pm);
  }

  const method = p.payment_method_options?.us_bank_account?.verification_method ?? pi.payment_method_options?.us_bank_account?.verification_method ?? 'automatic';
  const instant = !!pm.us_bank_account.financial_connections_account;
  if (method === 'instant' && !instant) throw invalid('This PaymentIntent only accepts bank accounts verified instantly. Link the account with Financial Connections.', 'payment_method', 'payment_method_unactivated');
  if (!instant && !pm._verified) return startMicrodeposits(ctx, pi, pm);
  return submitDebit(ctx, pi, pm);
}

async function startMicrodeposits(ctx: Ctx, pi: any, pm: any) {
  pm._microdeposits ??= { attempts: 0, sent_at: nowSeconds() };
  await saveObject(ctx.accountId, pm);
  pi.status = 'requires_action';
  pi.next_action = {
    type: 'verify_with_microdeposits',
    verify_with_microdeposits: {
      arrival_date: nowSeconds() + 86400,
      hosted_verification_url: `${ctx.baseUrl}/verify-microdeposits/${pi.id}?client_secret=${encodeURIComponent(pi.client_secret)}`,
      microdeposit_type: 'descriptor_code',
    },
  };
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'payment_intent.requires_action', pi);
  return pi;
}

/** POST /v1/payment_intents/:id/verify_microdeposits with amounts[] or descriptor_code. */
export async function verifyMicrodeposits(ctx: Ctx, id: string, p: Params) {
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent');
  if (pi.status !== 'requires_action' || pi.next_action?.type !== 'verify_with_microdeposits') {
    throw unexpectedState(`This PaymentIntent's status is ${pi.status}; microdeposits can only be verified while it is waiting for them (requires_action, verify_with_microdeposits).`);
  }
  const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method);
  const amounts = Array.isArray(p.amounts) ? p.amounts.map(Number) : p.amounts && typeof p.amounts === 'object' ? Object.values(p.amounts).map(Number) : null;
  const code = p.descriptor_code !== undefined ? String(p.descriptor_code).trim().toUpperCase() : null;
  if (!amounts && !code) throw invalid('Provide either amounts or descriptor_code.', 'amounts', 'parameter_missing');
  if (amounts && code) throw invalid('Provide only one of amounts or descriptor_code.', 'descriptor_code');
  if (amounts && amounts.length !== 2) throw invalid('amounts must contain exactly two values.', 'amounts');
  const ok = amounts ? [...amounts].sort((a, b) => a - b).join(',') === MICRODEPOSIT_AMOUNTS.join(',') : code === DESCRIPTOR_CODE;
  if (!ok) {
    pm._microdeposits = { ...(pm._microdeposits ?? {}), attempts: (pm._microdeposits?.attempts ?? 0) + 1 };
    const left = MAX_ATTEMPTS - pm._microdeposits.attempts;
    if (left <= 0) {
      pm._verification_failed = true;
      await saveObject(ctx.accountId, pm);
      pi.status = 'requires_payment_method';
      pi.next_action = null;
      pi.last_payment_error = { code: 'payment_method_microdeposit_verification_attempts_exceeded', message: 'You have exceeded the number of allowed verification attempts.', type: 'invalid_request_error' };
      await saveObject(ctx.accountId, pi);
      await emit(ctx, 'payment_intent.payment_failed', pi);
      return new CommitThenFail(new ApiError(400, 'invalid_request_error', 'You have exceeded the number of allowed verification attempts.', { code: 'payment_method_microdeposit_verification_attempts_exceeded' }));
    }
    await saveObject(ctx.accountId, pm);
    const err = amounts
      ? new ApiError(400, 'invalid_request_error', `The amounts provided do not match the amounts that were sent to the bank account. You have ${left} verification attempts remaining.`, { code: 'payment_method_microdeposit_verification_amounts_mismatch', param: 'amounts' })
      : new ApiError(400, 'invalid_request_error', `The verification code provided does not match the code sent to the bank account. You have ${left} verification attempts remaining.`, { code: 'payment_method_microdeposit_verification_descriptor_code_mismatch', param: 'descriptor_code' });
    return new CommitThenFail(err);
  }
  pm._verified = true;
  pm.us_bank_account.status_details = null;
  await saveObject(ctx.accountId, pm);
  pi.next_action = null;
  return submitDebit(ctx, pi, pm);
}

/** Hosted microdeposit page: what it shows, looked up by client secret. */
export async function hostedView(id: string, secret: string) {
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE id = $1 AND type = 'payment_intent'", [id]);
  if (!row || row.data.client_secret !== secret) throw new ApiError(404, 'invalid_request_error', 'This verification link is invalid.', { code: 'resource_missing' });
  const pi = row.data;
  const pm = pi.payment_method ? (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [pi.payment_method]))?.data : null;
  const acct = (await one<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [row.account_id]))?.data;
  return {
    id: pi.id, amount: pi.amount, currency: pi.currency, status: pi.status, waiting: pi.next_action?.type === 'verify_with_microdeposits',
    merchant: acct?.settings?.dashboard?.display_name ?? acct?.business_profile?.name ?? 'Merchant',
    bank: pm?.us_bank_account ? { bank_name: pm.us_bank_account.bank_name, last4: pm.us_bank_account.last4 } : null,
    attempts_left: MAX_ATTEMPTS - (pm?._microdeposits?.attempts ?? 0), return_url: pi._return_url ?? null,
  };
}

/** Submits the debit to the (simulated) ACH network: processing until the worker settles it. */
export async function submitDebit(ctx: Ctx, pi: any, pm: any) {
  const { chargeSkeleton } = await import('./paymentIntents.ts');
  const charge: any = chargeSkeleton(pi, pm);
  charge.status = 'pending';
  charge.outcome = { network_status: 'approved_by_network', reason: null, risk_level: 'not_assessed', risk_score: null, rule: null, seller_message: 'Payment is processing. ACH debits usually settle in about 4 business days.', type: 'authorized' };
  await insertObject(ctx.accountId, charge);
  const mandate = pi._mandate ? await findObject<any>(ctx.accountId, 'mandate', pi._mandate) : null;
  if (mandate?.type === 'single_use') { mandate._used = true; await saveObject(ctx.accountId, mandate); }
  pi._charges.push(charge.id);
  pi.latest_charge = charge.id;
  pi.status = 'processing';
  pi.next_action = null;
  pi._debit_settle_at = nowSeconds() + config.bankDebitSeconds;
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'charge.pending', charge);
  await emit(ctx, 'payment_intent.processing', pi);
  if (pi.metadata?.checkout_session) await (await import('./checkout.ts')).onPaymentProcessing(ctx, pi);
  return pi;
}

/** Worker: the ACH network's answers for debits whose settlement time has come. */
export async function settleBankDebits(now = nowSeconds()) {
  const rows = await query<{ account_id: string; platform: string | null; data: any }>(
    "SELECT o.account_id, a.platform, o.data FROM objects o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.type = 'payment_intent' AND o.data->>'status' = 'processing' AND (o.data->>'_debit_settle_at')::bigint <= $1 ORDER BY o.seq LIMIT 200",
    [now],
  );
  for (const { account_id, platform, data: pi } of rows) {
    const ctx = accountCtx(account_id);
    if (platform) ctx.platformAccountId = platform;
    await settleOne(ctx, pi);
  }
  return rows.length;
}

async function settleOne(ctx: Ctx, pi: any) {
  const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method);
  const charge = await getObject<any>(ctx.accountId, 'charge', pi.latest_charge);
  const failure = ACH_TEST_OUTCOMES[pm._account_number];
  delete pi._debit_settle_at;
  if (failure) {
    charge.status = 'failed';
    charge.failure_code = failure.code;
    charge.failure_message = failure.message;
    charge.outcome = { ...charge.outcome, network_status: 'declined_by_network', reason: failure.code, seller_message: failure.message, type: 'issuer_declined' };
    await saveObject(ctx.accountId, charge);
    pi.status = 'requires_payment_method';
    const { stripInternal } = await import('./paymentIntents.ts');
    pi.last_payment_error = { charge: charge.id, code: failure.code, doc_url: `http://localhost/docs/error-codes/${failure.code.replace(/_/g, '-')}`, message: failure.message, payment_method: stripInternal(pm), type: 'invalid_request_error' };
    if (['account_closed', 'no_account', 'debit_not_authorized'].includes(failure.code) && pi._mandate) {
      const m = await findObject<any>(ctx.accountId, 'mandate', pi._mandate);
      if (m) { m.status = 'inactive'; await saveObject(ctx.accountId, m); await emit(ctx, 'mandate.updated', m); }
    }
    await saveObject(ctx.accountId, pi);
    await emit(ctx, 'charge.failed', charge);
    await emit(ctx, 'payment_intent.payment_failed', pi);
    await paymentFailed(ctx, pi);
    return;
  }
  charge.status = 'succeeded';
  charge.paid = true;
  charge.captured = true;
  charge.amount_captured = pi.amount;
  charge.receipt_url = `${ctx.baseUrl}/receipts/${charge.id}`;
  charge.outcome = { ...charge.outcome, seller_message: 'Payment complete.' };
  const txn = await recordCapture(ctx.accountId, charge, pi.amount, false, directFee(ctx, pi, pi.amount));
  charge.balance_transaction = txn.id;
  await afterCapture(ctx, pi, charge, pi.amount, txn);
  await saveObject(ctx.accountId, charge);
  pi.status = 'succeeded';
  pi.amount_received = pi.amount;
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'charge.succeeded', charge);
  await emit(ctx, 'payment_intent.succeeded', pi);
  await paymentSucceeded(ctx, pi);
}
