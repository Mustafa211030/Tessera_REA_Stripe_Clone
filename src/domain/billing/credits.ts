import { query } from '../../db/index.ts';
import { invalid, missing } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { currency, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { emit } from '../events.ts';
import { findObject, getObject, insertObject, listObjects, saveObject } from '../store.ts';
import { clockTime } from './clocks.ts';

/**
 * Billing credits: prepaid or promotional credit a customer can spend on usage-based
 * (metered) charges.
 *
 *  - A credit grant gives a customer an amount of credit in one currency, optionally from a
 *    start date (effective_at) until an end date (expires_at), with a priority (lower is used
 *    first; then the grant that expires soonest).
 *  - When an invoice is finalized, available credit is applied to its metered lines before tax,
 *    so tax is charged on what is left. Each use is a debit credit balance transaction; the
 *    invoice lists them in total_pretax_credit_amounts and on each line.
 *  - Voiding the invoice gives the credit back (a credit transaction). Voiding or expiring a
 *    grant removes what was left on it.
 */
const money = (value: number, cur: string) => ({ monetary: { currency: cur, value }, type: 'monetary' });

export async function createGrant(ctx: Ctx, p: Params) {
  const customer = str(p, 'customer');
  if (!customer) throw missing('customer');
  const c = await getObject<any>(ctx.accountId, 'customer', customer, 'customer', 'customer');
  const amt = p.amount;
  if (!amt || typeof amt !== 'object') throw missing('amount');
  if ((amt.type ?? 'monetary') !== 'monetary') throw invalid('amount[type] must be monetary.', 'amount[type]');
  const m = amt.monetary ?? {};
  const cur = currency(m, 'currency', true)!;
  const value = int(m, 'value', { required: true, min: 1, max: 100_000_000 })!;
  const scope = p.applicability_config?.scope?.price_type ?? 'metered';
  if (scope !== 'metered') throw invalid("applicability_config[scope][price_type] must be 'metered'.", 'applicability_config[scope][price_type]');
  const now = await clockTime(ctx.accountId, c.test_clock ?? null);
  const effective_at = p.effective_at !== undefined ? int(p, 'effective_at', { min: 0 })! : now;
  const expires_at = p.expires_at !== undefined && p.expires_at !== '' ? int(p, 'expires_at', { min: 0 })! : null;
  if (expires_at !== null && expires_at <= effective_at) throw invalid('expires_at must be after effective_at.', 'expires_at');
  const g = {
    id: newId('credgr', 20), object: 'billing.credit_grant', amount: money(value, cur), applicability_config: { scope: { price_type: 'metered' } },
    category: oneOf(p, 'category', ['paid', 'promotional'] as const, 'paid')!, created: now, customer, effective_at, expires_at, livemode: false, metadata: metadata(p),
    name: str(p, 'name', { max: 100 }) ?? null, priority: int(p, 'priority', { min: 0, max: 100 }) ?? 50, test_clock: c.test_clock ?? null, updated: now, voided_at: null as number | null,
  };
  await insertObject(ctx.accountId, g);
  const t = await transaction(ctx, g, 'credit', value, { type: 'credits_granted' }, g.effective_at);
  await emit(ctx, 'billing.credit_grant.created', g);
  await emit(ctx, 'billing.credit_balance_transaction.created', t);
  return g;
}

async function transaction(ctx: Ctx, g: any, type: 'credit' | 'debit', value: number, detail: any, at: number) {
  const t = {
    id: newId('cbtxn', 20), object: 'billing.credit_balance_transaction', created: at, effective_at: at, livemode: false, test_clock: g.test_clock ?? null, type,
    credit: type === 'credit' ? { amount: money(value, g.amount.monetary.currency), ...detail } : null,
    debit: type === 'debit' ? { amount: money(value, g.amount.monetary.currency), ...detail } : null,
    credit_grant: g.id, _customer: g.customer,
  };
  await insertObject(ctx.accountId, t);
  return t;
}

async function transactionsOf(accountId: string, grantId: string) {
  return (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'billing.credit_balance_transaction' AND data->>'credit_grant' = $2 ORDER BY seq", [accountId, grantId])).map((r) => r.data);
}

/** What is left on a grant: credits granted or given back, minus credits used or removed. */
export async function remaining(accountId: string, g: any) {
  let left = 0;
  for (const t of await transactionsOf(accountId, g.id)) left += t.type === 'credit' ? t.credit.amount.monetary.value : -t.debit.amount.monetary.value;
  return left;
}

const usable = (g: any, now: number) => !g.voided_at && g.effective_at <= now && (g.expires_at === null || g.expires_at > now);

export async function getGrant(ctx: Ctx, id: string) {
  return getObject<any>(ctx.accountId, 'billing.credit_grant', id, 'credit grant');
}

export async function listGrants(ctx: Ctx, p: Params) {
  const filters = p.customer ? [{ field: 'customer', value: String(p.customer) }] : [];
  return listObjects(ctx.accountId, 'billing.credit_grant', '/v1/billing/credit_grants', p, filters);
}

export async function updateGrant(ctx: Ctx, id: string, p: Params) {
  const g = await getGrant(ctx, id);
  if (p.expires_at !== undefined) {
    const v = p.expires_at === '' ? null : int(p, 'expires_at', { min: 0 })!;
    if (v !== null && v <= g.effective_at) throw invalid('expires_at must be after effective_at.', 'expires_at');
    g.expires_at = v;
  }
  if (p.metadata !== undefined) g.metadata = metadata(p, g.metadata);
  g.updated = await clockTime(ctx.accountId, g.test_clock);
  await saveObject(ctx.accountId, g);
  await emit(ctx, 'billing.credit_grant.updated', g);
  return g;
}

/** Void (or expire now): whatever is left on the grant can no longer be used. */
export async function endGrant(ctx: Ctx, id: string, how: 'void' | 'expire') {
  const g = await getGrant(ctx, id);
  if (g.voided_at) throw invalid('This credit grant has already been voided.', 'id', 'credit_grant_voided');
  const now = await clockTime(ctx.accountId, g.test_clock);
  if (how === 'expire' && g.expires_at !== null && g.expires_at <= now) throw invalid('This credit grant has already expired.', 'id', 'credit_grant_expired');
  const left = await remaining(ctx.accountId, g);
  if (how === 'void') g.voided_at = now; else g.expires_at = now;
  g.updated = now;
  await saveObject(ctx.accountId, g);
  if (left > 0) {
    const t = await transaction(ctx, g, 'debit', left, { type: how === 'void' ? 'credits_voided' : 'credits_expired' }, now);
    await emit(ctx, 'billing.credit_balance_transaction.created', t);
  }
  await emit(ctx, 'billing.credit_grant.updated', g);
  return g;
}

export async function balanceSummary(ctx: Ctx, p: Params) {
  const customer = str(p, 'customer');
  if (!customer) throw missing('customer');
  const c = await getObject<any>(ctx.accountId, 'customer', customer, 'customer', 'customer');
  if (p.filter && (p.filter.type ?? 'applicability_scope') !== 'applicability_scope' && p.filter.type !== 'credit_grant') throw invalid('filter[type] must be applicability_scope or credit_grant.', 'filter[type]');
  const now = await clockTime(ctx.accountId, c.test_clock ?? null);
  const grants = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'billing.credit_grant' AND data->>'customer' = $2", [ctx.accountId, customer])).map((r) => r.data)
    .filter((g) => !p.filter?.credit_grant || g.id === p.filter.credit_grant);
  const by = new Map<string, { available: number; ledger: number }>();
  for (const g of grants) {
    if (g.voided_at || (g.expires_at !== null && g.expires_at <= now)) continue;
    const cur = g.amount.monetary.currency;
    const left = await remaining(ctx.accountId, g);
    const b = by.get(cur) ?? { available: 0, ledger: 0 };
    b.ledger += left;
    if (usable(g, now)) b.available += left;
    by.set(cur, b);
  }
  return {
    object: 'billing.credit_balance_summary', customer, livemode: false,
    balances: [...by.entries()].map(([cur, b]) => ({ available_balance: money(b.available, cur), ledger_balance: money(b.ledger, cur) })),
  };
}

export async function listTransactions(ctx: Ctx, p: Params) {
  const filters = [];
  if (p.credit_grant) filters.push({ field: 'credit_grant', value: String(p.credit_grant) });
  else if (p.customer) filters.push({ field: '_customer', value: String(p.customer) });
  else throw missing('customer');
  return listObjects(ctx.accountId, 'billing.credit_balance_transaction', '/v1/billing/credit_balance_transactions', p, filters);
}

export async function getTransaction(ctx: Ctx, id: string) {
  return getObject<any>(ctx.accountId, 'billing.credit_balance_transaction', id, 'credit balance transaction');
}

// ---------------------------------------------------------------- invoices

/**
 * At finalization: spends the customer's usable credit on the invoice's metered lines.
 * Sets inv._credit_alloc (line id → amount) for the totals, which are recomputed after.
 */
export async function applyCredits(ctx: Ctx, inv: any, now: number) {
  if (inv._credit_alloc) return;
  const metered: { line: any; room: number }[] = [];
  for (const l of inv.lines.data) {
    if (l.amount <= 0 || !l.price) continue;
    const price = typeof l.price === 'string' ? await findObject<any>(ctx.accountId, 'price', l.price) : l.price;
    if (price?.recurring?.usage_type === 'metered') metered.push({ line: l, room: l.amount - (l.discount_amounts ?? []).reduce((s: number, d: any) => s + d.amount, 0) });
  }
  if (!metered.length) return;
  const grants = (await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'billing.credit_grant' AND data->>'customer' = $2", [ctx.accountId, inv.customer])).map((r) => r.data)
    .filter((g) => usable(g, now) && g.amount.monetary.currency === inv.currency)
    .sort((a, b) => a.priority - b.priority || (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity) || a.created - b.created);
  const alloc: Record<string, number> = {};
  const applied: any[] = [];
  for (const g of grants) {
    let left = await remaining(ctx.accountId, g);
    for (const m of metered) {
      if (left <= 0) break;
      const use = Math.min(left, m.room);
      if (use <= 0) continue;
      m.room -= use;
      left -= use;
      alloc[m.line.id] = (alloc[m.line.id] ?? 0) + use;
      const t = await transaction(ctx, g, 'debit', use, { credits_applied: { invoice: inv.id, invoice_line_item: m.line.id }, type: 'credits_applied' }, now);
      applied.push({ amount: use, credit_balance_transaction: t.id, type: 'credit_balance_transaction', _line: m.line.id });
      await emit(ctx, 'billing.credit_balance_transaction.created', t);
    }
  }
  if (!applied.length) return;
  inv._credit_alloc = alloc;
  inv.total_pretax_credit_amounts = applied.map(({ _line, ...a }) => a);
  for (const l of inv.lines.data) l.pretax_credit_amounts = applied.filter((a) => a._line === l.id).map(({ _line, ...a }) => a);
}

/** Voiding an invoice gives back the credit it used. */
export async function reinstateCredits(ctx: Ctx, inv: any, now: number) {
  for (const a of inv.total_pretax_credit_amounts ?? []) {
    const used = await findObject<any>(ctx.accountId, 'billing.credit_balance_transaction', a.credit_balance_transaction);
    if (!used) continue;
    const g = await findObject<any>(ctx.accountId, 'billing.credit_grant', used.credit_grant);
    if (!g) continue;
    const t = await transaction(ctx, g, 'credit', a.amount, { credits_application_invoice_voided: { invoice: inv.id, invoice_line_item: used.debit.credits_applied.invoice_line_item }, type: 'credits_application_invoice_voided' }, now);
    await emit(ctx, 'billing.credit_balance_transaction.created', t);
  }
}
