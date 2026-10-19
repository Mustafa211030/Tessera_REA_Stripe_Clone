import type { FastifyInstance } from 'fastify';
import * as cash from '../domain/cashBalance.ts';
import * as issuing from '../domain/issuing.ts';
import { getObject, listObjects, type ListFilter } from '../domain/store.ts';
import * as treasury from '../domain/treasury.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

/** Treasury financial accounts, Issuing disputes and customer cash balances. */
export function registerTreasury(app: FastifyInstance) {
  // ---------- Financial accounts ----------
  const fa = (ctx: any, id: string, expand?: any) => getObject<any>(ctx.accountId, 'treasury.financial_account', id, 'treasury.financial_account').then((x) => treasury.present(ctx.accountId, x, expand));
  apiRoute(app, 'POST', '/v1/treasury/financial_accounts', { resource: 'treasury' }, async (ctx, p) => treasury.present(ctx.accountId, await treasury.createFinancialAccount(ctx, p), p.expand));
  apiRoute(app, 'GET', '/v1/treasury/financial_accounts', { resource: 'treasury' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'treasury.financial_account', '/v1/treasury/financial_accounts', p, filters(p, ['status']));
    return { ...l, data: await Promise.all(l.data.map((x) => treasury.present(ctx.accountId, x, p.expand))) };
  });
  apiRoute(app, 'GET', '/v1/treasury/financial_accounts/:id', { resource: 'treasury' }, (ctx, p) => fa(ctx, p.id, p.expand));
  apiRoute(app, 'POST', '/v1/treasury/financial_accounts/:id', { resource: 'treasury' }, async (ctx, p) => treasury.present(ctx.accountId, await treasury.updateFinancialAccount(ctx, p.id, p), p.expand));
  apiRoute(app, 'POST', '/v1/treasury/financial_accounts/:id/close', { resource: 'treasury' }, async (ctx, p) => treasury.present(ctx.accountId, await treasury.closeFinancialAccount(ctx, p.id), p.expand));
  apiRoute(app, 'GET', '/v1/treasury/financial_accounts/:id/features', { resource: 'treasury' }, async (ctx, p) => {
    const f = await getObject<any>(ctx.accountId, 'treasury.financial_account', p.id, 'treasury.financial_account');
    const out: any = { object: 'treasury.financial_account_features' };
    for (const name of f.active_features) {
      const [a, b] = name.split('.');
      const status = { requested: true, status: 'active', status_details: [] };
      if (b) (out[a!] ??= {})[b] = status; else out[a!] = status;
    }
    return out;
  });

  // ---------- Money movement ----------
  const list = (type: string, url: string, extra: string[] = []) => (ctx: any, p: any) => listObjects(ctx.accountId, type, url, p, filters(p, ['financial_account', 'status', ...extra]));
  apiRoute(app, 'POST', '/v1/treasury/inbound_transfers', { resource: 'treasury', critical: true }, (ctx, p) => treasury.createInboundTransfer(ctx, p));
  apiRoute(app, 'GET', '/v1/treasury/inbound_transfers', { resource: 'treasury' }, list('treasury.inbound_transfer', '/v1/treasury/inbound_transfers'));
  apiRoute(app, 'GET', '/v1/treasury/inbound_transfers/:id', { resource: 'treasury' }, (ctx, p) => getObject(ctx.accountId, 'treasury.inbound_transfer', p.id, 'treasury.inbound_transfer'));
  apiRoute(app, 'POST', '/v1/treasury/inbound_transfers/:id/cancel', { resource: 'treasury' }, (ctx, p) => treasury.finishInboundTransfer(ctx, p.id, 'cancel'));
  for (const kind of ['payment', 'transfer'] as const) {
    const type = `treasury.outbound_${kind}`;
    const base = `/v1/treasury/outbound_${kind}s`;
    apiRoute(app, 'POST', base, { resource: 'treasury', critical: true }, (ctx, p) => (kind === 'payment' ? treasury.createOutboundPayment(ctx, p) : treasury.createOutboundTransfer(ctx, p)));
    apiRoute(app, 'GET', base, { resource: 'treasury' }, list(type, base, kind === 'payment' ? ['customer'] : []));
    apiRoute(app, 'GET', `${base}/:id`, { resource: 'treasury' }, (ctx, p) => getObject(ctx.accountId, type, p.id, type));
    apiRoute(app, 'POST', `${base}/:id/cancel`, { resource: 'treasury' }, (ctx, p) => treasury.cancelOutbound(ctx, type, p.id));
    for (const action of ['post', 'fail', 'return'] as const) {
      apiRoute(app, 'POST', `/v1/test_helpers/treasury/outbound_${kind}s/:id/${action}`, { resource: 'treasury' }, (ctx, p) => treasury.settleOutbound(ctx, type, p.id, action, p.returned_details?.code));
    }
  }
  apiRoute(app, 'GET', '/v1/treasury/received_credits', { resource: 'treasury' }, list('treasury.received_credit', '/v1/treasury/received_credits'));
  apiRoute(app, 'GET', '/v1/treasury/received_credits/:id', { resource: 'treasury' }, (ctx, p) => getObject(ctx.accountId, 'treasury.received_credit', p.id, 'treasury.received_credit'));
  apiRoute(app, 'GET', '/v1/treasury/received_debits', { resource: 'treasury' }, list('treasury.received_debit', '/v1/treasury/received_debits'));
  apiRoute(app, 'GET', '/v1/treasury/received_debits/:id', { resource: 'treasury' }, (ctx, p) => getObject(ctx.accountId, 'treasury.received_debit', p.id, 'treasury.received_debit'));
  apiRoute(app, 'GET', '/v1/treasury/transactions', { resource: 'treasury' }, list('treasury.transaction', '/v1/treasury/transactions', ['flow']));
  apiRoute(app, 'GET', '/v1/treasury/transactions/:id', { resource: 'treasury' }, (ctx, p) => getObject(ctx.accountId, 'treasury.transaction', p.id, 'treasury.transaction'));
  apiRoute(app, 'GET', '/v1/treasury/transaction_entries', { resource: 'treasury' }, list('treasury.transaction_entry', '/v1/treasury/transaction_entries', ['transaction']));
  apiRoute(app, 'GET', '/v1/treasury/transaction_entries/:id', { resource: 'treasury' }, (ctx, p) => getObject(ctx.accountId, 'treasury.transaction_entry', p.id, 'treasury.transaction_entry'));

  // ---------- Treasury test helpers ----------
  apiRoute(app, 'POST', '/v1/test_helpers/treasury/inbound_transfers/:id/succeed', { resource: 'treasury' }, (ctx, p) => treasury.finishInboundTransfer(ctx, p.id, 'succeed'));
  apiRoute(app, 'POST', '/v1/test_helpers/treasury/inbound_transfers/:id/fail', { resource: 'treasury' }, (ctx, p) => treasury.finishInboundTransfer(ctx, p.id, 'fail', p.failure_details?.code));
  apiRoute(app, 'POST', '/v1/test_helpers/treasury/inbound_transfers/:id/return', { resource: 'treasury' }, (ctx, p) => treasury.returnInboundTransfer(ctx, p.id));
  apiRoute(app, 'POST', '/v1/test_helpers/treasury/received_credits', { resource: 'treasury' }, (ctx, p) => treasury.testReceivedCredit(ctx, p));
  apiRoute(app, 'POST', '/v1/test_helpers/treasury/received_debits', { resource: 'treasury' }, (ctx, p) => treasury.testReceivedDebit(ctx, p));

  // ---------- Issuing disputes ----------
  apiRoute(app, 'POST', '/v1/issuing/disputes', { resource: 'issuing' }, (ctx, p) => issuing.createIssuingDispute(ctx, p));
  apiRoute(app, 'GET', '/v1/issuing/disputes', { resource: 'issuing' }, (ctx, p) => listObjects(ctx.accountId, 'issuing.dispute', '/v1/issuing/disputes', p, filters(p, ['status', 'transaction'])));
  apiRoute(app, 'GET', '/v1/issuing/disputes/:id', { resource: 'issuing' }, (ctx, p) => getObject(ctx.accountId, 'issuing.dispute', p.id, 'issuing.dispute'));
  apiRoute(app, 'POST', '/v1/issuing/disputes/:id', { resource: 'issuing' }, (ctx, p) => issuing.updateIssuingDispute(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/issuing/disputes/:id/submit', { resource: 'issuing' }, (ctx, p) => issuing.submitIssuingDispute(ctx, p.id, p));

  // ---------- Customer cash balance ----------
  apiRoute(app, 'GET', '/v1/customers/:id/cash_balance', { resource: 'customers' }, (ctx, p) => cash.cashBalance(ctx, p.id));
  apiRoute(app, 'POST', '/v1/customers/:id/cash_balance', { resource: 'customers' }, (ctx, p) => cash.updateCashBalance(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/customers/:id/funding_instructions', { resource: 'customers' }, (ctx, p) => cash.fundingInstructions(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/customers/:id/cash_balance_transactions', { resource: 'customers' }, async (ctx, p) => {
    const { id, ...rest } = p;
    await getObject(ctx.accountId, 'customer', id, 'customer');
    return listObjects(ctx.accountId, 'customer_cash_balance_transaction', `/v1/customers/${id}/cash_balance_transactions`, rest, [{ field: 'customer', value: id }]);
  });
  apiRoute(app, 'POST', '/v1/test_helpers/customers/:id/fund_cash_balance', { resource: 'customers', critical: true }, (ctx, p) => cash.fundCashBalance(ctx, p.id, p));
}
