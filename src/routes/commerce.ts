import type { FastifyInstance } from 'fastify';
import * as portal from '../domain/billing/portal.ts';
import * as quotes from '../domain/billing/quotes.ts';
import { exchangeRateObject, SUPPORTED_CURRENCIES } from '../domain/fx.ts';
import { getObject, listObjects, type ListFilter } from '../domain/store.ts';
import * as tax from '../domain/tax.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

/** Tax, quotes, the customer portal and exchange rates. */
export function registerCommerce(app: FastifyInstance) {
  // ---------- Tax rates ----------
  apiRoute(app, 'POST', '/v1/tax_rates', { resource: 'tax_rates' }, (ctx, p) => tax.createTaxRate(ctx, p));
  apiRoute(app, 'GET', '/v1/tax_rates', { resource: 'tax_rates' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'tax_rate', '/v1/tax_rates', p);
    if (p.active !== undefined) l.data = l.data.filter((r) => String(r.active) === String(p.active));
    if (p.inclusive !== undefined) l.data = l.data.filter((r) => String(r.inclusive) === String(p.inclusive));
    return l;
  });
  apiRoute(app, 'GET', '/v1/tax_rates/:id', { resource: 'tax_rates' }, (ctx, p) => getObject(ctx.accountId, 'tax_rate', p.id, 'tax rate'));
  apiRoute(app, 'POST', '/v1/tax_rates/:id', { resource: 'tax_rates' }, (ctx, p) => tax.updateTaxRate(ctx, p.id, p));

  // ---------- Automatic tax ----------
  apiRoute(app, 'POST', '/v1/tax/registrations', { resource: 'tax' }, (ctx, p) => tax.createRegistration(ctx, p));
  apiRoute(app, 'GET', '/v1/tax/registrations', { resource: 'tax' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'tax.registration', '/v1/tax/registrations', p);
    if (p.status && p.status !== 'all') l.data = l.data.filter((r) => r.status === p.status);
    return l;
  });
  apiRoute(app, 'GET', '/v1/tax/registrations/:id', { resource: 'tax' }, (ctx, p) => getObject(ctx.accountId, 'tax.registration', p.id, 'tax registration'));
  apiRoute(app, 'POST', '/v1/tax/registrations/:id', { resource: 'tax' }, (ctx, p) => tax.updateRegistration(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/tax/calculations', { resource: 'tax' }, (ctx, p) => tax.createCalculation(ctx, p));
  apiRoute(app, 'GET', '/v1/tax/calculations/:id/line_items', { resource: 'tax' }, (ctx, p) => tax.calculationLineItems(ctx, p.id));
  apiRoute(app, 'POST', '/v1/tax/transactions/create_from_calculation', { resource: 'tax' }, (ctx, p) => tax.createTransactionFromCalculation(ctx, p));
  apiRoute(app, 'GET', '/v1/tax/transactions/:id', { resource: 'tax' }, (ctx, p) => getObject(ctx.accountId, 'tax.transaction', p.id, 'tax transaction'));
  apiRoute(app, 'GET', '/v1/tessera/tax/jurisdictions', { resource: 'tax', raw: true }, async () => tax.supportedJurisdictions());

  // ---------- Quotes ----------
  apiRoute(app, 'POST', '/v1/quotes', { resource: 'quotes' }, (ctx, p) => quotes.createQuote(ctx, p));
  apiRoute(app, 'GET', '/v1/quotes', { resource: 'quotes' }, (ctx, p) => listObjects(ctx.accountId, 'quote', '/v1/quotes', p, filters(p, ['customer', 'status'])));
  apiRoute(app, 'GET', '/v1/quotes/:id', { resource: 'quotes' }, (ctx, p) => getObject(ctx.accountId, 'quote', p.id, 'quote'));
  apiRoute(app, 'POST', '/v1/quotes/:id', { resource: 'quotes' }, (ctx, p) => quotes.updateQuote(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/quotes/:id/finalize', { resource: 'quotes' }, (ctx, p) => quotes.finalizeQuote(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/quotes/:id/accept', { resource: 'quotes', critical: true }, (ctx, p) => quotes.acceptQuote(ctx, p.id));
  apiRoute(app, 'POST', '/v1/quotes/:id/cancel', { resource: 'quotes' }, (ctx, p) => quotes.cancelQuote(ctx, p.id));
  apiRoute(app, 'GET', '/v1/quotes/:id/line_items', { resource: 'quotes' }, async (ctx, p) => quotes.quoteLineItems(await getObject(ctx.accountId, 'quote', p.id, 'quote')));
  apiRoute(app, 'GET', '/v1/quotes/:id/computed_upfront_line_items', { resource: 'quotes' }, async (ctx, p) => quotes.quoteLineItems(await getObject(ctx.accountId, 'quote', p.id, 'quote'), true));
  apiRoute(app, 'GET', '/v1/quotes/:id/pdf', { resource: 'quotes', raw: true }, (ctx, p) => quotes.quotePdf(ctx, p.id));

  // ---------- Customer portal ----------
  apiRoute(app, 'POST', '/v1/billing_portal/configurations', { resource: 'billing_portal' }, (ctx, p) => portal.createConfiguration(ctx, p));
  apiRoute(app, 'GET', '/v1/billing_portal/configurations', { resource: 'billing_portal' }, (ctx, p) => listObjects(ctx.accountId, 'billing_portal.configuration', '/v1/billing_portal/configurations', p));
  apiRoute(app, 'GET', '/v1/billing_portal/configurations/:id', { resource: 'billing_portal' }, (ctx, p) => getObject(ctx.accountId, 'billing_portal.configuration', p.id, 'billing portal configuration'));
  apiRoute(app, 'POST', '/v1/billing_portal/configurations/:id', { resource: 'billing_portal' }, (ctx, p) => portal.updateConfiguration(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/billing_portal/sessions', { resource: 'billing_portal' }, (ctx, p) => portal.createPortalSession(ctx, p));

  // ---------- Exchange rates ----------
  apiRoute(app, 'GET', '/v1/exchange_rates', { resource: 'exchange_rates' }, async () => ({ object: 'list', data: SUPPORTED_CURRENCIES.map(exchangeRateObject), has_more: false, url: '/v1/exchange_rates' }));
  apiRoute(app, 'GET', '/v1/exchange_rates/:currency', { resource: 'exchange_rates' }, async (_ctx, p) => exchangeRateObject(String(p.currency).toLowerCase()));
}
