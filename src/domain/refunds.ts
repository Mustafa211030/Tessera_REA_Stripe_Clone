import { invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { recordRefund } from './money.ts';
import { afterRefund } from './connect/transfers.ts';
import { afterRefundForDisputes, assertRefundable } from './disputes.ts';
import { getObject, insertObject, saveObject } from './store.ts';

export async function createRefund(ctx: Ctx, p: Params) {
  const piId = str(p, 'payment_intent');
  let chId = str(p, 'charge');
  if (!piId && !chId) throw missing('charge');
  if (piId) {
    const pi = await getObject<any>(ctx.accountId, 'payment_intent', piId, 'payment_intent', 'payment_intent');
    if (pi.status !== 'succeeded') throw invalid(`This PaymentIntent does not have a successful charge to refund.`, 'payment_intent');
    chId = pi.latest_charge;
  }
  const charge = await getObject<any>(ctx.accountId, 'charge', chId!, 'charge', 'charge');
  if (charge.source_transfer) throw invalid(`${charge.id} is a payment from a platform transfer. The platform reverses it with POST /v1/transfers/${charge.source_transfer}/reversals.`, 'charge');
  if (!charge.captured || charge.status !== 'succeeded') throw invalid(`Charge ${charge.id} has not been captured and cannot be refunded.`, 'charge');
  await assertRefundable(ctx, charge);
  const released = charge.amount - charge.amount_captured; // uncaptured part of a partial capture
  const refundable = charge.amount_captured - (charge.amount_refunded - released);
  if (refundable <= 0) throw invalid(`Charge ${charge.id} has already been refunded.`, 'charge', 'charge_already_refunded');
  const amount = int(p, 'amount', { min: 1 }) ?? refundable;
  if (amount > refundable) throw invalid(`Refund amount (${amount}) is greater than unrefunded amount on charge (${refundable})`, 'amount');

  const refund: any = {
    id: newId('re'),
    object: 'refund',
    amount,
    balance_transaction: null,
    charge: charge.id,
    created: nowSeconds(),
    currency: charge.currency,
    destination_details: { card: { reference_status: 'available', reference_type: 'acquirer_reference_number', type: 'refund' }, type: 'card' },
    metadata: metadata(p),
    payment_intent: charge.payment_intent,
    reason: oneOf(p, 'reason', ['duplicate', 'fraudulent', 'requested_by_customer'] as const) ?? null,
    receipt_number: null,
    source_transfer_reversal: null,
    status: 'succeeded',
    transfer_reversal: null,
  };
  const txn = await recordRefund(ctx.accountId, refund, charge);
  refund.balance_transaction = txn.id;
  await afterRefund(ctx, refund, charge, p);
  if (charge.payment_method_details?.type === 'customer_balance') await (await import('./cashBalance.ts')).refundToCashBalance(ctx, refund, charge);
  await insertObject(ctx.accountId, refund);

  charge.amount_refunded += amount;
  charge.refunded = charge.amount_refunded >= charge.amount;
  if (refund.reason === 'fraudulent') charge.fraud_details = { user_report: 'fraudulent' };
  await saveObject(ctx.accountId, charge);
  await emit(ctx, 'refund.created', refund);
  await emit(ctx, 'charge.refunded', charge);
  await afterRefundForDisputes(ctx, charge);
  return refund;
}

/** Approve or refund a review opened by a fraud rule. */
export async function closeReview(ctx: Ctx, id: string, action: 'approve' | 'refund') {
  const review = await getObject<any>(ctx.accountId, 'review', id, 'review');
  if (!review.open) throw invalid('This review is already closed.', 'review');
  if (action === 'refund') {
    await createRefund(ctx, { charge: review.charge, reason: 'fraudulent' });
    review.closed_reason = 'refunded_as_fraud';
  } else {
    review.closed_reason = 'approved';
  }
  review.open = false;
  await saveObject(ctx.accountId, review);
  await emit(ctx, 'review.closed', review);
  return review;
}
