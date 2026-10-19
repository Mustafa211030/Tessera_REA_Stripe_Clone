import { useState } from 'react';
import { api, date, Link, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHead, Skeleton } from '../ui.tsx';

const ATTRS = ['amount_in_usd', 'risk_score', 'risk_level', 'card_country', 'card_brand', 'card_funding', 'cvc_check', 'email_domain', 'attempts_per_card_1h', 'declines_per_card_1d', 'card_fingerprint', 'currency', 'is_3d_secure'];

export function Radar() {
  const toast = useToast();
  const rules = useLoad(() => api('GET', '/v1/radar/rules', { limit: 100 }), []);
  const lists = useLoad(() => api('GET', '/v1/radar/value_lists', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [action, setAction] = useState('block');
  const [predicate, setPredicate] = useState(":amount_in_usd: > 500 and :card_country: != 'US'");
  const [test, setTest] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [vl, setVl] = useState({ alias: 'blocked_emails', items: 'fraudster@example.com' });

  const save = async () => {
    setErr(null);
    try { await api('POST', '/v1/radar/rules', { action, predicate }); toast('Rule added'); setOpen(false); rules.reload(); } catch (e) { setErr(e); }
  };
  const runTest = async () => {
    setErr(null);
    try { setTest(await api('POST', '/v1/radar/rules/test', { predicate })); } catch (e) { setErr(e); setTest(null); }
  };
  const toggle = async (r: any) => { await api('POST', `/v1/radar/rules/${r.id}`, { enabled: String(!r.enabled) }); rules.reload(); };

  return (
    <>
      <PageHead title="Fraud rules" sub="Rules run before a card reaches the network. Order: allow, then block, then review." actions={<><button className="btn btn-secondary" onClick={() => setListOpen(true)}>+ Value list</button><button className="btn btn-primary" onClick={() => { setTest(null); setOpen(true); }}>+ Add rule</button></>} />
      <Card title="Rules" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Action</th><th>Rule</th><th>Status</th><th></th></tr></thead>
          <tbody>
            <tr><td><Badge kind="danger">block</Badge></td><td><code>:risk_level: = 'highest'</code> <span className="muted">· built in</span></td><td><Badge kind="success">Enabled</Badge></td><td /></tr>
            {rules.data?.data.map((r: any) => (
              <tr key={r.id}>
                <td><Badge kind={r.action === 'block' ? 'danger' : r.action === 'review' ? 'warning' : 'success'}>{r.action}</Badge></td>
                <td><code>{r.predicate}</code></td>
                <td>{r.enabled ? <Badge kind="success">Enabled</Badge> : <Badge>Disabled</Badge>}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card title="Value lists" pad={false}>
          {!lists.data ? <Skeleton /> : !lists.data.data.length ? <Empty>Lists let rules match many values, e.g. <code>:email: in @blocked_emails</code>.</Empty> : (
            <table className="table"><tbody>{lists.data.data.map((l: any) => <tr key={l.id}><td><code>@{l.alias}</code></td><td className="soft">{l.list_items.join(', ')}</td><td className="soft">{date(l.created)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a rule"
        footer={<><button className="btn btn-secondary" onClick={runTest}>Test against history</button><button className="btn btn-primary" onClick={save}>Add rule</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {[[':amount_in_usd: > 500 and :card_country: != \'US\'', 'Large foreign payment'], ["::customer:tier:: = 'blocked'", 'Customer metadata'], ["::order_type:: = 'gift'", 'Payment metadata'], [":email: like '%@mailinator.com'", 'Email pattern']].map(([v, l]) => (
              <button key={l} type="button" className="btn btn-ghost btn-sm" onClick={() => setPredicate(v!)}>{l}</button>
            ))}
          </div>
          <Field label="Action"><select className="input" value={action} onChange={(e) => setAction(e.target.value)}><option value="block">Block</option><option value="review">Review</option><option value="allow">Allow</option></select></Field>
          <Field label="Condition" hint={<>Attributes: {ATTRS.map((a) => <code key={a} style={{ marginRight: 6 }}>:{a}:</code>)}<br />Metadata: <code>::order_type::</code> (payment) and <code>::customer:tier::</code> (customer). Patterns: <code>:email: like '%@example.org'</code>.</>}>
            <textarea className="input" rows={3} value={predicate} onChange={(e) => setPredicate(e.target.value)} spellCheck={false} />
          </Field>
          {test && <div className="alert alert-info">Would have matched {test.matched} of the last {test.charges_evaluated} payments.</div>}
        </div>
      </Modal>
      <Modal open={listOpen} onClose={() => setListOpen(false)} title="New value list"
        footer={<button className="btn btn-primary" onClick={async () => { await api('POST', '/v1/radar/value_lists', { alias: vl.alias, list_items: vl.items.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) }); setListOpen(false); lists.reload(); }}>Create list</button>}>
        <div className="form-grid">
          <Field label="Alias"><input className="input" value={vl.alias} onChange={(e) => setVl({ ...vl, alias: e.target.value })} /></Field>
          <Field label="Items (one per line)"><textarea className="input" rows={4} value={vl.items} onChange={(e) => setVl({ ...vl, items: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

export function Reviews() {
  const toast = useToast();
  const reviews = useLoad(() => api('GET', '/v1/reviews', { limit: 100, expand: ['data.charge'] }), []);
  const act = async (id: string, what: 'approve' | 'refund') => {
    await api('POST', `/v1/reviews/${id}/${what}`);
    toast(what === 'approve' ? 'Payment approved' : 'Payment refunded as fraud');
    reviews.reload();
  };
  return (
    <>
      <PageHead title="Reviews" sub="Payments a review rule flagged. Approve them, or refund and mark as fraud." />
      <Card pad={false}>
        {!reviews.data ? <Skeleton /> : reviews.error ? <ErrorNote error={reviews.error} /> : !reviews.data.data.length ? <Empty>No payments waiting for review.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Payment</th><th>Rule</th><th>Status</th><th>Opened</th><th /></tr></thead>
            <tbody>{reviews.data.data.map((r: any) => (
              <tr key={r.id}>
                <td><Link to={`/payments/${r.payment_intent}`}>{r.charge?.payment_method_details?.card?.brand} •••• {r.charge?.payment_method_details?.card?.last4}</Link></td>
                <td><code>{r.charge?.outcome?.rule?.predicate}</code></td>
                <td>{r.open ? <Badge kind="warning">Open</Badge> : <Badge>{r.closed_reason}</Badge>}</td>
                <td className="soft">{date(r.created)}</td>
                <td className="num">{r.open && <><button className="btn btn-secondary btn-sm" onClick={() => act(r.id, 'approve')}>Approve</button> <button className="btn btn-danger btn-sm" onClick={() => act(r.id, 'refund')}>Refund</button></>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
