import { config } from '../config.ts';
import { findObject } from './store.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { getAccount } from './accounts.ts';
import { convert, processingFee as feeFor, rate, settlementCurrency } from './fx.ts';
import { post } from './ledger.ts';
import { insertObject } from './store.ts';

/** Domestic, same-currency processing fee (2.9% + 30). Kept for callers and tests. */
export const processingFee = (amount: number) => feeFor(amount, 'usd');

/**
 * Balance transaction and ledger postings for a captured charge.
 *
 * The charge is in its presentment currency; the balance transaction is in the settlement
 * currency (converted when the account cannot settle the presentment currency), with
 * `exchange_rate` set. Fees: 2.9% + 30, +1.5% international card, +1% conversion.
 */
export async function recordCapture(accountId: string, charge: any, amount: number, bypassPending: boolean, appFee?: { amount: number; platform: string; application: string }) {
  const settle = await settlementCurrency(accountId, charge.currency);
  const converted = settle !== charge.currency;
  const settled = convert(amount, charge.currency, settle);
  const account = await getAccount(accountId);
  const details = charge.payment_method_details?.card ?? charge.payment_method_details?.card_present;
  const international = !!details?.country && details.country !== (account?.country ?? 'US');
  const type = charge.payment_method_details?.type;
  // Bank debits: 0.8% capped at 5.00. Pay in 4: 6% + 30. Cards: 2.9% + 30 (+ international/conversion).
  const methodFee = type === 'us_bank_account' ? Math.min(Math.round(settled * 0.008), convert(500, 'usd', settle))
    : type === 'quartet' ? Math.round(settled * (0.06 + (converted ? 0.01 : 0))) + convert(30, 'usd', settle)
    : feeFor(settled, settle, { international, converted });
  const tesseraFee = Math.min(methodFee, settled);
  const application = Math.min(appFee ? convert(appFee.amount, charge.currency, settle) : 0, settled - tesseraFee);
  const fee = tesseraFee + application;
  const net = settled - fee;
  const now = nowSeconds();
  const parts = type === 'us_bank_account' ? 'ACH Direct Debit 0.8%, capped at 5.00' : type === 'quartet' ? `Pay in 4 6% + fixed${converted ? ', 1% currency conversion' : ''}` : ['2.9% + fixed', international ? '1.5% international card' : '', converted ? '1% currency conversion' : ''].filter(Boolean).join(', ');
  const txn = {
    id: newId('txn'),
    object: 'balance_transaction',
    amount: settled,
    available_on: bypassPending ? now : now + config.settlementDelaySeconds,
    created: now,
    currency: settle,
    description: charge.description ?? null,
    exchange_rate: converted ? rate(charge.currency, settle) : null,
    fee,
    fee_details: [
      ...(application ? [{ amount: application, application: appFee!.application, currency: settle, description: 'Application fee', type: 'application_fee' }] : []),
      { amount: tesseraFee, application: null, currency: settle, description: `Processing fees (${parts})`, type: 'stripe_fee' },
    ],
    livemode: false,
    net,
    reporting_category: 'charge',
    source: charge.id,
    status: bypassPending ? 'available' : 'pending',
    type: 'charge',
    _network_settled: false,
    _application_fee: application,
  };
  await post(accountId, settle, [
    { account: 'processor_receivable', amount: settled },
    { account: 'merchant_pending', amount: -net },
    { account: 'fee_revenue', amount: -tesseraFee },
    // Direct charge: the platform's application fee is booked in the same group.
    ...(application ? [{ account: bypassPending ? 'merchant_available' : 'merchant_pending', amount: -application, owner: appFee!.platform }] : []),
  ], charge.id, `Capture ${charge.id}`);
  if (bypassPending) {
    await post(accountId, settle, [
      { account: 'merchant_pending', amount: net },
      { account: 'merchant_available', amount: -net },
    ], txn.id, `Funds available for ${charge.id}`);
  }
  await insertObject(accountId, txn);
  return txn;
}

/** Converts a presentment amount of `charge` into the currency its capture settled in, at today's rate. */
export async function settledAmountFor(accountId: string, charge: any, presentmentAmount: number) {
  const capture = charge.balance_transaction ? await findObject<any>(accountId, 'balance_transaction', charge.balance_transaction) : null;
  const settle = capture?.currency ?? charge.currency;
  return { currency: settle, amount: convert(presentmentAmount, charge.currency, settle), exchange_rate: settle === charge.currency ? null : rate(charge.currency, settle) };
}

export async function recordRefund(accountId: string, refund: any, charge: any) {
  const now = nowSeconds();
  const s = await settledAmountFor(accountId, charge, refund.amount);
  const txn = {
    id: newId('txn'),
    object: 'balance_transaction',
    amount: -s.amount,
    available_on: now,
    created: now,
    currency: s.currency,
    description: 'REFUND FOR CHARGE' + (charge.description ? ` (${charge.description})` : ''),
    exchange_rate: s.exchange_rate,
    fee: 0,
    fee_details: [],
    livemode: false,
    net: -s.amount,
    reporting_category: 'refund',
    source: refund.id,
    status: 'available',
    type: 'refund',
    _network_settled: false,
  };
  await post(accountId, s.currency, [
    { account: 'merchant_available', amount: s.amount },
    { account: 'refund_payable', amount: -s.amount },
  ], refund.id, `Refund ${refund.id}`);
  await insertObject(accountId, txn);
  return txn;
}
