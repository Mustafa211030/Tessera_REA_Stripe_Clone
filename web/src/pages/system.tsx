import { useEffect, useState } from 'react';
import { api, dateLong, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, PageHead, Skeleton } from '../ui.tsx';
import { useSession } from './settings.tsx';

const CLASSES: { id: string; label: string; hint: string }[] = [
  { id: 'critical', label: 'Critical', hint: 'Creating and confirming payments' },
  { id: 'post', label: 'Writes', hint: 'Other API writes' },
  { id: 'get', label: 'Reads', hint: 'API reads and lists' },
  { id: 'low', label: 'Dashboard reads', hint: 'Pages like this one' },
];
const RANK: Record<string, number> = { critical: 0, post: 1, get: 2, low: 3 };
const STEPS = ['register', 'bulk_import', 'replicate', 'verify', 'switch', 'deregister'];
const STEP_LABEL: Record<string, string> = { register: 'Register', bulk_import: 'Bulk import', replicate: 'Replicate', verify: 'Verify', switch: 'Switch', deregister: 'Deregister' };
const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

/** Developers → System health: traffic, load shedding, shards and data movement, ledger checks. */
export function SystemHealth() {
  const toast = useToast();
  const session = useSession();
  const canAct = ['owner', 'admin', 'developer'].includes(session?.user?.role);
  const sys = useLoad(() => api('GET', '/v1/tessera/system'), []);
  const runs = useLoad(() => api('GET', '/v1/tessera/reconciliation_runs', { limit: 5 }), []);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Live view: refresh every two seconds (dashboard reads are the first traffic shed under load).
  useEffect(() => { const t = setInterval(() => sys.reload(), 2000); return () => clearInterval(t); }, []);

  async function act(fn: () => Promise<any>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok); sys.reload(); runs.reload(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  /** The simulate call answers with the limiter state, so the page updates even while its reads are shed. */
  const simulate = (ms: number | '', ok: string) => act(async () => {
    const st = await api('POST', '/v1/tessera/system/simulate_load', { event_loop_delay_ms: ms });
    setLast((d: any) => (d ? { ...d, load_shedding: st } : d));
  }, ok);
  // Keep showing the last good reading: under load this page's own reads are shed first.
  const [last, setLast] = useState<any>(null);
  useEffect(() => { if (sys.data) setLast(sys.data); }, [sys.data]);
  const data = sys.data ?? last;
  if (sys.error && !data) return <><PageHead title="System health" /><ErrorNote error={sys.error} /></>;
  if (!data) return <><PageHead title="System health" /><Skeleton /></>;
  const { traffic, load_shedding: ls, storage } = data;
  const paused = !!sys.error && !sys.data;
  const shed = ls.counters.fleet_shed + ls.counters.worker_shed;
  const latest = runs.data?.data?.[0];
  const moving = storage.moves.find((m: any) => !['complete', 'failed'].includes(m.status));
  const peak = Math.max(10, ...traffic.series.map((s: any) => s.requests));
  const others = storage.shards.filter((s: any) => s.shard !== storage.account.shard);
  return (
    <>
      <PageHead title="System health" sub="How this Tessera server protects itself under load and keeps its data and money correct: rate limiting, load shedding, sharded storage with live data movement, and ledger reconciliation." />
      {paused && <div className="alert alert-warning" role="status" style={{ marginBottom: 16 }}>Live updates paused: the server is shedding dashboard reads (HTTP 429), so this page shows its last reading. Payments and other critical requests are still served.</div>}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card><div className="stat-label">Requests per second</div><div className="stat-value">{traffic.requests_per_second}</div><div className="muted" style={{ fontSize: 12 }}>peak {traffic.peak_requests_per_second} in the last minute</div></Card>
        <Card><div className="stat-label">Latency p99</div><div className="stat-value">{traffic.latency_ms.p99} ms</div><div className="muted" style={{ fontSize: 12 }}>p50 {traffic.latency_ms.p50} ms · p95 {traffic.latency_ms.p95} ms</div></Card>
        <Card><div className="stat-label">Event-loop delay</div><div className="stat-value">{ls.event_loop_delay_ms} ms</div><div className="muted" style={{ fontSize: 12 }}>shedding starts at {ls.shed_threshold_ms} ms</div></Card>
        <Card><div className="stat-label">Requests shed</div><div className="stat-value">{shed}</div><div className="muted" style={{ fontSize: 12 }}>{ls.counters.rate_limited + ls.counters.concurrency_limited} more rate-limited</div></Card>
      </div>

      <Card title="Traffic, last 60 seconds">
        <svg viewBox="0 0 760 170" role="img" aria-label="Requests per second over the last minute" style={{ width: '100%', height: 'auto' }}>
          <line x1="40" x2="750" y1="140" y2="140" stroke="var(--color-border)" />
          <text x="34" y="24" textAnchor="end" fontSize="11" fill="var(--color-text-quiet)">{peak}</text>
          <text x="34" y="143" textAnchor="end" fontSize="11" fill="var(--color-text-quiet)">0</text>
          {traffic.series.map((s: any, i: number) => {
            const w = 710 / traffic.series.length, x = 40 + i * w, h = (s.requests / peak) * 116, hs = (s.shed / peak) * 116;
            return (
              <g key={s.t}>
                <rect x={x + 1} y={140 - h} width={w - 2} height={h - hs} fill="var(--color-brand)" opacity="0.75"><title>{`${s.requests} requests, ${s.shed} shed`}</title></rect>
                {s.shed > 0 && <rect x={x + 1} y={140 - hs} width={w - 2} height={hs} fill="var(--color-danger-text)" opacity="0.8"><title>{`${s.shed} shed`}</title></rect>}
              </g>
            );
          })}
          <text x="40" y="160" fontSize="11" fill="var(--color-text-quiet)">60 s ago</text>
          <text x="750" y="160" textAnchor="end" fontSize="11" fill="var(--color-text-quiet)">now</text>
        </svg>
        <div className="row" style={{ fontSize: 12 }}><span className="legend-dot" style={{ background: 'var(--color-brand)' }} /> served <span className="legend-dot" style={{ background: 'var(--color-danger-text)', marginLeft: 12 }} /> shed (HTTP 429)</div>
      </Card>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="Load shedding">
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}><span>Requests in flight</span><span className="mono">{ls.fleet_inflight} / {ls.fleet_capacity}</span></div>
              <div className="capacity-bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (ls.fleet_inflight / ls.fleet_capacity) * 100)}%` }} />
                <i style={{ left: '80%' }} />
              </div>
              <div className="muted" style={{ fontSize: 12 }}>The last 20% ({ls.critical_reserve} requests) is kept for critical requests.</div>
            </div>
            <table className="table">
              <thead><tr><th>Priority</th><th>Status</th><th style={{ textAlign: 'right' }}>Served</th><th style={{ textAlign: 'right' }}>Shed</th></tr></thead>
              <tbody>{CLASSES.map((c) => (
                <tr key={c.id}><td><strong style={{ fontSize: 13 }}>{c.label}</strong><div className="muted" style={{ fontSize: 12 }}>{c.hint}</div></td>
                  <td>{RANK[c.id]! <= RANK[ls.served_up_to]! ? <Badge kind="success">Served</Badge> : <Badge kind="danger">Shedding</Badge>}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{ls.counters.by_class[c.id]}</td><td className="mono" style={{ textAlign: 'right' }}>{ls.counters.shed_by_class[c.id]}</td></tr>
              ))}</tbody>
            </table>
            <div className="muted" style={{ fontSize: 12 }}>Tiers: token bucket {ls.rate_per_second}/s per key · {ls.concurrency_per_account} concurrent per account · fleet reserve for critical traffic · worker shedding by priority.</div>
            {canAct && <div className="row">
              <span className="muted" style={{ fontSize: 12 }}>Simulate a busy server:</span>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => simulate(ls.shed_threshold_ms * 2, 'Simulating a busy server: reads are shed')}>Busy</button>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => simulate(ls.shed_threshold_ms * 4, 'Simulating overload: only critical requests are served')}>Overloaded</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => simulate('', 'Back to normal')}>Clear</button>
            </div>}
          </div>
        </Card>

        <Card title="Ledger reconciliation" actions={canAct && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => api('POST', '/v1/tessera/reconciliation_runs'), 'Reconciliation finished')}>Run now</button>}>
          {!runs.data ? <Skeleton /> : !latest ? <Empty>No run yet. Runs happen hourly, or run one now.</Empty> : (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row">{latest.status === 'passed' ? <Badge kind="success">All checks passed</Badge> : <Badge kind="danger">{latest.failures} discrepancies</Badge>}<span className="muted" style={{ fontSize: 12 }}>{dateLong(latest.created)} · {latest.duration_ms} ms</span></div>
              <table className="table">
                <tbody>{latest.checks.map((c: any) => (
                  <tr key={c.name}><td><strong style={{ fontSize: 13 }}>{c.description}</strong>{c.failures > 0 && <div className="mono" style={{ fontSize: 11, color: 'var(--color-danger-text)' }}>{c.examples.join(' · ')}</div>}</td>
                    <td className="mono" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{c.checked.toLocaleString()} checked</td>
                    <td style={{ textAlign: 'right' }}>{c.failures ? <Badge kind="danger">{c.failures} failed</Badge> : <Badge kind="success">OK</Badge>}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Storage shards" actions={<span className="muted" style={{ fontSize: 12 }}>This account: shard {storage.account.shard ?? '—'} · directory version {storage.account.directory_version ?? '—'}</span>}>
        <table className="table">
          <thead><tr><th>Shard</th><th>Table</th><th style={{ textAlign: 'right' }}>Accounts</th><th style={{ textAlign: 'right' }}>Objects</th><th style={{ textAlign: 'right' }}>Size</th></tr></thead>
          <tbody>{storage.shards.map((s: any) => (
            <tr key={s.shard}><td>Shard {s.shard} {s.shard === storage.account.shard && <Badge kind="info">This account</Badge>}</td><td className="mono">{s.table}</td>
              <td className="mono" style={{ textAlign: 'right' }}>{s.accounts}</td><td className="mono" style={{ textAlign: 'right' }}>{s.objects.toLocaleString()}</td><td className="mono" style={{ textAlign: 'right' }}>{bytes(s.bytes)}</td></tr>
          ))}</tbody>
        </table>
        {canAct && (
          <div className="row" style={{ marginTop: 12 }}>
            <label className="row" style={{ fontSize: 13 }}>Move this account to
              <select className="input input-sm" aria-label="Target shard" value={target ?? ''} onChange={(e) => setTarget(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Choose a shard…</option>{others.map((s: any) => <option key={s.shard} value={s.shard}>Shard {s.shard}</option>)}
              </select></label>
            <button className="btn btn-primary btn-sm" disabled={busy || target === null || !!moving} onClick={() => act(() => api('POST', '/v1/tessera/shard_moves', { target_shard: target }), 'Move started; the account keeps serving requests')}>Move without downtime</button>
          </div>
        )}
        {storage.moves.length > 0 && (
          <div className="stack" style={{ gap: 10, marginTop: 16 }}>
            {storage.moves.slice(0, 3).map((m: any) => (
              <div key={m.id} className="move-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span><strong style={{ fontSize: 13 }}>Shard {m.source_shard} → shard {m.target_shard}</strong> <span className="mono muted" style={{ fontSize: 11 }}>{m.id}</span></span>
                  {m.status === 'complete' ? <Badge kind="success">Complete · switched in {m.switch_ms} ms</Badge> : m.status === 'failed' ? <Badge kind="danger">Failed</Badge> : <Badge kind="info">{m.status}</Badge>}
                </div>
                <ol className="move-steps">{STEPS.map((s) => { const st = m.steps.find((x: any) => x.step === s); return <li key={s} data-done={!!st} title={st?.detail}><span>{STEP_LABEL[s]}</span></li>; })}</ol>
                <div className="muted" style={{ fontSize: 12 }}>{m.failure ?? `${m.objects_copied.toLocaleString()} objects copied · ${m.changes_replayed} writes replayed during the copy`}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
