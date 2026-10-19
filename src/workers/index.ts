import { config } from '../config.ts';
import { query, transaction } from '../db/index.ts';
import { settleDue } from '../domain/balance.ts';
import { deliverDue } from '../domain/webhooks.ts';
import { runBilling } from '../domain/billing/subscriptions.ts';
import { advancePayouts, automaticPayouts } from '../domain/connect/payouts.ts';
import { resolveDisputes } from '../domain/disputes.ts';
import { processReportRuns } from '../domain/reporting.ts';
import { processVerifications } from '../domain/identity.ts';
import { processTreasury } from '../domain/treasury.ts';
import { resolveIssuingDisputes } from '../domain/issuing.ts';
import { confirmOrders } from '../domain/climate.ts';
import { processCapital } from '../domain/capital.ts';
import { verifyTaxIds } from '../domain/taxIds.ts';
import { runDueSchedules } from '../domain/scheduledReports.ts';
import { overdueInstallments } from '../domain/billing/installments.ts';
import { settleBankDebits } from '../domain/bankDebits.ts';
import { scheduledReconciliation } from '../domain/reconciliation.ts';
import type { Ctx } from '../platform/context.ts';
import { nowSeconds } from '../lib/ids.ts';

/**
 * Background workers, kept off the request path:
 *  - webhook delivery with retries and backoff
 *  - settlement (pending -> available, network clearing)
 *  - idempotency-key pruning after 24h
 */
/** Billing engine for real-time (non test-clock) subscriptions, one account at a time. */
export async function billingTick() {
  const accounts = await query<{ account_id: string; platform: string | null }>("SELECT DISTINCT o.account_id, a.platform FROM objects o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.type = 'subscription'");
  for (const { account_id, platform } of accounts) {
    const ctx: Ctx = { accountId: account_id, platformAccountId: platform ?? undefined, livemode: false, apiVersion: config.latestApiVersion, keyType: 'secret', requestId: `req_billing_${Date.now()}`, baseUrl: `http://localhost:${config.port}` };
    await transaction(() => runBilling(ctx, null, nowSeconds()));
  }
}

export function startWorkers() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await billingTick();
      await transaction(() => settleBankDebits());
      await transaction(() => settleDue());
      await payoutsTick();
      await transaction(() => resolveDisputes());
      await transaction(() => processReportRuns());
      await transaction(() => processVerifications());
      await transaction(() => processTreasury());
      await transaction(() => resolveIssuingDisputes());
      await transaction(() => confirmOrders());
      await transaction(() => processCapital());
      await transaction(() => verifyTaxIds());
      await transaction(() => runDueSchedules());
      await transaction(() => overdueInstallments());
      await transaction(() => scheduledReconciliation(config.reconcileSeconds));
      await deliverDue();
      await query('DELETE FROM idempotency_keys WHERE created < $1', [nowSeconds() - 86400]);
      await query('DELETE FROM sessions WHERE expires < $1', [nowSeconds()]);
    } catch (e) {
      console.error('[worker]', e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, config.workerIntervalMs);
  return () => clearInterval(timer);
}

/** Payouts: lifecycle (pending → in_transit → paid/failed) and automatic schedules. */
export async function payoutsTick(now?: number) {
  await transaction(() => advancePayouts(now));
  await transaction(() => automaticPayouts(now));
}

export async function runWorkersOnce() {
  await billingTick();
  await transaction(() => settleBankDebits());
  await transaction(() => settleDue());
  await payoutsTick();
  await transaction(() => resolveDisputes());
  await transaction(() => processReportRuns());
  await transaction(() => processVerifications());
  await transaction(() => processTreasury());
  await transaction(() => resolveIssuingDisputes());
  await transaction(() => confirmOrders());
  await transaction(() => processCapital());
  await transaction(() => verifyTaxIds());
  await transaction(() => overdueInstallments());
  await transaction(() => runDueSchedules());
  await transaction(() => processReportRuns());
  await deliverDue();
}
