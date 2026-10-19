import { PGlite } from '@electric-sql/pglite';
import { query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import type { Ctx } from '../platform/context.ts';

/**
 * SQL over your own data (Sigma-style). Each query runs against a fresh in-memory Postgres
 * that holds only the calling account's objects, so arbitrary SQL can't reach other
 * accounts or change anything. Objects are flattened into one table per type:
 *
 *   - scalar fields become columns (bigint / numeric / boolean / text)
 *   - references to other objects are named `<field>_id` (charges.customer_id, ...)
 *   - nested objects and arrays become jsonb (billing_details->>'email')
 *   - unix timestamps (created, *_at, available_on, arrival_date, ...) become timestamptz
 *
 * Results are capped at MAX_ROWS rows.
 */

export const MAX_ROWS = 1000;
const MAX_SQL = 20_000;

/** table name → object type */
export const TABLES: Record<string, string> = {
  balance_transactions: 'balance_transaction',
  charges: 'charge',
  coupons: 'coupon',
  customers: 'customer',
  disputes: 'dispute',
  invoices: 'invoice',
  payment_intents: 'payment_intent',
  payouts: 'payout',
  prices: 'price',
  products: 'product',
  refunds: 'refund',
  subscriptions: 'subscription',
  transfers: 'transfer',
};

const REFS = new Set([
  'customer', 'payment_intent', 'charge', 'invoice', 'subscription', 'balance_transaction', 'product', 'price', 'payment_method',
  'destination', 'source_transaction', 'transfer', 'payout', 'refund', 'dispute', 'coupon', 'on_behalf_of', 'application_fee',
  'latest_charge', 'latest_invoice', 'default_payment_method', 'source', 'failure_balance_transaction', 'destination_payment',
  'test_clock', 'schedule', 'review', 'quote', 'setup_intent', 'mandate',
]);
const TIME = /^(created|available_on|arrival_date|due_date|period_start|period_end|start_date|ended_at|canceled_at|trial_start|trial_end|current_period_start|current_period_end|billing_cycle_anchor|cancel_at|effective_at|finalized_at|paid_at|redeem_by|succeeded_at|expires_at)$/;

type ColType = 'bigint' | 'numeric' | 'boolean' | 'text' | 'jsonb' | 'timestamptz';
type Column = { name: string; source: string; type: ColType };

function columnsFor(docs: any[]): Column[] {
  const kinds = new Map<string, Set<string>>();
  for (const d of docs) {
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('_') || k === 'object') continue;
      const set = kinds.get(k) ?? new Set<string>();
      if (v === null || v === undefined) set.add('null');
      else if (Array.isArray(v) || typeof v === 'object') set.add('json');
      else if (typeof v === 'number') set.add(Number.isInteger(v) ? 'int' : 'num');
      else set.add(typeof v);
      kinds.set(k, set);
    }
  }
  const cols: Column[] = [];
  for (const [k, set] of kinds) {
    set.delete('null');
    let type: ColType = 'text';
    if (set.has('json')) type = 'jsonb';
    else if (set.size === 1 && set.has('int')) type = TIME.test(k) ? 'timestamptz' : 'bigint';
    else if ([...set].every((x) => x === 'int' || x === 'num') && set.size) type = 'numeric';
    else if (set.size === 1 && set.has('boolean')) type = 'boolean';
    const name = REFS.has(k) && type === 'text' ? `${k}_id` : k;
    cols.push({ name, source: k, type });
  }
  cols.sort((a, b) => (a.name === 'id' ? -1 : b.name === 'id' ? 1 : a.name === 'created' ? -1 : b.name === 'created' ? 1 : a.name.localeCompare(b.name)));
  return cols;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function cell(v: any, type: ColType) {
  if (v === null || v === undefined) return null;
  if (type === 'jsonb') return JSON.stringify(v);
  if (type === 'timestamptz') return new Date(Number(v) * 1000).toISOString();
  if (type === 'text' && typeof v !== 'string') return typeof v === 'object' ? JSON.stringify(v) : String(v);
  return v;
}

async function snapshot(accountId: string) {
  const db = new PGlite();
  const schema: { table: string; columns: { name: string; type: ColType }[]; rows: number }[] = [];
  for (const [table, type] of Object.entries(TABLES)) {
    const rows = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = $2 AND coalesce(data->>'deleted', 'false') <> 'true' ORDER BY seq", [accountId, type]);
    const docs = rows.map((r) => r.data);
    const cols = docs.length ? columnsFor(docs) : [{ name: 'id', source: 'id', type: 'text' as ColType }, { name: 'created', source: 'created', type: 'timestamptz' as ColType }];
    await db.exec(`CREATE TABLE ${table} (${cols.map((c) => `${q(c.name)} ${c.type}`).join(', ')})`);
    for (let i = 0; i < docs.length; i += 200) {
      const chunk = docs.slice(i, i + 200);
      const args: any[] = [];
      const values = chunk.map((d) => `(${cols.map((c) => { args.push(cell(d[c.source], c.type)); return `$${args.length}`; }).join(', ')})`);
      await db.query(`INSERT INTO ${table} (${cols.map((c) => q(c.name)).join(', ')}) VALUES ${values.join(', ')}`, args);
    }
    schema.push({ table, columns: cols.map(({ name, type: t }) => ({ name, type: t })), rows: docs.length });
  }
  return { db, schema };
}

export async function sigmaSchema(ctx: Ctx) {
  const { db, schema } = await snapshot(ctx.accountId);
  await db.close();
  return { object: 'list', data: schema };
}

const jsonable = (v: any): any => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`;
  return v;
};

export async function runQuery(ctx: Ctx, sql: string) {
  if (typeof sql !== 'string' || !sql.trim()) throw invalid('Missing required param: sql.', 'sql', 'parameter_missing');
  if (sql.length > MAX_SQL) throw invalid(`Queries can be at most ${MAX_SQL} characters.`, 'sql');
  const started = performance.now();
  const { db } = await snapshot(ctx.accountId);
  const loaded = performance.now();
  try {
    // The extended protocol runs exactly one statement, so "SELECT 1; DROP ..." is rejected.
    const res = await db.query<any>(sql.trim().replace(/;\s*$/, ''), [], { rowMode: 'array' });
    const columns = res.fields.map((f) => f.name);
    const truncated = res.rows.length > MAX_ROWS;
    // numeric (1700) arrives as a string; show it as a number when that is lossless enough.
    const numericCols = res.fields.map((f) => f.dataTypeID === 1700);
    const rows = res.rows.slice(0, MAX_ROWS).map((r: any[]) => r.map((v, i) => {
      if (numericCols[i] && typeof v === 'string' && Number.isFinite(Number(v)) && Math.abs(Number(v)) < 2 ** 53) return Number(v);
      return jsonable(v);
    }));
    return {
      object: 'sigma.query_result',
      columns,
      rows,
      row_count: rows.length,
      truncated,
      elapsed_ms: Math.round(performance.now() - loaded),
      snapshot_ms: Math.round(loaded - started),
    };
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    const pos = e?.position ? ` (at character ${e.position})` : '';
    throw new ApiError(400, 'invalid_request_error', `${String(e?.message ?? e)}${pos}`, { code: 'sql_error', param: 'sql' });
  } finally {
    await db.close();
  }
}

/** Starter queries for the dashboard editor. */
export const TEMPLATES = [
  { name: 'Gross volume by day', sql: "SELECT date_trunc('day', created)::date AS day, count(*) AS charges, sum(amount) / 100.0 AS gross\nFROM charges\nWHERE status = 'succeeded'\nGROUP BY 1\nORDER BY 1 DESC" },
  { name: 'Top customers by spend', sql: "SELECT c.id, c.email, count(ch.id) AS payments, sum(ch.amount - ch.amount_refunded) / 100.0 AS net_spend\nFROM customers c\nJOIN charges ch ON ch.customer_id = c.id AND ch.status = 'succeeded'\nGROUP BY c.id, c.email\nORDER BY net_spend DESC\nLIMIT 20" },
  { name: 'Fees and net by type', sql: "SELECT type, count(*) AS n, sum(amount) / 100.0 AS amount, sum(fee) / 100.0 AS fees, sum(net) / 100.0 AS net\nFROM balance_transactions\nGROUP BY type\nORDER BY n DESC" },
  { name: 'Card brands', sql: "SELECT payment_method_details->'card'->>'brand' AS brand, count(*) AS charges,\n       round(100.0 * avg(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 1) AS success_rate\nFROM charges\nGROUP BY 1\nORDER BY 2 DESC" },
  { name: 'Subscriptions by status', sql: "SELECT status, count(*) AS subscriptions\nFROM subscriptions\nGROUP BY status\nORDER BY 2 DESC" },
  { name: 'Open invoices', sql: "SELECT id, customer_id, amount_due / 100.0 AS amount_due, due_date, status\nFROM invoices\nWHERE status = 'open'\nORDER BY created DESC" },
  { name: 'Refund rate by month', sql: "SELECT date_trunc('month', created)::date AS month,\n       sum(amount) / 100.0 AS charged, sum(amount_refunded) / 100.0 AS refunded,\n       round(100.0 * sum(amount_refunded) / nullif(sum(amount), 0), 2) AS refund_pct\nFROM charges WHERE status = 'succeeded'\nGROUP BY 1 ORDER BY 1 DESC" },
];
