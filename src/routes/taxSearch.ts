import type { FastifyInstance } from 'fastify';
import { search } from '../domain/search.ts';
import * as taxIds from '../domain/taxIds.ts';
import { apiRoute } from '../platform/http.ts';

/** Tax IDs and the search query language. */
export function registerTaxSearch(app: FastifyInstance) {
  // ---------- Tax IDs ----------
  apiRoute(app, 'POST', '/v1/customers/:id/tax_ids', { resource: 'customers' }, (ctx, p) => taxIds.createCustomerTaxId(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/customers/:id/tax_ids', { resource: 'customers' }, (ctx, p) => taxIds.listTaxIds(ctx, p, p.id));
  apiRoute(app, 'GET', '/v1/customers/:id/tax_ids/:tid', { resource: 'customers' }, (ctx, p) => taxIds.getTaxId(ctx, p.tid, p.id));
  apiRoute(app, 'DELETE', '/v1/customers/:id/tax_ids/:tid', { resource: 'customers' }, (ctx, p) => taxIds.deleteTaxId(ctx, p.tid, p.id));
  apiRoute(app, 'POST', '/v1/tax_ids', { resource: 'tax_ids' }, (ctx, p) => taxIds.createTaxId(ctx, p));
  apiRoute(app, 'GET', '/v1/tax_ids', { resource: 'tax_ids' }, (ctx, p) => taxIds.listTaxIds(ctx, p));
  apiRoute(app, 'GET', '/v1/tax_ids/:id', { resource: 'tax_ids' }, (ctx, p) => taxIds.getTaxId(ctx, p.id));
  apiRoute(app, 'DELETE', '/v1/tax_ids/:id', { resource: 'tax_ids' }, (ctx, p) => taxIds.deleteTaxId(ctx, p.id));

  // ---------- Search ----------
  const resources: [string, string, string][] = [
    ['charges', 'charge', 'charges'], ['customers', 'customer', 'customers'], ['invoices', 'invoice', 'invoices'], ['payment_intents', 'payment_intent', 'payment_intents'],
    ['prices', 'price', 'products'], ['products', 'product', 'products'], ['subscriptions', 'subscription', 'subscriptions'],
  ];
  for (const [path, type, resource] of resources) {
    apiRoute(app, 'GET', `/v1/${path}/search`, { resource }, (ctx, p) => search(ctx, type, `/v1/${path}/search`, p));
  }
}
