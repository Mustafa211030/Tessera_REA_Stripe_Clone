import type { FastifyInstance, FastifyReply } from 'fastify';
import { one, query, transaction } from '../db/index.ts';
import * as team from '../domain/team.ts';
import * as accounts from '../domain/accounts.ts';
import * as checkout from '../domain/checkout.ts';
import { completeAuthentication } from '../domain/paymentIntents.ts';
import { ApiError, CommitThenFail } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Ctx } from '../platform/context.ts';
import { config } from '../config.ts';
import { stripInternal } from '../domain/paymentIntents.ts';
import * as connect from '../domain/connect/accounts.ts';
import { getBalance } from '../domain/balance.ts';

const COOKIE = 'tsr_session';

function sendErr(reply: FastifyReply, e: unknown) {
  const err = e instanceof ApiError ? e : new ApiError(500, 'api_error', 'Something went wrong.');
  if (!(e instanceof ApiError)) console.error(e);
  return reply.code(err.status).send(err.toJSON());
}

async function ctxForObject(id: string, baseUrl: string): Promise<Ctx> {
  const row = await one<{ account_id: string; platform: string | null }>('SELECT o.account_id, a.platform FROM objects o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.id = $1', [id]);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'Not found', { code: 'resource_missing' });
  return { accountId: row.account_id, platformAccountId: row.platform ?? undefined, livemode: false, apiVersion: config.latestApiVersion, keyType: 'publishable', requestId: `req_${newId('', 14).slice(1)}`, baseUrl };
}

async function publishableKeyFor(accountId: string) {
  return (await one<{ token: string }>("SELECT token FROM api_keys WHERE account_id = $1 AND type = 'publishable' AND expires IS NULL ORDER BY created LIMIT 1", [accountId]))?.token;
}

/** Card element credentials for a hosted page: connected accounts use their platform's key plus Stripe-Account. */
async function clientKeys(accountId: string) {
  const platform = (await one<{ platform: string | null }>('SELECT platform FROM accounts WHERE id = $1', [accountId]))?.platform;
  return platform ? { publishable_key: await publishableKeyFor(platform), stripe_account: accountId } : { publishable_key: await publishableKeyFor(accountId), stripe_account: null };
}

/** Dashboard session endpoints and the public hosted-page endpoints. */
export function registerWeb(app: FastifyInstance) {
  const base = (req: any) => `${req.protocol}://${req.headers.host}`;
  const setCookie = (reply: FastifyReply, s: { id: string }) =>
    reply.header('Set-Cookie', `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}`);

  app.post('/dashboard-api/signup', async (req, reply) => {
    try {
      const b = req.body as any;
      const r = await accounts.createAccount(String(b?.email ?? ''), String(b?.password ?? ''), String(b?.business_name || 'My business'));
      const s = await accounts.login(String(b.email), String(b.password));
      await team.audit(r.account.id, { id: r.userId, email: String(b.email).toLowerCase() }, 'account.created', String(b.email).toLowerCase(), null, req.ip);
      setCookie(reply, s);
      return { ok: true, account: r.account.id, csrf: s.csrf };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/dashboard-api/login', async (req, reply) => {
    try {
      const b = req.body as any;
      const r = await transaction(() => team.signIn(String(b?.email ?? ''), String(b?.password ?? ''), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') }));
      if (r.failed) throw r.failed;
      if (r.mfa_required) return { ok: false, mfa_required: true, mfa_token: r.mfa_token };
      setCookie(reply, r.session);
      return { ok: true, csrf: r.session.csrf };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/dashboard-api/login/2fa', async (req, reply) => {
    try {
      const b = req.body as any;
      const r = await transaction(() => team.verifySignIn(String(b?.mfa_token ?? ''), String(b?.code ?? ''), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') }));
      if (r.failed) throw r.failed;
      setCookie(reply, r.session);
      return { ok: true, csrf: r.session.csrf, backup_codes_left: r.backup_codes_left };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/dashboard-api/logout', async (_req, reply) => {
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  const requireUser = async (req: any) => {
    const sid = /(?:^|;\s*)tsr_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const u = await accounts.sessionUser(sid);
    if (!u) throw new ApiError(401, 'authentication_error', 'Not signed in.');
    if (req.method !== 'GET' && req.headers['x-tessera-csrf'] !== u.csrf) throw new ApiError(403, 'permission_error', 'Invalid CSRF token.');
    return u;
  };

  app.get('/dashboard-api/session', async (req, reply) => {
    try {
      const u = await requireUser(req);
      const account = await accounts.getAccount(u.account_id);
      const role = team.isRole(u.role) ? u.role : 'view_only';
      const r = team.ROLES[role];
      return {
        user: { id: u.user_id, email: u.email, name: u.name, role, role_label: r.label, two_step: !!u.two_step },
        permissions: { team: r.team, keys: r.keys, sandbox: r.sandbox, write: r.write },
        account: stripInternal(account), csrf: u.csrf, api_version: account._api_version,
      };
    } catch (e) { return sendErr(reply, e); }
  });

  app.get('/dashboard-api/keys', async (req, reply) => {
    try {
      const u = await requireUser(req);
      team.requireRole(u, 'keys', 'view API keys');
      return { data: await accounts.listKeys(u.account_id) };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/dashboard-api/keys', async (req, reply) => {
    try {
      const u = await requireUser(req);
      const b = req.body as any;
      team.requireRole(u, 'keys', 'create API keys');
      const perms = b?.permissions && typeof b.permissions === 'object' ? b.permissions : {};
      const k = await accounts.createKey(u.account_id, 'restricted', String(b?.name || 'Restricted key'), perms);
      await team.audit(u.account_id, { id: u.user_id, email: u.email }, 'api_key.created', k.name, { type: 'restricted', id: k.id }, req.ip);
      return k;
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/dashboard-api/keys/:id/roll', async (req, reply) => {
    try {
      const u = await requireUser(req);
      const b = req.body as any;
      team.requireRole(u, 'keys', 'roll API keys');
      const k = await accounts.rollKey(u.account_id, (req.params as any).id, Number(b?.expires_in ?? 0));
      await team.audit(u.account_id, { id: u.user_id, email: u.email }, 'api_key.rolled', k.name, { old: (req.params as any).id, new: k.id, expires_in: Number(b?.expires_in ?? 0) }, req.ip);
      return k;
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Hosted payment page ----------
  app.get('/hosted-api/checkout/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const s = await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'checkout.session'", [id]);
      if (!s) throw new ApiError(404, 'invalid_request_error', 'No such session', { code: 'resource_missing' });
      let pi = s.data.payment_intent ? (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [s.data.payment_intent]))?.data : null;
      if (s.data.subscription) {
        const sub = (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [s.data.subscription]))?.data;
        const inv = sub?.latest_invoice ? (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [sub.latest_invoice]))?.data : null;
        pi = inv?.payment_intent ? (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [inv.payment_intent]))?.data : null;
        if (sub && ['active', 'trialing'].includes(sub.status) && s.data.status === 'open') await transaction(() => checkout.completeIfPaid(ctx, s.data, { status: 'succeeded' }));
      } else if (s.data.setup_intent) {
        pi = (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [s.data.setup_intent]))?.data;
        if (pi?.status === 'succeeded' && s.data.status === 'open') await transaction(() => checkout.completeSetup(ctx, s.data));
      } else if (pi && pi.status === 'succeeded' && s.data.status === 'open') await transaction(() => checkout.completeIfPaid(ctx, s.data, pi));
      const { hostedMethodFlags } = await import('./methods.ts');
      return {
        ...checkout.publicView(s.data), ...(await clientKeys(ctx.accountId)), payment_intent_status: pi?.status ?? null, last_error: pi?.last_payment_error?.message ?? pi?.last_setup_error?.message ?? null,
        methods: await hostedMethodFlags(ctx), next_action: pi?.next_action?.type === 'verify_with_microdeposits' ? pi.next_action : null,
      };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/hosted-api/checkout/:id/pay', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const b = req.body as any;
      if (!b?.payment_method && !b?.oneclick?.token) throw new ApiError(400, 'invalid_request_error', 'Missing payment_method', { param: 'payment_method' });
      const oneclick = await import('../domain/oneclick.ts');
      const r = await transaction(async () => {
        let pmId = String(b.payment_method ?? '');
        let email = b.email, name = b.name;
        if (b.oneclick?.token) {
          // One-click: a new card PaymentMethod from the customer's saved details.
          const oc = await oneclick.paymentMethod(ctx, String(b.oneclick.token), b.oneclick.card ? String(b.oneclick.card) : undefined);
          pmId = oc.pm.id; email = oc.email; name = name || oc.name;
        }
        return checkout.paySession(ctx, id, { payment_method: pmId, email, name, custom_fields: b.custom_fields && typeof b.custom_fields === 'object' ? b.custom_fields : undefined, consent: b.consent && typeof b.consent === 'object' ? b.consent : undefined, client: { ip: req.ip, user_agent: String(req.headers['user-agent'] ?? '') } });
      });
      if (r instanceof CommitThenFail) throw r.error;
      let saved = null;
      if ((b.save_oneclick === true || b.save_oneclick === 'true') && ['succeeded', 'processing'].includes(r.payment_intent.status) && (r.payment_intent.payment_method ?? b.payment_method)) {
        saved = await transaction(() => oneclick.saveCard(ctx, String(r.payment_intent.payment_method ?? b.payment_method), b.email, b.name));
      }
      return { status: r.payment_intent.status, next_action: r.payment_intent.next_action ?? null, success_url: r.session.success_url, oneclick_saved: !!saved };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/hosted-api/checkout/:id/tax_id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const s = await transaction(() => checkout.setSessionTaxId(ctx, id, (req.body as any) ?? {}));
      return checkout.publicView(s);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Hosted invoice page ----------
  app.get('/hosted-api/invoices/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE id = $1 AND type = 'invoice'", [id]);
      if (!row || row.data.status === 'draft' || row.data.deleted) throw new ApiError(404, 'invalid_request_error', 'Invoice not found', { code: 'resource_missing' });
      const inv = row.data;
      let error = null;
      if (inv.payment_intent) error = (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [inv.payment_intent]))?.data?.last_payment_error?.message ?? null;
      return {
        id: inv.id, number: inv.number, status: inv.status, merchant: inv.account_name, customer_email: inv.customer_email, currency: inv.currency,
        amount_due: inv.amount_due, amount_paid: inv.amount_paid, amount_remaining: inv.amount_remaining ?? inv.amount_due,
        amounts_due: inv.amounts_due ? inv.amounts_due.map((a: any) => ({ amount: a.amount, due_date: a.due_date, description: a.description, status: a.status, paid_at: a.paid_at })) : null,
        reverse_charge: (inv.total_tax_amounts ?? []).some((t: any) => t.taxability_reason === 'reverse_charge'), customer_tax_ids: inv.customer_tax_ids ?? [], subtotal: inv.subtotal, total: inv.total, discount: inv.total_discount_amounts?.[0]?.amount ?? 0, invoice_pdf: inv.invoice_pdf ?? null,
        tax_lines: await Promise.all((inv.total_tax_amounts ?? []).map(async (t: any) => {
          const r = (await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2", [row.account_id, t.tax_rate]))?.data;
          return { label: t.taxability_reason === 'reverse_charge' ? `${r?.display_name ?? 'VAT'} - reverse charge` : `${r?.display_name ?? 'Tax'}${r?.jurisdiction ? ` - ${r.jurisdiction}` : ''} (${r?.percentage ?? 0}%${t.inclusive ? ', included' : ''})`, amount: t.amount };
        })),
        due_date: inv.due_date, created: inv.created, description: inv.description,
        lines: inv.lines.data.map((l: any) => ({ id: l.id, description: l.description, amount: l.amount, quantity: l.quantity, period: l.period })),
        ...(await clientKeys(row.account_id)), last_error: inv.status === 'open' ? error : null,
        // The customer's preferred language (customer.preferred_locales[0]) picks the page language.
        locale: (inv.customer ? (await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2", [row.account_id, inv.customer]))?.data?.preferred_locales?.[0] : null) ?? 'auto',
      };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/hosted-api/invoices/:id/pay', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const b = req.body as any;
      if (!b?.payment_method) throw new ApiError(400, 'invalid_request_error', 'Missing payment_method', { param: 'payment_method' });
      const { payInvoice } = await import('../domain/billing/invoices.ts');
      const { attachPaymentMethod } = await import('../domain/paymentMethods.ts');
      const r = await transaction(async () => {
        const inv = await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'invoice'", [id]);
        await attachPaymentMethod(ctx, String(b.payment_method), { customer: inv!.data.customer }).catch(() => undefined);
        if (b.installment && inv!.data.amounts_due?.length) {
          const { payInstallment } = await import('../domain/billing/installments.ts');
          const pi = await payInstallment(ctx, inv!.data, { payment_method: String(b.payment_method), return_url: `${base(req)}/invoices/pay/${id}` });
          if (pi instanceof CommitThenFail) return pi;
          return { ...(await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [id]))!.data, _pi: pi };
        }
        return payInvoice(ctx, inv!.data, { payment_method: String(b.payment_method), throwOnFailure: true, return_url: `${base(req)}/invoices/pay/${id}` });
      });
      if (r instanceof CommitThenFail) throw r.error;
      if ((r as any)._pi) return { status: (r as any).status, installment_status: (r as any)._pi.status, next_action: (r as any)._pi.status === 'requires_action' ? (r as any)._pi.next_action : null };
      const pi = r.payment_intent ? (await one<{ data: any }>('SELECT data FROM objects WHERE id = $1', [r.payment_intent]))?.data : null;
      return { status: r.status, next_action: pi?.status === 'requires_action' ? pi.next_action : null };
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Invoice PDF (public link, like the hosted invoice page) ----------
  app.get('/invoices/pdf/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE id = $1 AND type = 'invoice'", [id]);
      if (!row || row.data.status === 'draft') throw new ApiError(404, 'invalid_request_error', 'Invoice not found', { code: 'resource_missing' });
      const { invoicePdf } = await import('../domain/billing/documents.ts');
      const pdf = await invoicePdf(row.account_id, row.data);
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${row.data.number ?? id}.pdf"`).send(pdf);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Checkout: shipping address and option ----------
  app.post('/hosted-api/checkout/:id/shipping', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const s = await transaction(() => checkout.setSessionShipping(ctx, id, (req.body as any) ?? {}));
      return checkout.publicView(s);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Credit note PDF (public link, like invoice PDFs) ----------
  app.get('/credit_notes/pdf/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE id = $1 AND type = 'credit_note'", [id]);
      if (!row) throw new ApiError(404, 'invalid_request_error', 'Credit note not found', { code: 'resource_missing' });
      const { creditNotePdf } = await import('../domain/billing/documents.ts');
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${row.data.number}.pdf"`).send(await creditNotePdf(row.account_id, row.data));
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Identity verification (hosted page) ----------
  app.get('/hosted-api/identity/:token', async (req, reply) => {
    try {
      const identity = await import('../domain/identity.ts');
      const row = await identity.findByToken((req.params as any).token);
      return identity.hostedView(row.account_id, row.data);
    } catch (e) { return sendErr(reply, e); }
  });
  app.get('/hosted-api/identity-secret/:secret', async (req, reply) => {
    try {
      const secret = String((req.params as any).secret);
      const row = await one<{ data: any }>("SELECT data FROM objects WHERE type = 'identity.verification_session' AND data->>'client_secret' = $1", [secret]);
      if (!row) throw new ApiError(404, 'invalid_request_error', 'No such verification session.', { code: 'resource_missing' });
      return { url: row.data.url, status: row.data.status };
    } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/identity/:token/submit', async (req, reply) => {
    try {
      const identity = await import('../domain/identity.ts');
      const token = (req.params as any).token;
      const row = await identity.findByToken(token);
      const s = await transaction(() => identity.submitVerification(row.account_id, token, req.body));
      return identity.hostedView(row.account_id, s);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Checkout: promotion codes and adjustable quantities ----------
  app.post('/hosted-api/checkout/:id/promotion_code', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const s = await transaction(() => checkout.applySessionCode(ctx, id, String((req.body as any)?.code ?? '')));
      return checkout.publicView(s);
    } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/checkout/:id/quantity', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const b = req.body as any;
      const s = await transaction(() => checkout.setSessionQuantity(ctx, id, String(b?.line_item ?? ''), Number(b?.quantity)));
      return checkout.publicView(s);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Payment links: each visit opens a new Checkout Session ----------
  app.get('/b/:code', async (req, reply) => {
    const code = (req.params as any).code;
    try {
      const { findLinkByCode, sessionForLink } = await import('../domain/paymentLinks.ts');
      const row = await findLinkByCode(code);
      const ctx = await ctxForObject(row.data.id, base(req));
      const s = await transaction(() => sessionForLink(ctx, row.data));
      return reply.redirect(`/pay/${s.id}`, 303);
    } catch {
      return reply.redirect(`/link-unavailable/${encodeURIComponent(code)}`, 303);
    }
  });
  app.get('/hosted-api/links/:code', async (req, reply) => {
    try {
      const { findLinkByCode } = await import('../domain/paymentLinks.ts');
      const row = await findLinkByCode((req.params as any).code);
      const acct = await one<{ data: any }>("SELECT data FROM accounts WHERE id = $1", [row.account_id]).catch(() => null);
      const r = row.data.restrictions?.completed_sessions;
      return { active: row.data.active && !(r && r.count >= r.limit), merchant_name: acct?.data?.business_profile?.name ?? acct?.data?.settings?.dashboard?.display_name ?? null };
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Checkout: billing address for automatic tax ----------
  app.post('/hosted-api/checkout/:id/address', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const s = await transaction(() => checkout.setSessionAddress(ctx, id, (req.body as any)?.address));
      return checkout.publicView(s);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Customer portal ----------
  app.get('/hosted-api/portal/:token', async (req, reply) => {
    try {
      const { findPortalSession, portalView } = await import('../domain/billing/portal.ts');
      const row = await findPortalSession((req.params as any).token);
      const ctx = await ctxForObject(row.data.id, base(req));
      return { ...(await portalView(ctx, row.data)), ...(await clientKeys(row.account_id)) };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/hosted-api/portal/:token/:action', async (req, reply) => {
    try {
      const { findPortalSession, portalAction } = await import('../domain/billing/portal.ts');
      const { token, action } = req.params as any;
      const row = await findPortalSession(token);
      const ctx = await ctxForObject(row.data.id, base(req));
      const b = (req.body ?? {}) as any;
      // Previews do a dry run in their own transaction and roll it back.
      const r = action === 'preview' ? await portalAction(ctx, row.data, action, b) : await transaction(() => portalAction(ctx, row.data, action, b));
      return stripInternal(r);
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Simulated 3-D Secure challenge ----------
  app.get('/hosted-api/authenticate/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const row = await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type IN ('payment_intent', 'setup_intent')", [id]);
      if (!row || row.data.client_secret !== (req.query as any).client_secret) throw new ApiError(404, 'invalid_request_error', 'Not found');
      const acct = await accounts.getAccount((await one<any>('SELECT account_id FROM objects WHERE id = $1', [id])).account_id);
      const kind = row.data.object === 'setup_intent' ? 'setup' : 'payment';
      return { id, kind, amount: row.data.amount ?? 0, currency: row.data.currency ?? 'usd', status: row.data.status, merchant: acct?.business_profile?.name ?? acct?.settings?.dashboard?.display_name, return_url: row.data._return_url };
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/hosted-api/authenticate/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const b = req.body as any;
      if (id.startsWith('seti_')) {
        const { completeSetupAuthentication, returnUrlFor } = await import('../domain/setupIntents.ts');
        const si = await transaction(() => completeSetupAuthentication(ctx, id, String(b?.client_secret ?? ''), b?.result === 'success'));
        return { status: si.status, return_url: returnUrlFor(si), last_payment_error: si.last_setup_error?.message ?? null };
      }
      const pi = await transaction(() => completeAuthentication(ctx, id, String(b?.client_secret ?? ''), b?.result === 'success'));
      return { status: pi.status, return_url: pi._return_url ?? null, last_payment_error: pi.last_payment_error?.message ?? null };
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Connect: hosted onboarding (account links) ----------
  const onboardingView = (a: any, platform: any, link: any) => {
    const pub = stripInternal(a);
    return {
      platform: { name: platform?.business_profile?.name ?? platform?.settings?.dashboard?.display_name ?? 'Platform' },
      type: link._type,
      account: {
        id: pub.id, type: pub.type, country: pub.country, email: pub.email, business_type: pub.business_type, business_profile: pub.business_profile,
        individual: pub.individual ?? null, company: pub.company ?? null,
        representative: stripInternal((a._persons ?? []).find((x: any) => x.relationship.representative) ?? null), tos_accepted: !!pub.tos_acceptance?.date,
        external_accounts: pub.external_accounts.data.map((b: any) => ({ id: b.id, bank_name: b.bank_name, last4: b.last4, currency: b.currency, routing_number: b.routing_number })),
        requirements: pub.requirements, details_submitted: pub.details_submitted, charges_enabled: pub.charges_enabled, payouts_enabled: pub.payouts_enabled,
      },
    };
  };

  app.get('/hosted-api/connect/onboarding/:token', async (req, reply) => {
    try {
      const row = await connect.findLink((req.params as any).token);
      if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
      const link = row.data;
      if (link._used || link.expires_at < nowSeconds()) return { expired: true, refresh_url: link._refresh_url };
      return onboardingView(await connect.loadAccount(link._account), await connect.loadAccount(row.account_id), link);
    } catch (e) { return sendErr(reply, e); }
  });

  app.post('/hosted-api/connect/onboarding/:token', async (req, reply) => {
    try {
      const row = await connect.findLink((req.params as any).token);
      if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
      const link = row.data;
      if (link._used || link.expires_at < nowSeconds()) return reply.code(410).send({ expired: true, refresh_url: link._refresh_url });
      const b = (req.body ?? {}) as any;
      const p: any = {};
      for (const k of ['business_type', 'business_profile', 'individual', 'company', 'email']) if (b[k] !== undefined && b[k] !== null) p[k] = b[k];
      if (b.external_account) p.external_account = b.external_account;
      if (b.representative && typeof b.representative === 'object') p._representative = b.representative;
      if (b.accept_tos) p.tos_acceptance = { date: nowSeconds(), ip: req.ip, user_agent: String(req.headers['user-agent'] ?? '').slice(0, 200) };
      const ctx: Ctx = { ...connect.accountCtx(row.account_id, base(req)) };
      const acct = await transaction(async () => {
        const a = await connect.updateConnectedAccount(ctx, link._account, p, { hosted: true });
        link._used = true;
        await query('UPDATE objects SET data = $1 WHERE id = $2', [JSON.stringify(link), link.id]);
        return a;
      });
      return { return_url: link._return_url, ...onboardingView(acct, await connect.loadAccount(row.account_id), link) };
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Connect: Express dashboard (login links) ----------
  app.get('/hosted-api/connect/express/:token', async (req, reply) => {
    try {
      const row = await connect.findLoginLink((req.params as any).token);
      if (!row) throw new ApiError(404, 'invalid_request_error', 'This login link has expired. Ask the platform for a new one.', { code: 'resource_missing' });
      const acctId = row.data._account;
      const a = stripInternal(await connect.loadAccount(acctId));
      const platform = await connect.loadAccount(row.account_id);
      const list = async (type: string) => (await query<{ data: any }>('SELECT data FROM objects WHERE account_id = $1 AND type = $2 ORDER BY seq DESC LIMIT 25', [acctId, type])).map((r) => stripInternal(r.data));
      const charges = (await list('charge')).filter((c: any) => c.status === 'succeeded');
      return {
        platform: { name: platform?.business_profile?.name ?? 'Platform' },
        account: { id: a.id, display_name: a.settings?.dashboard?.display_name, email: a.email, country: a.country, payouts_enabled: a.payouts_enabled, schedule: a.settings?.payouts?.schedule, external_accounts: a.external_accounts.data.map((b: any) => ({ id: b.id, bank_name: b.bank_name, last4: b.last4, currency: b.currency, default_for_currency: b.default_for_currency })) },
        balance: await getBalance(acctId),
        payouts: (await list('payout')).map((p: any) => ({ id: p.id, amount: p.amount, currency: p.currency, status: p.status, arrival_date: p.arrival_date, automatic: p.automatic, failure_message: p.failure_message })),
        payments: charges.map((c: any) => ({ id: c.id, amount: c.amount, amount_refunded: c.amount_refunded, currency: c.currency, created: c.created, description: c.description, kind: c.source_transfer ? 'transfer' : 'card' })),
      };
    } catch (e) { return sendErr(reply, e); }
  });

  app.get('/hosted-api/receipts/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE id = $1 AND type = 'charge'", [id]);
      if (!row) throw new ApiError(404, 'invalid_request_error', 'Not found');
      const acct = await accounts.getAccount(row.account_id);
      const c = row.data;
      return { id: c.id, amount: c.amount, amount_refunded: c.amount_refunded, currency: c.currency, created: c.created, description: c.description, brand: (c.payment_method_details.card ?? c.payment_method_details.card_present)?.brand ?? 'transfer', last4: (c.payment_method_details.card ?? c.payment_method_details.card_present)?.last4 ?? '', merchant: acct?.business_profile?.name ?? acct?.settings?.dashboard?.display_name, status: c.status };
    } catch (e) { return sendErr(reply, e); }
  });
}
