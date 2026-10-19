import { join } from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4242),
  host: env.HOST ?? '127.0.0.1',
  dataDir: env.DATA_DIR ?? join(process.cwd(), 'data'),
  /** Latest API version; accounts are pinned to it on creation. */
  latestApiVersion: '2026-10-01',
  /** Seconds before captured funds move from pending to available. */
  settlementDelaySeconds: Number(env.SETTLEMENT_DELAY_SECONDS ?? 120),
  /** Sandbox-style limits from the public rate-limit docs. */
  rateLimitPerSecond: Number(env.RATE_LIMIT_PER_SECOND ?? 25),
  concurrencyLimit: Number(env.CONCURRENCY_LIMIT ?? 50),
  /** Webhook retry schedule in seconds (live-mode style: about 3 days in total). */
  webhookRetrySchedule: (env.WEBHOOK_RETRY_SCHEDULE ?? '60,300,1800,3600,7200,14400,28800,43200,86400,86400').split(',').map(Number),
  webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 10000),
  workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 1000),
  /** Payouts: seconds until a pending payout is in transit, and until it arrives (paid or failed). */
  payoutInTransitSeconds: Number(env.PAYOUT_IN_TRANSIT_SECONDS ?? 5),
  payoutArrivalSeconds: Number(env.PAYOUT_ARRIVAL_SECONDS ?? 60),
  /** Instant Payouts to debit cards arrive after this many seconds. */
  instantPayoutSeconds: Number(env.INSTANT_PAYOUT_SECONDS ?? 2),
  /** Disputes: seconds a submitted dispute stays under review before the (simulated) issuer decides. */
  disputeReviewSeconds: Number(env.DISPUTE_REVIEW_SECONDS ?? 30),
  disputeFee: Number(env.DISPUTE_FEE ?? 1500),
  /** Identity: seconds a submitted verification spends processing before its (simulated) result. */
  /** Issuing: how long an issuing_authorization.request endpoint has to answer. */
  issuingWebhookTimeoutMs: Number(env.ISSUING_WEBHOOK_TIMEOUT_MS ?? 2000),
  /** Treasury: seconds until a processing ACH flow settles (succeeds, posts or fails). */
  treasurySettleSeconds: Number(env.TREASURY_SETTLE_SECONDS ?? 5),
  identityProcessingSeconds: Number(env.IDENTITY_PROCESSING_SECONDS ?? 3),
  /** Climate: seconds until a new carbon removal order is confirmed with suppliers. */
  climateConfirmSeconds: Number(env.CLIMATE_CONFIRM_SECONDS ?? 3),
  /** Capital: seconds between accepting a financing offer and the advance being paid out. */
  capitalPayoutSeconds: Number(env.CAPITAL_PAYOUT_SECONDS ?? 3),
  /** Tax IDs: seconds until a pending VAT/ABN verification resolves. */
  taxIdVerifySeconds: Number(env.TAX_ID_VERIFY_SECONDS ?? 2),
  /** ACH Direct Debit: seconds a submitted bank debit stays processing before the network answers. */
  bankDebitSeconds: Number(env.BANK_DEBIT_SECONDS ?? 10),
  /** Shards (partitions) of the object store; can be raised later, never lowered. */
  shardCount: Number(env.SHARD_COUNT ?? 4),
  /** Load shedding: in-flight requests the server is sized for; non-critical traffic is shed above 80%. */
  fleetCapacity: Number(env.FLEET_CAPACITY ?? 200),
  /** Load shedding: event-loop delay (ms) at which the worker starts shedding lower-priority traffic. */
  shedLagMs: Number(env.SHED_LAG_MS ?? 500),
  /** Ledger reconciliation runs this often (seconds). */
  reconcileSeconds: Number(env.RECONCILE_SECONDS ?? 3600),
};

export const setConfig = (patch: Partial<typeof config>) => Object.assign(config, patch);
