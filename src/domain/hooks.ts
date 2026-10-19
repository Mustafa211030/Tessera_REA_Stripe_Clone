import type { Ctx } from '../platform/context.ts';

/**
 * In-process subscribers for PaymentIntent outcomes. Billing uses this to mark invoices
 * paid when their PaymentIntent succeeds, whichever path confirmed it (server-side,
 * client-side with a client_secret, or after a 3-D Secure challenge).
 */
type Hook = (ctx: Ctx, pi: any) => Promise<void>;
const succeeded: Hook[] = [];
const failed: Hook[] = [];

export const onPaymentSucceeded = (h: Hook) => succeeded.push(h);
export const onPaymentFailed = (h: Hook) => failed.push(h);

export async function paymentSucceeded(ctx: Ctx, pi: any) {
  for (const h of succeeded) await h(ctx, pi);
}
export async function paymentFailed(ctx: Ctx, pi: any) {
  for (const h of failed) await h(ctx, pi);
}
