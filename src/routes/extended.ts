import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../db/index.ts';
import * as disputes from '../domain/disputes.ts';
import * as reporting from '../domain/reporting.ts';
import * as setup from '../domain/setupIntents.ts';
import { getObject, listObjects, type ListFilter } from '../domain/store.ts';
import { invalid } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

/** A publishable key may act on a SetupIntent only with that intent's client_secret. */
async function hasClientSecret(req: FastifyRequest, p: any) {
  const id = (req.params as any).id;
  if (!p.client_secret || !String(p.client_secret).startsWith(`${id}_secret_`)) return false;
  const row = (await query<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND type = 'setup_intent'", [id]))[0];
  return row?.data.client_secret === p.client_secret;
}

function clientView(si: any) {
  const keep = ['id', 'object', 'cancellation_reason', 'client_secret', 'created', 'description', 'last_setup_error', 'livemode', 'next_action', 'payment_method', 'payment_method_types', 'status', 'usage'];
  return Object.fromEntries(keep.map((k) => [k, si[k]]));
}

/** SetupIntents, disputes, early fraud warnings, financial reports and files. */
export function registerExtended(app: FastifyInstance) {
  // ---------- SetupIntents ----------
  apiRoute(app, 'POST', '/v1/setup_intents', { resource: 'setup_intents' }, (ctx, p) => setup.createSetupIntent(ctx, p));
  apiRoute(app, 'GET', '/v1/setup_intents', { resource: 'setup_intents' }, (ctx, p) => listObjects(ctx.accountId, 'setup_intent', '/v1/setup_intents', p, filters(p, ['customer', 'payment_method', 'status'])));
  apiRoute(app, 'GET', '/v1/setup_intents/:id', { resource: 'setup_intents', publishable: hasClientSecret }, async (ctx, p) => {
    const si = await getObject<any>(ctx.accountId, 'setup_intent', p.id, 'setup_intent');
    return ctx.keyType === 'publishable' ? clientView(si) : si;
  });
  apiRoute(app, 'POST', '/v1/setup_intents/:id', { resource: 'setup_intents' }, (ctx, p) => setup.updateSetupIntent(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/setup_intents/:id/confirm', { resource: 'setup_intents', critical: true, publishable: hasClientSecret }, async (ctx, p) => {
    const r = await setup.confirmSetupIntent(ctx, p.id, p);
    return ctx.keyType === 'publishable' && r?.object === 'setup_intent' ? clientView(r) : r;
  });
  apiRoute(app, 'POST', '/v1/setup_intents/:id/cancel', { resource: 'setup_intents' }, (ctx, p) => setup.cancelSetupIntent(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/setup_attempts', { resource: 'setup_intents' }, (ctx, p) => {
    if (!p.setup_intent) throw invalid('Missing required param: setup_intent.', 'setup_intent', 'parameter_missing');
    return listObjects(ctx.accountId, 'setup_attempt', '/v1/setup_attempts', p, filters(p, ['setup_intent']));
  });

  // ---------- Disputes ----------
  apiRoute(app, 'GET', '/v1/disputes', { resource: 'disputes' }, (ctx, p) => listObjects(ctx.accountId, 'dispute', '/v1/disputes', p, filters(p, ['charge', 'payment_intent', 'status'])));
  apiRoute(app, 'GET', '/v1/disputes/:id', { resource: 'disputes' }, (ctx, p) => getObject(ctx.accountId, 'dispute', p.id, 'dispute'));
  apiRoute(app, 'POST', '/v1/disputes/:id', { resource: 'disputes' }, (ctx, p) => disputes.updateDispute(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/disputes/:id/close', { resource: 'disputes' }, (ctx, p) => disputes.closeDispute(ctx, p.id));
  apiRoute(app, 'GET', '/v1/radar/early_fraud_warnings', { resource: 'radar' }, (ctx, p) => listObjects(ctx.accountId, 'radar.early_fraud_warning', '/v1/radar/early_fraud_warnings', p, filters(p, ['charge', 'payment_intent'])));
  apiRoute(app, 'GET', '/v1/radar/early_fraud_warnings/:id', { resource: 'radar' }, (ctx, p) => getObject(ctx.accountId, 'radar.early_fraud_warning', p.id, 'early fraud warning'));

  // ---------- Reporting ----------
  apiRoute(app, 'GET', '/v1/reporting/report_types', { resource: 'reporting' }, (ctx) => reporting.listReportTypes(ctx));
  apiRoute(app, 'GET', '/v1/reporting/report_types/:id', { resource: 'reporting' }, (ctx, p) => reporting.getReportType(ctx, p.id));
  apiRoute(app, 'POST', '/v1/reporting/report_runs', { resource: 'reporting' }, (ctx, p) => reporting.createReportRun(ctx, p));
  apiRoute(app, 'GET', '/v1/reporting/report_runs', { resource: 'reporting' }, (ctx, p) => listObjects(ctx.accountId, 'reporting.report_run', '/v1/reporting/report_runs', p, filters(p, ['report_type'])));
  apiRoute(app, 'GET', '/v1/reporting/report_runs/:id', { resource: 'reporting' }, (ctx, p) => getObject(ctx.accountId, 'reporting.report_run', p.id, 'report run'));

  // ---------- Files ----------
}
