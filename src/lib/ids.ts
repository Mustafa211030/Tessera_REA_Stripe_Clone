import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Random base62 string, e.g. for object ids and secrets. */
export function base62(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 248) out += ALPHABET[b % 62];
  }
  while (out.length < length) out += ALPHABET[randomBytes(1)[0]! % 62];
  return out;
}

/** Stripe-style prefixed ids: pi_3Pq..., cus_Q..., evt_... */
export function newId(prefix: string, length = 24): string {
  return `${prefix}_${base62(length)}`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
