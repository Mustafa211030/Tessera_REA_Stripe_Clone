import { assertFile } from './files.ts';
import { config } from '../config.ts';
import { query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { bool, metadata, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { convert } from './fx.ts';
import { settledAmountFor } from './money.ts';
import { post } from './ledger.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/**
 * Disputes (chargebacks), inquiries and early fraud warnings.
 *
 * The simulated issuer opens them for the documented test cards:
 *   4000 0000 0000 0259  fraudulent chargeback        4000 0000 0000 1976  inquiry
 *   4000 0000 0000 2685  product_not_received          4000 0000 0000 5423  early fraud warning
 *
 * Chargeback lifecycle:  needs_response ──submit──► under_review ──► won | lost
 *                                        └─close / due date passes──► lost
 * Inquiry lifecycle:     warning_needs_response ──submit──► warning_under_review ──► warning_closed
 *                        (losing evidence escalates the inquiry to a chargeback)
 *
 * Evidence outcome uses the documented test strings in evidence[uncategorized_text]:
 * "winning_evidence" or "losing_evidence". Funds: a chargeback withdraws the amount plus the
 * dispute fee from the available balance; a win reinstates the amount (the fee is kept).
 */

export const EVIDENCE_FIELDS = [
  'access_activity_log', 'billing_address', 'cancellation_policy', 'cancellation_policy_disclosure', 'cancellation_rebuttal',
  'customer_communication', 'customer_email_address', 'customer_name', 'customer_purchase_ip', 'customer_signature',
  'duplicate_charge_documentation', 'duplicate_charge_explanation', 'duplicate_charge_id', 'product_description', 'receipt',
  'refund_policy', 'refund_policy_disclosure', 'refund_refusal_explanation', 'service_date', 'service_documentation',
  'shipping_address', 'shipping_carrier', 'shipping_date', 'shipping_documentation', 'shipping_tracking_number',
  'uncategorized_file', 'uncategorized_text',
] as const;

/** Evidence fields that take an uploaded file id (purpose dispute_evidence). */
export const FILE_EVIDENCE = new Set(['cancellation_policy', 'customer_communication', 'customer_signature', 'duplicate_charge_documentation', 'receipt', 'refund_policy', 'service_documentation', 'shipping_documentation', 'uncategorized_file']);

const NETWORK_REASON: Record<string, string> = { fraudulent: '10.4', product_not_received: '13.1', duplicate: '12.6.1', subscription_canceled: '13.2', general: '13.7' };
const DAY = 86400;

/** Hook called after every successful capture. */
export async function afterSuccessfulCapture(ctx: Ctx, pi: any, charge: any, pm: any) {
  const profile = pm?._dispute_profile;
  if (!profile) return;
  if (profile.efw) return createEarlyFraudWarning(ctx, charge);
  return openDispute(ctx, charge, profile.reason, !!profile.inquiry);
}

async function withdraw(ctx: Ctx, dp: any, charge: any) {
  // Withdrawn in the currency the charge settled in, at today's rate; the fee is a flat 15.00 there.
  const s = await settledAmountFor(ctx.accountId, charge, dp.amount);
  const fee = convert(config.disputeFee, 'usd', s.currency);
  const now = nowSeconds();
  const txn = {
    id: newId('txn'), object: 'balance_transaction', amount: -s.amount, available_on: now, created: now, currency: s.currency,
    description: `Chargeback withdrawal for ${charge.id}`, exchange_rate: s.exchange_rate, fee,
    fee_details: [{ amount: fee, application: null, currency: s.currency, description: 'Dispute fee', type: 'stripe_fee' }],
    livemode: false, net: -s.amount - fee, reporting_category: 'dispute', source: dp.id, status: 'available', type: 'adjustment', _network_settled: true,
  };
  await post(ctx.accountId, s.currency, [
    { account: 'merchant_available', amount: s.amount + fee },
    { account: 'cash', amount: -s.amount },
    { account: 'fee_revenue', amount: -fee },
  ], dp.id, `Dispute ${dp.id} withdrawal`);
  await insertObject(ctx.accountId, txn);
  dp.balance_transactions.push(txn);
  dp.is_charge_refundable = false;
}

async function reinstate(ctx: Ctx, dp: any) {
  const now = nowSeconds();
  const charge = await findObject<any>(ctx.accountId, 'charge', dp.charge);
  const s = await settledAmountFor(ctx.accountId, charge ?? { currency: dp.currency }, dp.amount);
  const txn = {
    id: newId('txn'), object: 'balance_transaction', amount: s.amount, available_on: now, created: now, currency: s.currency,
    description: `Chargeback reversal for ${dp.charge}`, exchange_rate: s.exchange_rate, fee: 0, fee_details: [], livemode: false, net: s.amount,
    reporting_category: 'dispute_reversal', source: dp.id, status: 'available', type: 'adjustment', _network_settled: true,
  };
  await post(ctx.accountId, s.currency, [
    { account: 'cash', amount: s.amount },
    { account: 'merchant_available', amount: -s.amount },
  ], dp.id, `Dispute ${dp.id} won`);
  await insertObject(ctx.accountId, txn);
  dp.balance_transactions.push(txn);
  await emit(ctx, 'charge.dispute.funds_reinstated', dp);
}

export async function openDispute(ctx: Ctx, charge: any, reason: string, inquiry: boolean) {
  const now = nowSeconds();
  const dp: any = {
    id: newId('dp'),
    object: 'dispute',
    amount: charge.amount_captured,
    balance_transactions: [] as any[],
    charge: charge.id,
    created: now,
    currency: charge.currency,
    enhanced_eligibility_types: [],
    evidence: Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, null])),
    evidence_details: { due_by: now + 7 * DAY, enhanced_eligibility: {}, has_evidence: false, past_due: false, submission_count: 0 },
    is_charge_refundable: inquiry,
    livemode: false,
    metadata: {},
    network_reason_code: NETWORK_REASON[reason] ?? null,
    payment_intent: charge.payment_intent,
    payment_method_details: { card: { brand: charge.payment_method_details?.card?.brand ?? 'visa', case_type: inquiry ? 'inquiry' : 'chargeback', network_reason_code: NETWORK_REASON[reason] ?? null }, type: 'card' },
    reason,
    status: inquiry ? 'warning_needs_response' : 'needs_response',
    _resolve_at: null as number | null,
  };
  // Pre-fill what the platform already knows, as the dashboard does.
  dp.evidence.customer_email_address = charge.billing_details?.email ?? charge.receipt_email ?? null;
  dp.evidence.customer_name = charge.billing_details?.name ?? null;
  dp.evidence.product_description = charge.description ?? null;
  if (!inquiry) await withdraw(ctx, dp, charge);
  await insertObject(ctx.accountId, dp);
  charge.disputed = true;
  charge._dispute = dp.id;
  await saveObject(ctx.accountId, charge);
  await emit(ctx, 'charge.dispute.created', dp);
  if (!inquiry) await emit(ctx, 'charge.dispute.funds_withdrawn', dp);
  return dp;
}

export async function updateDispute(ctx: Ctx, id: string, p: Params) {
  const dp = await getObject<any>(ctx.accountId, 'dispute', id, 'dispute');
  if (!['needs_response', 'warning_needs_response'].includes(dp.status)) {
    throw new ApiError(400, 'invalid_request_error', `This dispute is ${dp.status} and can no longer be updated.`, { code: 'dispute_already_submitted' });
  }
  if (p.evidence !== undefined) {
    if (typeof p.evidence !== 'object') throw invalid('Invalid evidence', 'evidence');
    for (const [k, v] of Object.entries<any>(p.evidence)) {
      if (!(EVIDENCE_FIELDS as readonly string[]).includes(k)) throw invalid(`Received unknown parameter: evidence[${k}]`, `evidence[${k}]`);
      if (FILE_EVIDENCE.has(k) && v) await assertFile(ctx, String(v), ['dispute_evidence'], `evidence[${k}]`);
      dp.evidence[k] = v === '' ? null : typeof v === 'object' ? v : String(v).slice(0, 20000);
    }
    dp.evidence_details.has_evidence = Object.values(dp.evidence).some((v) => v !== null);
  }
  dp.metadata = metadata(p, dp.metadata);
  const submit = bool(p, 'submit') ?? true; // the public API submits by default
  if (submit) {
    if (!dp.evidence_details.has_evidence) throw invalid('Provide at least one piece of evidence before submitting.', 'evidence');
    dp.evidence_details.submission_count += 1;
    dp.status = dp.status === 'warning_needs_response' ? 'warning_under_review' : 'under_review';
    dp._resolve_at = nowSeconds() + config.disputeReviewSeconds;
  }
  await saveObject(ctx.accountId, dp);
  await emit(ctx, 'charge.dispute.updated', dp);
  return dp;
}

/** Accept the dispute (or close the inquiry) without contesting it. */
export async function closeDispute(ctx: Ctx, id: string) {
  const dp = await getObject<any>(ctx.accountId, 'dispute', id, 'dispute');
  if (['won', 'lost', 'warning_closed'].includes(dp.status)) throw invalid(`This dispute is already ${dp.status}.`, 'dispute');
  if (['under_review', 'warning_under_review'].includes(dp.status)) throw invalid('Evidence was already submitted; the issuer is reviewing it.', 'dispute');
  dp.status = dp.status.startsWith('warning') ? 'warning_closed' : 'lost';
  dp._resolve_at = null;
  await saveObject(ctx.accountId, dp);
  await emit(ctx, 'charge.dispute.closed', dp);
  return dp;
}

/** Worker: the simulated issuer decides submitted disputes; unanswered ones expire as lost. */
export async function resolveDisputes(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>(
    "SELECT account_id, data FROM objects WHERE type = 'dispute' AND data->>'status' IN ('under_review', 'warning_under_review', 'needs_response', 'warning_needs_response') ORDER BY seq LIMIT 200",
  );
  let n = 0;
  for (const { account_id, data: dp } of rows) {
    const ctx = accountCtx(account_id);
    if (dp.status.endsWith('needs_response')) {
      if (now <= dp.evidence_details.due_by) continue;
      dp.evidence_details.past_due = true;
      dp.status = dp.status === 'warning_needs_response' ? 'warning_closed' : 'lost';
    } else {
      if (!dp._resolve_at || now < dp._resolve_at) continue;
      const text = String(dp.evidence.uncategorized_text ?? '');
      const win = text.includes('winning_evidence');
      const lose = text.includes('losing_evidence');
      if (!win && !lose) continue; // stays under review, as in test mode
      if (dp.status === 'warning_under_review') {
        if (win) dp.status = 'warning_closed';
        else {
          // The issuer escalates the inquiry to a chargeback.
          const charge = await findObject<any>(account_id, 'charge', dp.charge);
          dp.status = 'needs_response';
          dp.payment_method_details.card.case_type = 'chargeback';
          dp.evidence_details.due_by = now + 7 * DAY;
          dp._resolve_at = null;
          await withdraw(ctx, dp, charge);
          await saveObject(account_id, dp);
          await emit(ctx, 'charge.dispute.funds_withdrawn', dp);
          await emit(ctx, 'charge.dispute.updated', dp);
          n++;
          continue;
        }
      } else {
        dp.status = win ? 'won' : 'lost';
        if (win) await reinstate(ctx, dp);
      }
    }
    dp._resolve_at = null;
    await saveObject(account_id, dp);
    await emit(ctx, 'charge.dispute.closed', dp);
    n++;
  }
  return n;
}

/** Refunds are blocked on charged-back payments (an inquiry can still be refunded). */
export async function assertRefundable(ctx: Ctx, charge: any) {
  if (!charge._dispute) return;
  const dp = await findObject<any>(ctx.accountId, 'dispute', charge._dispute);
  if (dp && !dp.is_charge_refundable && !['won', 'warning_closed'].includes(dp.status)) {
    throw new ApiError(400, 'invalid_request_error', `Charge ${charge.id} has been charged back; cannot issue a refund.`, { code: 'charge_disputed', param: 'charge' });
  }
}

// ---------------------------------------------------------------- early fraud warnings

async function createEarlyFraudWarning(ctx: Ctx, charge: any) {
  const efw = {
    id: newId('issfr'),
    object: 'radar.early_fraud_warning',
    actionable: true,
    charge: charge.id,
    created: nowSeconds(),
    fraud_type: 'made_with_stolen_card',
    livemode: false,
    payment_intent: charge.payment_intent,
  };
  await insertObject(ctx.accountId, efw);
  charge._efw = efw.id;
  await saveObject(ctx.accountId, charge);
  await emit(ctx, 'radar.early_fraud_warning.created', efw);
  return efw;
}

/** A refunded charge's early fraud warning is no longer actionable. */
export async function afterRefundForDisputes(ctx: Ctx, charge: any) {
  if (charge._efw) {
    const efw = await findObject<any>(ctx.accountId, 'radar.early_fraud_warning', charge._efw);
    if (efw?.actionable) {
      efw.actionable = false;
      await saveObject(ctx.accountId, efw);
      await emit(ctx, 'radar.early_fraud_warning.updated', efw);
    }
  }
  if (charge._dispute) {
    const dp = await findObject<any>(ctx.accountId, 'dispute', charge._dispute);
    if (dp?.status === 'warning_needs_response' && charge.refunded) {
      dp.status = 'warning_closed';
      await saveObject(ctx.accountId, dp);
      await emit(ctx, 'charge.dispute.closed', dp);
    }
  }
}
