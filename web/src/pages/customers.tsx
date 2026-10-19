import { useState } from 'react';
import { SavedCards } from './savedCards.tsx';
import { api, date, Link, useLoad, useRouter, useToast } from '../lib.tsx';
import { Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton } from '../ui.tsx';
import { CreatePaymentModal, PaymentsTable } from './payments.tsx';
import { CreateSubscriptionModal, InvoiceTable, SubStatus } from './billing.tsx';
import { BalanceCard } from './finance.tsx';
import { CashBalanceCard } from './treasury.tsx';
import { LinkedAccountsCard } from './services.tsx';
import { TaxIdsCard } from './b2b.tsx';
import { CreditGrantsCard, EntitlementsCard } from './billing2.tsx';

export function Customers() {
  const { navigate } = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', description: '' });
  const [err, setErr] = useState<any>(null);
  const qq = q.trim().replace(/["\\]/g, '');
  const list = useLoad(() => (qq.length >= 3 ? api('GET', '/v1/customers/search', { query: `email~"${qq}" OR name~"${qq}"`, limit: 100 }) : api('GET', '/v1/customers', { limit: 100 })), [qq]);
  async function create() {
    setErr(null);
    try {
      const c = await api('POST', '/v1/customers', form);
      toast('Customer created');
      setOpen(false);
      navigate(`/customers/${c.id}`);
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Customers" actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Add customer</button>} />
      <div style={{ marginBottom: 12, maxWidth: 360 }}><input className="input" placeholder="Search by email" aria-label="Search customers by email" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Card pad={false}>
        {list.loading && !list.data ? <Skeleton /> : list.error ? <div className="card-body"><ErrorNote error={list.error} /></div> : !list.data.data.length ? <Empty>No customers found.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>ID</th><th>Created</th></tr></thead>
            <tbody>{list.data.data.map((c: any) => (
              <tr key={c.id} className="clickable" onClick={() => navigate(`/customers/${c.id}`)}><td>{c.name ?? '—'}</td><td>{c.email ?? '—'}</td><td className="mono soft">{c.id}</td><td className="soft">{date(c.created)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a customer" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Add customer</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

export function CustomerDetail({ id }: { id: string }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const c = useLoad(() => api('GET', `/v1/customers/${id}`), [id]);
  const charges = useLoad(() => api('GET', '/v1/charges', { customer: id, limit: 100 }), [id]);
  const subs = useLoad(() => api('GET', '/v1/subscriptions', { customer: id, status: 'all', limit: 100, expand: ['data.items.data.price.product'] }), [id]);
  const invs = useLoad(() => api('GET', '/v1/invoices', { customer: id, limit: 100 }), [id]);
  const [pay, setPay] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  if (c.loading && !c.data) return <Card><Skeleton /></Card>;
  if (c.error) return <ErrorNote error={c.error} />;
  if (c.data.deleted) return <Empty>This customer was deleted.</Empty>;
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/customers">Customers</Link> / <span className="mono">{id}</span></div>
      <PageHead title={c.data.name ?? c.data.email ?? id} sub={c.data.email}
        actions={<>
          <button className="btn btn-primary" onClick={() => setPay(true)}>Create payment</button>
          <button className="btn btn-secondary" onClick={() => setSubOpen(true)}>Create subscription</button>
          <button className="btn btn-secondary" onClick={async () => { try { const s = await api('POST', '/v1/billing_portal/sessions', { customer: id, return_url: location.href }); window.open(s.url, '_blank', 'noopener'); } catch (e: any) { toast(e.message, 'error'); } }}>Open portal</button>
          <button className="btn btn-danger" onClick={async () => { if (!confirm('Delete this customer?')) return; await api('DELETE', `/v1/customers/${id}`); toast('Customer deleted'); navigate('/customers'); }}>Delete</button>
        </>} />
      <div className="grid grid-3-1">
        <div className="stack">
          <Card title="Subscriptions" pad={false}>
            {!subs.data?.data.length ? <Empty>No subscriptions.</Empty> : (
              <table className="table"><tbody>{subs.data.data.map((s: any) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`/subscriptions/${s.id}`)}><td>{s.items.data.map((it: any) => `${it.quantity} × ${it.price.product?.name ?? it.price.product}`).join(', ')}</td><td><SubStatus s={s.status} /></td></tr>
              ))}</tbody></table>
            )}
          </Card>
          <Card title="Payments" pad={false}>{charges.data ? <PaymentsTable charges={charges.data.data} /> : <Skeleton />}</Card>
          <Card title="Invoices" pad={false}><InvoiceTable invoices={invs.data?.data} /></Card>
          <Card title="Customer object"><Json value={c.data} /></Card>
        </div>
        <div className="stack">
          <BalanceCard customer={c.data} onChange={() => { c.reload(); invs.reload(); }} />
          <EntitlementsCard customer={id} />
          <CreditGrantsCard customer={id} currency={c.data.currency ?? 'usd'} />
          <CashBalanceCard customer={c.data} />
          <LinkedAccountsCard customer={c.data} />
          <TaxIdsCard customer={c.data} />
          <AddressCard c={c.data} onSaved={() => c.reload()} />
          <SavedCards customer={id} defaultPm={c.data.invoice_settings?.default_payment_method ?? null} onChange={() => { c.reload(); charges.reload(); }} />
        </div>
      </div>
      <CreatePaymentModal open={pay} onClose={() => setPay(false)} onDone={() => charges.reload()} customer={id} />
      <CreateSubscriptionModal open={subOpen} customer={id} onClose={() => setSubOpen(false)} onDone={(s) => navigate(`/subscriptions/${s.id}`)} />
    </>
  );
}

/** Address and tax status: automatic tax uses the address to find the jurisdiction. */
function AddressCard({ c, onSaved }: { c: any; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const a = c.address ?? {};
  const [f, setF] = useState({ line1: a.line1 ?? '', city: a.city ?? '', state: a.state ?? '', postal_code: a.postal_code ?? '', country: a.country ?? 'US', tax_exempt: c.tax_exempt ?? 'none' });
  const located = a.country && (!['US', 'CA'].includes(a.country) || a.state);
  async function save() {
    try {
      await api('POST', `/v1/customers/${c.id}`, { address: { line1: f.line1, city: f.city, state: f.state, postal_code: f.postal_code, country: f.country }, tax_exempt: f.tax_exempt });
      toast('Customer updated'); setOpen(false); onSaved();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <Card title="Address and tax" actions={<button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Edit</button>}>
      <dl className="kv" style={{ gridTemplateColumns: '90px 1fr' }}>
        <dt>Address</dt><dd>{a.country ? [a.line1, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ') : <span className="muted">None</span>}</dd>
        <dt>Tax status</dt><dd>{c.tax_exempt === 'exempt' ? 'Exempt' : c.tax_exempt === 'reverse' ? 'Reverse charge' : 'Taxable'}</dd>
        <dt>Auto tax</dt><dd>{located ? 'Location recognized' : <span className="muted">Needs country (+ state in US/CA)</span>}</dd>
      </dl>
      <Modal open={open} onClose={() => setOpen(false)} title="Address and tax" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
        <div className="form-grid">
          <Field label="Address"><input className="input" value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="City"><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
            <Field label="State / province"><input className="input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Postal code"><input className="input" value={f.postal_code} onChange={(e) => setF({ ...f, postal_code: e.target.value })} /></Field>
            <Field label="Country"><input className="input" maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
          </div>
          <Field label="Tax status"><select className="input" value={f.tax_exempt} onChange={(e) => setF({ ...f, tax_exempt: e.target.value })}><option value="none">Taxable</option><option value="exempt">Exempt</option><option value="reverse">Reverse charge (EU/UK business)</option></select></Field>
        </div>
      </Modal>
    </Card>
  );
}
