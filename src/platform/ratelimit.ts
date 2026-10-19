import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config } from '../config.ts';
import { ApiError } from '../lib/errors.ts';

/**
 * Four tiers of protection, after Stripe's published design:
 *
 *  1. Request rate limiter (token bucket per API key): steady rate config.rateLimitPerSecond,
 *     bursts up to the bucket size.
 *  2. Concurrent request limiter: at most config.concurrencyLimit requests in flight per account.
 *  3. Fleet usage load shedder: 20% of capacity is kept for critical requests (creating and
 *     confirming payments); everything else is shed once the server is 80% busy.
 *  4. Worker utilization load shedder: when the event loop falls behind (measured delay), traffic
 *     is shed by priority class, lowest first: dashboard reads, then API reads, then non-critical
 *     writes. Critical requests are never shed by this tier.
 *
 * Every tier fails open: a bug in limiting must never take the API down.
 */
export type TrafficClass = 'critical' | 'post' | 'get' | 'low';
const CLASS_RANK: Record<TrafficClass, number> = { critical: 0, post: 1, get: 2, low: 3 };

type Bucket = { tokens: number; updated: number };
const buckets = new Map<string, Bucket>();
const inflight = new Map<string, number>();
let fleetInflight = 0;

export const counters = {
  allowed: 0,
  rate_limited: 0, // tier 1
  concurrency_limited: 0, // tier 2
  fleet_shed: 0, // tier 3
  worker_shed: 0, // tier 4
  by_class: { critical: 0, post: 0, get: 0, low: 0 } as Record<TrafficClass, number>,
  shed_by_class: { critical: 0, post: 0, get: 0, low: 0 } as Record<TrafficClass, number>,
};

// ---------------------------------------------------------------- worker utilization signal

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let lagMs = 0;
let previous = 0;
let simulatedLag: number | null = null;
const sampler = setInterval(() => {
  // Mean delay per second, minus the sampling resolution; the lower of the last two seconds,
  // so a single slow moment (a big query, start-up) never sheds traffic on its own.
  const mean = Math.max(0, histogram.mean / 1e6 - 10);
  lagMs = Math.min(mean, previous);
  previous = mean;
  histogram.reset();
}, 1000);
sampler.unref();

/** Event-loop delay used by tier 4 (sustained over two seconds, in ms). */
export const currentLag = () => simulatedLag ?? lagMs;
/** Tests and the load demo can pretend the worker is overloaded. */
export const simulateLag = (ms: number | null) => { simulatedLag = ms; };

/** The lowest-priority class still served at the current delay. */
export function servedUpTo(): TrafficClass {
  const lag = currentLag(), t = config.shedLagMs;
  if (lag >= t * 4) return 'critical';
  if (lag >= t * 2) return 'post';
  if (lag >= t) return 'get';
  return 'low';
}

function limited(reason: string, message: string) {
  return new ApiError(429, 'rate_limit_error', message, { code: 'rate_limit', headers: { 'Stripe-Rate-Limited-Reason': reason, 'Stripe-Should-Retry': 'true' } });
}

export function acquire(keyId: string, accountId: string, cls: TrafficClass): () => void {
  try {
    const now = Date.now();
    // Tier 1: token bucket.
    const rate = config.rateLimitPerSecond;
    const b = buckets.get(keyId) ?? { tokens: rate, updated: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.updated) / 1000) * rate);
    b.updated = now;
    if (b.tokens < 1) {
      buckets.set(keyId, b);
      counters.rate_limited++;
      throw limited('global-rate', 'Request rate limit exceeded. Learn more about rate limits in the docs; retry with exponential backoff and jitter.');
    }
    // Tier 2: concurrent requests per account.
    const n = inflight.get(accountId) ?? 0;
    if (n >= config.concurrencyLimit) {
      counters.concurrency_limited++;
      throw limited('global-concurrency', 'Too many concurrent requests. Reduce the number of simultaneous requests and retry with backoff.');
    }
    // Tier 3: fleet usage; the last 20% of capacity is for critical requests only.
    if (cls !== 'critical' && fleetInflight >= Math.floor(config.fleetCapacity * 0.8)) {
      counters.fleet_shed++;
      counters.shed_by_class[cls]++;
      throw limited('fleet-usage', 'The API is shedding non-critical traffic due to high load. Retry shortly.');
    }
    // Tier 4: worker utilization, by priority class.
    if (CLASS_RANK[cls] > CLASS_RANK[servedUpTo()]) {
      counters.worker_shed++;
      counters.shed_by_class[cls]++;
      throw limited('worker-utilization', 'The server is busy and is serving higher-priority requests first. Retry shortly.');
    }
    b.tokens -= 1;
    buckets.set(keyId, b);
    inflight.set(accountId, n + 1);
    fleetInflight++;
    counters.allowed++;
    counters.by_class[cls]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inflight.set(accountId, Math.max(0, (inflight.get(accountId) ?? 1) - 1));
      fleetInflight = Math.max(0, fleetInflight - 1);
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return () => {}; // fail open
  }
}

export function limiterState() {
  return {
    fleet_inflight: fleetInflight, fleet_capacity: config.fleetCapacity, critical_reserve: config.fleetCapacity - Math.floor(config.fleetCapacity * 0.8),
    event_loop_delay_ms: Math.round(currentLag()), shed_threshold_ms: config.shedLagMs, served_up_to: servedUpTo(),
    rate_per_second: config.rateLimitPerSecond, concurrency_per_account: config.concurrencyLimit, counters: JSON.parse(JSON.stringify(counters)),
  };
}

export function resetLimits() {
  buckets.clear();
  inflight.clear();
  fleetInflight = 0;
  simulatedLag = null;
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) {
    const v = counters[k];
    if (typeof v === 'number') (counters as any)[k] = 0;
    else for (const c of Object.keys(v)) (v as any)[c] = 0;
  }
}
