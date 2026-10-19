import { one } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { nowSeconds } from '../lib/ids.ts';
import type { Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { getAccount } from './accounts.ts';
import { emit } from './events.ts';
import { paymentFailed } from './hooks.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/**
 * Pay in 4 with Quartet: a fictional buy-now-pay-later provider for test mode.
 *
 * Confirming with a `quartet` payment method returns `requires_action` with a redirect to
 * Quartet's (simulated) approval page, which shows the four-payment plan. Approving pays the
 * merchant the full amount at once (Quartet collects the installments from the shopper);
 * declining returns the PaymentIntent to `requires_payment_method`.
 *
 * Amounts (minor units) Quartet accepts, by currency.
 */
export const QUARTET_LIMITS: Record<string, [number, number]> = {
  usd: [100, 400000], cad: [100, 400000], aud: [100, 400000], gbp: [100, 100000], eur: [100, 100000],
};

/** Four payments every two weeks; the first absorbs the rounding remainder. */
export function schedule(amount: number, start = nowSeconds()) {
  const part = Math.floor(amount / 4);
  return [0, 1, 2, 3].map((i) => ({ amount: i === 0 ? amount - part * 3 : part, due: start + i * 14 * 86400 }));
}

export async function confirmQuartet(ctx: Ctx, pi: any, pm: any, p: Params) {
  const lim = QUARTET_LIMITS[pi.currency];
  if (!lim) throw invalid(`Pay in 4 with Quartet doesn't support ${pi.currency.toUpperCase()}. Supported currencies: ${Object.keys(QUARTET_LIMITS).join(', ')}.`, 'currency', 'payment_method_currency_mismatch');
  if (pi.amount < lim[0]) throw invalid(`Pay in 4 with Quartet needs an amount of at least ${lim[0]} ${pi.currency}.`, 'amount', 'amount_too_small');
  if (pi.amount > lim[1]) throw invalid(`Pay in 4 with Quartet is limited to ${lim[1]} ${pi.currency} per purchase.`, 'amount', 'amount_too_large');
  if (pi.capture_method === 'manual') throw invalid('quartet payments do not support capture_method=manual in test mode.', 'capture_method');
  const returnUrl = p.return_url ? String(p.return_url) : pi._return_url;
  if (!returnUrl) throw invalid('A return_url is required to confirm a PaymentIntent with a quartet payment method: the customer is redirected to Quartet to approve the plan.', 'return_url');
  pi._return_url = returnUrl;
  pi._quartet = { status: 'pending', schedule: schedule(pi.amount) };
  pi.status = 'requires_action';
  pi.next_action = { type: 'redirect_to_url', redirect_to_url: { return_url: returnUrl, url: `${ctx.baseUrl}/quartet/${pi.id}?client_secret=${encodeURIComponent(pi.client_secret)}` } };
  await saveObject(ctx.accountId, pi);
  await emit(ctx, 'payment_intent.requires_action', pi);
  return pi;
}

async function load(id: string, secret: string) {
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE id = $1 AND type = 'payment_intent'", [id]);
  if (!row || row.data.client_secret !== secret) throw new ApiError(404, 'invalid_request_error', 'This approval link is invalid.', { code: 'resource_missing' });
  return row;
}

const withResult = (url: string, pi: any, status: string) => {
  const u = new URL(url);
  u.searchParams.set('payment_intent', pi.id);
  u.searchParams.set('payment_intent_client_secret', pi.client_secret);
  u.searchParams.set('redirect_status', status);
  return u.toString();
};

/** What the approval page shows. */
export async function hostedView(id: string, secret: string) {
  const { account_id, data: pi } = await load(id, secret);
  const pm = pi.payment_method ? (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [pi.payment_method]))?.data : null;
  const acct = await getAccount(account_id);
  return {
    id: pi.id, amount: pi.amount, currency: pi.currency, status: pi.status, pending: pi.status === 'requires_action' && pi._quartet?.status === 'pending',
    merchant: acct?.settings?.dashboard?.display_name ?? acct?.business_profile?.name ?? 'Merchant',
    shopper: pm ? { name: pm.billing_details?.name, email: pm.billing_details?.email } : null,
    schedule: pi._quartet?.schedule ?? schedule(pi.amount),
    return_url: pi._return_url ? withResult(pi._return_url, pi, pi.status === 'succeeded' ? 'succeeded' : 'failed') : null,
  };
}

/** The shopper approves (or declines) the plan on Quartet's page. */
export async function decide(id: string, secret: string, approve: boolean, baseUrl: string) {
  const row = await load(id, secret);
  const pi = row.data;
  const ctx = accountCtx(row.account_id, baseUrl);
  const platform = (await one<{ platform: string | null }>('SELECT platform FROM accounts WHERE id = $1', [row.account_id]))?.platform;
  if (platform) ctx.platformAccountId = platform;
  if (pi.status !== 'requires_action' || pi._quartet?.status !== 'pending') {
    return { status: pi.status, return_url: pi._return_url ? withResult(pi._return_url, pi, pi.status === 'succeeded' ? 'succeeded' : 'failed') : null };
  }
  const pm = await getObject<any>(ctx.accountId, 'payment_method', pi.payment_method);
  pi._quartet.status = approve ? 'approved' : 'declined';
  if (approve) {
    const { succeedOffline } = await import('./paymentIntents.ts');
    await succeedOffline(ctx, pi, pm, { bypassPending: false, sellerMessage: 'Pay in 4 plan approved by Quartet.' });
  } else {
    const { chargeSkeleton, stripInternal } = await import('./paymentIntents.ts');
    const charge: any = chargeSkeleton(pi, pm);
    charge.status = 'failed';
    charge.failure_code = 'payment_method_provider_decline';
    charge.failure_message = 'The customer declined the Pay in 4 plan, or Quartet did not approve it.';
    charge.outcome = { network_status: 'declined_by_network', reason: 'declined', risk_level: 'not_assessed', risk_score: null, rule: null, seller_message: 'Quartet did not approve this purchase.', type: 'issuer_declined' };
    await insertObject(ctx.accountId, charge);
    pi._charges.push(charge.id);
    pi.latest_charge = charge.id;
    pi.status = 'requires_payment_method';
    pi.next_action = null;
    pi.last_payment_error = {
      charge: charge.id, code: 'payment_method_provider_decline', decline_code: null,
      doc_url: 'http://localhost/docs/error-codes/payment-method-provider-decline',
      message: 'The payment was declined by Quartet. Choose a different payment method.', payment_method: stripInternal(pm), type: 'invalid_request_error',
    };
    await saveObject(ctx.accountId, pi);
    await emit(ctx, 'charge.failed', charge);
    await emit(ctx, 'payment_intent.payment_failed', pi);
    await paymentFailed(ctx, pi);
  }
  return { status: pi.status, return_url: pi._return_url ? withResult(pi._return_url, pi, approve ? 'succeeded' : 'failed') : null };
}
