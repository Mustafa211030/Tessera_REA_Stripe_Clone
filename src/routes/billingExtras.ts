import type { FastifyInstance } from 'fastify';
import * as credits from '../domain/billing/credits.ts';
import * as retries from '../domain/billing/retries.ts';
import * as ent from '../domain/entitlements.ts';
import { apiRoute } from '../platform/http.ts';

/** Entitlements, billing credits, and failed-payment retry settings. */
export function registerBillingExtras(app: FastifyInstance) {
  // ---------- Entitlements ----------
  apiRoute(app, 'POST', '/v1/entitlements/features', { resource: 'products' }, (ctx, p) => ent.createFeature(ctx, p));
  apiRoute(app, 'GET', '/v1/entitlements/features', { resource: 'products' }, (ctx, p) => ent.listFeatures(ctx, p));
  apiRoute(app, 'GET', '/v1/entitlements/features/:id', { resource: 'products' }, async (ctx, p) => (await import('../domain/store.ts')).getObject(ctx.accountId, 'entitlements.feature', p.id, 'feature'));
  apiRoute(app, 'POST', '/v1/entitlements/features/:id', { resource: 'products' }, (ctx, p) => ent.updateFeature(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/products/:id/features', { resource: 'products' }, (ctx, p) => ent.attachFeature(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/products/:id/features', { resource: 'products' }, (ctx, p) => ent.listProductFeatures(ctx, p.id));
  apiRoute(app, 'DELETE', '/v1/products/:product/features/:id', { resource: 'products' }, (ctx, p) => ent.detachFeature(ctx, p.product, p.id));
  apiRoute(app, 'GET', '/v1/entitlements/active_entitlements', { resource: 'customers' }, (ctx, p) => ent.listActive(ctx, p));
  apiRoute(app, 'GET', '/v1/entitlements/active_entitlements/:id', { resource: 'customers' }, (ctx, p) => ent.getActive(ctx, p.id, p));

  // ---------- Billing credits ----------
  apiRoute(app, 'POST', '/v1/billing/credit_grants', { resource: 'customers' }, (ctx, p) => credits.createGrant(ctx, p));
  apiRoute(app, 'GET', '/v1/billing/credit_grants', { resource: 'customers' }, (ctx, p) => credits.listGrants(ctx, p));
  apiRoute(app, 'GET', '/v1/billing/credit_grants/:id', { resource: 'customers' }, (ctx, p) => credits.getGrant(ctx, p.id));
  apiRoute(app, 'POST', '/v1/billing/credit_grants/:id', { resource: 'customers' }, (ctx, p) => credits.updateGrant(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/billing/credit_grants/:id/void', { resource: 'customers' }, (ctx, p) => credits.endGrant(ctx, p.id, 'void'));
  apiRoute(app, 'POST', '/v1/billing/credit_grants/:id/expire', { resource: 'customers' }, (ctx, p) => credits.endGrant(ctx, p.id, 'expire'));
  apiRoute(app, 'GET', '/v1/billing/credit_balance_summary', { resource: 'customers' }, (ctx, p) => credits.balanceSummary(ctx, p));
  apiRoute(app, 'GET', '/v1/billing/credit_balance_transactions', { resource: 'customers' }, (ctx, p) => credits.listTransactions(ctx, p));
  apiRoute(app, 'GET', '/v1/billing/credit_balance_transactions/:id', { resource: 'customers' }, (ctx, p) => credits.getTransaction(ctx, p.id));

  // ---------- Failed-payment retries (Settings → Billing) ----------
  apiRoute(app, 'GET', '/v1/tessera/billing_settings', { resource: 'subscriptions' }, async (ctx) => ({ object: 'tessera.billing_settings', ...(await retries.getSettings(ctx.accountId)) }));
  apiRoute(app, 'POST', '/v1/tessera/billing_settings', { resource: 'subscriptions' }, (ctx, p) => retries.updateSettings(ctx, p));
  apiRoute(app, 'GET', '/v1/tessera/invoices/:id/retries', { resource: 'invoices' }, (ctx, p) => retries.retryHistory(ctx, p.id));
}
