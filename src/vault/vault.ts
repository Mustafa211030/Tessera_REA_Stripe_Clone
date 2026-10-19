import { PGlite } from '@electric-sql/pglite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as processor from './processor.ts';

/**
 * Card Data Vault.
 *
 * Isolation model (from Stripe's published security design, scaled down to one machine):
 *  - Its own database (separate PGlite data directory) and its own key file; nothing in
 *    src/domain imports this module's internals, only the narrow interface exported below.
 *  - PANs are encrypted at rest with AES-256-GCM; the data key lives in a different file
 *    from the ciphertext.
 *  - CVC is checked at tokenization and never stored.
 *  - Callers get an opaque token and display data (brand, last4, fingerprint). There is
 *    no function that returns a PAN; the vault only forwards cards to the processor.
 */
export type TokenizeInput = { number: string; exp_month: number; exp_year: number; cvc?: string };
export type TokenizeResult =
  | { ok: true; token: string; brand: string; last4: string; fingerprint: string; country: string; funding: string; exp_month: number; exp_year: number; cvc_check: 'pass' | 'fail' | 'unavailable'; three_d_secure_required: boolean; auth_profile: 'none' | 'setup' | 'always'; dispute_profile: { reason: string; inquiry?: boolean; efw?: boolean } | null; risk_hint: number; bypass_pending: boolean }
  | { ok: false; code: string; message: string; param: string };

let vdb: PGlite | null = null;
let dataKey: Buffer;
let fingerprintKey: Buffer;

export async function openVault(dir?: string) {
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, '..', 'vault.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(64).toString('hex'), { mode: 0o600 });
    const raw = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    dataKey = raw.subarray(0, 32);
    fingerprintKey = raw.subarray(32, 64);
  } else {
    dataKey = randomBytes(32);
    fingerprintKey = randomBytes(32);
  }
  vdb = await PGlite.create(dir);
  await vdb.exec(`CREATE TABLE IF NOT EXISTS cards (
    token text PRIMARY KEY, iv text NOT NULL, ciphertext text NOT NULL, tag text NOT NULL,
    fingerprint text NOT NULL, created bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS access_log (seq bigserial PRIMARY KEY, token text, action text, at bigint);`);
}

export async function closeVault() {
  if (vdb) await vdb.close();
  vdb = null;
}

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), ciphertext: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

function decrypt(row: { iv: string; ciphertext: string; tag: string }) {
  const d = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(row.iv, 'base64'));
  d.setAuthTag(Buffer.from(row.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(row.ciphertext, 'base64')), d.final()]).toString('utf8');
}

export async function tokenize(input: TokenizeInput): Promise<TokenizeResult> {
  if (!vdb) throw new Error('vault closed');
  const number = String(input.number).replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(number) || !processor.luhn(number))
    return { ok: false, code: 'incorrect_number', message: 'Your card number is incorrect.', param: 'card[number]' };
  const now = new Date();
  const m = Number(input.exp_month);
  let y = Number(input.exp_year);
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12)) return { ok: false, code: 'invalid_expiry_month', message: "Your card's expiration month is invalid.", param: 'card[exp_month]' };
  if (!(y >= now.getUTCFullYear()) || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1))
    return { ok: false, code: 'invalid_expiry_year', message: "Your card's expiration year is invalid.", param: 'card[exp_year]' };
  if (input.cvc !== undefined && !/^\d{3,4}$/.test(String(input.cvc)))
    return { ok: false, code: 'invalid_cvc', message: "Your card's security code is invalid.", param: 'card[cvc]' };

  const fingerprint = createHmac('sha256', fingerprintKey).update(number).digest('base64url').slice(0, 16);
  const token = `vtok_${randomBytes(12).toString('base64url')}`;
  const enc = encrypt(number);
  await vdb.query('INSERT INTO cards (token, iv, ciphertext, tag, fingerprint, created) VALUES ($1,$2,$3,$4,$5,$6)', [
    token, enc.iv, enc.ciphertext, enc.tag, fingerprint, Math.floor(Date.now() / 1000),
  ]);
  const info = processor.cardInfo(number);
  return {
    ok: true,
    token,
    brand: info.brand,
    country: info.country,
    funding: info.funding,
    last4: number.slice(-4),
    fingerprint,
    exp_month: m,
    exp_year: y,
    cvc_check: input.cvc === undefined ? 'unavailable' : processor.CVC_FAIL.has(number) ? 'fail' : 'pass',
    three_d_secure_required: processor.THREE_DS_REQUIRED.has(number),
    auth_profile: processor.AUTH_PROFILE[number] ?? 'none',
    dispute_profile: processor.DISPUTE_PROFILE[number] ?? null,
    risk_hint: processor.RISK_HINT[number] ?? 0,
    bypass_pending: processor.BYPASS_PENDING.has(number),
  };
}

/** Forward the card behind `token` to the processor for authorization. */
export async function authorize(token: string, amount: number): Promise<processor.AuthResult> {
  if (!vdb) throw new Error('vault closed');
  const row = await vdb.query<{ iv: string; ciphertext: string; tag: string }>('SELECT iv, ciphertext, tag FROM cards WHERE token = $1', [token]);
  if (!row.rows[0]) return { approved: false, network_status: 'not_sent_to_network', code: 'payment_method_unavailable', message: 'The card could not be found in the vault.' };
  await vdb.query('INSERT INTO access_log (token, action, at) VALUES ($1, $2, $3)', [token, 'authorize', Math.floor(Date.now() / 1000)]);
  const pan = decrypt(row.rows[0]);
  return processor.authorize(pan, amount);
}

export async function vaultStats() {
  if (!vdb) return { cards: 0, accesses: 0 };
  const c = await vdb.query<{ n: number }>('SELECT count(*)::int AS n FROM cards');
  const a = await vdb.query<{ n: number }>('SELECT count(*)::int AS n FROM access_log');
  return { cards: c.rows[0]!.n, accesses: a.rows[0]!.n };
}
