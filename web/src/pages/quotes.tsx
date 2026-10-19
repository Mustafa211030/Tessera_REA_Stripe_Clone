import { useState } from 'react';
import { api, ApiErr, date, dateLong, Link, money, priceText, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton } from '../ui.tsx';
import { TaxRows } from './billing.tsx';

const STATUS: Record<string, ['neutral' | 'info' | 'success' | 'warning', string]> = { draft: ['neutral', 'Draft'], open: ['info', 'Open'], accepted: ['success', 'Accepted'], canceled: ['neutral', 'Canceled'] };
export const QuoteStatus = ({ q }: { q: any }) => {
  const expired = q.status === 'open' && q.expires_at < Date.now() / 1000;
  const [kind, label] = expired ? (['warning', 'Expired'] as const) : STATUS[q.status] ?? ['neutral', q.status];
  return <Badge kind={kind}>{label}</Badge>;
};

export function Quotes() {
  const { navigate } = useRouter();
  const list = useLoad(() => api('GET', '/v1/quotes', { limit: 100, expand: ['data.customer'] }), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Quotes" sub="Priced offers your customer accepts. Accepting creates the subscription or invoice automatically." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create quote</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No quotes yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="num">Upfront</th><th>Recurring</th><th>Status</th><th>Customer</th><th>Number</th><th>Expires</th></tr></thead>
            <tbody>{list.data.data.map((q: any) => (
              <tr key={q.id} className="clickable" onClick={() => navigate(`/quotes/${q.id}`)}>
                <td className="num amount">{money(q.amount_total, q.currency)}</td>
                <td className="soft">{q.computed.recurring ? `${money(q.computed.recurring.amount_total, q.currency)} / ${q.computed.recurring.interval}` : '—'}</td>
                <td><QuoteStatus q={q} /></td>
                <td>{q.customer?.name ?? q.customer?.email ?? '—'}</td>
                <td className="mono soft">{q.number ?? '—'}</td>
                <td className="soft">{date(q.expires_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <CreateQuoteModal open={open} onClose={() => setOpen(false)} onDone={(q) => navigate(`/quotes/${q.id}`)} />
    </>
  );
}

function CreateQuoteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (q: any) => void }) {
  const customers = useLoad(() => (open ? api('GET', '/v1/customers', { limit: 100 }) : Promise.resolve({ data: [] })), [open]);
  const prices = useLoad(() => (open ? api('GET', '/v1/prices', { active: 'true', limit: 100, expand: ['data.product'] }) : Promise.resolve({ data: [] })), [open]);
  const coupons = useLoad(() => (open ? api('GET', '/v1/coupons', { limit: 100 }) : Promise.resolve({ data: [] })), [open]);
  const rates = useLoad(() => (open ? api('GET', '/v1/tax_rates', { active: 'true', limit: 100 }) : Promise.resolve({ data: [] })), [open]);
  const [customer, setCustomer] = useState('');
  const [lines, setLines] = useState<{ price: string; quantity: string }[]>([{ price: '', quantity: '1' }]);
  const [coupon, setCoupon] = useState('');
  const [tax, setTax] = useState('');
  const [trial, setTrial] = useState('');
  const [days, setDays] = useState('30');
  const [header, setHeader] = useState('');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const priceLabel = (p: any) => `${p.product?.name ?? p.product} · ${priceText(p)}`;
  async function create() {
    setBusy(true); setErr(null);
    try {
      const q = await api('POST', '/v1/quotes', {
        customer: customer || undefined,
        line_items: lines.filter((l) => l.price).map((l) => ({ price: l.price, quantity: l.quantity })),
        discounts: coupon ? [{ coupon }] : undefined,
        automatic_tax: tax === 'automatic' ? { enabled: 'true' } : undefined,
        default_tax_rates: tax && tax !== 'automatic' ? [tax] : undefined,
        subscription_data: trial ? { trial_period_days: trial } : undefined,
        expires_at: Math.floor(Date.now() / 1000) + Number(days || 30) * 86400,
        header: header || undefined,
      });
      onClose();
      onDone(q);
    } catch (e) { setErr(e instanceof ApiErr ? e : { message: String(e) }); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Create quote" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !lines.some((l) => l.price)} onClick={create}>Create draft</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Customer"><select className="input" value={customer} onChange={(e) => setCustomer(e.target.value)}><option value="">Choose a customer…</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}</select></Field>
        <Field label="Header (optional)"><input className="input" value={header} placeholder="e.g. Annual onboarding package" onChange={(e) => setHeader(e.target.value)} /></Field>
        {lines.map((l, i) => (
          <div key={i} className="form-row">
            <Field label={i === 0 ? 'Items' : ' '}><select className="input" value={l.price} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))}><option value="">Choose a price…</option>{prices.data?.data.map((p: any) => <option key={p.id} value={p.id}>{priceLabel(p)}</option>)}</select></Field>
            <Field label={i === 0 ? 'Qty' : ' '}><input className="input" type="number" min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} /></Field>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setLines([...lines, { price: '', quantity: '1' }])}>+ Add item</button>
        <div className="form-row">
          <Field label="Coupon"><select className="input" value={coupon} onChange={(e) => setCoupon(e.target.value)}><option value="">None</option>{coupons.data?.data.filter((c: any) => c.valid).map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.id} ({c.percent_off ? `${c.percent_off}%` : money(c.amount_off, c.currency)} off)</option>)}</select></Field>
          <Field label="Tax"><select className="input" value={tax} onChange={(e) => setTax(e.target.value)}><option value="">No tax</option><option value="automatic">Automatic (customer address)</option>{rates.data?.data.map((r: any) => <option key={r.id} value={r.id}>{r.display_name} {r.percentage}%{r.inclusive ? ' incl.' : ''}</option>)}</select></Field>
        </div>
        <div className="form-row">
          <Field label="Free trial (days, recurring items)"><input className="input" type="number" min={0} value={trial} onChange={(e) => setTrial(e.target.value)} /></Field>
          <Field label="Valid for (days)"><input className="input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export function QuoteDetail({ id }: { id: string }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const q = useLoad(() => api('GET', `/v1/quotes/${id}`, { expand: ['customer'] }), [id]);
  const lines = useLoad(() => api('GET', `/v1/quotes/${id}/line_items`), [id]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [pdfOpen, setPdfOpen] = useState<string | null>(null);
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : <Card><Skeleton /></Card>;
  const d = q.data;
  const act = async (path: string, msg: string) => {
    setBusy(true); setErr(null);
    try { await api('POST', `/v1/quotes/${id}/${path}`); toast(msg); q.reload(); lines.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  async function pdf() {
    const res = await fetch(`/v1/quotes/${id}/pdf`, { credentials: 'same-origin' });
    if (!res.ok) { setErr((await res.json()).error); return; }
    setPdfOpen(URL.createObjectURL(await res.blob()));
  }
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/quotes">Quotes</Link> / <span className="mono">{d.number ?? d.id}</span></div>
      <PageHead title={money(d.amount_total, d.currency)} sub={<span className="row"><QuoteStatus q={d} />{d.customer && <Link to={`/customers/${d.customer.id}`}>{d.customer.name ?? d.customer.email}</Link>}{d.computed.recurring && <span className="soft">then {money(d.computed.recurring.amount_total, d.currency)} / {d.computed.recurring.interval}</span>}</span>}
        actions={<>
          {d.status === 'draft' && <button className="btn btn-primary" disabled={busy || !d.customer} onClick={() => act('finalize', 'Quote finalized')}>Finalize</button>}
          {d.status === 'open' && <button className="btn btn-primary" disabled={busy} onClick={() => act('accept', 'Quote accepted')}>Mark accepted</button>}
          {d.status !== 'draft' && <button className="btn btn-secondary" onClick={pdf}>Download PDF</button>}
          {['draft', 'open'].includes(d.status) && <button className="btn btn-secondary" disabled={busy} onClick={() => act('cancel', 'Quote canceled')}>Cancel quote</button>}
        </>} />
      <ErrorNote error={err} />
      {d.status === 'accepted' && <div className="alert alert-info" style={{ marginTop: 12 }}>Accepted {dateLong(d.status_transitions.accepted_at)}. {d.subscription && <Link to={`/subscriptions/${d.subscription}`}>View subscription</Link>} {d.invoice && <Link to={`/invoices/${d.invoice}`}>View invoice</Link>}</div>}
      <div className="grid grid-3-1" style={{ marginTop: 12 }}>
        <div className="stack">
          <Card title={d.header ?? 'Items'} pad={false}>
            <table className="table">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {lines.data?.data.map((l: any) => <tr key={l.id}><td>{l.description}{l.price.recurring && <span className="muted"> · per {l.price.recurring.interval}</span>}</td><td className="num">{l.quantity}</td><td className="num">{l.price.unit_amount !== null ? money(l.price.unit_amount, l.currency) : '—'}</td><td className="num">{money(l.amount_subtotal, l.currency)}</td></tr>)}
                <tr><td colSpan={3} className="soft">Subtotal</td><td className="num">{money(d.amount_subtotal, d.currency)}</td></tr>
                {d.total_details.amount_discount > 0 && <tr><td colSpan={3} className="soft">Discount</td><td className="num">−{money(d.total_details.amount_discount, d.currency)}</td></tr>}
                <TaxRows amounts={d.total_details.breakdown?.taxes?.map((t: any) => ({ tax_rate: t.rate, amount: t.amount, inclusive: false }))} currency={d.currency} colSpan={3} />
                <tr><td colSpan={3}><strong>{d.computed.recurring ? 'Due on first invoice' : 'Total'}</strong></td><td className="num amount">{money(d.amount_total, d.currency)}</td></tr>
                {d.computed.recurring && <tr><td colSpan={3} className="soft">Then every {d.computed.recurring.interval_count > 1 ? `${d.computed.recurring.interval_count} ` : ''}{d.computed.recurring.interval}</td><td className="num">{money(d.computed.recurring.amount_total, d.currency)}</td></tr>}
              </tbody>
            </table>
          </Card>
          <Card title="Quote object"><Json value={d} /></Card>
        </div>
        <Card title="Details">
          <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>Number</dt><dd className="mono">{d.number ?? 'Assigned on finalize'}</dd>
            <dt>Expires</dt><dd>{dateLong(d.expires_at)}</dd>
            <dt>Collection</dt><dd>{d.collection_method.replace(/_/g, ' ')}</dd>
            {d.subscription_data.trial_period_days && <><dt>Trial</dt><dd>{d.subscription_data.trial_period_days} days</dd></>}
            <dt>Tax</dt><dd>{d.automatic_tax.enabled ? `Automatic (${d.automatic_tax.status?.replace(/_/g, ' ')})` : d.default_tax_rates.length ? 'Tax rate' : 'None'}</dd>
          </dl>
          {!d.customer && <div className="alert alert-warning" style={{ marginTop: 12 }}>Add a customer before finalizing.</div>}
        </Card>
      </div>
      <Modal open={!!pdfOpen} onClose={() => setPdfOpen(null)} title={`Quote ${d.number}`} footer={<><a className="btn btn-secondary" href={pdfOpen ?? '#'} download={`${d.number}.pdf`}>Save PDF</a><button className="btn btn-primary" onClick={() => setPdfOpen(null)}>Close</button></>}>
        {pdfOpen && <iframe title="Quote PDF" src={pdfOpen} style={{ width: 'min(720px, 80vw)', height: '70vh', border: 0 }} />}
      </Modal>
    </>
  );
  void navigate;
}
