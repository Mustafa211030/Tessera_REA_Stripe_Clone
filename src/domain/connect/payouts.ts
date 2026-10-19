import { config } from '../../config.ts';
import { query } from '../../db/index.ts';
import { ApiError, invalid, unexpectedState } from '../../lib/errors.ts';
import { newId, nowSeconds } from '../../lib/ids.ts';
import { currency, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { getBalance } from '../balance.ts';
import { emit } from '../events.ts';
import { post } from '../ledger.ts';
import { getObject, insertObject, saveObject } from '../store.ts';
import { accountCtx, defaultExternal, loadAccount, saveAccount, SCHEDULE_SECONDS, TEST_BANK_ACCOUNTS } from './accounts.ts';
import { insufficientFunds } from './transfers.ts';

/**
 * Payouts move available funds to the account's bank account.
 *
 *   pending ──(PAYOUT_IN_TRANSIT_SECONDS)──► in_transit ──(arrival_date)──► paid | failed
 *      └── cancel ──► canceled
 *
 * Ledger: merchant_available → payouts_in_transit (clearing) → cash when paid; a failed or
 * canceled payout returns the funds to merchant_available. The test bank account number
 * decides the outcome (000123456789 succeeds; 000111111116 fails with no_account, ...).
 * Accounts on an automatic schedule are paid out by the worker; manual accounts call the API.
 */

function txn(type: string, amount: number, cur: string, source: string, description: string) {
  const now = nowSeconds();
  return {
    id: newId('txn'), object: 'balance_transaction', amount, available_on: now, created: now, currency: cur, description, exchange_rate: null,
    fee: 0, fee_details: [], livemode: false, net: amount, reporting_category: type === 'payout' ? 'payout' : 'payout_reversal', source, status: 'available', type, _network_settled: true,
  };
}

export async function createPayout(ctx: Ctx, p: Params, opts: { automatic?: boolean } = {}) {
  const acct = await loadAccount(ctx.accountId);
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  const cur = currency(p, 'currency', false) ?? acct.default_currency ?? 'usd';
  const method = oneOf(p, 'method', ['standard', 'instant'] as const, 'standard')!;
  if (!opts.automatic && acct.settings?.payouts?.schedule?.interval !== 'manual') {
    throw new ApiError(400, 'invalid_request_error', 'You cannot create manual payouts on an account with an automatic payout schedule. Set settings[payouts][schedule][interval]=manual first.', { code: 'payout_schedule_automatic' });
  }
  if (acct._platform && !acct.payouts_enabled) {
    throw new ApiError(400, 'invalid_request_error', `Payouts are not enabled for this account. See requirements.currently_due on /v1/accounts/${acct.id}.`, { code: 'payouts_not_allowed' });
  }
  const destId = str(p, 'destination');
  const instantDest = () => acct.external_accounts?.data.find((x: any) => x.currency === cur && x.available_payout_methods?.includes('instant'));
  const dest = destId ? acct.external_accounts?.data.find((x: any) => x.id === destId) : method === 'instant' ? instantDest() ?? defaultExternal(acct, cur) : defaultExternal(acct, cur);
  if (!dest) throw invalid(destId ? `No such external account: '${destId}'` : `You don't have any external accounts in that currency (${cur}).`, destId ? 'destination' : 'currency');
  if (dest.currency !== cur) throw invalid(`The currency of the payout (${cur}) must match the external account's currency (${dest.currency}).`, 'currency');
  if (method === 'instant' && !dest.available_payout_methods?.includes('instant')) {
    throw invalid(`The external account ${dest.id} does not support Instant Payouts. Add an eligible debit card (for example tok_visa_debit), or use method=standard.`, 'method', 'instant_payouts_unsupported');
  }
  // Instant Payouts cost 1.5% of the amount (minimum 0.50), deducted from the balance on top of the amount.
  const fee = method === 'instant' ? instantFee(amount) : 0;
  if (method === 'instant' && amount > INSTANT_LIMIT) throw invalid(`Instant Payouts are limited to ${INSTANT_LIMIT / 100} ${cur.toUpperCase()} per payout.`, 'amount', 'instant_payouts_limit_exceeded');
  const avail = (await getBalance(ctx.accountId)).available.find((b: any) => b.currency === cur)?.amount ?? 0;
  if (amount + fee > avail) throw insufficientFunds();

  const now = nowSeconds();
  const po: any = {
    id: newId('po'),
    object: 'payout',
    amount,
    application_fee: null,
    application_fee_amount: null,
    arrival_date: now + (method === 'instant' ? config.instantPayoutSeconds : config.payoutArrivalSeconds),
    automatic: !!opts.automatic,
    balance_transaction: null,
    created: now,
    currency: cur,
    description: str(p, 'description') ?? (opts.automatic ? 'TESSERA PAYOUT' : null),
    destination: dest.id,
    failure_balance_transaction: null,
    failure_code: null,
    failure_message: null,
    livemode: false,
    metadata: metadata(p),
    method,
    original_payout: null,
    reconciliation_status: opts.automatic ? 'in_progress' : 'not_applicable',
    reversed_by: null,
    source_type: 'card',
    statement_descriptor: str(p, 'statement_descriptor', { max: 22 }) ?? acct.settings?.payouts?.statement_descriptor ?? null,
    status: 'pending',
    type: dest.object === 'card' ? 'card' : 'bank_account',
    _fee: fee,
  };
  const t: any = txn('payout', -amount, cur, po.id, po.description ?? (method === 'instant' ? 'Instant Payout' : 'Payout'));
  if (fee) {
    t.fee = fee;
    t.net = -(amount + fee);
    t.fee_details = [{ amount: fee, application: null, currency: cur, description: 'Instant Payout fee', type: 'stripe_fee' }];
  }
  po.balance_transaction = t.id;
  await post(ctx.accountId, cur, [
    { account: 'merchant_available', amount: amount + fee },
    { account: 'payouts_in_transit', amount: -amount },
    ...(fee ? [{ account: 'fee_revenue', amount: -fee }] : []),
  ], po.id, `${method === 'instant' ? 'Instant payout' : 'Payout'} ${po.id}`);
  await insertObject(ctx.accountId, t);
  await insertObject(ctx.accountId, po);
  await emit(ctx, 'payout.created', po);
  return po;
}

export const INSTANT_LIMIT = 1_000_000;
export const instantFee = (amount: number) => Math.max(50, Math.round(amount * 0.015));

async function returnFunds(ctx: Ctx, po: any, type: 'payout_cancel' | 'payout_failure') {
  const fee = po._fee ?? 0; // the Instant Payout fee is refunded with the funds
  const t = txn(type, po.amount + fee, po.currency, po.id, type === 'payout_cancel' ? 'Payout canceled' : 'Payout failure');
  await post(ctx.accountId, po.currency, [
    { account: 'payouts_in_transit', amount: po.amount },
    ...(fee ? [{ account: 'fee_revenue', amount: fee }] : []),
    { account: 'merchant_available', amount: -(po.amount + fee) },
  ], po.id, `${type === 'payout_cancel' ? 'Canceled' : 'Failed'} payout ${po.id}`);
  await insertObject(ctx.accountId, t);
  return t;
}

export async function cancelPayout(ctx: Ctx, id: string) {
  const po = await getObject<any>(ctx.accountId, 'payout', id, 'payout');
  if (po.status !== 'pending') throw unexpectedState(`Payouts can only be canceled while they are pending. This payout is ${po.status}.`);
  await returnFunds(ctx, po, 'payout_cancel');
  po.status = 'canceled';
  await saveObject(ctx.accountId, po);
  await emit(ctx, 'payout.canceled', po);
  return po;
}

export async function updatePayout(ctx: Ctx, id: string, p: Params) {
  const po = await getObject<any>(ctx.accountId, 'payout', id, 'payout');
  po.metadata = metadata(p, po.metadata);
  await saveObject(ctx.accountId, po);
  await emit(ctx, 'payout.updated', po);
  return po;
}

/** Worker: advances payouts through in_transit to paid / failed. */
export async function advancePayouts(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>(
    "SELECT account_id, data FROM objects WHERE type = 'payout' AND data->>'status' IN ('pending', 'in_transit') ORDER BY seq LIMIT 200",
  );
  let n = 0;
  for (const { account_id, data: po } of rows) {
    const ctx = accountCtx(account_id);
    if (po.status === 'pending' && po.method === 'instant' && now >= po.arrival_date) {
      po.status = 'in_transit'; // instant payouts skip the visible in-transit wait
    } else if (po.status === 'pending' && po.method !== 'instant' && now >= po.created + config.payoutInTransitSeconds) {
      po.status = 'in_transit';
      await saveObject(account_id, po);
      await emit(ctx, 'payout.updated', po, { status: 'pending' });
      n++;
    }
    if (po.status === 'in_transit' && now >= po.arrival_date) {
      const acct = await loadAccount(account_id);
      const bank = acct?.external_accounts?.data.find((x: any) => x.id === po.destination);
      const outcome = bank?._payout_fails ? { failure: 'could_not_process', message: 'The bank could not process this payout.' } : TEST_BANK_ACCOUNTS[bank?._account_number ?? ''] ?? {};
      if (outcome.failure) {
        const t = await returnFunds(ctx, po, 'payout_failure');
        po.status = 'failed';
        po.failure_code = outcome.failure;
        po.failure_message = outcome.message;
        po.failure_balance_transaction = t.id;
        if (bank) {
          bank.status = 'errored';
          await saveAccount(acct);
        }
        await saveObject(account_id, po);
        await emit(ctx, 'payout.failed', po);
      } else {
        await post(account_id, po.currency, [
          { account: 'payouts_in_transit', amount: po.amount },
          { account: 'cash', amount: -po.amount },
        ], po.id, `Payout ${po.id} arrived`);
        po.status = 'paid';
        if (po.automatic) po.reconciliation_status = 'completed';
        await saveObject(account_id, po);
        await emit(ctx, 'payout.paid', po);
      }
      n++;
    }
  }
  return n;
}

/** Worker: automatic payouts for accounts on a daily / weekly / monthly schedule. */
export async function automaticPayouts(now = nowSeconds()) {
  const rows = await query<{ data: any }>("SELECT data FROM accounts WHERE coalesce(data->'settings'->'payouts'->'schedule'->>'interval', 'manual') <> 'manual' AND coalesce(data->>'_deleted', 'false') <> 'true'");
  let n = 0;
  for (const { data: acct } of rows) {
    if (acct._platform && !acct.payouts_enabled) continue;
    if (acct._next_auto_payout && now < acct._next_auto_payout) continue;
    const ctx = accountCtx(acct.id);
    const bal = await getBalance(acct.id);
    let made = 0;
    for (const b of bal.available) {
      if (b.amount <= 0 || !defaultExternal(acct, b.currency)) continue;
      await createPayout(ctx, { amount: b.amount, currency: b.currency }, { automatic: true });
      made++;
    }
    if (!made) continue;
    n += made;
    const fresh = await loadAccount(acct.id);
    fresh._next_auto_payout = now + (SCHEDULE_SECONDS[fresh.settings.payouts.schedule.interval] ?? 86400);
    await saveAccount(fresh);
  }
  return n;
}
