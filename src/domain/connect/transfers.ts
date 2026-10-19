import { one, query } from '../../db/index.ts';
import { ApiError, invalid, missing } from '../../lib/errors.ts';
import { newId, nowSeconds } from '../../lib/ids.ts';
import { bool, currency, int, metadata, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { getBalance } from '../balance.ts';
import { convert } from '../fx.ts';
import { emit } from '../events.ts';
import { post } from '../ledger.ts';
import { findObject, getObject, insertObject, saveObject } from '../store.ts';
import { applicationId, connectedAccount, connectedCtx, loadAccount } from './accounts.ts';

/**
 * Connect money movement.
 *
 *  Destination charge   platform charges the card; on capture a transfer (source_transaction = the
 *                       charge) moves the funds to the connected account; application_fee_amount is
 *                       taken back from the connected account as an application fee.
 *  Direct charge        made on the connected account (Stripe-Account header); the application fee
 *                       moves from the connected account to the platform in the same ledger group.
 *  Separate transfers   POST /v1/transfers from the platform's available balance (or from a
 *                       specific charge's pending funds with source_transaction).
 *
 * Every movement is one balanced ledger group whose entries belong to both accounts, plus one
 * balance transaction per account, so each side's balance stays derivable from the ledger.
 */

type Txn = any;

function balanceTxn(f: { type: string; amount: number; currency: string; source: string; status: 'pending' | 'available'; available_on: number; fee?: number; fee_details?: any[]; description?: string | null; reporting_category?: string }): Txn {
  const fee = f.fee ?? 0;
  return {
    id: newId('txn'),
    object: 'balance_transaction',
    amount: f.amount,
    available_on: f.available_on,
    created: nowSeconds(),
    currency: f.currency,
    description: f.description ?? null,
    exchange_rate: null,
    fee,
    fee_details: f.fee_details ?? [],
    livemode: false,
    net: f.amount - fee,
    reporting_category: f.reporting_category ?? f.type,
    source: f.source,
    status: f.status,
    type: f.type,
    _network_settled: true,
  };
}

const bucket = (status: 'pending' | 'available') => (status === 'pending' ? 'merchant_pending' : 'merchant_available');

async function requireTransferCapable(ctx: Ctx, destination: string, param: string) {
  const dest = await connectedAccount(ctx, destination, param);
  if (dest.capabilities?.transfers !== 'active' && dest.capabilities?.card_payments !== 'active') {
    throw new ApiError(400, 'invalid_request_error', 'Your destination account needs to have at least one of the following capabilities enabled: transfers, crypto_transfers, legacy_payments', { code: 'insufficient_capabilities_for_transfer', param });
  }
  return dest;
}

async function available(accountId: string, cur: string) {
  const b = await getBalance(accountId);
  return b.available.find((x: any) => x.currency === cur)?.amount ?? 0;
}

export const insufficientFunds = () =>
  new ApiError(400, 'invalid_request_error', 'You have insufficient available funds in your Tessera account. Try adding funds directly to your available balance by creating a charge using the 4000000000000077 test card.', { code: 'balance_insufficient' });

// ---------------------------------------------------------------- PaymentIntent integration

/** Validates Connect parameters on PaymentIntent creation and fills the Connect fields. */
export async function applyConnectParams(ctx: Ctx, pi: any, p: Params) {
  const fee = int(p, 'application_fee_amount', { min: 0 });
  const td = p.transfer_data;
  pi.application = ctx.platformAccountId ? applicationId(ctx.platformAccountId) : null;
  if (ctx.platformAccountId) {
    const acct = await loadAccount(ctx.accountId);
    if (!acct.charges_enabled) {
      throw new ApiError(400, 'invalid_request_error', `Your account cannot currently make charges. To find out why charge creation is currently disabled, look at the \`requirements.disabled_reason\` property on this account (/v1/accounts/${ctx.accountId}).`, { code: 'account_invalid' });
    }
    if (td) throw invalid('Destination charges (transfer_data) cannot be created on a connected account. Make the request as the platform, without the Stripe-Account header.', 'transfer_data');
  }
  if (td !== undefined && td !== '') {
    if (typeof td !== 'object' || !td.destination) throw missing('transfer_data[destination]');
    await requireTransferCapable(ctx, String(td.destination), 'transfer_data[destination]');
    const amount = td.amount === undefined || td.amount === '' ? undefined : int(td, 'amount', { min: 1 });
    if (amount !== undefined && amount > pi.amount) throw invalid('transfer_data[amount] cannot be greater than the PaymentIntent amount.', 'transfer_data[amount]');
    if (amount !== undefined && fee !== undefined) throw invalid('You cannot set both transfer_data[amount] and application_fee_amount. Use one of them to keep part of the charge.', 'application_fee_amount');
    pi.transfer_data = { destination: String(td.destination), ...(amount !== undefined ? { amount } : {}) };
  }
  if (fee !== undefined) {
    if (!ctx.platformAccountId && !pi.transfer_data) {
      throw invalid('Can only apply an application_fee_amount when the PaymentIntent is attempting a direct payment (using an OAuth key or Stripe-Account header) or destination payment (using `transfer_data[destination]`).', 'application_fee_amount');
    }
    if (fee > pi.amount) throw invalid('application_fee_amount cannot be greater than the PaymentIntent amount.', 'application_fee_amount');
    pi.application_fee_amount = fee;
  }
  const obo = str(p, 'on_behalf_of');
  if (obo) {
    if (ctx.platformAccountId) throw invalid('on_behalf_of cannot be used on a connected account.', 'on_behalf_of');
    const a = await connectedAccount(ctx, obo, 'on_behalf_of');
    if (pi.transfer_data && pi.transfer_data.destination !== obo) throw invalid('on_behalf_of must match transfer_data[destination].', 'on_behalf_of');
    pi.on_behalf_of = obo;
    pi.statement_descriptor ??= a.settings?.payments?.statement_descriptor ?? null;
  }
  if (pi.transfer_data && !pi.transfer_group) pi.transfer_group = `group_${pi.id}`;
}

/** Direct-charge application fee to fold into the capture ledger group, if any. */
export function directFee(ctx: Ctx, pi: any, captured: number) {
  if (!ctx.platformAccountId || !pi.application_fee_amount) return undefined;
  return { amount: Math.min(pi.application_fee_amount, captured), platform: ctx.platformAccountId, application: applicationId(ctx.platformAccountId) };
}

/** Called after a capture is booked: creates the destination transfer or the direct-charge fee object. */
export async function afterCapture(ctx: Ctx, pi: any, charge: any, captured: number, captureTxn: Txn) {
  if (pi.transfer_data?.destination) {
    // Transfers move settled funds, so amounts are converted into the capture's settlement currency.
    const settle = captureTxn.currency;
    const presentAmount = pi.transfer_data.amount !== undefined ? Math.min(pi.transfer_data.amount, captured) : captured;
    const amount = Math.min(convert(presentAmount, charge.currency, settle), captureTxn.amount);
    const fee = pi.application_fee_amount ? Math.min(convert(pi.application_fee_amount, charge.currency, settle), amount) : 0;
    const { transfer, fee: feeObj, payment } = await transferCore(ctx, {
      amount, currency: settle, destination: pi.transfer_data.destination, sourceCharge: charge, sourceTxn: captureTxn,
      applicationFee: fee, transfer_group: pi.transfer_group, description: null, metadata: {},
    });
    charge.transfer = transfer.id;
    charge.destination = pi.transfer_data.destination;
    charge.application_fee = feeObj?.id ?? null;
    charge.transfer_group = pi.transfer_group;
    void payment;
    return;
  }
  const f = directFee(ctx, pi, captured);
  if (f) {
    const now = nowSeconds();
    const feeId = newId('fee');
    const amount = captureTxn._application_fee ?? f.amount;
    const txn = balanceTxn({ type: 'application_fee', amount, currency: captureTxn.currency, source: feeId, status: captureTxn.status, available_on: captureTxn.available_on, description: `Application fee from ${ctx.accountId}` });
    const feeObj = feeObject(feeId, amount, captureTxn.currency, ctx.accountId, f.application, txn.id, charge.id, charge.id, now);
    await insertObject(f.platform, txn);
    await insertObject(f.platform, feeObj);
    charge.application = f.application;
    charge.application_fee = feeId;
    charge.application_fee_amount = f.amount;
    await emit({ ...ctx, accountId: f.platform, platformAccountId: undefined }, 'application_fee.created', feeObj);
  }
}

function feeObject(id: string, amount: number, cur: string, account: string, application: string, txnId: string, chargeId: string, originating: string, now: number) {
  return {
    id,
    object: 'application_fee',
    account,
    amount,
    amount_refunded: 0,
    application,
    balance_transaction: txnId,
    charge: chargeId,
    created: now,
    currency: cur,
    fee_source: { charge: chargeId, type: 'charge' },
    livemode: false,
    originating_transaction: originating,
    refunded: false,
    refunds: { object: 'list', data: [] as any[], has_more: false, total_count: 0, url: `/v1/application_fees/${id}/refunds` },
  };
}

/**
 * Connect parameters for subscriptions and invoices: application_fee_percent (or a fixed
 * application_fee_amount on one-off invoices), transfer_data[destination|amount_percent|amount]
 * and on_behalf_of. Each invoice turns them into amounts for its PaymentIntent.
 */
export async function billingConnectParams(ctx: Ctx, p: Params, opts: { percent: boolean }) {
  const out: any = {};
  if (p.on_behalf_of !== undefined) out.on_behalf_of = p.on_behalf_of ? (await connectedAccount(ctx, String(p.on_behalf_of), 'on_behalf_of')).id : null;
  if (p.transfer_data !== undefined) {
    if (p.transfer_data === '') out.transfer_data = null;
    else {
      if (!p.transfer_data?.destination) throw missing('transfer_data[destination]');
      if (ctx.platformAccountId) throw invalid('transfer_data cannot be used on a connected account.', 'transfer_data');
      await requireTransferCapable(ctx, String(p.transfer_data.destination), 'transfer_data[destination]');
      const td: any = { destination: String(p.transfer_data.destination) };
      if (p.transfer_data.amount_percent !== undefined && p.transfer_data.amount_percent !== '') {
        const pct = Number(p.transfer_data.amount_percent);
        if (!(pct >= 0 && pct <= 100)) throw invalid('transfer_data[amount_percent] must be between 0 and 100.', 'transfer_data[amount_percent]');
        td.amount_percent = pct;
      }
      if (!opts.percent && p.transfer_data.amount !== undefined) td.amount = int(p.transfer_data, 'amount', { min: 0 });
      out.transfer_data = td;
    }
  }
  const key = opts.percent ? 'application_fee_percent' : 'application_fee_amount';
  if (p[key] !== undefined) {
    if (p[key] === '') out[key] = null;
    else {
      const v = Number(p[key]);
      if (opts.percent ? !(v >= 0 && v <= 100) : !Number.isInteger(v) || v < 0) throw invalid(opts.percent ? 'application_fee_percent must be between 0 and 100.' : 'application_fee_amount must be a non-negative integer.', key);
      const td = out.transfer_data !== undefined ? out.transfer_data : p._existing_transfer_data;
      if (!ctx.platformAccountId && !td) {
        throw invalid(`Can only apply an ${key} when the request is made on behalf of another account (using an OAuth key, the Stripe-Account header, or the transfer_data parameter).`, key);
      }
      out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- transfers

type TransferInput = {
  amount: number; currency: string; destination: string;
  sourceCharge?: any; sourceTxn?: Txn; applicationFee?: number;
  transfer_group?: string | null; description?: string | null; metadata: Record<string, string>;
};

async function transferCore(ctx: Ctx, t: TransferInput) {
  const platform = ctx.accountId;
  const dest = await requireTransferCapable(ctx, t.destination, 'destination');
  const now = nowSeconds();
  const status: 'pending' | 'available' = t.sourceTxn?.status === 'pending' ? 'pending' : 'available';
  const availableOn = status === 'pending' ? t.sourceTxn!.available_on : now;
  const app = applicationId(platform);
  const fee = t.applicationFee ?? 0;

  const transfer: any = {
    id: newId('tr'),
    object: 'transfer',
    amount: t.amount,
    amount_reversed: 0,
    balance_transaction: null,
    created: now,
    currency: t.currency,
    description: t.description ?? null,
    destination: dest.id,
    destination_payment: null,
    livemode: false,
    metadata: t.metadata,
    reversals: { object: 'list', data: [] as any[], has_more: false, total_count: 0, url: '' },
    reversed: false,
    source_transaction: t.sourceCharge?.id ?? null,
    source_type: 'card',
    transfer_group: t.transfer_group ?? null,
  };
  transfer.reversals.url = `/v1/transfers/${transfer.id}/reversals`;
  const payment: any = {
    id: newId('py'),
    object: 'charge',
    amount: t.amount,
    amount_captured: t.amount,
    amount_refunded: 0,
    application: app,
    application_fee: null,
    application_fee_amount: fee || null,
    balance_transaction: null,
    billing_details: { address: null, email: null, name: null, phone: null },
    calculated_statement_descriptor: null,
    captured: true,
    created: now,
    currency: t.currency,
    customer: null,
    description: null,
    disputed: false,
    failure_code: null,
    failure_message: null,
    livemode: false,
    metadata: {},
    on_behalf_of: null,
    outcome: null,
    paid: true,
    payment_intent: null,
    payment_method: null,
    payment_method_details: { stripe_account: {}, type: 'stripe_account' },
    refunded: false,
    refunds: { object: 'list', data: [] as any[], has_more: false, total_count: 0, url: '' },
    source_transfer: transfer.id,
    status: 'succeeded',
    transfer_group: t.transfer_group ?? null,
  };
  payment.refunds.url = `/v1/charges/${payment.id}/refunds`;
  transfer.destination_payment = payment.id;

  const pTxn = balanceTxn({ type: 'transfer', amount: -t.amount, currency: t.currency, source: transfer.id, status, available_on: availableOn, description: t.description ?? null });
  const dTxn = balanceTxn({
    type: 'payment', amount: t.amount, currency: t.currency, source: payment.id, status, available_on: availableOn, fee,
    fee_details: fee ? [{ amount: fee, application: app, currency: t.currency, description: 'Application fee', type: 'application_fee' }] : [],
    reporting_category: 'charge',
  });
  transfer.balance_transaction = pTxn.id;
  payment.balance_transaction = dTxn.id;
  const b = bucket(status);
  await post(platform, t.currency, [
    { account: b, amount: t.amount },
    { account: b, amount: -t.amount, owner: dest.id },
  ], transfer.id, `Transfer ${transfer.id} to ${dest.id}`);

  let feeObj: any = null;
  if (fee) {
    const feeId = newId('fee');
    const fTxn = balanceTxn({ type: 'application_fee', amount: fee, currency: t.currency, source: feeId, status, available_on: availableOn, description: `Application fee from ${dest.id}` });
    feeObj = feeObject(feeId, fee, t.currency, dest.id, app, fTxn.id, payment.id, t.sourceCharge?.id ?? payment.id, now);
    payment.application_fee = feeId;
    await post(platform, t.currency, [
      { account: b, amount: fee, owner: dest.id },
      { account: b, amount: -fee },
    ], feeId, `Application fee ${feeId} from ${dest.id}`);
    await insertObject(platform, fTxn);
    await insertObject(platform, feeObj);
  }
  await insertObject(platform, pTxn);
  await insertObject(platform, transfer);
  await insertObject(dest.id, dTxn);
  await insertObject(dest.id, payment);
  if (t.sourceCharge) t.sourceCharge._transferred = (t.sourceCharge._transferred ?? 0) + t.amount;

  await emit(ctx, 'transfer.created', transfer);
  if (feeObj) await emit(ctx, 'application_fee.created', feeObj);
  await emit(connectedCtx(ctx, dest.id), 'payment.created', payment);
  return { transfer, payment, fee: feeObj };
}

export async function createTransfer(ctx: Ctx, p: Params) {
  if (ctx.platformAccountId) throw new ApiError(400, 'invalid_request_error', 'Transfers are created by the platform. Make this request without the Stripe-Account header.');
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  const cur = currency(p)!;
  const destination = str(p, 'destination', { required: true })!;
  const sourceId = str(p, 'source_transaction');
  let sourceCharge: any;
  let sourceTxn: Txn | undefined;
  if (sourceId) {
    sourceCharge = await findObject<any>(ctx.accountId, 'charge', sourceId);
    if (!sourceCharge) throw invalid(`No such charge: '${sourceId}'`, 'source_transaction', 'resource_missing');
    if (!sourceCharge.captured || sourceCharge.status !== 'succeeded') throw invalid('The source_transaction must be a captured, successful charge.', 'source_transaction');
    sourceTxn = await getObject<any>(ctx.accountId, 'balance_transaction', sourceCharge.balance_transaction);
    if (sourceTxn.currency !== cur) throw invalid(`The currency of source_transaction's balance transaction (${sourceTxn.currency}) must be the same as the transfer currency (${cur})`, 'currency');
    const remaining = sourceTxn!.net - (sourceCharge._transferred ?? 0) - convert(sourceCharge.amount_refunded ?? 0, sourceCharge.currency, sourceTxn!.currency);
    if (amount > remaining) throw new ApiError(400, 'invalid_request_error', `Insufficient funds in the source transaction. You can transfer at most ${remaining} ${cur} from ${sourceId}.`, { code: 'balance_insufficient', param: 'amount' });
  } else if (amount > (await available(ctx.accountId, cur))) {
    throw insufficientFunds();
  }
  const r = await transferCore(ctx, { amount, currency: cur, destination, sourceCharge, sourceTxn, transfer_group: str(p, 'transfer_group') ?? null, description: str(p, 'description') ?? null, metadata: metadata(p) });
  if (sourceCharge) await saveObject(ctx.accountId, sourceCharge);
  return r.transfer;
}

export async function updateTransfer(ctx: Ctx, id: string, p: Params) {
  const tr = await getObject<any>(ctx.accountId, 'transfer', id, 'transfer');
  if (p.description !== undefined) tr.description = p.description || null;
  tr.metadata = metadata(p, tr.metadata);
  await saveObject(ctx.accountId, tr);
  await emit(ctx, 'transfer.updated', tr);
  return tr;
}

/** Pulls funds back from the connected account (always from its available balance; it may go negative). */
export async function reverseTransfer(ctx: Ctx, id: string, p: Params, opts: { sourceRefund?: string } = {}) {
  const tr = await getObject<any>(ctx.accountId, 'transfer', id, 'transfer');
  const remaining = tr.amount - tr.amount_reversed;
  if (remaining <= 0) throw invalid(`Transfer ${id} has already been fully reversed.`, 'transfer', 'transfer_already_reversed');
  const amount = int(p, 'amount', { min: 1 }) ?? remaining;
  if (amount > remaining) throw invalid(`Amount (${amount}) is greater than the amount remaining to reverse on this transfer (${remaining}).`, 'amount');
  const now = nowSeconds();
  const reversal: any = {
    id: newId('trr'),
    object: 'transfer_reversal',
    amount,
    balance_transaction: null,
    created: now,
    currency: tr.currency,
    destination_payment_refund: newId('pyr'),
    metadata: metadata(p),
    source_refund: opts.sourceRefund ?? null,
    transfer: tr.id,
  };
  const pTxn = balanceTxn({ type: 'transfer_refund', amount, currency: tr.currency, source: reversal.id, status: 'available', available_on: now, description: 'REFUND FOR TRANSFER' });
  const dTxn = balanceTxn({ type: 'payment_refund', amount: -amount, currency: tr.currency, source: reversal.destination_payment_refund, status: 'available', available_on: now, reporting_category: 'refund' });
  reversal.balance_transaction = pTxn.id;
  await post(ctx.accountId, tr.currency, [
    { account: 'merchant_available', amount: -amount },
    { account: 'merchant_available', amount, owner: tr.destination },
  ], reversal.id, `Reversal ${reversal.id} of ${tr.id}`);
  await insertObject(ctx.accountId, pTxn);
  await insertObject(tr.destination, dTxn);

  const py = await findObject<any>(tr.destination, 'charge', tr.destination_payment);
  if (py) {
    py.amount_refunded += amount;
    py.refunded = py.amount_refunded >= py.amount;
    py.refunds.data.unshift({ id: reversal.destination_payment_refund, object: 'refund', amount, balance_transaction: dTxn.id, charge: py.id, created: now, currency: tr.currency, metadata: {}, reason: null, status: 'succeeded' });
    py.refunds.total_count = py.refunds.data.length;
    await saveObject(tr.destination, py);
  }

  tr.amount_reversed += amount;
  tr.reversed = tr.amount_reversed >= tr.amount;
  tr.reversals.data.unshift(reversal);
  tr.reversals.total_count = tr.reversals.data.length;
  await saveObject(ctx.accountId, tr);
  await emit(ctx, 'transfer.reversed', tr);

  // A reversal can also return the matching share of the application fee.
  if (bool(p, 'refund_application_fee') && py?.application_fee) {
    const fee = await findObject<any>(ctx.accountId, 'application_fee', py.application_fee);
    if (fee) {
      const share = Math.min(fee.amount - fee.amount_refunded, Math.round((fee.amount * amount) / tr.amount));
      if (share > 0) await refundApplicationFee(ctx, fee.id, { amount: share });
    }
  }
  return reversal;
}

// ---------------------------------------------------------------- application fees

export async function refundApplicationFee(ctx: Ctx, id: string, p: Params) {
  const fee = await getObject<any>(ctx.accountId, 'application_fee', id, 'application_fee');
  const remaining = fee.amount - fee.amount_refunded;
  if (remaining <= 0) throw invalid(`Application fee ${id} has already been refunded.`, 'id', 'charge_already_refunded');
  const amount = int(p, 'amount', { min: 1 }) ?? remaining;
  if (amount > remaining) throw invalid(`Refund amount (${amount}) is greater than unrefunded amount on fee (${remaining})`, 'amount');
  const now = nowSeconds();
  const refund: any = { id: newId('fr'), object: 'fee_refund', amount, balance_transaction: null, created: now, currency: fee.currency, fee: fee.id, metadata: metadata(p) };
  const pTxn = balanceTxn({ type: 'application_fee_refund', amount: -amount, currency: fee.currency, source: refund.id, status: 'available', available_on: now, description: `Application fee refund to ${fee.account}` });
  const dTxn = balanceTxn({ type: 'application_fee_refund', amount, currency: fee.currency, source: refund.id, status: 'available', available_on: now, reporting_category: 'fee' });
  refund.balance_transaction = pTxn.id;
  await post(ctx.accountId, fee.currency, [
    { account: 'merchant_available', amount },
    { account: 'merchant_available', amount: -amount, owner: fee.account },
  ], refund.id, `Application fee refund ${refund.id}`);
  await insertObject(ctx.accountId, pTxn);
  await insertObject(fee.account, dTxn);
  fee.amount_refunded += amount;
  fee.refunded = fee.amount_refunded >= fee.amount;
  fee.refunds.data.unshift(refund);
  fee.refunds.total_count = fee.refunds.data.length;
  await saveObject(ctx.accountId, fee);
  await emit(ctx, 'application_fee.refunded', fee);
  return refund;
}

// ---------------------------------------------------------------- refunds of Connect charges

/** reverse_transfer / refund_application_fee handling for POST /v1/refunds. */
export async function afterRefund(ctx: Ctx, refund: any, charge: any, p: Params) {
  const reverse = bool(p, 'reverse_transfer');
  const refundFee = bool(p, 'refund_application_fee');
  if (reverse) {
    if (!charge.transfer) throw invalid('reverse_transfer can only be used when refunding a destination charge (one created with transfer_data[destination]).', 'reverse_transfer');
    const tr = await getObject<any>(ctx.accountId, 'transfer', charge.transfer);
    const share = Math.min(tr.amount - tr.amount_reversed, Math.round((refund.amount * tr.amount) / charge.amount_captured));
    if (share > 0) {
      const rev = await reverseTransfer(ctx, tr.id, { amount: share, refund_application_fee: refundFee ? 'true' : undefined }, { sourceRefund: refund.id });
      refund.transfer_reversal = rev.id;
    }
    return;
  }
  if (refundFee) {
    if (!charge.application_fee) throw invalid('This charge has no application fee to refund.', 'refund_application_fee');
    const platform = ctx.platformAccountId ?? ctx.accountId;
    const fee = await getObject<any>(platform, 'application_fee', charge.application_fee);
    const share = Math.min(fee.amount - fee.amount_refunded, Math.round((fee.amount * refund.amount) / charge.amount_captured));
    if (share > 0) await refundApplicationFee({ ...ctx, accountId: platform, platformAccountId: undefined }, fee.id, { amount: share });
  }
}

/** Platform-wide Connect summary for the dashboard: each account with its balance and volume. */
export async function overview(ctx: Ctx) {
  const rows = await query<{ data: any }>("SELECT data FROM accounts WHERE platform = $1 AND coalesce(data->>'_deleted', 'false') <> 'true' ORDER BY created DESC LIMIT 200", [ctx.accountId]);
  const out = [];
  for (const { data: a } of rows) {
    const bal = await getBalance(a.id);
    const vol = await one<{ total: string }>("SELECT coalesce(sum((data->>'amount')::bigint), 0)::text AS total FROM objects WHERE account_id = $1 AND type = 'charge' AND data->>'status' = 'succeeded'", [a.id]);
    out.push({ id: a.id, type: a.type, email: a.email, display_name: a.settings?.dashboard?.display_name ?? null, country: a.country, created: a.created, charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled, details_submitted: a.details_submitted, disabled_reason: a.requirements?.disabled_reason ?? null, currently_due: a.requirements?.currently_due?.length ?? 0, balance: bal, volume: Number(vol?.total ?? 0) });
  }
  const fees = await one<{ total: string; refunded: string }>("SELECT coalesce(sum((data->>'amount')::bigint),0)::text AS total, coalesce(sum((data->>'amount_refunded')::bigint),0)::text AS refunded FROM objects WHERE account_id = $1 AND type = 'application_fee'", [ctx.accountId]);
  return { object: 'connect_overview', accounts: out, application_fees: { collected: Number(fees?.total ?? 0), refunded: Number(fees?.refunded ?? 0) } };
}
