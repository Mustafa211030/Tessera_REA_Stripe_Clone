import { createHash, createHmac, randomBytes } from 'node:crypto';
import { one, query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { checkPassword, getAccount, hashPassword } from './accounts.ts';

/**
 * Team members, roles, the security history (audit log) and two-step sign-in (TOTP).
 *
 * Roles decide what a dashboard session may change. Everyone can read; writes are limited
 * per role and per API resource (the same names restricted keys use):
 *
 *   owner / admin   everything, including the team, API keys and sandbox reset
 *   developer       every API resource, API keys and webhooks; not the team
 *   analyst         read-only, plus reports and SQL
 *   support         customers, refunds, disputes, invoices, credit notes, subscriptions
 *   view_only       read-only
 */

export const ROLES = {
  owner: { label: 'Owner', write: '*', team: true, keys: true, sandbox: true },
  admin: { label: 'Administrator', write: '*', team: true, keys: true, sandbox: true },
  developer: { label: 'Developer', write: '*', team: false, keys: true, sandbox: false },
  analyst: { label: 'Analyst', write: ['reporting'], team: false, keys: false, sandbox: false },
  support: { label: 'Support specialist', write: ['customers', 'refunds', 'disputes', 'invoices', 'credit_notes', 'subscriptions', 'payment_methods', 'setup_intents', 'charges', 'tax_ids'], team: false, keys: false, sandbox: false },
  view_only: { label: 'View only', write: [], team: false, keys: false, sandbox: false },
} as const;
export type Role = keyof typeof ROLES;
export const isRole = (r: unknown): r is Role => typeof r === 'string' && r in ROLES;

/** Whether a dashboard session with this role may make this request. */
export function can(role: string, resource: string, method: string) {
  if (method === 'GET') return true;
  const r = ROLES[(isRole(role) ? role : 'view_only') as Role];
  return r.write === '*' || (r.write as readonly string[]).includes(resource);
}

export function requireRole(user: { role: string }, need: 'team' | 'keys' | 'sandbox', what: string) {
  const r = ROLES[(isRole(user.role) ? user.role : 'view_only') as Role];
  if (!r[need]) throw new ApiError(403, 'permission_error', `Your role (${r.label}) can't ${what}. Ask an owner or administrator.`, { code: 'role_not_permitted' });
}

// ---------------------------------------------------------------- audit log

export async function audit(accountId: string, actor: { id?: string | null; email?: string | null } | null, action: string, target: string | null = null, details: Record<string, unknown> | null = null, ip: string | null = null) {
  await query('INSERT INTO audit_logs (id, account_id, user_id, actor, action, target, details, ip, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    newId('aud', 16), accountId, actor?.id ?? null, actor?.email ?? null, action, target, details ? JSON.stringify(details) : null, ip, nowSeconds(),
  ]);
}

export async function auditLog(accountId: string, p: { limit?: number; before?: number; action?: string }) {
  const args: unknown[] = [accountId];
  let where = 'account_id = $1';
  if (p.action) { args.push(`${p.action}%`); where += ` AND action LIKE $${args.length}`; }
  if (p.before) { args.push(p.before); where += ` AND seq < $${args.length}`; }
  args.push(Math.min(200, Math.max(1, p.limit ?? 50)));
  const rows = await query<any>(`SELECT seq, id, user_id, actor, action, target, details, ip, created FROM audit_logs WHERE ${where} ORDER BY seq DESC LIMIT $${args.length}`, args);
  return { data: rows };
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secret: string, step = Math.floor(Date.now() / 1000 / 30)) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

/** Accepts the previous, current and next 30-second step; returns the matched step. */
function verifyTotp(secret: string, code: string, lastStep: number | null) {
  const now = Math.floor(Date.now() / 1000 / 30);
  for (const s of [now - 1, now, now + 1]) {
    if (lastStep !== null && s <= lastStep) continue; // a code works once
    if (totp(secret, s) === code) return s;
  }
  return null;
}

const hashCode = (c: string) => createHash('sha256').update(c.replace(/[\s-]/g, '').toLowerCase()).digest('hex');

export async function startTotpSetup(userId: string, password: string) {
  const u = await one<any>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u || !checkPassword(password, u.password_hash)) throw new ApiError(401, 'authentication_error', 'Incorrect password.', { code: 'incorrect_password' });
  if (u.totp_secret) throw invalid('Two-step authentication is already on. Turn it off first to set up a new authenticator.', 'totp');
  const secret = base32Encode(randomBytes(20));
  await query('UPDATE users SET totp_pending = $1 WHERE id = $2', [secret, userId]);
  const acct = await getAccount(u.account_id);
  const issuer = 'Tessera';
  const label = encodeURIComponent(`${issuer}:${u.email}`);
  return {
    secret: secret.match(/.{1,4}/g)!.join(' '),
    otpauth_uri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
    account: acct?.settings?.dashboard?.display_name ?? null,
  };
}

export async function enableTotp(user: { user_id: string; email: string; account_id: string }, code: string, ip?: string) {
  const u = await one<any>('SELECT * FROM users WHERE id = $1', [user.user_id]);
  if (!u?.totp_pending) throw invalid('Start the setup first.', 'code');
  const step = verifyTotp(u.totp_pending, String(code).trim(), null);
  if (step === null) throw invalid("That code doesn't match. Check your authenticator app's clock and try the newest code.", 'code', 'incorrect_code');
  const codes = Array.from({ length: 10 }, () => `${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`);
  await query('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $1, backup_codes = $2 WHERE id = $3', [step, JSON.stringify(codes.map(hashCode)), user.user_id]);
  await audit(user.account_id, { id: user.user_id, email: user.email }, 'user.two_step_enabled', user.email, null, ip ?? null);
  return { backup_codes: codes };
}

export async function disableTotp(user: { user_id: string; email: string; account_id: string }, password: string, ip?: string) {
  const u = await one<any>('SELECT * FROM users WHERE id = $1', [user.user_id]);
  if (!u || !checkPassword(password, u.password_hash)) throw new ApiError(401, 'authentication_error', 'Incorrect password.', { code: 'incorrect_password' });
  await query('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, backup_codes = NULL WHERE id = $1', [user.user_id]);
  await audit(user.account_id, { id: user.user_id, email: user.email }, 'user.two_step_disabled', user.email, null, ip ?? null);
  return { ok: true };
}

// ---------------------------------------------------------------- sign-in

async function newSession(userId: string, userAgent?: string) {
  const session = { id: `sess_${randomBytes(24).toString('base64url')}`, csrf: randomBytes(18).toString('base64url'), expires: nowSeconds() + 7 * 86400 };
  await query('INSERT INTO sessions (id, user_id, csrf, expires, created, user_agent) VALUES ($1,$2,$3,$4,$5,$6)', [session.id, userId, session.csrf, session.expires, nowSeconds(), userAgent?.slice(0, 200) ?? null]);
  await query('UPDATE users SET last_login = $1 WHERE id = $2', [nowSeconds(), userId]);
  return session;
}

/** Step one: password. Returns a session, or an MFA challenge when two-step is on. */
export async function signIn(email: string, password: string, meta: { ip?: string; userAgent?: string } = {}) {
  const u = await one<any>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!u || !checkPassword(password, u.password_hash)) {
    if (u) await audit(u.account_id, { id: u.id, email: u.email }, 'user.login_failed', u.email, { reason: 'password' }, meta.ip ?? null);
    // Returned (not thrown) so the audit entry commits; the route turns it into the error.
    return { failed: new ApiError(401, 'authentication_error', 'Incorrect email or password.') } as const;
  }
  if (u.totp_secret) {
    const token = `mfa_${randomBytes(24).toString('base64url')}`;
    await query('INSERT INTO mfa_challenges (token, user_id, expires) VALUES ($1,$2,$3)', [token, u.id, nowSeconds() + 300]);
    return { mfa_required: true as const, mfa_token: token, failed: undefined };
  }
  const s = await newSession(u.id, meta.userAgent);
  await audit(u.account_id, { id: u.id, email: u.email }, 'user.login', u.email, null, meta.ip ?? null);
  return { mfa_required: false as const, session: s, failed: undefined };
}

/** Step two: a 6-digit code from the authenticator app, or a one-time backup code. */
export async function verifySignIn(token: string, code: string, meta: { ip?: string; userAgent?: string } = {}) {
  const ch = await one<any>('SELECT * FROM mfa_challenges WHERE token = $1', [token]);
  if (!ch || ch.expires < nowSeconds() || ch.attempts >= 5) {
    throw new ApiError(401, 'authentication_error', 'This sign-in attempt expired. Enter your email and password again.', { code: 'mfa_challenge_expired' });
  }
  const u = await one<any>('SELECT * FROM users WHERE id = $1', [ch.user_id]);
  const c = String(code ?? '').trim();
  let ok = false;
  let usedBackup = false;
  if (/^\d{6}$/.test(c)) {
    const step = verifyTotp(u.totp_secret, c, u.totp_last_step === null ? null : Number(u.totp_last_step));
    if (step !== null) { ok = true; await query('UPDATE users SET totp_last_step = $1 WHERE id = $2', [step, u.id]); }
  } else if (c) {
    const codes: string[] = u.backup_codes ?? [];
    const h = hashCode(c);
    if (codes.includes(h)) {
      ok = true; usedBackup = true;
      await query('UPDATE users SET backup_codes = $1 WHERE id = $2', [JSON.stringify(codes.filter((x) => x !== h)), u.id]);
    }
  }
  if (!ok) {
    await query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token = $1', [token]);
    await audit(u.account_id, { id: u.id, email: u.email }, 'user.login_failed', u.email, { reason: 'two_step_code' }, meta.ip ?? null);
    return { failed: new ApiError(401, 'authentication_error', 'That code is incorrect or has already been used.', { code: 'incorrect_code' }) } as const;
  }
  await query('DELETE FROM mfa_challenges WHERE token = $1', [token]);
  const s = await newSession(u.id, meta.userAgent);
  await audit(u.account_id, { id: u.id, email: u.email }, 'user.login', u.email, { two_step: usedBackup ? 'backup_code' : 'authenticator' }, meta.ip ?? null);
  return { session: s, backup_codes_left: usedBackup ? (u.backup_codes?.length ?? 1) - 1 : undefined, failed: undefined };
}

// ---------------------------------------------------------------- members and invitations

export async function members(accountId: string) {
  const users = await query<any>('SELECT id, email, name, role, created, last_login, (totp_secret IS NOT NULL) AS two_step FROM users WHERE account_id = $1 ORDER BY created', [accountId]);
  const invites = await query<any>('SELECT id, email, role, created, expires, invited_by FROM invitations WHERE account_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires > $2 ORDER BY created DESC', [accountId, nowSeconds()]);
  return { members: users, invitations: invites };
}

export async function invite(actor: { user_id: string; email: string; account_id: string; role: string }, email: string, role: string, baseUrl: string) {
  requireRole(actor, 'team', 'invite team members');
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw invalid('Enter a valid email address.', 'email');
  if (!isRole(role)) throw invalid(`Choose a role: ${Object.keys(ROLES).join(', ')}.`, 'role');
  if (role === 'owner' && actor.role !== 'owner') throw new ApiError(403, 'permission_error', 'Only an owner can invite another owner.', { code: 'role_not_permitted' });
  if (await one('SELECT 1 FROM users WHERE email = $1', [e])) throw invalid('That person already has a Tessera account. Each email can belong to one account in this local build.', 'email');
  await query('UPDATE invitations SET revoked_at = $1 WHERE account_id = $2 AND email = $3 AND accepted_at IS NULL AND revoked_at IS NULL', [nowSeconds(), actor.account_id, e]);
  const token = randomBytes(24).toString('base64url');
  const inv = { id: newId('inv', 16), account_id: actor.account_id, email: e, role, token, invited_by: actor.email, created: nowSeconds(), expires: nowSeconds() + 7 * 86400 };
  await query('INSERT INTO invitations (id, account_id, email, role, token, invited_by, created, expires) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [inv.id, inv.account_id, e, role, token, actor.email, inv.created, inv.expires]);
  await audit(actor.account_id, { id: actor.user_id, email: actor.email }, 'team.invited', e, { role });
  const acct = await getAccount(actor.account_id);
  const name = acct?.settings?.dashboard?.display_name ?? 'a Tessera account';
  const url = `${baseUrl}/invite/${token}`;
  const { sendEmail } = await import('./emails.ts');
  await sendEmail(actor.account_id, {
    to: e, kind: 'team_invite', subject: `${actor.email} invited you to join ${name} on Tessera`,
    heading: `Join ${name} on Tessera`,
    paragraphs: [`${actor.email} invited you to the ${name} team as ${ROLES[role].label}.`, 'The invitation expires in 7 days.'],
    button: { label: 'Accept invitation', url },
  });
  return { ...inv, token: undefined, url };
}

export async function revokeInvite(actor: { user_id: string; email: string; account_id: string; role: string }, id: string) {
  requireRole(actor, 'team', 'manage invitations');
  const inv = await one<any>('SELECT * FROM invitations WHERE id = $1 AND account_id = $2', [id, actor.account_id]);
  if (!inv) throw invalid('No such invitation.', 'id', 'resource_missing');
  await query('UPDATE invitations SET revoked_at = $1 WHERE id = $2', [nowSeconds(), id]);
  await audit(actor.account_id, { id: actor.user_id, email: actor.email }, 'team.invitation_revoked', inv.email);
  return { ok: true };
}

export async function invitationView(token: string) {
  const inv = await one<any>('SELECT * FROM invitations WHERE token = $1', [token]);
  if (!inv || inv.revoked_at || inv.accepted_at || inv.expires < nowSeconds()) throw new ApiError(404, 'invalid_request_error', 'This invitation is no longer valid. Ask for a new one.', { code: 'invitation_invalid' });
  const acct = await getAccount(inv.account_id);
  return { email: inv.email, role: inv.role, role_label: ROLES[inv.role as Role]?.label ?? inv.role, account: acct?.settings?.dashboard?.display_name ?? 'Tessera account', invited_by: inv.invited_by };
}

export async function acceptInvite(token: string, name: string, password: string, meta: { ip?: string; userAgent?: string } = {}) {
  const v = await invitationView(token);
  if (String(password ?? '').length < 8) throw invalid('Use at least 8 characters for your password.', 'password');
  const inv = await one<any>('SELECT * FROM invitations WHERE token = $1', [token]);
  if (await one('SELECT 1 FROM users WHERE email = $1', [inv.email])) throw invalid('An account with this email already exists.', 'email');
  const id = newId('usr', 16);
  await query('INSERT INTO users (id, email, password_hash, account_id, created, role, name) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, inv.email, hashPassword(password), inv.account_id, nowSeconds(), inv.role, String(name ?? '').slice(0, 100) || null]);
  await query('UPDATE invitations SET accepted_at = $1 WHERE id = $2', [nowSeconds(), inv.id]);
  await audit(inv.account_id, { id, email: inv.email }, 'team.member_joined', inv.email, { role: inv.role }, meta.ip ?? null);
  const s = await newSession(id, meta.userAgent);
  return { session: s, account: v.account };
}

async function ownersLeft(accountId: string, excluding: string) {
  return (await one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE account_id = $1 AND role = 'owner' AND id <> $2", [accountId, excluding]))?.n ?? 0;
}

export async function changeRole(actor: { user_id: string; email: string; account_id: string; role: string }, userId: string, role: string) {
  requireRole(actor, 'team', 'change roles');
  if (!isRole(role)) throw invalid(`Choose a role: ${Object.keys(ROLES).join(', ')}.`, 'role');
  const u = await one<any>('SELECT * FROM users WHERE id = $1 AND account_id = $2', [userId, actor.account_id]);
  if (!u) throw invalid('No such team member.', 'id', 'resource_missing');
  if ((role === 'owner' || u.role === 'owner') && actor.role !== 'owner') throw new ApiError(403, 'permission_error', 'Only an owner can grant or remove the owner role.', { code: 'role_not_permitted' });
  if (u.role === 'owner' && role !== 'owner' && (await ownersLeft(actor.account_id, u.id)) === 0) throw invalid('An account needs at least one owner. Make someone else an owner first.', 'role', 'last_owner');
  await query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
  await audit(actor.account_id, { id: actor.user_id, email: actor.email }, 'team.role_changed', u.email, { from: u.role, to: role });
  return { ok: true };
}

export async function removeMember(actor: { user_id: string; email: string; account_id: string; role: string }, userId: string) {
  requireRole(actor, 'team', 'remove team members');
  const u = await one<any>('SELECT * FROM users WHERE id = $1 AND account_id = $2', [userId, actor.account_id]);
  if (!u) throw invalid('No such team member.', 'id', 'resource_missing');
  if (u.id === actor.user_id) throw invalid("You can't remove yourself. Ask another administrator.", 'id');
  if (u.role === 'owner' && actor.role !== 'owner') throw new ApiError(403, 'permission_error', 'Only an owner can remove an owner.', { code: 'role_not_permitted' });
  if (u.role === 'owner' && (await ownersLeft(actor.account_id, u.id)) === 0) throw invalid('An account needs at least one owner.', 'id', 'last_owner');
  await query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  await query('DELETE FROM mfa_challenges WHERE user_id = $1', [u.id]);
  await query('DELETE FROM users WHERE id = $1', [u.id]);
  await audit(actor.account_id, { id: actor.user_id, email: actor.email }, 'team.member_removed', u.email, { role: u.role });
  return { ok: true };
}
