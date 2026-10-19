import { createHash, randomBytes, randomInt } from 'node:crypto';
import { one, query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Ctx } from '../platform/context.ts';
import { sendEmail } from './emails.ts';
import { buildFromToken, vaultCardOf } from './paymentMethods.ts';
import { findObject } from './store.ts';

/**
 * Tessera one-click checkout: customers save their card once, then pay at any Tessera business
 * by confirming a six-digit code sent to their email.
 *
 *   lookup(email)        → is there a profile? if so, a code is emailed (Developers → Emails)
 *   verify(id, code)     → a 30-minute session token with the saved cards (masked)
 *   paymentMethod(...)   → a fresh card PaymentMethod on the merchant's account, card.wallet.type = oneclick
 *   saveCard(...)        → after a successful card payment, if the customer opted in
 *
 * Profiles live outside any one account (like a wallet). In test mode the code 000000 is
 * also accepted, so flows can be scripted without reading the inbox.
 */
const CODE_TTL = 10 * 60;
const SESSION_TTL = 30 * 60;
const MAX_ATTEMPTS = 5;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (e: string) => String(e ?? '').trim().toLowerCase();

export function maskEmail(email: string) {
  const [u, d] = email.split('@');
  return `${u!.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, u!.length - 1)))}@${d}`;
}

async function profile(email: string) {
  return (await one<{ data: any }>('SELECT data FROM oneclick_profiles WHERE email = $1', [norm(email)]))?.data ?? null;
}

/** Starts sign-in when a profile exists for this email; the code goes to the merchant's test inbox. */
export async function lookup(ctx: Ctx, emailIn: string) {
  const email = norm(emailIn);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('Enter a valid email address.', 'email', 'email_invalid');
  const p = await profile(email);
  if (!p) return { exists: false };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = newId('occh', 20);
  await query('INSERT INTO oneclick_challenges (id, email, code_hash, expires) VALUES ($1,$2,$3,$4)', [id, email, hash(code), nowSeconds() + CODE_TTL]);
  await sendEmail(ctx.accountId, {
    to: email, kind: 'verification_code', subject: `${code} is your one-click checkout code`, heading: 'Your one-click checkout code',
    paragraphs: [`Enter ${code} to pay with the details you saved for one-click checkout.`, 'The code expires in 10 minutes. If you did not try to check out, you can ignore this email.'],
    related: null,
  });
  return { exists: true, challenge: id, masked_email: maskEmail(email), name: p.name ?? null };
}

export async function verify(challengeId: string, code: string) {
  const ch = await one<any>('SELECT * FROM oneclick_challenges WHERE id = $1', [String(challengeId ?? '')]);
  if (!ch || ch.used || Number(ch.expires) < nowSeconds()) throw new ApiError(400, 'invalid_request_error', 'This code has expired. Request a new one.', { code: 'verification_expired' });
  if (ch.attempts >= MAX_ATTEMPTS) throw new ApiError(400, 'invalid_request_error', 'Too many incorrect codes. Request a new one.', { code: 'verification_attempts_exceeded' });
  const c = String(code ?? '').replace(/\D/g, '');
  if (c !== '000000' && hash(c) !== ch.code_hash) {
    await query('UPDATE oneclick_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
    return { failed: true as const, left: MAX_ATTEMPTS - ch.attempts - 1 };
  }
  await query('UPDATE oneclick_challenges SET used = true WHERE id = $1', [ch.id]);
  const token = `ocs_${randomBytes(24).toString('base64url')}`;
  await query('INSERT INTO oneclick_sessions (token, email, expires) VALUES ($1,$2,$3)', [token, ch.email, nowSeconds() + SESSION_TTL]);
  return { token, ...(await view(token)) };
}

async function sessionEmail(token: string) {
  const s = await one<{ email: string; expires: string }>('SELECT email, expires FROM oneclick_sessions WHERE token = $1', [String(token ?? '')]);
  if (!s || Number(s.expires) < nowSeconds()) throw new ApiError(401, 'authentication_error', 'Your one-click session has ended. Sign in again.', { code: 'oneclick_session_expired' });
  return s.email;
}

export async function view(token: string) {
  const email = await sessionEmail(token);
  const p = await profile(email);
  if (!p) throw new ApiError(404, 'invalid_request_error', 'No saved details for this email.', { code: 'resource_missing' });
  return {
    email, name: p.name ?? null, default_card: p.default_card ?? p.cards[0]?.id ?? null,
    cards: p.cards.map((c: any) => ({ id: c.id, brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year, funding: c.funding })),
  };
}

export async function logout(token: string) {
  await query('DELETE FROM oneclick_sessions WHERE token = $1', [String(token ?? '')]);
  return { ok: true };
}

/** Removes one saved card, or the whole profile when it was the last. */
export async function removeCard(token: string, cardId: string) {
  const email = await sessionEmail(token);
  const p = await profile(email);
  if (!p) return { deleted: true };
  p.cards = p.cards.filter((c: any) => c.id !== cardId);
  if (!p.cards.length) {
    await query('DELETE FROM oneclick_profiles WHERE email = $1', [email]);
    await query('DELETE FROM oneclick_sessions WHERE email = $1', [email]);
    return { deleted: true };
  }
  if (p.default_card === cardId) p.default_card = p.cards[0].id;
  await query('UPDATE oneclick_profiles SET data = $1, updated = $2 WHERE email = $3', [JSON.stringify(p), nowSeconds(), email]);
  return view(token);
}

/** A card PaymentMethod on the merchant's account, made from a saved one-click card. */
export async function paymentMethod(ctx: Ctx, token: string, cardId?: string) {
  const email = await sessionEmail(token);
  const p = await profile(email);
  const card = p?.cards.find((c: any) => c.id === (cardId || p.default_card)) ?? p?.cards[0];
  if (!card) throw invalid('That saved card is no longer available.', 'oneclick[card]');
  if (card.exp_year < new Date().getUTCFullYear() || (card.exp_year === new Date().getUTCFullYear() && card.exp_month < new Date().getUTCMonth() + 1)) {
    throw invalid('That saved card has expired. Pay with a different card.', 'oneclick[card]', 'expired_card');
  }
  const pm = await buildFromToken(ctx, card.vault, { billing_details: { email, name: p.name ?? null } }, { type: 'oneclick', oneclick: { email } });
  return { pm, email, name: p.name ?? null };
}

/** After a successful card payment where the customer opted in: save (or add) the card. */
export async function saveCard(ctx: Ctx, pmId: string, emailIn: string, name?: string | null) {
  const email = norm(emailIn);
  if (!email) return null;
  const pm = await findObject<any>(ctx.accountId, 'payment_method', pmId);
  const vault = vaultCardOf(pm);
  if (!vault || pm.card?.wallet?.type === 'oneclick') return null;
  const now = nowSeconds();
  const existing = await profile(email);
  const p = existing ?? { name: name ?? null, cards: [] as any[] };
  if (name && !p.name) p.name = name;
  let card = p.cards.find((c: any) => c.fingerprint === vault.fingerprint);
  if (!card) {
    card = { id: newId('occ', 16), brand: vault.brand, last4: vault.last4, exp_month: vault.exp_month, exp_year: vault.exp_year, funding: vault.funding, fingerprint: vault.fingerprint, vault, added: now };
    p.cards.unshift(card);
  }
  p.default_card = card.id;
  if (existing) await query('UPDATE oneclick_profiles SET data = $1, updated = $2 WHERE email = $3', [JSON.stringify(p), now, email]);
  else await query('INSERT INTO oneclick_profiles (email, data, created, updated) VALUES ($1,$2,$3,$3)', [email, JSON.stringify(p), now]);
  return { saved: true, email, card: card.id };
}

export async function hasProfile(email: string) {
  return !!(await profile(email));
}
