import { query } from '../../db/index.ts';
import { invalid } from '../../lib/errors.ts';
import type { Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { getAccount } from '../accounts.ts';
import { emit } from '../events.ts';
import { findObject, saveObject } from '../store.ts';

/**
 * Failed-payment recovery for subscription invoices (Settings → Billing).
 *
 * Retry modes:
 *   schedule  retry after fixed numbers of days (default 3, 5, 7 days after each failure)
 *   smart     Tessera picks each retry time from the decline:
 *               - hard declines (lost, stolen or expired card, wrong number, authentication
 *                 required…) are not retried: a retry cannot succeed until the card changes
 *               - insufficient funds: retried on the next 1st or 15th of the month (common paydays)
 *               - other declines: spaced out (1, 2, 2, 3, 3, 3 … days) at 14:00 UTC
 *             within a window (default 8 attempts in 14 days)
 *
 * When retries run out, `after_failure` decides what happens: the subscription is canceled,
 * marked unpaid (renewals stop until an invoice is paid) or left past due; the invoice is left
 * open or marked uncollectible.
 */
export type BillingSettings = {
  retry: { mode: 'smart' | 'schedule'; schedule_days: number[]; max_attempts: number; window_days: number };
  after_failure: { subscription: 'cancel' | 'unpaid' | 'past_due'; invoice: 'open' | 'uncollectible' };
};
const DEFAULTS: BillingSettings = {
  retry: { mode: 'schedule', schedule_days: [3, 5, 7], max_attempts: 8, window_days: 14 },
  after_failure: { subscription: 'cancel', invoice: 'open' },
};
const DAY = 86400;

/** Declines a retry cannot fix: the customer has to give a new payment method. */
export const HARD_DECLINES: Record<string, string> = {
  expired_card: 'the card has expired',
  lost_card: 'the card was reported lost',
  stolen_card: 'the card was reported stolen',
  incorrect_number: 'the card number is incorrect',
  invalid_account: 'the account is invalid',
  pickup_card: 'the bank asked for the card to be retained',
  card_not_supported: 'the card does not support this kind of purchase',
  authentication_required: 'the bank requires the customer to authenticate',
  account_closed: 'the bank account is closed',
  no_account: 'the bank account could not be found',
  debit_not_authorized: 'the customer told their bank the debit was not authorized',
};

export async function getSettings(accountId: string): Promise<BillingSettings> {
  const a = await getAccount(accountId);
  const s = a?._billing_settings ?? {};
  return { retry: { ...DEFAULTS.retry, ...(s.retry ?? {}) }, after_failure: { ...DEFAULTS.after_failure, ...(s.after_failure ?? {}) } };
}

export async function updateSettings(ctx: Ctx, p: Params) {
  const cur = await getSettings(ctx.accountId);
  const r = p.retry ?? {};
  if (r.mode !== undefined) {
    if (!['smart', 'schedule'].includes(r.mode)) throw invalid('retry[mode] must be smart or schedule.', 'retry[mode]');
    cur.retry.mode = r.mode;
  }
  if (r.schedule_days !== undefined) {
    const days: number[] = (Array.isArray(r.schedule_days) ? r.schedule_days : Object.values(r.schedule_days)).map(Number);
    if (!days.length || days.length > 8 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 30)) throw invalid('retry[schedule_days] takes 1 to 8 whole numbers of days, each 1 to 30.', 'retry[schedule_days]');
    cur.retry.schedule_days = days;
  }
  if (r.max_attempts !== undefined) {
    const n = Number(r.max_attempts);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw invalid('retry[max_attempts] must be between 1 and 8.', 'retry[max_attempts]');
    cur.retry.max_attempts = n;
  }
  if (r.window_days !== undefined) {
    const n = Number(r.window_days);
    if (![7, 14, 21, 30, 60].includes(n)) throw invalid('retry[window_days] must be 7, 14, 21, 30 or 60.', 'retry[window_days]');
    cur.retry.window_days = n;
  }
  const a = p.after_failure ?? {};
  if (a.subscription !== undefined) {
    if (!['cancel', 'unpaid', 'past_due'].includes(a.subscription)) throw invalid('after_failure[subscription] must be cancel, unpaid or past_due.', 'after_failure[subscription]');
    cur.after_failure.subscription = a.subscription;
  }
  if (a.invoice !== undefined) {
    if (!['open', 'uncollectible'].includes(a.invoice)) throw invalid('after_failure[invoice] must be open or uncollectible.', 'after_failure[invoice]');
    cur.after_failure.invoice = a.invoice;
  }
  const acct = await getAccount(ctx.accountId);
  acct._billing_settings = cur;
  await query('UPDATE accounts SET data = $1 WHERE id = $2', [JSON.stringify(acct), ctx.accountId]);
  return { object: 'tessera.billing_settings', ...cur };
}

/** 14:00 UTC on the day `t` falls on, or the next day if that has passed. */
function afternoon(t: number) {
  const d = new Date(t * 1000);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14) / 1000;
  return at >= t ? at : at + DAY;
}

/** The next 1st or 15th of a month, at 14:00 UTC, at least a day after `t`. */
function nextPayday(t: number) {
  const from = new Date((t + DAY) * 1000);
  const y = from.getUTCFullYear(), m = from.getUTCMonth(), day = from.getUTCDate();
  const c = day <= 1 ? Date.UTC(y, m, 1, 14) : day <= 15 ? Date.UTC(y, m, 15, 14) : Date.UTC(y, m + 1, 1, 14);
  return Math.max(c / 1000, afternoon(t + DAY));
}

const fmtDay = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Decides whether (and when) to retry after a failed automatic attempt. */
export function planRetry(s: BillingSettings, inv: any, now: number, code: string | null): { next: number | null; reason: string } {
  if (s.retry.mode === 'schedule') {
    const days = s.retry.schedule_days[inv.attempt_count - 1];
    return days === undefined
      ? { next: null, reason: `All ${s.retry.schedule_days.length} scheduled retries have been used.` }
      : { next: now + days * DAY, reason: `Retry ${inv.attempt_count} of ${s.retry.schedule_days.length}, ${days} day${days === 1 ? '' : 's'} after this failure (custom schedule).` };
  }
  if (code && HARD_DECLINES[code]) return { next: null, reason: `Not retried: ${HARD_DECLINES[code]}, so a retry cannot succeed. The customer needs to update their payment method.` };
  if (inv.attempt_count >= s.retry.max_attempts) return { next: null, reason: `All ${s.retry.max_attempts} attempts have been used.` };
  const first = inv._first_failure_at ?? now;
  const deadline = first + s.retry.window_days * DAY;
  if (now >= deadline - DAY / 2) return { next: null, reason: `The ${s.retry.window_days}-day retry window has ended.` };
  let next: number, reason: string;
  if (code === 'insufficient_funds') {
    next = nextPayday(now);
    reason = `Insufficient funds: retrying on ${fmtDay(next)}, the next common payday.`;
  } else {
    const gaps = [1, 2, 2, 3, 3, 3, 3, 3];
    const gap = gaps.at(Math.min(inv.attempt_count - 1, gaps.length - 1))!;
    next = afternoon(now + gap * DAY);
    reason = code === 'no_payment_method'
      ? `No payment method on file: retrying on ${fmtDay(next)} in case the customer adds one.`
      : `Retrying on ${fmtDay(next)}${code ? ` after a ${code.replace(/_/g, ' ')} decline` : ''}, spacing attempts across the ${s.retry.window_days}-day window.`;
  }
  if (next > deadline) { next = deadline; reason += ` Moved to the end of the ${s.retry.window_days}-day window.`; }
  return { next, reason };
}

/** Records the attempt on the invoice and returns whether retries have run out. */
export async function scheduleRetry(ctx: Ctx, inv: any, now: number, failure: { code: string | null; message: string | null }) {
  const automatic = inv.auto_advance && inv.collection_method === 'charge_automatically' && inv.billing_reason !== 'subscription_create';
  if (inv.attempt_count === 1) inv._first_failure_at = now;
  const plan = automatic ? planRetry(await getSettings(ctx.accountId), inv, now, failure.code) : { next: null, reason: inv.billing_reason === 'subscription_create' ? 'First invoice of a subscription: the customer pays it on-session.' : 'This invoice is not collected automatically.' };
  inv.next_payment_attempt = plan.next;
  inv._attempts = [...(inv._attempts ?? []), { at: now, decline_code: failure.code, message: failure.message, next_payment_attempt: plan.next, reason: plan.reason }];
  return { exhausted: automatic && plan.next === null };
}

/** What happens once retries have run out (Settings → Billing → after all retries fail). */
export async function afterRetriesExhausted(ctx: Ctx, inv: any, now: number) {
  const s = await getSettings(ctx.accountId);
  if (inv.subscription) {
    const sub = await findObject<any>(ctx.accountId, 'subscription', inv.subscription);
    if (sub && ['past_due', 'active', 'trialing'].includes(sub.status)) {
      if (s.after_failure.subscription === 'cancel') {
        await (await import('./subscriptions.ts')).cancelForNonPayment(ctx, sub, now);
      } else if (s.after_failure.subscription === 'unpaid') {
        const prev = sub.status;
        sub.status = 'unpaid';
        await saveObject(ctx.accountId, sub);
        await emit(ctx, 'customer.subscription.updated', sub, { status: prev });
      }
    }
  }
  if (s.after_failure.invoice === 'uncollectible') {
    const fresh = await findObject<any>(ctx.accountId, 'invoice', inv.id);
    if (fresh?.status === 'open') await (await import('./invoices.ts')).markUncollectible(ctx, fresh);
  }
}

/** Attempt history and the plan for an invoice (dashboard). */
export async function retryHistory(ctx: Ctx, invoiceId: string) {
  const inv = await findObject<any>(ctx.accountId, 'invoice', invoiceId);
  if (!inv) throw invalid(`No such invoice: '${invoiceId}'`, 'id', 'resource_missing');
  const s = await getSettings(ctx.accountId);
  return { object: 'tessera.invoice_retries', invoice: inv.id, attempt_count: inv.attempt_count, next_payment_attempt: inv.next_payment_attempt, mode: s.retry.mode, attempts: inv._attempts ?? [] };
}
