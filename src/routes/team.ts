import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { transaction } from '../db/index.ts';
import { sessionUser } from '../domain/accounts.ts';
import * as emails from '../domain/emails.ts';
import * as sandbox from '../domain/sandbox.ts';
import * as schedules from '../domain/scheduledReports.ts';
import * as team from '../domain/team.ts';
import { ApiError } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';

const COOKIE = 'tsr_session';

function sendErr(reply: FastifyReply, e: unknown) {
  const err = e instanceof ApiError ? e : new ApiError(500, 'api_error', 'Something went wrong.');
  if (!(e instanceof ApiError)) console.error(e);
  return reply.code(err.status).send(err.toJSON());
}

async function user(req: FastifyRequest) {
  const sid = /(?:^|;\s*)tsr_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const u = await sessionUser(sid);
  if (!u) throw new ApiError(401, 'authentication_error', 'Not signed in.');
  if (req.method !== 'GET' && req.headers['x-tessera-csrf'] !== u.csrf) throw new ApiError(403, 'permission_error', 'Invalid CSRF token.');
  return u;
}

const base = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;

/** Team, roles, two-step sign-in, security history, emails, scheduled reports and sandbox tools. */
export function registerTeam(app: FastifyInstance) {
  const route = (method: 'GET' | 'POST' | 'DELETE', url: string, fn: (u: Awaited<ReturnType<typeof user>>, req: FastifyRequest, reply: FastifyReply) => Promise<any>) => {
    app.route({ method, url, handler: async (req, reply) => {
      try {
        const u = await user(req);
        return await transaction(() => fn(u, req, reply));
      } catch (e) { return sendErr(reply, e); }
    } });
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as any;

  // ---------- Team ----------
  route('GET', '/dashboard-api/team', async (u) => ({ ...(await team.members(u.account_id)), roles: Object.entries(team.ROLES).map(([id, r]) => ({ id, ...r })), me: u.user_id }));
  route('POST', '/dashboard-api/team/invitations', async (u, req) => team.invite(u, body(req).email, body(req).role, base(req)));
  route('DELETE', '/dashboard-api/team/invitations/:id', async (u, req) => team.revokeInvite(u, (req.params as any).id));
  route('POST', '/dashboard-api/team/members/:id', async (u, req) => team.changeRole(u, (req.params as any).id, body(req).role));
  route('DELETE', '/dashboard-api/team/members/:id', async (u, req) => team.removeMember(u, (req.params as any).id));

  app.get('/hosted-api/invitations/:token', async (req, reply) => {
    try { return await team.invitationView((req.params as any).token); } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/invitations/:token', async (req, reply) => {
    try {
      const b = body(req);
      const r = await transaction(() => team.acceptInvite((req.params as any).token, String(b.name ?? ''), String(b.password ?? ''), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') }));
      reply.header('Set-Cookie', `${COOKIE}=${r.session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}`);
      return { ok: true, csrf: r.session.csrf, account: r.account };
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Two-step authentication ----------
  route('POST', '/dashboard-api/2fa/setup', async (u, req) => team.startTotpSetup(u.user_id, String(body(req).password ?? '')));
  route('POST', '/dashboard-api/2fa/enable', async (u, req) => team.enableTotp(u, String(body(req).code ?? ''), req.ip));
  route('POST', '/dashboard-api/2fa/disable', async (u, req) => team.disableTotp(u, String(body(req).password ?? ''), req.ip));

  // ---------- Security history ----------
  route('GET', '/dashboard-api/audit', async (u, req) => {
    team.requireRole(u, 'team', 'view the security history');
    const q = req.query as any;
    return team.auditLog(u.account_id, { limit: q.limit ? Number(q.limit) : 50, before: q.before ? Number(q.before) : undefined, action: q.action ? String(q.action) : undefined });
  });

  // ---------- Email settings ----------
  route('GET', '/dashboard-api/email-settings', async (u) => ({ settings: await emails.emailSettings(u.account_id), kinds: emails.KINDS }));
  route('POST', '/dashboard-api/email-settings', async (u, req) => {
    team.requireRole(u, 'team', 'change email settings');
    const s = await emails.updateEmailSettings(u.account_id, body(req));
    await team.audit(u.account_id, { id: u.user_id, email: u.email }, 'settings.emails_updated', null, s, req.ip);
    return { settings: s, kinds: emails.KINDS };
  });
  apiRoute(app, 'GET', '/v1/tessera/emails', { resource: 'events' }, (ctx, p) => emails.listEmails(ctx, p));
  apiRoute(app, 'GET', '/v1/tessera/emails/:id', { resource: 'events' }, (ctx, p) => emails.getEmail(ctx, p.id));

  // ---------- Sandbox data ----------
  app.get('/dashboard-api/sandbox/export', async (req, reply) => {
    try {
      const u = await user(req);
      team.requireRole(u, 'keys', 'export account data');
      const data = await transaction(() => sandbox.exportData(u.account_id, u));
      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="tessera-export-${u.account_id}-${new Date().toISOString().slice(0, 10)}.json"`)
        .send(JSON.stringify(data, null, 2));
    } catch (e) { return sendErr(reply, e); }
  });
  route('POST', '/dashboard-api/sandbox/reset', async (u, req) => {
    team.requireRole(u, 'sandbox', 'reset account data');
    const b = body(req);
    return sandbox.resetData(u.account_id, u, { password: b.password, confirm: b.confirm, keep_api_keys: b.keep_api_keys !== false, keep_webhook_endpoints: b.keep_webhook_endpoints !== false });
  });

  // ---------- Scheduled reports ----------
  apiRoute(app, 'POST', '/v1/tessera/report_schedules', { resource: 'reporting' }, (ctx, p) => schedules.createSchedule(ctx, p));
  apiRoute(app, 'GET', '/v1/tessera/report_schedules', { resource: 'reporting' }, (ctx, p) => schedules.listSchedules(ctx, p));
  apiRoute(app, 'POST', '/v1/tessera/report_schedules/:id', { resource: 'reporting' }, (ctx, p) => schedules.updateSchedule(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/tessera/report_schedules/:id', { resource: 'reporting' }, (ctx, p) => schedules.deleteSchedule(ctx, p.id));
  apiRoute(app, 'POST', '/v1/tessera/report_schedules/:id/run', { resource: 'reporting' }, (ctx, p) => schedules.runNow(ctx, p.id));
  apiRoute(app, 'GET', '/v1/sigma/scheduled_query_runs', { resource: 'reporting' }, (ctx, p) => schedules.listQueryRuns(ctx, p));
  apiRoute(app, 'GET', '/v1/sigma/scheduled_query_runs/:id', { resource: 'reporting' }, (ctx, p) => schedules.getQueryRun(ctx, p.id));
}
