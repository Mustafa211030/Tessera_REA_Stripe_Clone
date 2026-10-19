import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { base32Decode, totp } from '../src/domain/team.ts';
import { runDueSchedules } from '../src/domain/scheduledReports.ts';
import { runWorkersOnce } from '../src/workers/index.ts';
import { form, start, type Env } from './helpers.ts';

let env: Env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

type Session = { cookie: string; csrf: string };

async function dash(s: Session | null, method: string, path: string, body?: any) {
  const res = await fetch(env.base + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(s ? { cookie: s.cookie, 'x-tessera-csrf': s.csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function v1(s: Session, method: string, path: string, body?: any) {
  const res = await fetch(env.base + path + (method === 'GET' && body ? `?${form(body)}` : ''), {
    method, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s.cookie, 'x-tessera-csrf': s.csrf },
    body: method !== 'GET' && body ? form(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}
const cookieOf = (h: Headers) => (h.get('set-cookie') ?? '').split(';')[0]!;
async function signup(email: string, name = 'Team Shop') {
  const r = await dash(null, 'POST', '/dashboard-api/signup', { email, password: 'password123', business_name: name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: cookieOf(r.headers), csrf: r.body.csrf } as Session;
}
async function login(email: string, password = 'password123') {
  const r = await dash(null, 'POST', '/dashboard-api/login', { email, password });
  return { ...r, session: r.body.ok ? { cookie: cookieOf(r.headers), csrf: r.body.csrf } as Session : null };
}

const tag = Date.now().toString(36);
const ownerEmail = `owner.${tag}@example.com`;
let owner: Session;
let analystId = '';

describe('team and roles', () => {
  it('invites by email, enforces roles and protects the last owner', async () => {
    owner = await signup(ownerEmail);
    const me = await dash(owner, 'GET', '/dashboard-api/session');
    assert.equal(me.body.user.role, 'owner');
    assert.equal(me.body.permissions.team, true);

    const bad = await dash(owner, 'POST', '/dashboard-api/team/invitations', { email: 'nope', role: 'analyst' });
    assert.equal(bad.status, 400);
    const inv = await dash(owner, 'POST', '/dashboard-api/team/invitations', { email: `ana.${tag}@example.com`, role: 'analyst' });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    const token = inv.body.url.split('/').pop();

    const inbox = await v1(owner, 'GET', '/v1/tessera/emails', { kind: 'team_invite' });
    assert.equal(inbox.body.data.length, 1);
    assert.equal(inbox.body.data[0].to, `ana.${tag}@example.com`);
    const full = await v1(owner, 'GET', `/v1/tessera/emails/${inbox.body.data[0].id}`);
    assert.ok(full.body.html.includes(`/invite/${token}`));

    const view = await dash(null, 'GET', `/hosted-api/invitations/${token}`);
    assert.equal(view.body.role_label, 'Analyst');
    const accepted = await dash(null, 'POST', `/hosted-api/invitations/${token}`, { name: 'Ana Lyst', password: 'password123' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const analyst: Session = { cookie: cookieOf(accepted.headers), csrf: accepted.body.csrf };
    assert.equal((await dash(null, 'GET', `/hosted-api/invitations/${token}`)).status, 404, 'invitations work once');

    const s = await dash(analyst, 'GET', '/dashboard-api/session');
    assert.equal(s.body.user.role, 'analyst');
    assert.equal((await v1(analyst, 'GET', '/v1/customers')).status, 200);
    const denied = await v1(analyst, 'POST', '/v1/customers', { email: 'x@example.com' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'role_not_permitted');
    assert.equal((await v1(analyst, 'POST', '/v1/tessera/sigma/query', { sql: 'SELECT 1' })).status, 200);
    assert.equal((await dash(analyst, 'GET', '/dashboard-api/keys')).status, 403);
    assert.equal((await dash(analyst, 'POST', '/dashboard-api/team/invitations', { email: 'z@example.com', role: 'admin' })).status, 403);
    assert.equal((await dash(analyst, 'GET', '/dashboard-api/audit')).status, 403);

    const team = await dash(owner, 'GET', '/dashboard-api/team');
    analystId = team.body.members.find((m: any) => m.role === 'analyst').id;
    await dash(owner, 'POST', `/dashboard-api/team/members/${analystId}`, { role: 'support' });
    assert.equal((await v1(analyst, 'POST', '/v1/customers', { email: 'ok@example.com' })).status, 200);
    assert.equal((await v1(analyst, 'POST', '/v1/webhook_endpoints', { url: 'http://x.example', enabled_events: ['*'] })).status, 403);

    const ownerId = team.body.members.find((m: any) => m.role === 'owner').id;
    const demote = await dash(owner, 'POST', `/dashboard-api/team/members/${ownerId}`, { role: 'admin' });
    assert.equal(demote.body.error.code, 'last_owner');
    assert.equal((await dash(owner, 'DELETE', `/dashboard-api/team/members/${ownerId}`)).status, 400, 'cannot remove yourself');
    const removed = await dash(owner, 'DELETE', `/dashboard-api/team/members/${analystId}`);
    assert.equal(removed.status, 200);
    assert.equal((await dash(analyst, 'GET', '/dashboard-api/session')).status, 401, 'removed members are signed out');
  });

  it('two-step sign-in with an authenticator app and backup codes', async () => {
    assert.equal((await dash(owner, 'POST', '/dashboard-api/2fa/setup', { password: 'wrong-password' })).status, 401);
    const setup = await dash(owner, 'POST', '/dashboard-api/2fa/setup', { password: 'password123' });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\//);
    const secret = setup.body.secret.replace(/\s/g, '');
    assert.equal(base32Decode(secret).length, 20);
    assert.equal((await dash(owner, 'POST', '/dashboard-api/2fa/enable', { code: '000000' === totp(secret) ? '111111' : '000000' })).status, 400);
    const on = await dash(owner, 'POST', '/dashboard-api/2fa/enable', { code: totp(secret) });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.backup_codes.length, 10);

    const step1 = await login(ownerEmail);
    assert.equal(step1.body.mfa_required, true);
    assert.equal(step1.session, null);
    const wrong = await dash(null, 'POST', '/dashboard-api/login/2fa', { mfa_token: step1.body.mfa_token, code: '123456' === totp(secret) ? '654321' : '123456' });
    assert.equal(wrong.status, 401);
    // The code used to enable two-step is spent; the next 30-second step is accepted (clock drift window).
    const code = totp(secret, Math.floor(Date.now() / 1000 / 30) + 1);
    const ok = await dash(null, 'POST', '/dashboard-api/login/2fa', { mfa_token: step1.body.mfa_token, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const session: Session = { cookie: cookieOf(ok.headers), csrf: ok.body.csrf };
    assert.equal((await dash(session, 'GET', '/dashboard-api/session')).body.user.two_step, true);

    const step2 = await login(ownerEmail);
    const replay = await dash(null, 'POST', '/dashboard-api/login/2fa', { mfa_token: step2.body.mfa_token, code });
    assert.equal(replay.status, 401, 'a code works only once');
    const backup = await dash(null, 'POST', '/dashboard-api/login/2fa', { mfa_token: step2.body.mfa_token, code: on.body.backup_codes[0] });
    assert.equal(backup.status, 200);
    assert.equal(backup.body.backup_codes_left, 9);
    const step3 = await login(ownerEmail);
    assert.equal((await dash(null, 'POST', '/dashboard-api/login/2fa', { mfa_token: step3.body.mfa_token, code: on.body.backup_codes[0] })).status, 401, 'backup codes work once');

    assert.equal((await login(ownerEmail, 'nope-nope-nope')).status, 401);
    const off = await dash(owner, 'POST', '/dashboard-api/2fa/disable', { password: 'password123' });
    assert.equal(off.status, 200);
    assert.equal((await login(ownerEmail)).body.ok, true);

    const log = await dash(owner, 'GET', '/dashboard-api/audit');
    const actions = log.body.data.map((x: any) => x.action);
    for (const a of ['account.created', 'team.invited', 'team.member_joined', 'team.role_changed', 'team.member_removed', 'user.two_step_enabled', 'user.login_failed', 'user.login', 'user.two_step_disabled']) {
      assert.ok(actions.includes(a), `${a} is in the security history`);
    }
    const failed = log.body.data.find((x: any) => x.action === 'user.login_failed' && x.details?.reason === 'password');
    assert.ok(failed, 'failed sign-ins are recorded even though the request failed');
  });
});

describe('emails', () => {
  it('sends receipts, refunds and invoices to the simulated inbox, per settings', async () => {
    const pi = await v1(owner, 'POST', '/v1/payment_intents', { amount: 2500, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', receipt_email: 'buyer@example.com', description: 'Beans' });
    assert.equal(pi.body.status, 'succeeded');
    await v1(owner, 'POST', '/v1/refunds', { payment_intent: pi.body.id, amount: 500 });
    const cus = (await v1(owner, 'POST', '/v1/customers', { email: 'inv@example.com' })).body;
    await v1(owner, 'POST', '/v1/invoiceitems', { customer: cus.id, amount: 9000, currency: 'usd', description: 'Consulting' });
    const inv = (await v1(owner, 'POST', '/v1/invoices', { customer: cus.id, pending_invoice_items_behavior: 'include', collection_method: 'send_invoice', days_until_due: 14 })).body;
    await v1(owner, 'POST', `/v1/invoices/${inv.id}/send`);
    const list = (await v1(owner, 'GET', '/v1/tessera/emails', { limit: 50 })).body.data;
    const kinds = list.map((e: any) => `${e.kind}:${e.to}`);
    assert.ok(kinds.includes('receipt:buyer@example.com'));
    assert.ok(kinds.includes('refund:buyer@example.com'));
    assert.equal(list.filter((e: any) => e.kind === 'invoice' && e.to === 'inv@example.com').length, 1, 'finalize + send sends one invoice email');
    const invEmail = (await v1(owner, 'GET', `/v1/tessera/emails/${list.find((e: any) => e.kind === 'invoice').id}`)).body;
    assert.ok(invEmail.html.includes('/invoices/pay/'));
    assert.match(invEmail.subject, /^Invoice .* from Team Shop$/);

    const off = await dash(owner, 'POST', '/dashboard-api/email-settings', { receipt: false });
    assert.equal(off.body.settings.receipt, false);
    await v1(owner, 'POST', '/v1/payment_intents', { amount: 900, currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', receipt_email: 'quiet@example.com' });
    const after = (await v1(owner, 'GET', '/v1/tessera/emails', { to: 'quiet@example.com' })).body.data;
    assert.equal(after.length, 0);
  });
});

describe('scheduled reports', () => {
  it('runs saved SQL on a schedule and delivers results as events with a CSV file', async () => {
    const bad = await v1(owner, 'POST', '/v1/tessera/report_schedules', { kind: 'sql', name: 'Broken', sql: 'SELECT nope FROM charges' });
    assert.equal(bad.status, 400);
    const s = await v1(owner, 'POST', '/v1/tessera/report_schedules', { kind: 'sql', name: 'Daily volume', interval: 'daily', sql: 'SELECT count(*) AS n, sum(amount) AS total FROM charges' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const run = await v1(owner, 'POST', `/v1/tessera/report_schedules/${s.body.id}/run`);
    assert.equal(run.body.object, 'scheduled_query_run');
    assert.equal(run.body.status, 'completed');
    const csv = await fetch(`${env.base}/v1/files/${run.body.file.id}/contents`, { headers: { cookie: owner.cookie } }).then((r) => r.text());
    assert.match(csv, /^n,total\n\d+,\d+/);
    const runs = await v1(owner, 'GET', '/v1/sigma/scheduled_query_runs');
    assert.equal(runs.body.data[0].id, run.body.id);
    const evts = await v1(owner, 'GET', '/v1/events', { type: 'sigma.scheduled_query_run.created' });
    assert.equal(evts.body.data[0].data.object.id, run.body.id);

    const rep = await v1(owner, 'POST', '/v1/tessera/report_schedules', { kind: 'report', report_type: 'balance.summary.1', interval: 'weekly' });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    const due = await runDueSchedules(Math.floor(Date.now() / 1000) + 8 * 86400);
    assert.ok(due >= 2);
    await runWorkersOnce();
    const reports = await v1(owner, 'GET', '/v1/reporting/report_runs', { limit: 5 });
    assert.ok(reports.body.data.some((r: any) => r.report_type === 'balance.summary.1' && r.status === 'succeeded'));
    const sched = (await v1(owner, 'GET', '/v1/tessera/report_schedules')).body.data.find((x: any) => x.id === s.body.id);
    assert.equal(sched.runs, 2);
    await v1(owner, 'POST', `/v1/tessera/report_schedules/${s.body.id}`, { active: 'false' });
    assert.equal((await v1(owner, 'DELETE', `/v1/tessera/report_schedules/${rep.body.id}`)).body.deleted, true);
  });
});

describe('sandbox tools', () => {
  it('exports everything and resets the account', async () => {
    const hook = await v1(owner, 'POST', '/v1/webhook_endpoints', { url: 'http://127.0.0.1:9/hook', enabled_events: ['charge.succeeded'] });
    assert.equal(hook.status, 200);
    const exp = await dash(owner, 'GET', '/dashboard-api/sandbox/export');
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition') ?? '', /attachment; filename="tessera-export-/);
    assert.ok(exp.body.counts.customer >= 2);
    assert.ok(exp.body.ledger_entries.length > 0);
    assert.equal(JSON.stringify(exp.body).includes('"_'), false, 'internal fields are not exported');

    const name = (await dash(owner, 'GET', '/dashboard-api/session')).body.account.settings.dashboard.display_name;
    assert.equal((await dash(owner, 'POST', '/dashboard-api/sandbox/reset', { password: 'password123', confirm: 'wrong' })).body.error.code, 'confirmation_mismatch');
    const keys = (await dash(owner, 'GET', '/dashboard-api/keys')).body.data;
    const sk = keys.find((k: any) => k.type === 'secret').token;
    const reset = await dash(owner, 'POST', '/dashboard-api/sandbox/reset', { password: 'password123', confirm: name });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.ok(reset.body.objects_deleted > 10);
    assert.equal((await v1(owner, 'GET', '/v1/customers')).body.data.length, 0);
    assert.equal((await v1(owner, 'GET', '/v1/balance')).body.available[0].amount, 0);
    const hooks = (await v1(owner, 'GET', '/v1/webhook_endpoints')).body.data;
    assert.deepEqual(hooks.map((h: any) => h.id), [hook.body.id], 'webhook endpoints are kept');
    assert.equal((await fetch(`${env.base}/v1/customers`, { headers: { authorization: `Bearer ${sk}` } })).status, 200, 'API keys are kept');

    const reset2 = await dash(owner, 'POST', '/dashboard-api/sandbox/reset', { password: 'password123', confirm: name, keep_api_keys: false, keep_webhook_endpoints: false });
    assert.match(reset2.body.new_keys.secret, /^sk_test_/);
    assert.equal((await fetch(`${env.base}/v1/customers`, { headers: { authorization: `Bearer ${sk}` } })).status, 401);
    assert.equal((await v1(owner, 'GET', '/v1/webhook_endpoints')).body.data.length, 0);
    const log = await dash(owner, 'GET', '/dashboard-api/audit');
    assert.ok(log.body.data.some((x: any) => x.action === 'sandbox.reset'));
    assert.ok(log.body.data.some((x: any) => x.action === 'dashboard.change' && x.target === 'POST /v1/webhook_endpoints'));
  });
});
