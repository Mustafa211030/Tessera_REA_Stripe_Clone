import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { one, query, transaction } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { ensurePlatformFields } from './connect/accounts.ts';

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

export function checkPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  const a = scryptSync(pw, Buffer.from(salt!, 'hex'), 32);
  const b = Buffer.from(hash!, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createKey(accountId: string, type: 'secret' | 'publishable' | 'restricted', name?: string, permissions?: Record<string, string>) {
  const prefix = type === 'secret' ? 'sk_test' : type === 'publishable' ? 'pk_test' : 'rk_test';
  const key = { id: newId('key', 16), account_id: accountId, type, name: name ?? null, token: `${prefix}_${base62(99)}`, permissions: permissions ?? null, created: nowSeconds() };
  await query('INSERT INTO api_keys (id, account_id, type, name, token, permissions, created) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    key.id, accountId, type, key.name, key.token, permissions ? JSON.stringify(permissions) : null, key.created,
  ]);
  return key;
}

export async function createAccount(email: string, password: string, businessName: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('Enter a valid email address.', 'email');
  if (password.length < 8) throw invalid('Use at least 8 characters for your password.', 'password');
  return transaction(async () => {
    if (await one('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()])) throw invalid('An account with this email already exists.', 'email');
    const accountId = newId('acct', 16);
    const created = nowSeconds();
    const account = {
      id: accountId,
      object: 'account',
      business_profile: { name: businessName, url: null, support_email: email },
      charges_enabled: true,
      country: 'US',
      created,
      default_currency: 'usd',
      email,
      payouts_enabled: true,
      settings: { dashboard: { display_name: businessName, timezone: 'Etc/UTC' }, payments: { statement_descriptor: businessName.toUpperCase().slice(0, 22) } },
      type: 'standard',
      _api_version: config.latestApiVersion,
    };
    ensurePlatformFields(account);
    await query('INSERT INTO accounts (id, created, data) VALUES ($1,$2,$3)', [accountId, created, JSON.stringify(account)]);
    await query('SELECT tessera_shard($1)', [accountId]); // placed on a shard in the same transaction
    const userId = newId('usr', 16);
    await query('INSERT INTO users (id, email, password_hash, account_id, created) VALUES ($1,$2,$3,$4,$5)', [userId, email.toLowerCase(), hashPassword(password), accountId, created]);
    const sk = await createKey(accountId, 'secret', 'Standard secret key');
    const pk = await createKey(accountId, 'publishable', 'Standard publishable key');
    return { account, userId, secretKey: sk.token, publishableKey: pk.token };
  });
}

export async function getAccount(accountId: string) {
  return (await one<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [accountId]))?.data;
}

export async function login(email: string, password: string) {
  const u = await one<any>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!u || !checkPassword(password, u.password_hash)) throw new ApiError(401, 'authentication_error', 'Incorrect email or password.');
  const session = { id: `sess_${randomBytes(24).toString('base64url')}`, csrf: randomBytes(18).toString('base64url'), expires: nowSeconds() + 7 * 86400 };
  await query('INSERT INTO sessions (id, user_id, csrf, expires, created) VALUES ($1,$2,$3,$4,$5)', [session.id, u.id, session.csrf, session.expires, nowSeconds()]);
  return session;
}

export async function sessionUser(sessionId: string | undefined) {
  if (!sessionId) return undefined;
  return one<{ user_id: string; email: string; account_id: string; csrf: string; role: string; name: string | null; two_step: boolean }>(
    'SELECT s.user_id, s.csrf, u.email, u.account_id, u.role, u.name, (u.totp_secret IS NOT NULL) AS two_step FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires > $2',
    [sessionId, nowSeconds()],
  );
}

export async function listKeys(accountId: string) {
  return query('SELECT id, type, name, token, permissions, created, expires, last_used FROM api_keys WHERE account_id = $1 AND (expires IS NULL OR expires > $2) ORDER BY created', [accountId, nowSeconds()]);
}

/** Roll a key: issue a new one; the old one keeps working for `expiresIn` seconds. */
export async function rollKey(accountId: string, keyId: string, expiresIn = 0) {
  const k = await one<any>('SELECT * FROM api_keys WHERE id = $1 AND account_id = $2', [keyId, accountId]);
  if (!k) throw invalid('No such key', 'id');
  const fresh = await createKey(accountId, k.type, k.name, k.permissions ?? undefined);
  await query('UPDATE api_keys SET expires = $1 WHERE id = $2', [nowSeconds() + expiresIn, keyId]);
  (await import('../platform/hotpath.ts')).invalidateKeys();
  return fresh;
}
