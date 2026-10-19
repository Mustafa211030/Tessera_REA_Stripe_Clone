import { useState } from 'react';
import { api, ApiErr, date, money, useLoad, useToast } from '../lib.tsx';
import { Card, Empty, ErrorNote, Field, PageHead, Skeleton } from '../ui.tsx';

const DESCRIPTIONS: Record<string, string> = {
  'balance.summary.1': 'Starting balance, activity, fees, payouts and ending balance.',
  'balance_change_from_activity.itemized.1': 'Every balance transaction except payouts.',
  'payouts.summary.1': 'Total payouts and payout reversals.',
  'payouts.itemized.1': 'One row per payout balance transaction.',
};

const dayStart = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const isoDay = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

function parseCsv(text: string) {
  const [head, ...rows] = text.trim().split('\n');
  const split = (l: string) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, head!.split(',').length);
  return { columns: head!.split(','), rows: rows.map(split) };
}

/** Creates a report run, waits for the worker to finish it, and returns its CSV. */
async function runReport(report_type: string, start: number, end: number) {
  let run = await api('POST', '/v1/reporting/report_runs', { report_type, parameters: { interval_start: start, interval_end: end } });
  for (let i = 0; i < 40 && run.status === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    run = await api('GET', `/v1/reporting/report_runs/${run.id}`);
  }
  if (run.status !== 'succeeded') throw new Error(run.error ?? 'The report did not finish.');
  const res = await fetch(`/v1/files/${run.result.id}/contents`, { credentials: 'same-origin' });
  return { run, text: await res.text() };
}

function download(filename: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function Reports() {
  const toast = useToast();
  const now = Math.floor(Date.now() / 1000);
  const [from, setFrom] = useState(isoDay(now - 30 * 86400));
  const [to, setTo] = useState(isoDay(now));
  const range = () => ({ start: dayStart(from), end: Math.min(dayStart(to) + 86400, Math.floor(Date.now() / 1000)) });
  const summary = useLoad(async () => {
    const w = range();
    return parseCsv((await runReport('balance.summary.1', w.start, w.end)).text);
  }, [from, to]);
  const types = useLoad(() => api('GET', '/v1/reporting/report_types'), []);
  const runs = useLoad(() => api('GET', '/v1/reporting/report_runs', { limit: 20 }), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  async function get(type: string) {
    setBusy(type); setErr(null);
    try {
      const w = range();
      const { run, text } = await runReport(type, w.start, w.end);
      download(run.result.filename, text);
      toast('Report downloaded');
      runs.reload();
    } catch (e) { setErr(e instanceof ApiErr ? e : { message: String((e as any)?.message ?? e) }); } finally { setBusy(null); }
  }
  const byCategory = (cat: string) => summary.data?.rows.filter((r) => r[0] === cat) ?? [];
  return (
    <>
      <PageHead title="Reports" sub="Financial reports computed from balance transactions, in UTC. Each download is a report run with a CSV file, exactly as the API produces it." />
      <ErrorNote error={err ?? summary.error} />
      <Card title="Balance summary" actions={<div className="row">
        <Field label="From"><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} min={from} max={isoDay(now)} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>}>
        {!summary.data ? <Skeleton rows={4} /> : (
          <div className="grid grid-4">
            {[['starting_balance', 'Starting balance'], ['activity', 'Net activity'], ['payouts', 'Payouts'], ['ending_balance', 'Ending balance']].map(([cat, label]) => (
              <div key={cat}>
                <div className="stat-label">{label}</div>
                {byCategory(cat!).map((r) => <div key={r[3]} className="stat-value">{money(Math.round(Number(r[2]) * 100), r[3])}</div>)}
                {cat === 'activity' && byCategory('activity_fee').map((r) => <div key={r[3]} className="muted" style={{ fontSize: 12 }}>after {money(-Math.round(Number(r[2]) * 100), r[3])} in fees</div>)}
              </div>
            ))}
          </div>
        )}
      </Card>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        {(types.data?.data ?? []).map((t: any) => (
          <Card key={t.id} title={t.name} actions={<button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => get(t.id)}>{busy === t.id ? 'Running…' : 'Download CSV'}</button>}>
            <p className="soft">{DESCRIPTIONS[t.id]}</p>
            <p className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>{t.id} · {t.default_columns.length} columns</p>
          </Card>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title="Recent report runs" pad={false}>
          {!runs.data ? <Skeleton /> : !runs.data.data.length ? <Empty>No report runs yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Report</th><th>Window</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>{runs.data.data.map((r: any) => (
                <tr key={r.id}>
                  <td className="mono">{r.report_type}</td>
                  <td className="soft">{isoDay(r.parameters.interval_start)} → {isoDay(r.parameters.interval_end)}</td>
                  <td>{r.status}</td>
                  <td className="soft">{date(r.created)}</td>
                  <td className="num">{r.result && <button className="btn btn-ghost btn-sm" onClick={async () => download(r.result.filename, await (await fetch(`/v1/files/${r.result.id}/contents`, { credentials: 'same-origin' })).text())}>Download</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
