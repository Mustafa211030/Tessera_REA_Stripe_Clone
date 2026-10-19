import { createHash, randomBytes } from 'node:crypto';
import { one, query } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { arr, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { getObject, insertObject, listObjects, saveObject } from './store.ts';

/**
 * Financial Connections: customers link bank accounts through a hosted flow, and you read
 * balances, ownership and transactions (with their permission).
 *
 *   POST /v1/financial_connections/sessions  → client_secret
 *   tessera.collectFinancialConnectionsAccounts({ clientSecret })  (or /link-accounts/<secret>)
 *   the customer picks a test institution and accounts → session.accounts
 *
 * Test institutions are fictional. "Tessera Test Bank" links checking, savings and a credit
 * card; "Down Bank" is unavailable, so linking fails. Linked cash accounts use routing
 * 110000000 and can become us_bank_account payment methods.
 */

const PERMISSIONS = ['balances', 'ownership', 'payment_method', 'transactions'] as const;

type TestAccount = { key: string; display_name: string; category: 'cash' | 'credit'; subcategory: string; last4: string; available: number; current: number; number?: string };
export const INSTITUTIONS: { id: string; name: string; down?: boolean; accounts: TestAccount[] }[] = [
  {
    id: 'fcinst_tessera_test_bank', name: 'Tessera Test Bank', accounts: [
      { key: 'checking', display_name: 'Everyday Checking', category: 'cash', subcategory: 'checking', last4: '6789', available: 512_034, current: 528_034, number: '000123456789' },
      { key: 'savings', display_name: 'High-Yield Savings', category: 'cash', subcategory: 'savings', last4: '4321', available: 1_250_000, current: 1_250_000, number: '000987654321' },
      { key: 'credit', display_name: 'Rewards Credit Card', category: 'credit', subcategory: 'credit_card', last4: '1111', available: 467_500, current: -32_500 },
    ],
  },
  {
    id: 'fcinst_insufficient_funds_bank', name: 'Low Balance Credit Union', accounts: [
      { key: 'checking', display_name: 'Basic Checking', category: 'cash', subcategory: 'checking', last4: '2227', available: 1_250, current: 1_250, number: '000222222227' },
    ],
  },
  { id: 'fcinst_down_bank', name: 'Down Bank', down: true, accounts: [] },
];

const listOf = (data: any[], url: string) => ({ object: 'list', data, has_more: false, url });

function holderFrom(p: Params) {
  const h = p.account_holder;
  if (!h || typeof h !== 'object') throw missing('account_holder');
  if (h.type === 'customer') {
    if (!h.customer) throw missing('account_holder[customer]');
    return { customer: String(h.customer), type: 'customer' };
  }
  if (h.type === 'account') {
    if (!h.account) throw missing('account_holder[account]');
    return { account: String(h.account), type: 'account' };
  }
  throw invalid('account_holder[type] must be customer or account.', 'account_holder[type]');
}

export async function createSession(ctx: Ctx, p: Params) {
  const holder = holderFrom(p);
  if (holder.type === 'customer') await getObject(ctx.accountId, 'customer', holder.customer!, 'customer', 'account_holder[customer]');
  const permissions = (arr(p, 'permissions') ?? []).map(String);
  if (!permissions.length) throw missing('permissions');
  for (const x of permissions) if (!(PERMISSIONS as readonly string[]).includes(x)) throw invalid(`Invalid permission: ${x}. Use ${PERMISSIONS.join(', ')}.`, 'permissions');
  const prefetch = (arr(p, 'prefetch') ?? []).map(String);
  for (const x of prefetch) {
    if (!['balances', 'ownership', 'transactions'].includes(x)) throw invalid(`Invalid prefetch: ${x}.`, 'prefetch');
    if (!permissions.includes(x)) throw invalid(`You can only prefetch ${x} with the ${x} permission.`, 'prefetch');
  }
  const subs = (arr(p.filters && typeof p.filters === 'object' ? p.filters : {}, 'account_subcategories') ?? []).map(String);
  const id = newId('fcsess');
  const s = {
    id, object: 'financial_connections.session', account_holder: holder, accounts: listOf([], `/v1/financial_connections/accounts?session=${id}`),
    client_secret: `${id}_secret_${randomBytes(18).toString('base64url')}`, filters: { account_subcategories: subs.length ? subs : null, countries: ['US'] },
    livemode: false, permissions, prefetch, return_url: str(p, 'return_url') ?? null, created: nowSeconds(), _completed: false,
  };
  await insertObject(ctx.accountId, s);
  return s;
}

export async function getSession(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'financial_connections.session', id, 'session');
  const accts = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'financial_connections.account' AND data->>'_session' = $2 ORDER BY seq", [ctx.accountId, id]);
  s.accounts = listOf(accts.map((r) => r.data), s.accounts.url);
  return s;
}

/** Hosted flow: look up a session by its client secret. */
export async function sessionBySecret(secret: string) {
  const id = secret.split('_secret_')[0];
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE id = $1 AND type = 'financial_connections.session'", [id]);
  if (!row || row.data.client_secret !== secret) return null;
  return row;
}

export async function hostedView(secret: string) {
  const row = await sessionBySecret(secret);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
  const s = row.data;
  const merchant = await one<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [row.account_id]);
  const subs: string[] | null = s.filters.account_subcategories;
  return {
    merchant: merchant?.data.business_profile?.name ?? merchant?.data.settings?.dashboard?.display_name ?? 'This business',
    completed: s._completed, return_url: s.return_url, permissions: s.permissions,
    institutions: INSTITUTIONS.map((i) => ({ id: i.id, name: i.name, down: !!i.down, accounts: i.accounts.filter((a) => !subs || subs.includes(a.subcategory)).map((a) => ({ key: a.key, display_name: a.display_name, subcategory: a.subcategory, last4: a.last4 })) })),
  };
}

function balanceOf(t: TestAccount, now: number) {
  return t.category === 'cash'
    ? { as_of: now, cash: { available: { usd: t.available } }, current: { usd: t.current }, type: 'cash' }
    : { as_of: now, credit: { used: { usd: -t.current } }, current: { usd: t.current }, type: 'credit' };
}

function refreshState(now: number, id?: string) {
  return { ...(id ? { id } : {}), last_attempted_at: now, next_refresh_available_at: now + 60, status: 'succeeded' };
}

/** Hosted flow: the customer chose an institution and accounts. */
export async function completeSession(secret: string, institutionId: string, keys: string[]) {
  const row = await sessionBySecret(secret);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'This link is not valid.', { code: 'resource_missing' });
  const s = row.data;
  if (s._completed) throw new ApiError(400, 'invalid_request_error', 'These accounts are already linked. Return to the business to continue.', { code: 'session_completed' });
  const inst = INSTITUTIONS.find((i) => i.id === institutionId);
  if (!inst) throw invalid('Choose a bank.', 'institution');
  if (inst.down) throw new ApiError(503, 'api_error', `${inst.name} isn't responding right now. Try another bank or link your account manually.`, { code: 'institution_unavailable' });
  const chosen = inst.accounts.filter((a) => keys.includes(a.key));
  if (!chosen.length) throw invalid('Select at least one account.', 'accounts');
  const ctx = accountCtx(row.account_id);
  const now = nowSeconds();
  const owner = s.account_holder.customer ? (await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2 AND type = 'customer'", [row.account_id, s.account_holder.customer]))?.data : null;
  const created: any[] = [];
  for (const t of chosen) {
    const id = newId('fca');
    const fca: any = {
      id, object: 'financial_connections.account', account_holder: s.account_holder, balance: null, balance_refresh: null, category: t.category, created: now,
      display_name: t.display_name, institution_name: inst.name, last4: t.last4, livemode: false, ownership: null, ownership_refresh: null,
      permissions: s.permissions, status: 'active', subcategory: t.subcategory, subscriptions: [],
      supported_payment_method_types: t.category === 'cash' ? ['us_bank_account'] : [], transaction_refresh: null,
      _session: s.id, _institution: inst.id, _key: t.key, _account_number: t.number ?? null,
      _owner: { name: owner?.name ?? 'Jenny Rosen', email: owner?.email ?? 'jenny.rosen@example.com', phone: owner?.phone ?? '+15555550100' },
    };
    await insertObject(row.account_id, fca);
    if (s.prefetch.includes('balances')) applyBalance(fca, now);
    if (s.prefetch.includes('ownership')) await applyOwnership(row.account_id, fca, now);
    if (s.prefetch.includes('transactions')) await applyTransactions(row.account_id, fca, now);
    await saveObject(row.account_id, fca);
    await emit(ctx, 'financial_connections.account.created', fca);
    created.push(fca);
  }
  s._completed = true;
  await saveObject(row.account_id, s);
  return { accounts: created.map((a) => ({ id: a.id, display_name: a.display_name, last4: a.last4, institution_name: a.institution_name })), return_url: s.return_url, session: s.id };
}

function testAccountOf(fca: any) {
  return INSTITUTIONS.find((i) => i.id === fca._institution)!.accounts.find((a) => a.key === fca._key)!;
}

function applyBalance(fca: any, now: number) {
  fca.balance = balanceOf(testAccountOf(fca), now);
  fca.balance_refresh = refreshState(now);
}

async function applyOwnership(accountId: string, fca: any, now: number) {
  const ownership = newId('fcaowns');
  await insertObject(accountId, {
    id: newId('fcaown'), object: 'financial_connections.account_owner', created: now, livemode: false, email: fca._owner.email, name: fca._owner.name,
    ownership, phone: fca._owner.phone, raw_address: '510 Townsend St, San Francisco, CA 94103', refreshed_at: now, _account: fca.id,
  } as any);
  fca.ownership = ownership;
  fca.ownership_refresh = { last_attempted_at: now, next_refresh_available_at: now + 60, status: 'succeeded' };
}

const MERCHANTS = ['Payroll deposit', 'Coffee roaster wholesale', 'Electric utility', 'Office rent', 'Card processing payout', 'Shipping labels', 'Cloud hosting', 'Grocery market', 'Insurance premium', 'Refund from supplier', 'Phone service', 'Equipment lease'];

/** Deterministic transactions per account, generated for the last 30 days at each refresh. */
async function applyTransactions(accountId: string, fca: any, now: number) {
  const refresh = newId('fctxnref');
  const seed = createHash('sha256').update(fca.id).digest();
  const existing = new Set((await query<{ id: string }>("SELECT data->>'_key' AS id FROM objects WHERE account_id = $1 AND type = 'financial_connections.transaction' AND data->>'account' = $2", [accountId, fca.id])).map((r) => r.id));
  for (let i = 0; i < 12; i++) {
    const day = Math.floor(now / 86400) - i * 2 - (seed[i]! % 2);
    const key = `${day}-${i % 4}`;
    if (existing.has(key)) continue;
    const b = seed[(i * 3) % 32]!;
    const inflow = MERCHANTS[b % MERCHANTS.length]!.startsWith('Payroll') || MERCHANTS[b % MERCHANTS.length]!.startsWith('Refund') || MERCHANTS[b % MERCHANTS.length]!.startsWith('Card processing');
    const amount = (inflow ? 1 : -1) * (500 + b * 137 + i * 211);
    const at = day * 86400 + 36_000 + i * 600;
    const pending = i === 0;
    await insertObject(accountId, {
      id: newId('fctxn'), object: 'financial_connections.transaction', account: fca.id, amount: fca.category === 'credit' ? -Math.abs(amount) : amount, currency: 'usd',
      description: MERCHANTS[b % MERCHANTS.length], livemode: false, status: pending ? 'pending' : 'posted', status_transitions: { posted_at: pending ? null : at + 3600, void_at: null },
      transacted_at: at, transaction_refresh: refresh, updated: now, created: at, _key: key,
    } as any);
  }
  fca.transaction_refresh = refreshState(now, refresh);
}

export async function getAccount(ctx: Ctx, id: string) {
  return getObject<any>(ctx.accountId, 'financial_connections.account', id, 'financial_connections.account');
}

export async function listAccounts(ctx: Ctx, p: Params) {
  const h = p.account_holder ?? {};
  const filters: { field: string; value: string }[] = [];
  if (h.customer) filters.push({ field: 'account_holder.customer', value: String(h.customer) });
  if (h.account) filters.push({ field: 'account_holder.account', value: String(h.account) });
  if (p.session) filters.push({ field: '_session', value: String(p.session) });
  // account_holder.customer is nested: filter in memory after a wide page.
  const list = await listObjects(ctx.accountId, 'financial_connections.account', '/v1/financial_connections/accounts', { ...p, limit: 100 }, filters.filter((f) => !f.field.includes('.')));
  let data = list.data as any[];
  for (const f of filters.filter((x) => x.field.includes('.'))) data = data.filter((a) => a.account_holder?.[f.field.split('.')[1]!] === f.value);
  const limit = Number(p.limit ?? 10);
  return { ...list, data: data.slice(0, limit), has_more: list.has_more || data.length > limit };
}

function needActive(fca: any) {
  if (fca.status !== 'active') throw new ApiError(400, 'invalid_request_error', `This account is ${fca.status}. Ask the customer to link it again.`, { code: 'account_inactive' });
}
function needPermission(fca: any, perm: string, param = 'features') {
  if (!fca.permissions.includes(perm)) throw invalid(`The customer didn't grant the ${perm} permission for this account. Create a new session that requests it.`, param, 'permission_missing');
}

export async function refreshAccount(ctx: Ctx, id: string, p: Params) {
  const fca = await getAccount(ctx, id);
  needActive(fca);
  const features = (arr(p, 'features') ?? []).map(String);
  if (!features.length) throw missing('features');
  const now = nowSeconds();
  for (const f of features) {
    if (f === 'balance') { needPermission(fca, 'balances'); applyBalance(fca, now); }
    else if (f === 'ownership') { needPermission(fca, 'ownership'); await applyOwnership(ctx.accountId, fca, now); }
    else if (f === 'transactions') { needPermission(fca, 'transactions'); await applyTransactions(ctx.accountId, fca, now); }
    else throw invalid(`Invalid feature: ${f}. Use balance, ownership or transactions.`, 'features');
  }
  await saveObject(ctx.accountId, fca);
  for (const f of features) await emit(ctx, `financial_connections.account.refreshed_${f === 'balance' ? 'balance' : f}`, fca);
  return fca;
}

export async function disconnectAccount(ctx: Ctx, id: string) {
  const fca = await getAccount(ctx, id);
  if (fca.status === 'disconnected') return fca;
  fca.status = 'disconnected';
  fca.subscriptions = [];
  await saveObject(ctx.accountId, fca);
  await emit(ctx, 'financial_connections.account.disconnected', fca);
  return fca;
}

export async function setSubscription(ctx: Ctx, id: string, p: Params, on: boolean) {
  const fca = await getAccount(ctx, id);
  needActive(fca);
  const features = (arr(p, 'features') ?? []).map(String);
  if (!features.length) throw missing('features');
  for (const f of features) {
    if (f !== 'transactions') throw invalid('Only transactions can be subscribed to.', 'features');
    needPermission(fca, 'transactions');
  }
  fca.subscriptions = on ? ['transactions'] : [];
  if (on) await applyTransactions(ctx.accountId, fca, nowSeconds());
  await saveObject(ctx.accountId, fca);
  return fca;
}

export async function listOwners(ctx: Ctx, id: string, p: Params) {
  const fca = await getAccount(ctx, id);
  const ownership = str(p, 'ownership', { required: true })!;
  if (ownership !== fca.ownership) throw invalid(`No such ownership: '${ownership}'`, 'ownership', 'resource_missing');
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'financial_connections.account_owner' AND data->>'ownership' = $2", [ctx.accountId, ownership]);
  return listOf(rows.map((r) => r.data), `/v1/financial_connections/accounts/${id}/owners`);
}

export async function listTransactions(ctx: Ctx, p: Params) {
  const account = str(p, 'account', { required: true })!;
  const fca = await getAccount(ctx, account);
  needPermission(fca, 'transactions', 'account');
  const list = await listObjects(ctx.accountId, 'financial_connections.transaction', '/v1/financial_connections/transactions', p, [{ field: 'account', value: account }]);
  return list;
}

/** For us_bank_account payment methods created from a linked account. */
export async function bankDetailsFor(ctx: Ctx, id: string) {
  const fca = await getAccount(ctx, id);
  needActive(fca);
  needPermission(fca, 'payment_method', 'us_bank_account[financial_connections_account]');
  if (!fca.supported_payment_method_types.includes('us_bank_account')) throw invalid('This account (a credit card) cannot be used for bank payments.', 'us_bank_account[financial_connections_account]');
  return { routing: '110000000', number: fca._account_number as string, subcategory: fca.subcategory, owner: fca._owner?.name as string, institution: fca.institution_name as string };
}
