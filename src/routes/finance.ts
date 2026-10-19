import type { FastifyInstance } from 'fastify';
import * as balance from '../domain/billing/balance.ts';
import * as creditNotes from '../domain/billing/creditNotes.ts';
import * as identity from '../domain/identity.ts';
import * as shipping from '../domain/shipping.ts';
import { getObject, listObjects, type ListFilter } from '../domain/store.ts';
import { invalid } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

/** Credit notes, customer balance, shipping rates and identity verification. */
export function registerFinance(app: FastifyInstance) {
  // ---------- Customer balance ----------
  apiRoute(app, 'POST', '/v1/customers/:id/balance_transactions', { resource: 'customers' }, (ctx, p) => balance.createAdjustment(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/customers/:id/balance_transactions', { resource: 'customers' }, async (ctx, p) => {
    await getObject(ctx.accountId, 'customer', p.id, 'customer');
    const { id, ...rest } = p;
    return listObjects(ctx.accountId, 'customer_balance_transaction', `/v1/customers/${id}/balance_transactions`, rest, [{ field: 'customer', value: id }, ...filters(p, ['invoice', 'credit_note'])]);
  });
  apiRoute(app, 'GET', '/v1/customers/:customer/balance_transactions/:id', { resource: 'customers' }, async (ctx, p) => {
    const t = await getObject<any>(ctx.accountId, 'customer_balance_transaction', p.id, 'customer balance transaction');
    if (t.customer !== p.customer) throw invalid(`No such customer balance transaction: '${p.id}'`, 'id', 'resource_missing');
    return t;
  });
  apiRoute(app, 'POST', '/v1/customers/:customer/balance_transactions/:id', { resource: 'customers' }, (ctx, p) => balance.updateBalanceTxn(ctx, p.customer, p.id, p));

  // ---------- Credit notes ----------
  apiRoute(app, 'GET', '/v1/credit_notes/preview', { resource: 'credit_notes' }, (ctx, p) => creditNotes.previewCreditNote(ctx, p));
  apiRoute(app, 'GET', '/v1/credit_notes/preview/lines', { resource: 'credit_notes' }, async (ctx, p) => (await creditNotes.previewCreditNote(ctx, p)).lines);
  apiRoute(app, 'POST', '/v1/credit_notes', { resource: 'credit_notes', critical: true }, (ctx, p) => creditNotes.createCreditNote(ctx, p));
  apiRoute(app, 'GET', '/v1/credit_notes', { resource: 'credit_notes' }, (ctx, p) => listObjects(ctx.accountId, 'credit_note', '/v1/credit_notes', p, filters(p, ['invoice', 'customer'])));
  apiRoute(app, 'GET', '/v1/credit_notes/:id', { resource: 'credit_notes' }, (ctx, p) => getObject(ctx.accountId, 'credit_note', p.id, 'credit note'));
  apiRoute(app, 'GET', '/v1/credit_notes/:id/lines', { resource: 'credit_notes' }, async (ctx, p) => (await getObject<any>(ctx.accountId, 'credit_note', p.id, 'credit note')).lines);
  apiRoute(app, 'POST', '/v1/credit_notes/:id', { resource: 'credit_notes' }, (ctx, p) => creditNotes.updateCreditNote(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/credit_notes/:id/void', { resource: 'credit_notes' }, (ctx, p) => creditNotes.voidCreditNote(ctx, p.id));

  // ---------- Shipping rates ----------
  apiRoute(app, 'POST', '/v1/shipping_rates', { resource: 'shipping_rates' }, (ctx, p) => shipping.createShippingRate(ctx, p));
  apiRoute(app, 'GET', '/v1/shipping_rates', { resource: 'shipping_rates' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'shipping_rate', '/v1/shipping_rates', p);
    if (p.active !== undefined) l.data = l.data.filter((x: any) => String(x.active) === String(p.active));
    if (p.currency) l.data = l.data.filter((x: any) => x.fixed_amount.currency === p.currency);
    return l;
  });
  apiRoute(app, 'GET', '/v1/shipping_rates/:id', { resource: 'shipping_rates' }, (ctx, p) => getObject(ctx.accountId, 'shipping_rate', p.id, 'shipping rate'));
  apiRoute(app, 'POST', '/v1/shipping_rates/:id', { resource: 'shipping_rates' }, (ctx, p) => shipping.updateShippingRate(ctx, p.id, p));

  // ---------- Identity ----------
  const vs = (ctx: any, id: string) => getObject<any>(ctx.accountId, 'identity.verification_session', id, 'verification session');
  apiRoute(app, 'POST', '/v1/identity/verification_sessions', { resource: 'identity' }, async (ctx, p) => identity.present(await identity.createVerificationSession(ctx, p), p.expand));
  apiRoute(app, 'GET', '/v1/identity/verification_sessions', { resource: 'identity' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'identity.verification_session', '/v1/identity/verification_sessions', p, filters(p, ['status', 'client_reference_id', 'related_customer']));
    l.data = l.data.map((s) => identity.present(s, p.expand));
    return l;
  });
  apiRoute(app, 'GET', '/v1/identity/verification_sessions/:id', { resource: 'identity' }, async (ctx, p) => identity.present(await vs(ctx, p.id), p.expand));
  apiRoute(app, 'POST', '/v1/identity/verification_sessions/:id', { resource: 'identity' }, async (ctx, p) => identity.present(await identity.updateVerificationSession(ctx, p.id, p), p.expand));
  apiRoute(app, 'POST', '/v1/identity/verification_sessions/:id/cancel', { resource: 'identity' }, async (ctx, p) => identity.present(await identity.cancelVerificationSession(ctx, p.id), p.expand));
  apiRoute(app, 'POST', '/v1/identity/verification_sessions/:id/redact', { resource: 'identity' }, async (ctx, p) => identity.present(await identity.redactVerificationSession(ctx, p.id), p.expand));
  apiRoute(app, 'GET', '/v1/identity/verification_reports', { resource: 'identity' }, (ctx, p) => listObjects(ctx.accountId, 'identity.verification_report', '/v1/identity/verification_reports', p, filters(p, ['verification_session', 'type', 'client_reference_id'])));
  apiRoute(app, 'GET', '/v1/identity/verification_reports/:id', { resource: 'identity' }, (ctx, p) => getObject(ctx.accountId, 'identity.verification_report', p.id, 'verification report'));
}
