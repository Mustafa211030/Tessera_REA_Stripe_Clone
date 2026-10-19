import type { FastifyInstance, FastifyReply } from 'fastify';
import { transaction } from '../db/index.ts';
import * as capital from '../domain/capital.ts';
import * as climate from '../domain/climate.ts';
import * as fc from '../domain/financialConnections.ts';
import * as revrec from '../domain/revrec.ts';
import { getObject, listObjects } from '../domain/store.ts';
import { stripInternal } from '../domain/paymentIntents.ts';
import { ApiError } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';

function sendErr(reply: FastifyReply, e: unknown) {
  const err = e instanceof ApiError ? e : new ApiError(500, 'api_error', 'Something went wrong.');
  if (!(e instanceof ApiError)) console.error(e);
  return reply.code(err.status).send(err.toJSON());
}

/** Climate orders, Financial Connections, Capital financing and revenue recognition. */
export function registerServices(app: FastifyInstance) {
  // ---------- Climate ----------
  apiRoute(app, 'GET', '/v1/climate/products', { resource: 'climate_orders' }, () => climate.listProducts());
  apiRoute(app, 'GET', '/v1/climate/products/:id', { resource: 'climate_orders' }, (_ctx, p) => climate.getProduct(p.id));
  apiRoute(app, 'GET', '/v1/climate/suppliers', { resource: 'climate_orders' }, async () => climate.listSuppliers());
  apiRoute(app, 'GET', '/v1/climate/suppliers/:id', { resource: 'climate_orders' }, async (_ctx, p) => climate.getSupplier(p.id));
  apiRoute(app, 'POST', '/v1/climate/orders', { resource: 'climate_orders', critical: true }, (ctx, p) => climate.createOrder(ctx, p));
  apiRoute(app, 'GET', '/v1/climate/orders', { resource: 'climate_orders' }, (ctx, p) => listObjects(ctx.accountId, 'climate.order', '/v1/climate/orders', p));
  apiRoute(app, 'GET', '/v1/climate/orders/:id', { resource: 'climate_orders' }, (ctx, p) => getObject(ctx.accountId, 'climate.order', p.id, 'climate order'));
  apiRoute(app, 'POST', '/v1/climate/orders/:id', { resource: 'climate_orders' }, (ctx, p) => climate.updateOrder(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/climate/orders/:id/cancel', { resource: 'climate_orders' }, (ctx, p) => climate.cancelOrder(ctx, p.id));
  apiRoute(app, 'POST', '/v1/test_helpers/climate/orders/:id/deliver', { resource: 'climate_orders' }, (ctx, p) => climate.deliverOrder(ctx, p.id));
  apiRoute(app, 'POST', '/v1/test_helpers/climate/orders/:id/delay', { resource: 'climate_orders' }, (ctx, p) => climate.delayOrder(ctx, p.id));
  app.get('/hosted-api/climate/certificates/:token', async (req, reply) => {
    const c = await climate.certificate((req.params as any).token);
    if (!c) return reply.code(404).send({ error: { type: 'invalid_request_error', message: 'This certificate does not exist yet.' } });
    return c;
  });

  // ---------- Financial Connections ----------
  apiRoute(app, 'POST', '/v1/financial_connections/sessions', { resource: 'financial_connections' }, (ctx, p) => fc.createSession(ctx, p));
  apiRoute(app, 'GET', '/v1/financial_connections/sessions/:id', { resource: 'financial_connections' }, (ctx, p) => fc.getSession(ctx, p.id));
  apiRoute(app, 'GET', '/v1/financial_connections/accounts', { resource: 'financial_connections' }, (ctx, p) => fc.listAccounts(ctx, p));
  apiRoute(app, 'GET', '/v1/financial_connections/accounts/:id', { resource: 'financial_connections' }, (ctx, p) => fc.getAccount(ctx, p.id));
  apiRoute(app, 'POST', '/v1/financial_connections/accounts/:id/refresh', { resource: 'financial_connections' }, (ctx, p) => fc.refreshAccount(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/financial_connections/accounts/:id/disconnect', { resource: 'financial_connections' }, (ctx, p) => fc.disconnectAccount(ctx, p.id));
  apiRoute(app, 'POST', '/v1/financial_connections/accounts/:id/subscribe', { resource: 'financial_connections' }, (ctx, p) => fc.setSubscription(ctx, p.id, p, true));
  apiRoute(app, 'POST', '/v1/financial_connections/accounts/:id/unsubscribe', { resource: 'financial_connections' }, (ctx, p) => fc.setSubscription(ctx, p.id, p, false));
  apiRoute(app, 'GET', '/v1/financial_connections/accounts/:id/owners', { resource: 'financial_connections' }, (ctx, p) => fc.listOwners(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/financial_connections/transactions', { resource: 'financial_connections' }, (ctx, p) => fc.listTransactions(ctx, p));
  apiRoute(app, 'GET', '/v1/financial_connections/transactions/:id', { resource: 'financial_connections' }, (ctx, p) => getObject(ctx.accountId, 'financial_connections.transaction', p.id, 'financial_connections.transaction'));

  // Hosted account-linking flow (reached with the session's client secret).
  app.get('/hosted-api/financial-connections/:secret', async (req, reply) => {
    try { return await fc.hostedView((req.params as any).secret); } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/financial-connections/:secret', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      return await transaction(() => fc.completeSession((req.params as any).secret, String(b.institution ?? ''), Array.isArray(b.accounts) ? b.accounts.map(String) : []));
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Capital ----------
  apiRoute(app, 'GET', '/v1/capital/financing_offers', { resource: 'capital' }, (ctx, p) => capital.listOffers(ctx, p));
  apiRoute(app, 'GET', '/v1/capital/financing_offers/:id', { resource: 'capital' }, (ctx, p) => capital.getOffer(ctx, p.id));
  apiRoute(app, 'POST', '/v1/capital/financing_offers/:id/mark_delivered', { resource: 'capital' }, (ctx, p) => capital.markDelivered(ctx, p.id));
  apiRoute(app, 'POST', '/v1/test_helpers/capital/financing_offers/create', { resource: 'capital' }, (ctx, p) => capital.createTestOffer(ctx, p));
  apiRoute(app, 'POST', '/v1/tessera/capital/financing_offers/:id/application_link', { resource: 'capital', raw: true }, (ctx, p) => capital.applicationLink(ctx, p.id));
  // Dashboard view: offers with repayment progress (internal counters are not part of the API object).
  apiRoute(app, 'GET', '/v1/tessera/capital/financing_offers', { resource: 'capital', raw: true }, async (ctx, p) => {
    const l = await capital.listOffers(ctx, { ...p, limit: p.limit ?? 100 });
    return { ...l, data: l.data.map((o: any) => ({ ...stripInternal(o), progress: capital.progress(o) })) };
  });
  apiRoute(app, 'GET', '/v1/capital/financing_summary', { resource: 'capital' }, (ctx) => capital.summary(ctx));
  apiRoute(app, 'GET', '/v1/capital/financing_transactions', { resource: 'capital' }, (ctx, p) => capital.listTransactions(ctx, p));
  apiRoute(app, 'GET', '/v1/capital/financing_transactions/:id', { resource: 'capital' }, (ctx, p) => capital.getTransaction(ctx, p.id));

  app.get('/hosted-api/capital/:token', async (req, reply) => {
    try { return await capital.hostedView((req.params as any).token); } catch (e) { return sendErr(reply, e); }
  });
  app.post('/hosted-api/capital/:token', async (req, reply) => {
    try {
      const accept = (req.body as any)?.decision === 'accept';
      return await transaction(() => capital.hostedDecide((req.params as any).token, accept));
    } catch (e) { return sendErr(reply, e); }
  });

  // ---------- Revenue recognition ----------
  apiRoute(app, 'GET', '/v1/tessera/revenue_recognition', { resource: 'reporting', raw: true }, (ctx, p) => revrec.summary(ctx, p));
}
