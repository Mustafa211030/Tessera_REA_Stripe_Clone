import { EvidenceFile } from './data.tsx';
import { useEffect, useState } from 'react';
import { api, ApiErr, date, dateLong, Link, money, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Money, PageHead, Skeleton, Tabs } from '../ui.tsx';

const STATUS: Record<string, [string, 'warning' | 'info' | 'success' | 'danger' | 'neutral']> = {
  needs_response: ['Needs response', 'warning'], under_review: ['Under review', 'info'], won: ['Won', 'success'], lost: ['Lost', 'danger'],
  warning_needs_response: ['Inquiry: needs response', 'warning'], warning_under_review: ['Inquiry under review', 'info'], warning_closed: ['Inquiry closed', 'neutral'],
};
export function DisputeStatus({ s }: { s: string }) {
  const [label, kind] = STATUS[s] ?? [s, 'neutral'];
  return <Badge kind={kind}>{label}</Badge>;
}
const reasonLabel = (r: string) => r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function Disputes() {
  const { navigate } = useRouter();
  const [tab, setTab] = useState<'disputes' | 'efw'>('disputes');
  const list = useLoad(() => api('GET', tab === 'disputes' ? '/v1/disputes' : '/v1/radar/early_fraud_warnings', { limit: 100 }), [tab]);
  const rows: any[] = list.data?.data ?? [];
  const open = tab === 'disputes' ? rows.filter((d) => d.status.endsWith('needs_response')).length : 0;
  return (
    <>
      <PageHead title="Disputes" sub={<>Chargebacks and inquiries from card issuers. Test cards 4000 0000 0000 0259 (fraud), 2685 (not received) and 1976 (inquiry) open one.{open > 0 && <> <strong>{open} need a response.</strong></>}</>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'disputes', label: 'Disputes' }, { id: 'efw', label: 'Early fraud warnings' }]} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !rows.length ? <Empty>{tab === 'disputes' ? 'No disputes. Pay with 4000 0000 0000 0259 to open one.' : 'No early fraud warnings. Pay with 4000 0000 0000 5423 to get one.'}</Empty> : tab === 'disputes' ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="num">Amount</th><th>Status</th><th>Reason</th><th>Respond by</th><th>Payment</th><th>Opened</th></tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => navigate(`/disputes/${d.id}`)}>
                <td className="num"><Money amount={d.amount} currency={d.currency} /></td>
                <td><DisputeStatus s={d.status} /></td>
                <td>{reasonLabel(d.reason)}</td>
                <td className="soft">{d.status.endsWith('needs_response') ? date(d.evidence_details.due_by) : '—'}</td>
                <td className="mono soft">{d.payment_intent}</td>
                <td className="soft">{date(d.created)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Fraud type</th><th>Actionable</th><th>Payment</th><th>Received</th></tr></thead>
            <tbody>{rows.map((w) => (
              <tr key={w.id} className="clickable" onClick={() => navigate(`/payments/${w.payment_intent}`)}>
                <td>{reasonLabel(w.fraud_type)}</td>
                <td>{w.actionable ? <Badge kind="warning">Refund to avoid a dispute</Badge> : <Badge>Resolved</Badge>}</td>
                <td className="mono soft">{w.payment_intent}</td>
                <td className="soft">{date(w.created)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

const EVIDENCE: [string, string, 'text' | 'area' | 'date' | 'file'][] = [
  ['customer_name', 'Customer name', 'text'], ['customer_email_address', 'Customer email', 'text'], ['customer_purchase_ip', 'Purchase IP address', 'text'],
  ['product_description', 'Product or service', 'area'], ['shipping_carrier', 'Shipping carrier', 'text'], ['shipping_tracking_number', 'Tracking number', 'text'],
  ['shipping_date', 'Shipping date', 'date'], ['refund_policy_disclosure', 'How the refund policy was shown', 'area'], ['customer_communication', 'Customer communication', 'area'],
  ['receipt', 'Receipt', 'file'], ['shipping_documentation', 'Proof of delivery', 'file'], ['uncategorized_file', 'Other supporting file', 'file'],
  ['uncategorized_text', 'Additional evidence', 'area'],
];

export function DisputeDetail({ id }: { id: string }) {
  const toast = useToast();
  const d = useLoad(() => api('GET', `/v1/disputes/${id}`), [id]);
  const [ev, setEv] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (d.data) setEv(Object.fromEntries(EVIDENCE.map(([k]) => [k, typeof d.data.evidence[k] === 'string' ? d.data.evidence[k] : ''])));
  }, [d.data]);
  // Under review: poll until the simulated issuer decides.
  useEffect(() => {
    if (!d.data?.status.endsWith('under_review')) return;
    const t = setInterval(() => d.reload(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data?.status]);
  if (d.loading && !d.data) return <Card><Skeleton rows={6} /></Card>;
  if (d.error) return <ErrorNote error={d.error} />;
  const dp = d.data;
  const editable = dp.status.endsWith('needs_response');
  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true); setErr(null);
    try { await fn(); toast(msg); d.reload(); } catch (e) { setErr(e instanceof ApiErr ? e : { message: String(e) }); } finally { setBusy(false); }
  };
  const evidenceParams = Object.fromEntries(Object.entries(ev).filter(([k, v]) => v !== (typeof dp.evidence[k] === 'string' ? dp.evidence[k] : '')).map(([k, v]) => [k, v]));
  const withdrawn = dp.balance_transactions.filter((t: any) => t.amount < 0).reduce((s: number, t: any) => s + t.net, 0);
  const reinstated = dp.balance_transactions.filter((t: any) => t.amount > 0).reduce((s: number, t: any) => s + t.net, 0);
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/disputes">Disputes</Link> / <span className="mono">{dp.id}</span></div>
      <PageHead title={money(dp.amount, dp.currency)} sub={<span className="row"><DisputeStatus s={dp.status} />{reasonLabel(dp.reason)} · {dp.payment_method_details.card.case_type}</span>}
        actions={editable && <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => api('POST', `/v1/disputes/${id}/close`), dp.status.startsWith('warning') ? 'Inquiry closed' : 'Dispute accepted')}>{dp.status.startsWith('warning') ? 'Close inquiry' : 'Accept dispute'}</button>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 12 }}>
        <div className="stack">
          {editable ? (
            <Card title="Counter the dispute" actions={<>
              <button className="btn btn-ghost btn-sm" onClick={() => setEv({ ...ev, uncategorized_text: 'winning_evidence' })}>Winning test evidence</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEv({ ...ev, uncategorized_text: 'losing_evidence' })}>Losing test evidence</button>
            </>}>
              <div className="form-grid">
                <p className="soft">Respond by <strong>{dateLong(dp.evidence_details.due_by)}</strong>. {dp.status.startsWith('warning') ? 'No funds have been withdrawn for this inquiry yet.' : 'Submitting sends everything to the issuer; you can only submit once.'}</p>
                {EVIDENCE.map(([k, label, kind]) => kind === 'file' ? <EvidenceFile key={k} label={label} value={ev[k] ?? ''} onChange={(v) => setEv({ ...ev, [k]: v })} /> : (
                  <Field key={k} label={label}>
                    {kind === 'area' ? <textarea className="input" rows={k === 'uncategorized_text' ? 3 : 2} value={ev[k] ?? ''} onChange={(e) => setEv({ ...ev, [k]: e.target.value })} />
                      : <input className="input" type={kind} value={ev[k] ?? ''} onChange={(e) => setEv({ ...ev, [k]: e.target.value })} />}
                  </Field>
                ))}
                <div className="row">
                  <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => api('POST', `/v1/disputes/${id}`, { evidence: evidenceParams, submit: 'false' }), 'Draft saved')}>Save draft</button>
                  <span className="spacer" />
                  <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api('POST', `/v1/disputes/${id}`, { evidence: evidenceParams, submit: 'true' }), 'Evidence submitted')}>Submit evidence</button>
                </div>
              </div>
            </Card>
          ) : (
            <Card title="Submitted evidence">
              {dp.status.endsWith('under_review') && <div className="alert alert-info" style={{ marginBottom: 12 }}>The issuer is reviewing the evidence. Test evidence containing <code>winning_evidence</code> or <code>losing_evidence</code> is decided automatically.</div>}
              <dl className="kv" style={{ gridTemplateColumns: '200px 1fr' }}>
                {Object.entries(dp.evidence).filter(([, v]) => v).flatMap(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={k + 'v'}>{typeof v === 'string' && v.startsWith('file_') ? <a href={`/v1/files/${v}/contents`} target="_blank" rel="noreferrer">{v}</a> : String(v)}</dd>])}
              </dl>
            </Card>
          )}
          <Card title="Dispute object"><Json value={dp} /></Card>
        </div>
        <div className="stack">
          <Card title="Details">
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Payment</dt><dd><Link to={`/payments/${dp.payment_intent}`} className="mono">{dp.payment_intent}</Link></dd>
              <dt>Network code</dt><dd>{dp.network_reason_code ?? '—'}</dd>
              <dt>Opened</dt><dd>{dateLong(dp.created)}</dd>
              <dt>Submissions</dt><dd>{dp.evidence_details.submission_count}</dd>
            </dl>
          </Card>
          <Card title="Funds">
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Withdrawn</dt><dd>{money(withdrawn, dp.currency)}</dd>
              <dt>Reinstated</dt><dd>{money(reinstated, dp.currency)}</dd>
            </dl>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>A chargeback withdraws the amount plus a {money(1500, dp.currency)} dispute fee. Winning returns the amount; the fee is kept.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
