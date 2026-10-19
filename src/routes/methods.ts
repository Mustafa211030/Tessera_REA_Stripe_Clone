import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { one, query, transaction } from '../db/index.ts';
import * as bank from '../domain/bankDebits.ts';
import * as checkout from '../domain/checkout.ts';
import * as fc from '../domain/financialConnections.ts';
import * as oneclick from '../domain/oneclick.ts';
import * as pmc from '../domain/paymentMethodConfigs.ts';
import { createPaymentMethod } from '../domain/paymentMethods.ts';
import * as quartet from '../domain/quartet.ts';
import { getObject } from '../domain/store.ts';
import { ApiError, CommitThenFail } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { Ctx } from '../platform/context.ts';
import { apiRoute } from '../platform/http.ts';
import { clientView } from './v1.ts';

const base = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;
function sendErr(reply: FastifyReply, e: unknown) {
  const err = e instanceof CommitThenFail ? e.error : e instanceof ApiError ? e : new ApiError(500, 'api_error', 'Something went wrong.');
  if (!(e instanceof ApiError) && !(e instanceof CommitThenFail)) console.error(e);
  return reply.code(err.status).send(err.toJSON());
}

/** Context for the account that owns a hosted object (Checkout Session, PaymentIntent). */
export async function ctxForObject(id: string, baseUrl: string): Promise<Ctx> {
  const row = await one<{ account_id: string; platform: string | null }>('SELECT o.account_id, a.platform FROM objects o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.id = $1', [id]);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'Not found', { code: 'resource_missing' });
  return { accountId: row.account_id, platformAccountId: row.platform ?? undefined, livemode: false, apiVersion: config.latestApiVersion, keyType: 'publishable', requestId: `req_${newId('', 14).slice(1)}`, baseUrl };
}

async function openSession(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'checkout.session', id, 'checkout.session');
  if (s.status !== 'open') throw new ApiError(400, 'invalid_request_error', `This Checkout Session is ${s.status}.`, { code: 'checkout_session_closed' });
  return s;
}

/** Which card-based options the hosted page shows (from Settings → Payment methods). */
export async function hostedMethodFlags(ctx: Ctx) {
  const cfg = await pmc.getConfig(ctx);
  const on = (m: pmc.Method) => cfg[m]?.display_preference?.value === 'on';
  return { card: on('card'), device_wallet: on('device_wallet'), oneclick: on('oneclick') };
}

/**
 * Payment method settings, device wallets, one-click checkout, ACH Direct Debit
 * (microdeposits and mandates) and Pay in 4 (Quartet).
 */
export function registerMethods(app: FastifyInstance) {
  // ---------- Payment method configurations ----------
  apiRoute(app, 'GET', '/v1/payment_method_configurations', { resource: 'payment_methods' }, (ctx) => pmc.listConfigs(ctx));
  apiRoute(app, 'GET', '/v1/payment_method_configurations/:id', { resource: 'payment_methods' }, (ctx, p) => pmc.retrieveConfig(ctx, p.id));
  apiRoute(app, 'POST', '/v1/payment_method_configurations/:id', { resource: 'payment_methods' }, (ctx, p) => {
    const { id, ...rest } = p;
    return pmc.updateConfig(ctx, id, rest);
  });

  // ---------- Mandates and microdeposits ----------
  apiRoute(app, 'GET', '/v1/mandates/:id', { resource: 'payment_methods' }, (ctx, p) => bank.getMandate(ctx, p.id));
  const hasClientSecret = async (req: FastifyRequest, p: any) => {
    const id = (req.params as any).id;
    if (!p.client_secret || !String(p.client_secret).startsWith(`${id}_secret_`)) return false;
    const row = await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'payment_intent'", [id]);
    return row?.data.client_secret === p.client_secret;
  };
  apiRoute(app, 'POST', '/v1/payment_intents/:id/verify_microdeposits', { resource: 'payment_intents', publishable: hasClientSecret }, async (ctx, p) => {
    const { client_secret: _cs, id, ...rest } = p;
    const r = await bank.verifyMicrodeposits(ctx, id, rest);
    return ctx.keyType === 'publishable' && !(r instanceof CommitThenFail) ? clientView(r) : r;
  });

  app.get('/hosted-api/microdeposits/:id', async (req, reply) => {
    try { return await bank.hostedView((req.params as any).id, String((req.query as any).client_secret ?? '')); } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/microdeposits/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const b = (req.body ?? {}) as any;
      const view = await bank.hostedView(id, String(b.client_secret ?? ''));
      const ctx = await ctxForObject(id, base(req));
      const params: any = b.descriptor_code ? { descriptor_code: String(b.descriptor_code) } : { amounts: (Array.isArray(b.amounts) ? b.amounts : []).map(Number) };
      const r = await transaction(() => bank.verifyMicrodeposits(ctx, id, params));
      if (r instanceof CommitThenFail) throw r.error;
      return { status: r.status, return_url: view.return_url };
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Pay in 4 (Quartet) approval page ----------
  app.get('/hosted-api/quartet/:id', async (req, reply) => {
    try { return await quartet.hostedView((req.params as any).id, String((req.query as any).client_secret ?? '')); } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/quartet/:id', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      return await transaction(() => quartet.decide((req.params as any).id, String(b.client_secret ?? ''), b.result === 'approve', base(req)));
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Checkout: currency, bank accounts, Pay in 4 ----------
  app.post('/hosted-api/checkout/:id/currency', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const s = await transaction(() => checkout.setSessionCurrency(ctx, id, String((req.body as any)?.currency ?? '')));
      return checkout.publicView(s);
    } catch (e) { return sendErr(reply, e); }
  });

  /** Starts Financial Connections for a bank debit: the account holder is the (found or new) customer. */
  app.post('/hosted-api/checkout/:id/bank_session', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const b = (req.body ?? {}) as any;
      return await transaction(async () => {
        const s = await openSession(ctx, id);
        if (!s.payment_method_types?.includes('us_bank_account')) throw new ApiError(400, 'invalid_request_error', 'This Checkout Session does not accept bank debits.', { code: 'payment_method_unavailable' });
        const email = String(b.email ?? '').trim();
        if (!s.customer && !email) throw new ApiError(400, 'invalid_request_error', 'Enter your email first.', { param: 'email', code: 'email_invalid' });
        if (!s.customer) {
          const row = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'customer' AND lower(data->>'email') = $2 ORDER BY seq DESC LIMIT 1", [ctx.accountId, email.toLowerCase()]);
          const c = row[0] && !row[0].data.deleted ? row[0].data : await (await import('../domain/customers.ts')).createCustomer(ctx, { email, name: b.name || undefined });
          s.customer = c.id;
          await (await import('../domain/store.ts')).saveObject(ctx.accountId, s);
        }
        const fcs = await fc.createSession(ctx, { account_holder: { type: 'customer', customer: s.customer }, permissions: ['payment_method'], filters: { account_subcategories: ['checking', 'savings'] } });
        return { client_secret: fcs.client_secret };
      });
    } catch (e) { return sendErr(reply, e); }
  });

  /** Creates a us_bank_account or quartet PaymentMethod for the session's account. */
  app.post('/hosted-api/checkout/:id/payment_method', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const ctx = await ctxForObject(id, base(req));
      const b = (req.body ?? {}) as any;
      return await transaction(async () => {
        const s = await openSession(ctx, id);
        const type = String(b.type ?? '');
        if (!['us_bank_account', 'quartet'].includes(type) || !s.payment_method_types?.includes(type)) throw new ApiError(400, 'invalid_request_error', `This Checkout Session does not accept ${type || 'that payment method'}.`, { code: 'payment_method_unavailable' });
        const billing_details = { name: b.name || undefined, email: b.email || undefined };
        const pm: any = type === 'quartet'
          ? await createPaymentMethod(ctx, { type, billing_details })
          : await createPaymentMethod(ctx, { type, billing_details, us_bank_account: b.financial_connections_account ? { financial_connections_account: String(b.financial_connections_account) } : { routing_number: b.routing_number, account_number: b.account_number, account_holder_type: b.account_holder_type === 'company' ? 'company' : 'individual', account_type: b.account_type === 'savings' ? 'savings' : 'checking' } });
        return { id: pm.id, type: pm.type, bank: pm.us_bank_account ? { bank_name: pm.us_bank_account.bank_name, last4: pm.us_bank_account.last4, instant: !!pm.us_bank_account.financial_connections_account } : null };
      });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- One-click checkout ----------
  app.post('/hosted-api/oneclick/lookup', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const ctx = await ctxForObject(String(b.checkout_session ?? ''), base(req));
      const flags = await hostedMethodFlags(ctx);
      if (!flags.oneclick) return { exists: false };
      return await transaction(() => oneclick.lookup(ctx, String(b.email ?? '')));
    } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/oneclick/verify', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const r = await transaction(() => oneclick.verify(String(b.challenge ?? ''), String(b.code ?? '')));
      if ('failed' in r) { const left = (r as any).left as number; throw new ApiError(400, 'invalid_request_error', left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many incorrect codes. Request a new one.', { code: left > 0 ? 'verification_code_incorrect' : 'verification_attempts_exceeded' }); }
      return r;
    } catch (e) { return sendErr(reply, e); }
  });
  // One-click from the Express Checkout element: authorized by the PaymentIntent's client secret.
  const piFromSecret = async (req: FastifyRequest) => {
    const secret = String((req.body as any)?.client_secret ?? '');
    const id = secret.split('_secret_')[0]!;
    if (!/^pi_/.test(id)) throw new ApiError(400, 'invalid_request_error', 'A PaymentIntent client_secret is required.', { param: 'client_secret' });
    const ctx = await ctxForObject(id, base(req));
    const pi = await getObject<any>(ctx.accountId, 'payment_intent', id, 'payment_intent');
    if (pi.client_secret !== secret) throw new ApiError(400, 'invalid_request_error', 'The client_secret does not match this PaymentIntent.', { param: 'client_secret' });
    if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) throw new ApiError(400, 'invalid_request_error', `This PaymentIntent is ${pi.status}.`, { code: 'payment_intent_unexpected_state' });
    return { ctx, pi };
  };
  app.post('/hosted-api/elements/oneclick/lookup', async (req, reply) => {
    try {
      const { ctx, pi } = await piFromSecret(req);
      if (!(await hostedMethodFlags(ctx)).oneclick || !(pi.payment_method_types ?? []).includes('card')) return { exists: false };
      return await transaction(() => oneclick.lookup(ctx, String((req.body as any)?.email ?? '')));
    } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/elements/oneclick/payment_method', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const { ctx } = await piFromSecret(req);
      const r = await transaction(() => oneclick.paymentMethod(ctx, String(b.token ?? ''), b.card ? String(b.card) : undefined));
      const pm = r.pm as any;
      return { id: pm.id, object: 'payment_method', type: pm.type, billing_details: pm.billing_details, card: { brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year, wallet: pm.card.wallet ?? null } };
    } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/oneclick/logout', async (req, reply) => {
    try { return await oneclick.logout(String((req.body as any)?.token ?? '')); } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/oneclick/remove_card', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      return await transaction(() => oneclick.removeCard(String(b.token ?? ''), String(b.card ?? '')));
    } catch (e) { return sendErr(reply, e); }
  });
}
