import type { FastifyInstance } from 'fastify';
import * as issuing from '../domain/issuing.ts';
import { getObject, listObjects, type ListFilter } from '../domain/store.ts';
import * as terminal from '../domain/terminal.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));
const live = <T extends { data: any[] }>(l: T) => ({ ...l, data: l.data.filter((x) => !x.deleted) });

/** Terminal (in-person payments), Issuing (cards) and top-ups. */
export function registerOperations(app: FastifyInstance) {
  // ---------- Terminal ----------
  apiRoute(app, 'POST', '/v1/terminal/connection_tokens', { resource: 'terminal' }, async (_ctx, p) => terminal.connectionToken(p));
  apiRoute(app, 'POST', '/v1/terminal/locations', { resource: 'terminal' }, (ctx, p) => terminal.createLocation(ctx, p));
  apiRoute(app, 'GET', '/v1/terminal/locations', { resource: 'terminal' }, async (ctx, p) => live(await listObjects(ctx.accountId, 'terminal.location', '/v1/terminal/locations', p)));
  apiRoute(app, 'GET', '/v1/terminal/locations/:id', { resource: 'terminal' }, (ctx, p) => getObject(ctx.accountId, 'terminal.location', p.id, 'terminal location'));
  apiRoute(app, 'POST', '/v1/terminal/locations/:id', { resource: 'terminal' }, (ctx, p) => terminal.updateLocation(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/terminal/locations/:id', { resource: 'terminal' }, (ctx, p) => terminal.deleteLocation(ctx, p.id));
  apiRoute(app, 'POST', '/v1/terminal/readers', { resource: 'terminal' }, (ctx, p) => terminal.registerReader(ctx, p));
  apiRoute(app, 'GET', '/v1/terminal/readers', { resource: 'terminal' }, async (ctx, p) => live(await listObjects(ctx.accountId, 'terminal.reader', '/v1/terminal/readers', p, filters(p, ['location', 'status', 'device_type', 'serial_number']))));
  apiRoute(app, 'GET', '/v1/terminal/readers/:id', { resource: 'terminal' }, (ctx, p) => getObject(ctx.accountId, 'terminal.reader', p.id, 'terminal reader'));
  apiRoute(app, 'POST', '/v1/terminal/readers/:id', { resource: 'terminal' }, (ctx, p) => terminal.updateReader(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/terminal/readers/:id', { resource: 'terminal' }, (ctx, p) => terminal.deleteReader(ctx, p.id));
  apiRoute(app, 'POST', '/v1/terminal/readers/:id/process_payment_intent', { resource: 'terminal' }, (ctx, p) => terminal.processPaymentIntent(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/terminal/readers/:id/set_reader_display', { resource: 'terminal' }, (ctx, p) => terminal.setReaderDisplay(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/terminal/readers/:id/refund_payment', { resource: 'terminal' }, (ctx, p) => terminal.refundPayment(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/terminal/readers/:id/cancel_action', { resource: 'terminal' }, (ctx, p) => terminal.cancelAction(ctx, p.id));
  apiRoute(app, 'POST', '/v1/test_helpers/terminal/readers/:id/present_payment_method', { resource: 'terminal', critical: true }, (ctx, p) => terminal.presentPaymentMethod(ctx, p.id, p));

  // ---------- Top-ups ----------
  apiRoute(app, 'POST', '/v1/topups', { resource: 'topups' }, (ctx, p) => issuing.createTopup(ctx, p));
  apiRoute(app, 'GET', '/v1/topups', { resource: 'topups' }, (ctx, p) => listObjects(ctx.accountId, 'topup', '/v1/topups', p, filters(p, ['status'])));
  apiRoute(app, 'GET', '/v1/topups/:id', { resource: 'topups' }, (ctx, p) => getObject(ctx.accountId, 'topup', p.id, 'topup'));

  // ---------- Issuing ----------
  apiRoute(app, 'POST', '/v1/issuing/cardholders', { resource: 'issuing' }, (ctx, p) => issuing.createCardholder(ctx, p));
  apiRoute(app, 'GET', '/v1/issuing/cardholders', { resource: 'issuing' }, (ctx, p) => listObjects(ctx.accountId, 'issuing.cardholder', '/v1/issuing/cardholders', p, filters(p, ['status', 'type', 'email'])));
  apiRoute(app, 'GET', '/v1/issuing/cardholders/:id', { resource: 'issuing' }, (ctx, p) => getObject(ctx.accountId, 'issuing.cardholder', p.id, 'issuing.cardholder'));
  apiRoute(app, 'POST', '/v1/issuing/cardholders/:id', { resource: 'issuing' }, (ctx, p) => issuing.updateCardholder(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/issuing/cards', { resource: 'issuing' }, async (ctx, p) => issuing.presentCard(ctx.accountId, await issuing.createCard(ctx, p), p.expand));
  apiRoute(app, 'GET', '/v1/issuing/cards', { resource: 'issuing' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'issuing.card', '/v1/issuing/cards', p, filters(p, ['cardholder', 'status', 'type', 'last4']));
    return { ...l, data: await Promise.all(l.data.map((c) => issuing.presentCard(ctx.accountId, c, p.expand))) };
  });
  apiRoute(app, 'GET', '/v1/issuing/cards/:id', { resource: 'issuing' }, async (ctx, p) => issuing.presentCard(ctx.accountId, await getObject(ctx.accountId, 'issuing.card', p.id, 'issuing.card'), p.expand));
  apiRoute(app, 'POST', '/v1/issuing/cards/:id', { resource: 'issuing' }, async (ctx, p) => issuing.presentCard(ctx.accountId, await issuing.updateCard(ctx, p.id, p), p.expand));
  apiRoute(app, 'GET', '/v1/issuing/authorizations', { resource: 'issuing' }, (ctx, p) => listObjects(ctx.accountId, 'issuing.authorization', '/v1/issuing/authorizations', p, filters(p, ['cardholder', 'status']).concat(p.card ? [{ field: '_card_id', value: p.card }] : [])));
  apiRoute(app, 'GET', '/v1/issuing/authorizations/:id', { resource: 'issuing' }, (ctx, p) => getObject(ctx.accountId, 'issuing.authorization', p.id, 'issuing.authorization'));
  apiRoute(app, 'POST', '/v1/issuing/authorizations/:id', { resource: 'issuing' }, async (ctx, p) => {
    const a = await getObject<any>(ctx.accountId, 'issuing.authorization', p.id, 'issuing.authorization');
    const { metadata } = await import('../lib/params.ts');
    a.metadata = metadata(p, a.metadata);
    const { saveObject } = await import('../domain/store.ts');
    return saveObject(ctx.accountId, a);
  });
  apiRoute(app, 'GET', '/v1/issuing/transactions', { resource: 'issuing' }, (ctx, p) => listObjects(ctx.accountId, 'issuing.transaction', '/v1/issuing/transactions', p, filters(p, ['card', 'cardholder', 'type'])));
  apiRoute(app, 'GET', '/v1/issuing/transactions/:id', { resource: 'issuing' }, (ctx, p) => getObject(ctx.accountId, 'issuing.transaction', p.id, 'issuing.transaction'));

  // ---------- Issuing test helpers ----------
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/authorizations', { resource: 'issuing', critical: true }, (ctx, p) => issuing.createAuthorization(ctx, p));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/authorizations/:id/capture', { resource: 'issuing' }, (ctx, p) => issuing.captureAuthorization(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/authorizations/:id/expire', { resource: 'issuing' }, (ctx, p) => issuing.expireAuthorization(ctx, p.id));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/authorizations/:id/increment', { resource: 'issuing' }, (ctx, p) => issuing.incrementAuthorization(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/authorizations/:id/reverse', { resource: 'issuing' }, (ctx, p) => issuing.reverseAuthorization(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/transactions/create_force_capture', { resource: 'issuing' }, (ctx, p) => issuing.forceCapture(ctx, p, 'capture'));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/transactions/create_unlinked_refund', { resource: 'issuing' }, (ctx, p) => issuing.forceCapture(ctx, p, 'refund'));
  apiRoute(app, 'POST', '/v1/test_helpers/issuing/transactions/:id/refund', { resource: 'issuing' }, (ctx, p) => issuing.refundTransaction(ctx, p.id, p));
}
