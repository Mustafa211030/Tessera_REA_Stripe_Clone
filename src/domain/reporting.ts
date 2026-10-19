import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { int, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { getAccount } from './accounts.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { getObject, insertObject, saveObject } from './store.ts';
import { REVREC_REPORTS, reportRows } from './revrec.ts';

/**
 * Financial reports, computed from balance transactions (themselves backed by the ledger).
 *
 * A report run is created as `pending`; the worker computes it and attaches a CSV `file`
 * (purpose finance_report_run) whose contents are downloaded from /v1/files/:id/contents.
 * Amounts are in major units, as in the published report schemas. Time is UTC, and the
 * balance reports use each transaction's available_on (the available balance).
 */

type Txn = { id: string; created: number; available_on: number; currency: string; amount: number; fee: number; net: number; reporting_category: string; source: string; description: string | null; type: string; status: string };

const ITEMIZED_COLUMNS = ['balance_transaction_id', 'created_utc', 'available_on_utc', 'currency', 'gross', 'fee', 'net', 'reporting_category', 'source_id', 'description'];
const PAYOUT_COLUMNS = ['payout_id', 'effective_at_utc', 'currency', 'gross', 'fee', 'net', 'reporting_category', 'balance_transaction_id', 'description', 'payout_expected_arrival_date', 'payout_status', 'payout_type', 'payout_destination_id'];

export const REPORT_TYPES: Record<string, { name: string; columns: string[] }> = {
  'balance.summary.1': { name: 'Balance summary', columns: ['category', 'description', 'net_amount', 'currency'] },
  'balance_change_from_activity.itemized.1': { name: 'Balance change from activity', columns: ITEMIZED_COLUMNS },
  'payouts.summary.1': { name: 'Payouts summary', columns: ['category', 'description', 'net_amount', 'currency'] },
  'payouts.itemized.1': { name: 'Itemized payouts', columns: PAYOUT_COLUMNS },
  ...REVREC_REPORTS,
};

const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp']);
const major = (minor: number, cur: string) => (ZERO_DECIMAL.has(cur) ? String(minor) : (minor / 100).toFixed(2));
const iso = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19);
const PAYOUT_CATEGORIES = new Set(['payout', 'payout_reversal']);

async function availability(accountId: string) {
  const acct = await getAccount(accountId);
  const first = await one<{ t: number | null }>("SELECT min((data->>'available_on')::bigint) AS t FROM objects WHERE account_id = $1 AND type = 'balance_transaction'", [accountId]);
  const start = Math.min(acct?.created ?? nowSeconds(), Number(first?.t ?? Infinity));
  return { start, end: nowSeconds() };
}

export async function listReportTypes(ctx: Ctx) {
  const a = await availability(ctx.accountId);
  return {
    object: 'list',
    url: '/v1/reporting/report_types',
    has_more: false,
    data: Object.entries(REPORT_TYPES).map(([id, t]) => ({
      id, object: 'reporting.report_type', data_available_end: a.end, data_available_start: a.start, default_columns: t.columns,
      livemode: false, name: t.name, updated: a.end, version: 1,
    })),
  };
}

export async function getReportType(ctx: Ctx, id: string) {
  const all = await listReportTypes(ctx);
  const t = all.data.find((x) => x.id === id);
  if (!t) throw invalid(`No such report type: '${id}'`, 'id', 'resource_missing');
  return t;
}

export async function createReportRun(ctx: Ctx, p: Params) {
  const type = str(p, 'report_type', { required: true })!;
  const def = REPORT_TYPES[type];
  if (!def) throw invalid(`Unknown report type: ${type}. Supported: ${Object.keys(REPORT_TYPES).join(', ')}.`, 'report_type');
  const params = p.parameters ?? {};
  const avail = await availability(ctx.accountId);
  const start = int(params, 'interval_start') ?? avail.start;
  const end = int(params, 'interval_end') ?? avail.end;
  if (params.interval_start === undefined && params.interval_end === undefined && type.startsWith('balance.summary')) {
    // Summary reports need an explicit window on the public API.
    throw missing('parameters[interval_start]');
  }
  if (end <= start) throw invalid('parameters[interval_end] must be after parameters[interval_start].', 'parameters[interval_end]');
  if (end > avail.end) throw invalid(`parameters[interval_end] must be at most data_available_end (${avail.end}).`, 'parameters[interval_end]');
  const columns = params.columns ? (Array.isArray(params.columns) ? params.columns : Object.values(params.columns)).map(String) : undefined;
  if (columns) for (const c of columns) if (!def.columns.includes(c)) throw invalid(`Unknown column '${c}' for ${type}. Available: ${def.columns.join(', ')}.`, 'parameters[columns]');
  const run = {
    id: newId('frr'),
    object: 'reporting.report_run',
    created: nowSeconds(),
    error: null as string | null,
    livemode: false,
    parameters: {
      interval_start: start,
      interval_end: end,
      ...(columns ? { columns } : {}),
      ...(params.currency ? { currency: String(params.currency).toLowerCase() } : {}),
      ...(params.reporting_category ? { reporting_category: String(params.reporting_category) } : {}),
      timezone: 'Etc/UTC',
    },
    report_type: type,
    result: null as any,
    status: 'pending',
    succeeded_at: null as number | null,
    _base_url: ctx.baseUrl,
  };
  await insertObject(ctx.accountId, run);
  return run;
}

async function txnsFor(accountId: string, end: number, currency?: string) {
  const rows = await query<{ data: Txn }>(
    "SELECT data FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND (data->>'available_on')::bigint < $2 ORDER BY (data->>'available_on')::bigint, seq",
    [accountId, end],
  );
  return rows.map((r) => r.data).filter((t) => !currency || t.currency === currency);
}

function csv(columns: string[], rows: Record<string, unknown>[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Computes one report run's rows. Exported for tests and the dashboard. */
export async function computeReport(accountId: string, type: string, params: any) {
  if (type.startsWith('revenue_recognition.')) return reportRows(accountId, type, params);
  const { interval_start: start, interval_end: end, currency, reporting_category } = params;
  const all = await txnsFor(accountId, end, currency);
  const inWindow = all.filter((t) => t.available_on >= start && (!reporting_category || t.reporting_category === reporting_category));
  const currencies = [...new Set(all.map((t) => t.currency))].sort();
  if (!currencies.length) currencies.push(currency ?? 'usd');
  const rows: Record<string, unknown>[] = [];

  if (type === 'balance.summary.1') {
    for (const cur of currencies) {
      const before = all.filter((t) => t.currency === cur && t.available_on < start);
      const win = inWindow.filter((t) => t.currency === cur);
      const activity = win.filter((t) => !PAYOUT_CATEGORIES.has(t.reporting_category));
      const payouts = win.filter((t) => PAYOUT_CATEGORIES.has(t.reporting_category));
      const sum = (xs: Txn[], k: 'amount' | 'fee' | 'net') => xs.reduce((s, t) => s + t[k], 0);
      const starting = sum(before, 'net');
      const ending = starting + sum(win, 'net');
      rows.push(
        { category: 'starting_balance', description: 'Starting balance', net_amount: major(starting, cur), currency: cur },
        { category: 'activity_gross', description: 'Activity before fees', net_amount: major(sum(activity, 'amount'), cur), currency: cur },
        { category: 'activity_fee', description: 'Less fees', net_amount: major(-sum(activity, 'fee'), cur), currency: cur },
        { category: 'activity', description: 'Net balance change from activity', net_amount: major(sum(activity, 'net'), cur), currency: cur },
        { category: 'payouts', description: 'Total payouts', net_amount: major(sum(payouts, 'net'), cur), currency: cur },
        { category: 'ending_balance', description: 'Ending balance', net_amount: major(ending, cur), currency: cur },
      );
    }
  } else if (type === 'balance_change_from_activity.itemized.1') {
    for (const t of inWindow.filter((x) => !PAYOUT_CATEGORIES.has(x.reporting_category))) {
      rows.push({ balance_transaction_id: t.id, created_utc: iso(t.created), available_on_utc: iso(t.available_on), currency: t.currency, gross: major(t.amount, t.currency), fee: major(t.fee, t.currency), net: major(t.net, t.currency), reporting_category: t.reporting_category, source_id: t.source, description: t.description ?? '' });
    }
  } else if (type === 'payouts.summary.1') {
    for (const cur of currencies) {
      const win = inWindow.filter((t) => t.currency === cur);
      const paid = win.filter((t) => t.reporting_category === 'payout');
      const rev = win.filter((t) => t.reporting_category === 'payout_reversal');
      const total = (xs: Txn[]) => xs.reduce((s, t) => s + t.net, 0);
      rows.push(
        { category: 'payout', description: `Payouts (${paid.length})`, net_amount: major(total(paid), cur), currency: cur },
        { category: 'payout_reversal', description: `Payout reversals (${rev.length})`, net_amount: major(total(rev), cur), currency: cur },
        { category: 'total', description: 'Net payouts', net_amount: major(total(paid) + total(rev), cur), currency: cur },
      );
    }
  } else if (type === 'payouts.itemized.1') {
    for (const t of inWindow.filter((x) => PAYOUT_CATEGORIES.has(x.reporting_category))) {
      const po = (await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2 AND type = 'payout'", [accountId, t.source]))?.data;
      rows.push({
        payout_id: t.source, effective_at_utc: iso(t.available_on), currency: t.currency, gross: major(t.amount, t.currency), fee: major(t.fee, t.currency), net: major(t.net, t.currency),
        reporting_category: t.reporting_category, balance_transaction_id: t.id, description: t.description ?? '',
        payout_expected_arrival_date: po ? new Date(po.arrival_date * 1000).toISOString().slice(0, 10) : '', payout_status: po?.status ?? '', payout_type: po?.type ?? '', payout_destination_id: po?.destination ?? '',
      });
    }
  }
  return rows;
}

/** Worker: completes pending report runs. */
export async function processReportRuns() {
  const pending = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'reporting.report_run' AND data->>'status' = 'pending' ORDER BY seq LIMIT 20");
  for (const { account_id, data: run } of pending) {
    const ctx = accountCtx(account_id, run._base_url ?? `http://localhost:${config.port}`);
    try {
      const def = REPORT_TYPES[run.report_type]!;
      const rows = await computeReport(account_id, run.report_type, run.parameters);
      const content = csv(run.parameters.columns ?? def.columns, rows);
      const now = nowSeconds();
      const fileId = newId('file');
      const file = {
        id: fileId, object: 'file', created: now, expires_at: now + 365 * 86400,
        filename: `${run.report_type}-${new Date(run.parameters.interval_start * 1000).toISOString().slice(0, 10)}-to-${new Date(run.parameters.interval_end * 1000).toISOString().slice(0, 10)}.csv`,
        links: { object: 'list', data: [], has_more: false, url: `/v1/file_links?file=${fileId}` }, livemode: false, purpose: 'finance_report_run', size: Buffer.byteLength(content), title: null, type: 'csv',
        url: `${ctx.baseUrl}/v1/files/${fileId}/contents`, _content: content,
      };
      await insertObject(account_id, file);
      run.result = { ...file, _content: undefined };
      delete run.result._content;
      run.status = 'succeeded';
      run.succeeded_at = now;
      await saveObject(account_id, run);
      await emit(ctx, 'reporting.report_run.succeeded', run);
    } catch (e: any) {
      run.status = 'failed';
      run.error = String(e?.message ?? e);
      await saveObject(account_id, run);
      await emit(ctx, 'reporting.report_run.failed', run);
    }
  }
  return pending.length;
}

export async function fileContents(ctx: Ctx, id: string) {
  const f = await getObject<any>(ctx.accountId, 'file', id, 'file');
  return f._content ?? '';
}
