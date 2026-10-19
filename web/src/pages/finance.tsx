import { useEffect, useState } from 'react';
import { api, ApiErr, copy, date, dateLong, hosted, Link, money, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton } from '../ui.tsx';

const TXN_LABEL: Record<string, string> = {
  adjustment: 'Adjustment', applied_to_invoice: 'Applied to invoice', credit_note: 'Credit note', unapplied_from_invoice: 'Returned from voided invoice',
  invoice_overpaid: 'Invoice overpaid', initial: 'Initial balance', invoice_too_small: 'Invoice too small', invoice_too_large: 'Invoice too large', unspent_receiver_credit: 'Unspent credit',
};

/** Customer balance: credit (negative) is spent by the next invoice; a positive balance is collected by it. */
export function BalanceCard({ customer, onChange }: { customer: any; onChange: () => void }) {
  const toast = useToast();
  const txns = useLoad(() => api('GET', `/v1/customers/${customer.id}/balance_transactions`, { limit: 20 }), [customer.id, customer.balance]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ kind: 'credit', amount: '10.00', description: '' });
  const [err, setErr] = useState<any>(null);
  const cur = customer.currency ?? 'usd';
  const bal = customer.balance ?? 0;
  async function save() {
    setErr(null);
    try {
      const minor = toMinor(f.amount, cur);
      await api('POST', `/v1/customers/${customer.id}/balance_transactions`, { amount: f.kind === 'credit' ? -minor : minor, currency: cur, description: f.description || undefined });
      setOpen(false); toast('Balance adjusted'); onChange();
    } catch (e) { setErr(e); }
  }
  return (
    <Card title="Invoice balance" actions={<button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Adjust</button>}>
      <div className="stack" style={{ gap: 10 }}>
        <div>
          <div className="stat-value" style={{ fontSize: 22 }}>{money(Math.abs(bal), cur)}</div>
          <div className="soft" style={{ fontSize: 13 }}>{bal < 0 ? 'Credit, applied to the next invoice' : bal > 0 ? 'Owed, added to the next invoice' : 'No balance'}</div>
        </div>
        {!!txns.data?.data.length && (
          <table className="table table-compact"><tbody>{txns.data.data.slice(0, 6).map((t: any) => (
            <tr key={t.id}><td><div>{TXN_LABEL[t.type] ?? t.type}</div><div className="muted" style={{ fontSize: 12 }}>{t.description ?? (t.invoice ? <Link to={`/invoices/${t.invoice}`}>{t.invoice.slice(0, 14)}…</Link> : date(t.created))}</div></td><td className="num">{t.amount < 0 ? '−' : '+'}{money(Math.abs(t.amount), t.currency)}</td></tr>
          ))}</tbody></table>
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Adjust invoice balance" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={save}>Apply</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="credit">Credit: lowers what the customer pays next</option><option value="debit">Debit: adds to what the customer pays next</option></select></Field>
          <Field label={`Amount (${cur.toUpperCase()})`}><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Description (optional)"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

const REASONS: [string, string][] = [['', 'No reason'], ['duplicate', 'Duplicate'], ['fraudulent', 'Fraudulent'], ['order_change', 'Order change'], ['product_unsatisfactory', 'Product unsatisfactory']];
export const CreditNoteStatus = ({ s }: { s: string }) => (s === 'void' ? <Badge>Void</Badge> : <Badge kind="success">Issued</Badge>);

/** Credit notes on an invoice, and the modal that issues one. */
export function CreditNotesCard({ invoice, onChange }: { invoice: any; onChange: () => void }) {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/credit_notes', { invoice: invoice.id, limit: 50 }), [invoice.id, invoice.amount_due, invoice.post_payment_credit_notes_amount]);
  const [open, setOpen] = useState(false);
  const can = ['open', 'paid'].includes(invoice.status);
  return (
    <>
      <Card title="Credit notes" pad={false} actions={can && <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>Issue credit note</button>}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>{can ? 'No credit notes. Issue one to lower the amount due, refund, or credit the customer.' : 'Credit notes need an open or paid invoice.'}</Empty> : (
          <table className="table"><thead><tr><th>Number</th><th>Type</th><th>Reason</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.data.map((cn: any) => (
              <tr key={cn.id}><td className="mono">{cn.number}</td><td className="soft">{cn.type === 'pre_payment' ? 'Lowered amount due' : [cn.refunds.length && 'Refund', cn.customer_balance_transaction && 'Balance credit', cn.out_of_band_amount && 'Out of band'].filter(Boolean).join(' + ')}</td>
                <td className="soft">{cn.reason?.replace(/_/g, ' ') ?? '—'}</td><td className="num amount">{money(cn.total, cn.currency)}</td><td><CreditNoteStatus s={cn.status} /></td>
                <td className="num"><a className="btn btn-ghost btn-sm" href={cn.pdf} target="_blank" rel="noreferrer">PDF</a>{cn.status === 'issued' && !cn.refunds.length && <button className="btn btn-ghost btn-sm" onClick={async () => { try { await api('POST', `/v1/credit_notes/${cn.id}/void`); toast('Credit note voided'); onChange(); list.reload(); } catch (e: any) { toast(e.message, 'error'); } }}>Void</button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {open && <IssueCreditNoteModal invoice={invoice} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast('Credit note issued'); onChange(); list.reload(); }} />}
    </>
  );
}

function IssueCreditNoteModal({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const cur = invoice.currency;
  const paid = invoice.status === 'paid';
  const [qty, setQty] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState({ description: '', amount: '' });
  const [reason, setReason] = useState('');
  const [memo, setMemo] = useState('');
  const [split, setSplit] = useState({ refund: '', credit: '', oob: '' });
  const [mode, setMode] = useState<'refund' | 'credit' | 'split'>(invoice.payment_intent ? 'refund' : 'credit');
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const lines = [
    ...invoice.lines.data.filter((l: any) => Number(qty[l.id] || 0) > 0).map((l: any) => (l.quantity > 1 ? { type: 'invoice_line_item', invoice_line_item: l.id, quantity: qty[l.id] } : { type: 'invoice_line_item', invoice_line_item: l.id })),
    ...(custom.description && Number(custom.amount) > 0 ? [{ type: 'custom_line_item', description: custom.description, unit_amount: toMinor(custom.amount, cur), quantity: 1 }] : []),
  ];
  const key = JSON.stringify(lines);
  useEffect(() => {
    if (!lines.length) { setPreview(null); return; }
    let live = true;
    setErr(null);
    api('GET', '/v1/credit_notes/preview', { invoice: invoice.id, lines }).then((p) => live && setPreview(p), (e) => { if (live) { setPreview(null); setErr(e); } });
    return () => { live = false; };
  }, [key]);
  function amounts() {
    if (!paid || !preview) return {};
    if (mode === 'refund') return { refund_amount: preview.total };
    if (mode === 'credit') return { credit_amount: preview.total };
    return { refund_amount: toMinor(split.refund || '0', cur), credit_amount: toMinor(split.credit || '0', cur), out_of_band_amount: toMinor(split.oob || '0', cur) };
  }
  async function issue() {
    setBusy(true); setErr(null);
    try { await api('POST', '/v1/credit_notes', { invoice: invoice.id, lines, reason: reason || undefined, memo: memo || undefined, ...amounts() }); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Credit note for ${invoice.number}`} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !preview} onClick={issue}>{busy ? 'Issuing…' : preview ? `Issue ${money(preview.total, cur)} credit note` : 'Issue credit note'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <table className="table table-compact"><thead><tr><th>Item</th><th className="num">Amount</th><th className="num">Credit</th></tr></thead>
          <tbody>{invoice.lines.data.map((l: any) => (
            <tr key={l.id}><td>{l.description}</td><td className="num soft">{money(l.amount, cur)}</td>
              <td className="num">{l.quantity > 1
                ? <input className="input" aria-label={`Quantity to credit for ${l.description}`} type="number" min={0} max={l.quantity} style={{ width: 72 }} value={qty[l.id] ?? '0'} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
                : <input type="checkbox" aria-label={`Credit ${l.description}`} checked={Number(qty[l.id] || 0) > 0} onChange={(e) => setQty({ ...qty, [l.id]: e.target.checked ? '1' : '0' })} />}</td></tr>
          ))}</tbody>
        </table>
        <div className="form-row">
          <Field label="Extra credit (optional)"><input className="input" placeholder="e.g. Late delivery" value={custom.description} onChange={(e) => setCustom({ ...custom, description: e.target.value })} /></Field>
          <Field label="Amount"><input className="input" placeholder="0.00" value={custom.amount} onChange={(e) => setCustom({ ...custom, amount: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="Reason"><select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Memo (on the PDF)"><input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
        </div>
        {paid && <Field label="Give the money back as">
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as any)}>
            {invoice.payment_intent && <option value="refund">Refund to the original payment</option>}
            <option value="credit">Credit on the customer's balance</option>
            <option value="split">Split between refund, credit and out of band</option>
          </select>
        </Field>}
        {paid && mode === 'split' && <div className="form-row">
          <Field label="Refund"><input className="input" value={split.refund} placeholder="0.00" onChange={(e) => setSplit({ ...split, refund: e.target.value })} /></Field>
          <Field label="Balance credit"><input className="input" value={split.credit} placeholder="0.00" onChange={(e) => setSplit({ ...split, credit: e.target.value })} /></Field>
          <Field label="Out of band"><input className="input" value={split.oob} placeholder="0.00" onChange={(e) => setSplit({ ...split, oob: e.target.value })} /></Field>
        </div>}
        {preview && <div className="alert alert-info">Credit note total <strong>{money(preview.total, cur)}</strong>{preview.tax_amounts.length ? ` including ${money(preview.tax_amounts.reduce((s: number, t: any) => s + t.amount, 0), cur)} tax` : ''}. {paid ? '' : `The invoice's amount due drops to ${money(invoice.amount_due - preview.total, cur)}.`}</div>}
      </div>
    </Modal>
  );
}

export function CreditNotes() {
  const list = useLoad(() => api('GET', '/v1/credit_notes', { limit: 100, expand: ['data.customer'] }), []);
  const { navigate } = useRouter();
  return (
    <>
      <PageHead title="Credit notes" sub="Adjustments to finalized invoices: lower an amount due, refund, or credit the customer's balance." />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No credit notes yet. Issue one from an open or paid invoice.</Empty> : (
          <table className="table"><thead><tr><th>Number</th><th>Customer</th><th>Type</th><th className="num">Total</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{list.data.data.map((cn: any) => (
              <tr key={cn.id} className="clickable" onClick={() => navigate(`/invoices/${cn.invoice}`)}><td className="mono">{cn.number}</td><td>{cn.customer?.name ?? cn.customer?.email ?? '—'}</td><td className="soft">{cn.type === 'pre_payment' ? 'Before payment' : 'After payment'}</td><td className="num amount">{money(cn.total, cn.currency)}</td><td><CreditNoteStatus s={cn.status} /></td><td className="soft">{date(cn.created)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// ---------------- Shipping rates ----------------
const estimate = (e: any) => {
  if (!e || (!e.minimum && !e.maximum)) return '—';
  const u = (b: any) => `${b.unit.replace('_', ' ')}${b.value === 1 ? '' : 's'}`;
  if (e.minimum && e.maximum) return `${e.minimum.value}–${e.maximum.value} ${u(e.maximum)}`;
  const b = e.minimum ?? e.maximum;
  return `${e.minimum ? 'At least' : 'Up to'} ${b.value} ${u(b)}`;
};

export function ShippingRates() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/shipping_rates', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: 'Standard shipping', amount: '5.00', currency: 'usd', min: '3', max: '5', unit: 'business_day', tax: 'exclusive' });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try {
      await api('POST', '/v1/shipping_rates', {
        display_name: f.name, type: 'fixed_amount', fixed_amount: { amount: toMinor(f.amount, f.currency), currency: f.currency }, tax_behavior: f.tax,
        ...(f.min || f.max ? { delivery_estimate: { ...(f.min ? { minimum: { unit: f.unit, value: f.min } } : {}), ...(f.max ? { maximum: { unit: f.unit, value: f.max } } : {}) } } : {}),
      });
      setOpen(false); list.reload(); toast('Shipping rate created');
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Shipping rates" sub="Fixed shipping charges you offer at checkout and on payment links." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create shipping rate</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No shipping rates yet.</Empty> : (
          <table className="table"><thead><tr><th>Name</th><th className="num">Price</th><th>Delivery</th><th>Tax</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.data.map((r: any) => (
              <tr key={r.id}><td><strong>{r.display_name}</strong><div className="mono muted" style={{ fontSize: 12 }}>{r.id}</div></td><td className="num amount">{r.fixed_amount.amount ? money(r.fixed_amount.amount, r.fixed_amount.currency) : 'Free'}</td><td className="soft">{estimate(r.delivery_estimate)}</td><td className="soft">{r.tax_behavior}</td>
                <td>{r.active ? <Badge kind="success">Active</Badge> : <Badge>Archived</Badge>}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/shipping_rates/${r.id}`, { active: String(!r.active) }); list.reload(); }}>{r.active ? 'Archive' : 'Restore'}</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a shipping rate" footer={<button className="btn btn-primary" onClick={create}>Create</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Name customers see"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="Price"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'eur', 'gbp', 'cad'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
          </div>
          <div className="form-row">
            <Field label="Arrives in at least"><input className="input" type="number" min={1} value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></Field>
            <Field label="At most"><input className="input" type="number" min={1} value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></Field>
            <Field label="Unit"><select className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}><option value="business_day">Business days</option><option value="day">Days</option><option value="week">Weeks</option><option value="hour">Hours</option></select></Field>
          </div>
          <Field label="Tax behavior" hint="Exclusive adds tax on top of the shipping price when automatic tax is on."><select className="input" value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value })}><option value="exclusive">Exclusive</option><option value="inclusive">Inclusive</option><option value="unspecified">Unspecified</option></select></Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------- Identity ----------------
const VS: Record<string, ['neutral' | 'info' | 'success' | 'warning' | 'danger', string]> = { requires_input: ['warning', 'Requires input'], processing: ['info', 'Processing'], verified: ['success', 'Verified'], canceled: ['neutral', 'Canceled'] };
export const VerificationStatus = ({ s }: { s: any }) => <Badge kind={VS[s.status]?.[0] ?? 'neutral'}>{s.status === 'requires_input' && !s.last_error ? 'Not started' : VS[s.status]?.[1] ?? s.status}</Badge>;

export function Identity() {
  const { navigate } = useRouter();
  const list = useLoad(() => api('GET', '/v1/identity/verification_sessions', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ type: 'document', selfie: false, idnum: false, email: '', ref: '', types: { driving_license: true, id_card: true, passport: true } as Record<string, boolean> });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try {
      const s = await api('POST', '/v1/identity/verification_sessions', {
        type: f.type, client_reference_id: f.ref || undefined, provided_details: f.email ? { email: f.email } : undefined, return_url: `${location.origin}/identity`,
        ...(f.type === 'document' ? { options: { document: { allowed_types: Object.keys(f.types).filter((k) => f.types[k]), require_matching_selfie: String(f.selfie), require_id_number: String(f.idnum) } } } : {}),
      });
      navigate(`/identity/${s.id}`);
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Identity" sub="Verification sessions: send someone a link to confirm who they are with a document or an ID number (simulated in test mode)." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ New verification</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No verification sessions yet.</Empty> : (
          <table className="table"><thead><tr><th>Session</th><th>Type</th><th>Status</th><th>Last error</th><th>Reference</th><th>Created</th></tr></thead>
            <tbody>{list.data.data.map((s: any) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/identity/${s.id}`)}><td className="mono">{s.id}</td><td>{s.type === 'document' ? 'Document' : 'ID number'}</td><td><VerificationStatus s={s} /></td><td className="soft">{s.last_error?.code?.replace(/_/g, ' ') ?? '—'}</td><td className="soft">{s.client_reference_id ?? '—'}</td><td className="soft">{date(s.created)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New verification session" footer={<button className="btn btn-primary" onClick={create}>Create</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Verify with"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="document">A photo ID document</option><option value="id_number">An ID number (e.g. SSN)</option></select></Field>
          {f.type === 'document' && <>
            <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}><legend className="soft" style={{ marginBottom: 6 }}>Accepted documents</legend>
              {[['driving_license', "Driver's license"], ['id_card', 'ID card'], ['passport', 'Passport']].map(([k, l]) => <label key={k} className="row"><input type="checkbox" checked={f.types[k]} onChange={(e) => setF({ ...f, types: { ...f.types, [k!]: e.target.checked } })} /> {l}</label>)}
            </fieldset>
            <label className="row"><input type="checkbox" checked={f.selfie} onChange={(e) => setF({ ...f, selfie: e.target.checked })} /> Require a matching selfie</label>
            <label className="row"><input type="checkbox" checked={f.idnum} onChange={(e) => setF({ ...f, idnum: e.target.checked })} /> Also collect an ID number</label>
          </>}
          <div className="form-row">
            <Field label="Email (optional)"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Your reference (optional)"><input className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function VerificationDetail({ id }: { id: string }) {
  const toast = useToast();
  const s = useLoad(() => api('GET', `/v1/identity/verification_sessions/${id}`, { expand: ['verified_outputs', 'last_verification_report'] }), [id]);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (s.data?.status !== 'processing') return;
    const t = setTimeout(() => s.reload(), 1500);
    return () => clearTimeout(t);
  }, [s.data]);
  if (!s.data) return s.error ? <ErrorNote error={s.error} /> : <Card><Skeleton /></Card>;
  const v = s.data;
  const r = v.last_verification_report;
  const act = async (path: string, msg: string) => { setErr(null); try { await api('POST', `/v1/identity/verification_sessions/${id}/${path}`); toast(msg); s.reload(); } catch (e) { setErr(e); } };
  const o = v.verified_outputs;
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/identity">Identity</Link> / <span className="mono">{id}</span></div>
      <PageHead title={o?.first_name ? `${o.first_name} ${o.last_name}` : v.type === 'document' ? 'Document verification' : 'ID number verification'} sub={<span className="row"><VerificationStatus s={v} />{v.redaction?.status === 'redacted' && <Badge>Redacted</Badge>}</span>} actions={<>
        {v.status === 'requires_input' && <><button className="btn btn-secondary" onClick={() => copy(v.url, toast)}>Copy link</button><a className="btn btn-primary" href={v.url} target="_blank" rel="noreferrer">Open verification page</a></>}
        {v.status === 'requires_input' && <button className="btn btn-secondary" onClick={() => act('cancel', 'Verification canceled')}>Cancel</button>}
        {v.status !== 'processing' && v.redaction?.status !== 'redacted' && <button className="btn btn-danger" onClick={() => confirm('Permanently erase the collected details?') && act('redact', 'Session redacted')}>Redact</button>}
      </>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 8 }}>
        <div className="stack">
          {v.last_error && <div className="alert alert-warning"><strong>{v.last_error.code.replace(/_/g, ' ')}</strong>: {v.last_error.reason} The person can try again with the same link.</div>}
          {v.status === 'processing' && <div className="alert alert-info">Checking the submitted details…</div>}
          {o && <Card title="Verified details">
            <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
              <dt>Name</dt><dd>{o.first_name ?? '—'} {o.last_name ?? ''}</dd>
              <dt>Date of birth</dt><dd>{o.dob ? `${o.dob.year}-${String(o.dob.month).padStart(2, '0')}-${String(o.dob.day).padStart(2, '0')}` : '—'}</dd>
              {o.id_number_type && <><dt>ID number</dt><dd className="mono">•••••{String(o.id_number ?? '').slice(-4)} ({o.id_number_type})</dd></>}
              {o.email && <><dt>Email</dt><dd>{o.email}</dd></>}
            </dl>
          </Card>}
          {r && typeof r === 'object' && <Card title="Latest report">
            <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
              {r.document && <><dt>Document</dt><dd>{r.document.status === 'verified' ? <Badge kind="success">Verified</Badge> : <Badge kind="danger">Unverified</Badge>} <span className="soft">{r.document.type?.replace('_', ' ')} · {r.document.issuing_country}{r.document.expiration_date ? ` · expires ${r.document.expiration_date.year}` : ''}</span></dd></>}
              {r.selfie && <><dt>Selfie</dt><dd>{r.selfie.status === 'verified' ? <Badge kind="success">Matches</Badge> : <Badge kind="danger">No match</Badge>}</dd></>}
              {r.id_number && <><dt>ID number</dt><dd>{r.id_number.status === 'verified' ? <Badge kind="success">Verified</Badge> : <Badge kind="danger">Unverified</Badge>}</dd></>}
              <dt>Report</dt><dd className="mono">{r.id}</dd>
            </dl>
          </Card>}
          <Card title="Verification session object"><Json value={v} /></Card>
        </div>
        <Card title="Details">
          <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>Type</dt><dd>{v.type === 'document' ? 'Document' : 'ID number'}</dd>
            {v.type === 'document' && <><dt>Accepts</dt><dd>{v.options.document.allowed_types.map((t: string) => t.replace('_', ' ')).join(', ')}</dd><dt>Selfie</dt><dd>{v.options.document.require_matching_selfie ? 'Required' : 'No'}</dd></>}
            <dt>Created</dt><dd>{dateLong(v.created)}</dd>
            {v.client_reference_id && <><dt>Reference</dt><dd>{v.client_reference_id}</dd></>}
          </dl>
        </Card>
      </div>
    </>
  );
}

/** Hosted verification page (what the person being verified sees). */
export function Verify({ token }: { token: string }) {
  const v = useLoad(() => hosted('GET', `/identity/${token}`), [token]);
  const [f, setF] = useState({ first_name: '', last_name: '', day: '', month: '', year: '', document_type: '', id_number: '', outcome: 'verified', issuing_country: 'US' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const embedded = new URLSearchParams(location.search).get('embedded') === '1';
  const post = (event: string) => { if (embedded) window.parent.postMessage({ type: 'tessera:identity', event }, location.origin); };
  useEffect(() => { if (v.data) document.title = `Verify your identity · ${v.data.merchant_name}`; }, [v.data]);
  useEffect(() => {
    if (!submitted || v.data?.status !== 'processing') return;
    const t = setTimeout(() => v.reload(), 1200);
    return () => clearTimeout(t);
  }, [submitted, v.data]);
  if (v.loading && !v.data) return <div className="center-page"><Skeleton /></div>;
  if (v.error) return <div className="center-page"><ErrorNote error={v.error} /></div>;
  const d = v.data;
  const docLabel: Record<string, string> = { driving_license: "Driver's license", id_card: 'ID card', passport: 'Passport' };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await hosted('POST', `/identity/${token}/submit`, { first_name: f.first_name, last_name: f.last_name, dob: { day: f.day, month: f.month, year: f.year }, document_type: f.document_type || d.allowed_types[0], id_number: f.id_number || undefined, outcome: f.outcome, issuing_country: f.issuing_country });
      setSubmitted(true);
      v.reload();
      setTimeout(() => post('submitted'), 1500);
    } catch (e) { setErr(e instanceof ApiErr ? e.body.error ?? e : e); } finally { setBusy(false); }
  }
  const done = d.status === 'verified';
  return (
    <div className="onboard-page">
      <div className="test-band" style={{ position: 'fixed', top: 0, left: 0, right: 0 }} aria-hidden="true" />
      <div className="onboard-wrap">
        <div className="onboard-head"><div className="mark" aria-hidden="true">{d.merchant_name.slice(0, 1)}</div><strong>{d.merchant_name}</strong><Badge kind="test">Test mode</Badge>{embedded && <><span className="spacer" style={{ flex: 1 }} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => post(submitted ? 'submitted' : 'closed')}>Close</button></>}</div>
        <div className="card card-body stack">
          {done ? (
            <div className="stack" role="status">
              <h1 style={{ margin: 0, fontSize: 24 }}>You're verified</h1>
              <p className="soft" style={{ margin: 0 }}>{d.merchant_name} has been told that your identity was confirmed.</p>
              {d.return_url && <a className="btn btn-primary" href={d.return_url}>Return to {d.merchant_name}</a>}
            </div>
          ) : d.status === 'processing' ? (
            <div className="stack" role="status"><h1 style={{ margin: 0, fontSize: 24 }}>Checking your details…</h1><p className="soft" style={{ margin: 0 }}>This usually takes a few seconds. You can keep this page open.</p></div>
          ) : d.status === 'canceled' ? (
            <div className="alert alert-warning">This verification was canceled by {d.merchant_name}.</div>
          ) : (
            <form className="form-grid" onSubmit={submit}>
              <div><h1 style={{ margin: 0, fontSize: 24 }}>Verify your identity</h1><p className="soft" style={{ margin: '6px 0 0' }}>{d.merchant_name} needs to confirm who you are{d.type === 'document' ? ' with a photo ID' : ''}.</p></div>
              {d.last_error && <div className="alert alert-error">{d.last_error.reason} Please try again.</div>}
              <ErrorNote error={err} />
              <div className="form-row">
                <Field label="First name"><input className="input" required value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} autoComplete="given-name" /></Field>
                <Field label="Last name"><input className="input" required value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} autoComplete="family-name" /></Field>
              </div>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="soft" style={{ fontSize: 13, marginBottom: 4 }}>Date of birth</legend><div className="dob-row">
                <Field label="Day"><input className="input" required inputMode="numeric" maxLength={2} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} autoComplete="bday-day" /></Field>
                <Field label="Month"><input className="input" required inputMode="numeric" maxLength={2} value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} autoComplete="bday-month" /></Field>
                <Field label="Year"><input className="input" required inputMode="numeric" maxLength={4} value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} autoComplete="bday-year" /></Field>
              </div></fieldset>
              {d.type === 'document' && <>
                <Field label="Document"><select className="input" value={f.document_type || d.allowed_types[0]} onChange={(e) => setF({ ...f, document_type: e.target.value })}>{d.allowed_types.map((t: string) => <option key={t} value={t}>{docLabel[t] ?? t}</option>)}</select></Field>
                <div className="alert alert-info">In test mode no photo is taken. Choose the result to simulate below.{d.require_selfie ? ' A selfie would also be compared with the document photo.' : ''}</div>
              </>}
              {d.require_id_number && <Field label="ID number" hint="US Social Security number in test mode. Use 000000000."><input className="input mono" required value={f.id_number} onChange={(e) => setF({ ...f, id_number: e.target.value })} /></Field>}
              <Field label="Test result">
                <select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{d.outcomes.map((o: any) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
              </Field>
              <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>Your details are shared with {d.merchant_name} only to confirm your identity.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
