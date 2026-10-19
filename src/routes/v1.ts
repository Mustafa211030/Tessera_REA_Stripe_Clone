import type { FastifyInstance, FastifyRequest } from 'fastify';
import { flushLogs } from '../platform/hotpath.ts';
import { query } from '../db/index.ts';
import { getAccount } from '../domain/accounts.ts';
import { getBalance } from '../domain/balance.ts';
import * as checkout from '../domain/checkout.ts';
import * as customers from '../domain/customers.ts';
import { entriesFor, health } from '../domain/ledger.ts';
import * as pms from '../domain/paymentMethods.ts';
import * as pis from '../domain/paymentIntents.ts';
import * as radar from '../domain/radar.ts';
import * as refunds from '../domain/refunds.ts';
import { findObject, getObject, listObjects, type ListFilter } from '../domain/store.ts';
import * as webhooks from '../domain/webhooks.ts';
import { invalid } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';
import { CHANGES, SUPPORTED_VERSIONS } from '../platform/versioning.ts';
import { vaultStats } from '../vault/vault.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

/** A publishable key may act on a PaymentIntent only when it presents that intent's client_secret. */
async function hasClientSecret(req: FastifyRequest, p: any) {
  const id = (req.params as any).id;
  if (!p.client_secret || !String(p.client_secret).startsWith(`${id}_secret_`)) return false;
  const row = (await query<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'payment_intent'", [id]))[0];
  return row?.data.client_secret === p.client_secret;
}

/** What a publishable key may see of a PaymentIntent (as with client-side retrieval). */
export function clientView(pi: any) {
  const keep = ['id', 'object', 'amount', 'amount_details', 'automatic_payment_methods', 'canceled_at', 'cancellation_reason', 'capture_method', 'client_secret', 'confirmation_method', 'created', 'currency', 'description', 'last_payment_error', 'livemode', 'next_action', 'payment_method', 'payment_method_types', 'processing', 'receipt_email', 'setup_future_usage', 'shipping', 'status'];
  return Object.fromEntries(keep.map((k) => [k, pi[k]]));
}

export function registerV1(app: FastifyInstance) {
  // ---------- Account & balance ----------
  apiRoute(app, 'GET', '/v1/account', { resource: 'account' }, async (ctx) => getAccount(ctx.accountId));
  apiRoute(app, 'GET', '/v1/balance', { resource: 'balance' }, async (ctx) => getBalance(ctx.accountId));
  apiRoute(app, 'GET', '/v1/balance_transactions', { resource: 'balance' }, async (ctx, p) =>
    listObjects(ctx.accountId, 'balance_transaction', '/v1/balance_transactions', p, filters(p, ['type', 'source', 'currency'])),
  );
  apiRoute(app, 'GET', '/v1/balance_transactions/:id', { resource: 'balance' }, async (ctx, p) => getObject(ctx.accountId, 'balance_transaction', p.id, 'balance transaction'));

  // ---------- Customers ----------
  apiRoute(app, 'POST', '/v1/customers', { resource: 'customers' }, (ctx, p) => customers.createCustomer(ctx, p));
  apiRoute(app, 'GET', '/v1/customers', { resource: 'customers' }, async (ctx, p) => {
    const list = await listObjects(ctx.accountId, 'customer', '/v1/customers', p, filters(p, ['email']));
    list.data = list.data.filter((c) => !c.deleted);
    return list;
  });
  apiRoute(app, 'GET', '/v1/customers/:id', { resource: 'customers' }, async (ctx, p) => {
    const c = await getObject<any>(ctx.accountId, 'customer', p.id, 'customer');
    return c.deleted ? { id: c.id, object: 'customer', deleted: true } : c;
  });
  apiRoute(app, 'POST', '/v1/customers/:id', { resource: 'customers' }, (ctx, p) => customers.updateCustomer(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/customers/:id', { resource: 'customers' }, (ctx, p) => customers.deleteCustomer(ctx, p.id));
  apiRoute(app, 'GET', '/v1/customers/:id/payment_methods', { resource: 'payment_methods' }, (ctx, p) =>
    listObjects(ctx.accountId, 'payment_method', `/v1/customers/${p.id}/payment_methods`, p, [{ field: 'customer', value: p.id }]),
  );

  // ---------- Payment methods (tokenization via the vault) ----------
  apiRoute(app, 'POST', '/v1/payment_methods', { resource: 'payment_methods', critical: true, publishable: () => true }, (ctx, p) => pms.createPaymentMethod(ctx, p));
  apiRoute(app, 'GET', '/v1/payment_methods', { resource: 'payment_methods' }, (ctx, p) => {
    if (!p.customer) throw invalid('Missing required param: customer.', 'customer');
    return listObjects(ctx.accountId, 'payment_method', '/v1/payment_methods', p, filters(p, ['customer', 'type']));
  });
  apiRoute(app, 'GET', '/v1/payment_methods/:id', { resource: 'payment_methods' }, (ctx, p) => getObject(ctx.accountId, 'payment_method', p.id, 'PaymentMethod'));
  apiRoute(app, 'POST', '/v1/payment_methods/:id/attach', { resource: 'payment_methods' }, (ctx, p) => pms.attachPaymentMethod(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/payment_methods/:id/detach', { resource: 'payment_methods' }, (ctx, p) => pms.detachPaymentMethod(ctx, p.id));

  // ---------- PaymentIntents ----------
  apiRoute(app, 'POST', '/v1/payment_intents', { resource: 'payment_intents', critical: true }, (ctx, p) => pis.createPaymentIntent(ctx, p));
  apiRoute(app, 'GET', '/v1/payment_intents', { resource: 'payment_intents' }, (ctx, p) =>
    listObjects(ctx.accountId, 'payment_intent', '/v1/payment_intents', p, filters(p, ['customer', 'status'])),
  );
  apiRoute(app, 'GET', '/v1/payment_intents/:id', { resource: 'payment_intents', publishable: hasClientSecret }, async (ctx, p) => {
    const pi = await getObject<any>(ctx.accountId, 'payment_intent', p.id, 'payment_intent');
    return ctx.keyType === 'publishable' ? clientView(pi) : pi;
  });
  apiRoute(app, 'POST', '/v1/payment_intents/:id', { resource: 'payment_intents' }, (ctx, p) => pis.updatePaymentIntent(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/payment_intents/:id/confirm', { resource: 'payment_intents', critical: true, publishable: hasClientSecret }, async (ctx, p) => {
    const r = await pis.confirmPaymentIntent(ctx, p.id, p);
    return ctx.keyType === 'publishable' && !(r instanceof Error) && r?.object === 'payment_intent' ? clientView(r) : r;
  });
  apiRoute(app, 'POST', '/v1/payment_intents/:id/capture', { resource: 'payment_intents', critical: true }, (ctx, p) => pis.capturePaymentIntent(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/payment_intents/:id/cancel', { resource: 'payment_intents' }, (ctx, p) => pis.cancelPaymentIntent(ctx, p.id, p));

  // ---------- Charges & refunds ----------
  apiRoute(app, 'GET', '/v1/charges', { resource: 'charges' }, (ctx, p) => listObjects(ctx.accountId, 'charge', '/v1/charges', p, filters(p, ['customer', 'payment_intent', 'status'])));
  apiRoute(app, 'GET', '/v1/charges/:id', { resource: 'charges' }, (ctx, p) => getObject(ctx.accountId, 'charge', p.id, 'charge'));
  apiRoute(app, 'POST', '/v1/refunds', { resource: 'refunds', critical: true }, (ctx, p) => refunds.createRefund(ctx, p));
  apiRoute(app, 'GET', '/v1/refunds', { resource: 'refunds' }, (ctx, p) => listObjects(ctx.accountId, 'refund', '/v1/refunds', p, filters(p, ['charge', 'payment_intent'])));
  apiRoute(app, 'GET', '/v1/refunds/:id', { resource: 'refunds' }, (ctx, p) => getObject(ctx.accountId, 'refund', p.id, 'refund'));

  // ---------- Events & webhooks ----------
  apiRoute(app, 'GET', '/v1/events', { resource: 'events' }, async (ctx, p) => {
    const list = await listObjects(ctx.accountId, 'event', '/v1/events', p, filters(p, ['type']));
    if (p.related_object) list.data = list.data.filter((e: any) => e.data?.object?.id === p.related_object);
    return list;
  });
  apiRoute(app, 'GET', '/v1/events/:id', { resource: 'events' }, (ctx, p) => getObject(ctx.accountId, 'event', p.id, 'event'));
  apiRoute(app, 'POST', '/v1/webhook_endpoints', { resource: 'webhook_endpoints' }, (ctx, p) => webhooks.createEndpoint(ctx, p));
  apiRoute(app, 'GET', '/v1/webhook_endpoints', { resource: 'webhook_endpoints' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'webhook_endpoint', '/v1/webhook_endpoints', p);
    l.data = l.data.filter((e) => !e.deleted).map(webhooks.hideSecret);
    return l;
  });
  apiRoute(app, 'GET', '/v1/webhook_endpoints/:id', { resource: 'webhook_endpoints' }, async (ctx, p) => webhooks.hideSecret(await getObject(ctx.accountId, 'webhook_endpoint', p.id, 'webhook_endpoint')));
  apiRoute(app, 'POST', '/v1/webhook_endpoints/:id', { resource: 'webhook_endpoints' }, async (ctx, p) => webhooks.hideSecret(await webhooks.updateEndpoint(ctx, p.id, p)));
  apiRoute(app, 'DELETE', '/v1/webhook_endpoints/:id', { resource: 'webhook_endpoints' }, async (ctx, p) => {
    const ep = await webhooks.updateEndpoint(ctx, p.id, { disabled: 'true' });
    ep.deleted = true;
    await query('UPDATE objects SET data = $1 WHERE id = $2', [JSON.stringify(ep), ep.id]);
    return { id: ep.id, object: 'webhook_endpoint', deleted: true };
  });

  // ---------- Checkout ----------
  apiRoute(app, 'POST', '/v1/checkout/sessions', { resource: 'checkout_sessions' }, (ctx, p) => checkout.createSession(ctx, p));
  apiRoute(app, 'GET', '/v1/checkout/sessions', { resource: 'checkout_sessions' }, (ctx, p) => listObjects(ctx.accountId, 'checkout.session', '/v1/checkout/sessions', p, filters(p, ['payment_intent', 'status', 'payment_link', 'customer', 'subscription'])));
  apiRoute(app, 'GET', '/v1/checkout/sessions/:id', { resource: 'checkout_sessions' }, (ctx, p) => getObject(ctx.accountId, 'checkout.session', p.id, 'checkout.session'));
  apiRoute(app, 'GET', '/v1/checkout/sessions/:id/line_items', { resource: 'checkout_sessions' }, (ctx, p) => checkout.lineItems(ctx, p.id));
  apiRoute(app, 'POST', '/v1/checkout/sessions/:id/expire', { resource: 'checkout_sessions' }, (ctx, p) => checkout.expireSession(ctx, p.id));

  // ---------- Fraud rules (Radar-style) ----------
  apiRoute(app, 'GET', '/v1/radar/rules', { resource: 'radar' }, (ctx, p) => listObjects(ctx.accountId, 'radar.rule', '/v1/radar/rules', p));
  apiRoute(app, 'POST', '/v1/radar/rules', { resource: 'radar' }, (ctx, p) => radar.createRule(ctx, p));
  apiRoute(app, 'POST', '/v1/radar/rules/:id', { resource: 'radar' }, (ctx, p) => radar.updateRule(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/radar/rules/test', { resource: 'radar' }, (ctx, p) => radar.testRule(ctx, p));
  apiRoute(app, 'GET', '/v1/radar/value_lists', { resource: 'radar' }, (ctx, p) => listObjects(ctx.accountId, 'radar.value_list', '/v1/radar/value_lists', p));
  apiRoute(app, 'POST', '/v1/radar/value_lists', { resource: 'radar' }, (ctx, p) => radar.createValueList(ctx, p));
  apiRoute(app, 'GET', '/v1/reviews', { resource: 'radar' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'review', '/v1/reviews', p);
    if (p.open !== undefined) l.data = l.data.filter((r) => String(r.open) === String(p.open));
    return l;
  });
  apiRoute(app, 'POST', '/v1/reviews/:id/approve', { resource: 'radar' }, (ctx, p) => refunds.closeReview(ctx, p.id, 'approve'));
  apiRoute(app, 'POST', '/v1/reviews/:id/refund', { resource: 'radar' }, (ctx, p) => refunds.closeReview(ctx, p.id, 'refund'));

  // ---------- Platform introspection (not part of the public Stripe surface) ----------
  apiRoute(app, 'GET', '/v1/tessera/ledger', { resource: 'balance', raw: true }, async (ctx) => ({ object: 'ledger_health', ...(await health(ctx.accountId)), vault: await vaultStats() }));
  apiRoute(app, 'GET', '/v1/tessera/ledger/:source', { resource: 'balance', raw: true }, async (ctx, p) => ({ object: 'list', data: await entriesFor(ctx.accountId, p.source) }));
  apiRoute(app, 'GET', '/v1/tessera/versions', { resource: 'account', raw: true }, async () => ({ supported: SUPPORTED_VERSIONS, changes: CHANGES.map(({ version, description, resources }) => ({ version, description, resources })) }));
  apiRoute(app, 'GET', '/v1/tessera/request_logs', { resource: 'account', raw: true }, async (ctx, p) => {
    await flushLogs();
    const rows = await query('SELECT id, method, path, status, duration_ms, idempotency_key, api_version, source, created FROM request_logs WHERE account_id = $1 ORDER BY seq DESC LIMIT $2', [ctx.accountId, Math.min(Number(p.limit ?? 50), 200)]);
    return { object: 'list', data: rows };
  });
  apiRoute(app, 'GET', '/v1/tessera/request_logs/:id', { resource: 'account', raw: true }, async (ctx, p) => {
    await flushLogs();
    const rows = await query('SELECT * FROM request_logs WHERE account_id = $1 AND id = $2', [ctx.accountId, p.id]);
    if (!rows[0]) throw invalid('No such request log', 'id');
    return rows[0];
  });
  apiRoute(app, 'GET', '/v1/tessera/webhook_endpoints/:id/deliveries', { resource: 'webhook_endpoints', raw: true }, async (ctx, p) => ({ object: 'list', data: await webhooks.deliveriesFor(ctx.accountId, p.id) }));
  apiRoute(app, 'GET', '/v1/tessera/webhook_deliveries/:id/attempts', { resource: 'webhook_endpoints', raw: true }, async (_ctx, p) => ({ object: 'list', data: await webhooks.attemptsFor(p.id) }));
  apiRoute(app, 'POST', '/v1/tessera/events/:id/resend', { resource: 'webhook_endpoints', raw: true }, (ctx, p) => webhooks.resend(ctx, p.id, String(p.webhook_endpoint)));
  apiRoute(app, 'GET', '/v1/tessera/objects/:id', { resource: 'account' }, async (ctx, p) => {
    const row = (await query<{ data: any }>('SELECT data FROM objects WHERE account_id = $1 AND id = $2', [ctx.accountId, p.id]))[0];
    if (!row) throw invalid(`No such object: ${p.id}`, 'id');
    return row.data;
  });
  void findObject;
}
