import type { FastifyInstance } from 'fastify';
import * as accts from '../domain/connect/accounts.ts';
import * as payouts from '../domain/connect/payouts.ts';
import * as transfers from '../domain/connect/transfers.ts';
import { getObject, listObjects, type ListFilter } from '../domain/store.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

function listOf(data: any[], url: string, p: any) {
  const limit = p.limit === undefined ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('This value must be between 1 and 100.', 'limit');
  let start = 0;
  if (p.starting_after) start = data.findIndex((x) => x.id === p.starting_after) + 1;
  const page = data.slice(start, start + limit);
  return { object: 'list', data: page, has_more: start + limit < data.length, url };
}

/** Connect: accounts, onboarding links, external accounts, transfers, application fees and payouts. */
export function registerConnect(app: FastifyInstance) {
  // ---------- Accounts ----------
  apiRoute(app, 'POST', '/v1/accounts', { resource: 'accounts' }, (ctx, p) => accts.createConnectedAccount(ctx, p));
  apiRoute(app, 'GET', '/v1/accounts', { resource: 'accounts' }, (ctx, p) => accts.listConnectedAccounts(ctx, p));
  apiRoute(app, 'GET', '/v1/accounts/:id', { resource: 'accounts' }, (ctx, p) => accts.accessibleAccount(ctx, p.id));
  apiRoute(app, 'POST', '/v1/accounts/:id', { resource: 'accounts' }, (ctx, p) => accts.updateConnectedAccount(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/accounts/:id', { resource: 'accounts' }, (ctx, p) => accts.deleteAccount(ctx, p.id));
  apiRoute(app, 'POST', '/v1/accounts/:id/reject', { resource: 'accounts' }, (ctx, p) => accts.rejectAccount(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/accounts/:id/login_links', { resource: 'accounts' }, (ctx, p) => accts.createLoginLink(ctx, p.id));
  apiRoute(app, 'POST', '/v1/account_links', { resource: 'accounts' }, (ctx, p) => accts.createAccountLink(ctx, p));

  apiRoute(app, 'GET', '/v1/accounts/:id/capabilities', { resource: 'accounts' }, async (ctx, p) => {
    const a = await accts.connectedAccount(ctx, p.id);
    return { object: 'list', data: Object.keys(a._capabilities).map((c) => accts.capabilityObject(a, c)), has_more: false, url: `/v1/accounts/${a.id}/capabilities` };
  });
  apiRoute(app, 'GET', '/v1/accounts/:id/capabilities/:cap', { resource: 'accounts' }, async (ctx, p) => accts.capabilityObject(await accts.connectedAccount(ctx, p.id), p.cap));
  apiRoute(app, 'POST', '/v1/accounts/:id/capabilities/:cap', { resource: 'accounts' }, (ctx, p) => accts.updateCapability(ctx, p.id, p.cap, p));

  // ---------- External accounts (bank accounts) ----------
  apiRoute(app, 'POST', '/v1/accounts/:id/external_accounts', { resource: 'accounts' }, async (ctx, p) => {
    const a = await accts.accessibleAccount(ctx, p.id);
    if (p.external_account === undefined || p.external_account === '') throw invalid('Missing required param: external_account.', 'external_account', 'parameter_missing');
    return accts.addExternalAccount(ctx, a, p.external_account, { makeDefault: p.default_for_currency === 'true' });
  });
  apiRoute(app, 'GET', '/v1/accounts/:id/external_accounts', { resource: 'accounts' }, async (ctx, p) => {
    const a = await accts.accessibleAccount(ctx, p.id);
    const data = (a.external_accounts?.data ?? []).filter((x: any) => !p.object || x.object === p.object);
    return listOf(data, `/v1/accounts/${a.id}/external_accounts`, p);
  });
  apiRoute(app, 'GET', '/v1/accounts/:id/external_accounts/:ext', { resource: 'accounts' }, async (ctx, p) => accts.getExternal(await accts.accessibleAccount(ctx, p.id), p.ext));
  apiRoute(app, 'POST', '/v1/accounts/:id/external_accounts/:ext', { resource: 'accounts' }, async (ctx, p) => accts.updateExternalAccount(ctx, await accts.accessibleAccount(ctx, p.id), p.ext, p));
  apiRoute(app, 'DELETE', '/v1/accounts/:id/external_accounts/:ext', { resource: 'accounts' }, async (ctx, p) => accts.deleteExternalAccount(ctx, await accts.accessibleAccount(ctx, p.id), p.ext));

  // Bank account tokens (client-side collection with a publishable key).
  apiRoute(app, 'POST', '/v1/tokens', { resource: 'tokens', publishable: (_req, p) => !!p.bank_account }, (ctx, p) => accts.createBankToken(ctx, p));
  apiRoute(app, 'GET', '/v1/tokens/:id', { resource: 'tokens' }, (ctx, p) => getObject(ctx.platformAccountId ?? ctx.accountId, 'token', p.id, 'token'));

  // ---------- Transfers ----------
  apiRoute(app, 'POST', '/v1/transfers', { resource: 'transfers', critical: true }, (ctx, p) => transfers.createTransfer(ctx, p));
  apiRoute(app, 'GET', '/v1/transfers', { resource: 'transfers' }, (ctx, p) => listObjects(ctx.accountId, 'transfer', '/v1/transfers', p, filters(p, ['destination', 'transfer_group'])));
  apiRoute(app, 'GET', '/v1/transfers/:id', { resource: 'transfers' }, (ctx, p) => getObject(ctx.accountId, 'transfer', p.id, 'transfer'));
  apiRoute(app, 'POST', '/v1/transfers/:id', { resource: 'transfers' }, (ctx, p) => transfers.updateTransfer(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/transfers/:id/reversals', { resource: 'transfers', critical: true }, (ctx, p) => transfers.reverseTransfer(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/transfers/:id/reversals', { resource: 'transfers' }, async (ctx, p) => {
    const tr = await getObject<any>(ctx.accountId, 'transfer', p.id, 'transfer');
    return listOf(tr.reversals.data, tr.reversals.url, p);
  });
  apiRoute(app, 'GET', '/v1/transfers/:id/reversals/:rid', { resource: 'transfers' }, async (ctx, p) => {
    const tr = await getObject<any>(ctx.accountId, 'transfer', p.id, 'transfer');
    const r = tr.reversals.data.find((x: any) => x.id === p.rid);
    if (!r) throw new ApiError(404, 'invalid_request_error', `No such transfer reversal: '${p.rid}'`, { param: 'id', code: 'resource_missing' });
    return r;
  });

  // ---------- Application fees ----------
  apiRoute(app, 'GET', '/v1/application_fees', { resource: 'application_fees' }, (ctx, p) => listObjects(ctx.accountId, 'application_fee', '/v1/application_fees', p, filters(p, ['charge', 'account'])));
  apiRoute(app, 'GET', '/v1/application_fees/:id', { resource: 'application_fees' }, (ctx, p) => getObject(ctx.accountId, 'application_fee', p.id, 'application fee'));
  apiRoute(app, 'POST', '/v1/application_fees/:id/refunds', { resource: 'application_fees' }, (ctx, p) => transfers.refundApplicationFee(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/application_fees/:id/refund', { resource: 'application_fees' }, (ctx, p) => transfers.refundApplicationFee(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/application_fees/:id/refunds', { resource: 'application_fees' }, async (ctx, p) => {
    const fee = await getObject<any>(ctx.accountId, 'application_fee', p.id, 'application fee');
    return listOf(fee.refunds.data, fee.refunds.url, p);
  });

  // ---------- Payouts ----------
  apiRoute(app, 'POST', '/v1/payouts', { resource: 'payouts', critical: true }, (ctx, p) => payouts.createPayout(ctx, p));
  apiRoute(app, 'GET', '/v1/payouts', { resource: 'payouts' }, (ctx, p) => listObjects(ctx.accountId, 'payout', '/v1/payouts', p, filters(p, ['status', 'destination'])));
  apiRoute(app, 'GET', '/v1/payouts/:id', { resource: 'payouts' }, (ctx, p) => getObject(ctx.accountId, 'payout', p.id, 'payout'));
  apiRoute(app, 'POST', '/v1/payouts/:id', { resource: 'payouts' }, (ctx, p) => payouts.updatePayout(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/payouts/:id/cancel', { resource: 'payouts' }, (ctx, p) => payouts.cancelPayout(ctx, p.id));

  // ---------- Platform introspection ----------
  apiRoute(app, 'GET', '/v1/tessera/connect/overview', { resource: 'accounts', raw: true }, (ctx) => transfers.overview(ctx));
}
