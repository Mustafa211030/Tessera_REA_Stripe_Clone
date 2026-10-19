import { query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { createReportRun, REPORT_TYPES } from './reporting.ts';
import { runQuery } from './sigma.ts';
import { getObject, insertObject, listObjects, saveObject } from './store.ts';

/**
 * Scheduled reports. Two kinds:
 *
 *   sql      a saved SQL query run daily, weekly or monthly. Each run is a
 *            scheduled_query_run (GET /v1/sigma/scheduled_query_runs) with a CSV file, and
 *            sends the sigma.scheduled_query_run.created event, so a webhook gets the result.
 *   report   a financial report type (balance summary, payouts, revenue recognition, ...)
 *            run for the period since the previous run; the reporting.report_run.succeeded
 *            event follows when the file is ready.
 *
 * "Run now" runs a schedule immediately without moving its next run.
 */

const DAY = 86400;
const INTERVALS = { daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY } as const;
type Interval = keyof typeof INTERVALS;

export async function createSchedule(ctx: Ctx, p: Params) {
  const kind = str(p, 'kind', { required: true })!;
  if (kind !== 'sql' && kind !== 'report') throw invalid('kind must be sql or report.', 'kind');
  const interval = str(p, 'interval') ?? 'daily';
  if (!(interval in INTERVALS)) throw invalid('interval must be daily, weekly or monthly.', 'interval');
  const name = str(p, 'name', { max: 120 }) ?? (kind === 'sql' ? 'Scheduled query' : 'Scheduled report');
  let sql: string | null = null;
  let report_type: string | null = null;
  if (kind === 'sql') {
    sql = str(p, 'sql', { required: true })!;
    await runQuery(ctx, sql); // validate now, so a broken query is caught when it is saved
  } else {
    report_type = str(p, 'report_type', { required: true })!;
    if (!REPORT_TYPES[report_type]) throw invalid(`Unknown report type: ${report_type}.`, 'report_type');
  }
  const now = nowSeconds();
  const s = {
    id: newId('sqs'), object: 'tessera.report_schedule', active: true, created: now, interval, kind, livemode: false, name,
    report_type, sql, last_run_at: null as number | null, next_run_at: now + INTERVALS[interval as Interval], runs: 0,
  };
  await insertObject(ctx.accountId, s);
  return s;
}

export const listSchedules = (ctx: Ctx, p: Params) => listObjects(ctx.accountId, 'tessera.report_schedule', '/v1/tessera/report_schedules', { ...p, limit: p.limit ?? 100 });

export async function updateSchedule(ctx: Ctx, id: string, p: Params) {
  const s = await getObject<any>(ctx.accountId, 'tessera.report_schedule', id, 'report schedule');
  if (p.active !== undefined) s.active = p.active === true || p.active === 'true';
  if (p.name !== undefined) s.name = String(p.name).slice(0, 120);
  if (p.interval !== undefined) {
    if (!(p.interval in INTERVALS)) throw invalid('interval must be daily, weekly or monthly.', 'interval');
    s.interval = p.interval;
    s.next_run_at = (s.last_run_at ?? nowSeconds()) + INTERVALS[s.interval as Interval];
  }
  return saveObject(ctx.accountId, s);
}

export async function deleteSchedule(ctx: Ctx, id: string) {
  await getObject(ctx.accountId, 'tessera.report_schedule', id, 'report schedule');
  await query("DELETE FROM objects WHERE account_id = $1 AND id = $2 AND type = 'tessera.report_schedule'", [ctx.accountId, id]);
  return { id, object: 'tessera.report_schedule', deleted: true };
}

function csv(columns: string[], rows: any[][]) {
  const cell = (v: any) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';
}

/** Runs one schedule now. Returns the scheduled_query_run or the report run. */
export async function runSchedule(ctx: Ctx, s: any, opts: { advance: boolean }) {
  const now = nowSeconds();
  let result: any;
  if (s.kind === 'sql') {
    const run: any = {
      id: newId('sqr'), object: 'scheduled_query_run', created: now, data_load_time: now, error: null, file: null, livemode: false,
      result_available_until: now + 30 * DAY, sql: s.sql, status: 'completed', title: s.name, _schedule: s.id,
    };
    try {
      const r = await runQuery(ctx, s.sql);
      const content = csv(r.columns, r.rows);
      const fileId = newId('file');
      const file = {
        id: fileId, object: 'file', created: now, expires_at: run.result_available_until, filename: `${s.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'query'}-${new Date(now * 1000).toISOString().slice(0, 10)}.csv`,
        links: { object: 'list', data: [], has_more: false, url: `/v1/file_links?file=${fileId}` }, livemode: false, purpose: 'sigma_scheduled_query', size: Buffer.byteLength(content),
        title: s.name, type: 'csv', url: `${ctx.baseUrl}/v1/files/${fileId}/contents`, _content: content,
      };
      await insertObject(ctx.accountId, file as any);
      run.file = { ...file, _content: undefined };
    } catch (e: any) {
      run.status = 'failed';
      run.error = { message: e instanceof ApiError ? e.message : String(e?.message ?? e) };
    }
    await insertObject(ctx.accountId, run);
    await emit(ctx, 'sigma.scheduled_query_run.created', run);
    result = run;
  } else {
    const start = s.last_run_at ?? Math.max(s.created - INTERVALS[s.interval as Interval], 0);
    result = await createReportRun(ctx, { report_type: s.report_type, parameters: { interval_start: Math.min(start, now - 1), interval_end: now } });
  }
  s.runs += 1;
  s.last_run_at = now;
  if (opts.advance) s.next_run_at = now + INTERVALS[s.interval as Interval];
  await saveObject(ctx.accountId, s);
  return result;
}

export async function runNow(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'tessera.report_schedule', id, 'report schedule');
  return runSchedule(ctx, s, { advance: false });
}

/** Worker: runs schedules whose next_run_at has passed. */
export async function runDueSchedules(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'tessera.report_schedule' AND (data->>'active')::boolean AND (data->>'next_run_at')::bigint <= $1 LIMIT 20", [now]);
  for (const { account_id, data } of rows) await runSchedule(accountCtx(account_id), data, { advance: true });
  return rows.length;
}

export const listQueryRuns = (ctx: Ctx, p: Params) => listObjects(ctx.accountId, 'scheduled_query_run', '/v1/sigma/scheduled_query_runs', p);
export const getQueryRun = (ctx: Ctx, id: string) => getObject(ctx.accountId, 'scheduled_query_run', id, 'scheduled_query_run');
