import { useEffect, useState } from 'react';
import { api, date, Link, money, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHead, Skeleton } from '../ui.tsx';

const dayOnly = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' });

// ================================================================ Tax IDs

export const TAX_ID_TYPES: [string, string, string][] = [
  ['eu_vat', 'EU VAT', 'DE123456789'], ['gb_vat', 'UK VAT', 'GB123456789'], ['au_abn', 'Australian ABN', '12345678912'], ['us_ein', 'US EIN', '12-3456789'],
  ['ca_bn', 'Canadian BN', '123456789'], ['ch_vat', 'Swiss VAT', 'CHE-123.456.789 MWST'], ['no_vat', 'Norwegian VAT', '123456789MVA'], ['in_gst', 'Indian GST', '12ABCDE3456FGZH'],
  ['jp_cn', 'Japanese corporate number', '1234567891234'], ['br_cnpj', 'Brazilian CNPJ', '01.234.456/5432-10'], ['mx_rfc', 'Mexican RFC', 'ABC010203AB9'],
  ['nz_gst', 'New Zealand GST', '123456789'], ['sg_uen', 'Singapore UEN', '123456789F'], ['za_vat', 'South African VAT', '4123456789'],
];
const VERIFY: Record<string, [string, any]> = { verified: ['Verified', 'success'], pending: ['Verifying…', 'info'], unverified: ['Not verified', 'danger'], unavailable: ['Format checked', 'neutral'] };

export function TaxIdsCard({ customer }: { customer: any }) {
  const toast = useToast();
  const list = useLoad(() => api('GET', `/v1/customers/${customer.id}/tax_ids`, { limit: 25 }), [customer.id]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ type: 'eu_vat', value: '' });
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (!list.data?.data.some((t: any) => t.verification.status === 'pending')) return;
    const t = setTimeout(() => list.reload(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);
  async function add() {
    setErr(null);
    try { await api('POST', `/v1/customers/${customer.id}/tax_ids`, f); setOpen(false); setF({ ...f, value: '' }); toast('Tax ID added'); list.reload(); } catch (e) { setErr(e); }
  }
  const example = TAX_ID_TYPES.find((t) => t[0] === f.type)?.[2];
  return (
    <Card title="Tax IDs" actions={<button className="btn btn-ghost btn-sm" onClick={() => { setErr(null); setOpen(true); }}>+ Add</button>}>
      {!list.data ? <Skeleton rows={1} /> : !list.data.data.length ? <span className="muted">None. A verified EU or UK VAT number makes cross-border sales reverse-charged.</span> : (
        <div className="stack" style={{ gap: 8 }}>{list.data.data.map((t: any) => (
          <div key={t.id} className="row" style={{ flexWrap: 'wrap' }}>
            <div><div className="mono">{t.value}</div><div className="muted" style={{ fontSize: 12 }}>{TAX_ID_TYPES.find((x) => x[0] === t.type)?.[1] ?? t.type} · {t.country}{t.verification.verified_name ? ` · ${t.verification.verified_name}` : ''}</div></div>
            <span className="spacer" />
            <Badge kind={VERIFY[t.verification.status]?.[1]}>{VERIFY[t.verification.status]?.[0] ?? t.verification.status}</Badge>
            <button className="btn btn-ghost btn-sm" aria-label={`Remove ${t.value}`} onClick={async () => { await api('DELETE', `/v1/customers/${customer.id}/tax_ids/${t.id}`); toast('Tax ID removed'); list.reload(); }}>Remove</button>
          </div>
        ))}</div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add a tax ID" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!f.value} onClick={add}>Add tax ID</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Type"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TAX_ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Number" hint={<>For example <code>{example}</code>. Test numbers containing 111111111 fail verification; 222222222 can't be checked.</>}>
            <input className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder={example} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

// ================================================================ Payment plans

/** Draft send_invoice invoices can be split into installments; finalized ones show progress. */
export function PaymentPlanCard({ invoice, onChange }: { invoice: any; onChange: () => void }) {
  const toast = useToast();
  const [err, setErr] = useState<any>(null);
  const [n, setN] = useState(3);
  const [gap, setGap] = useState(30);
  const i = invoice;
  const plan = i.amounts_due as any[] | null;
  const editable = i.status === 'draft' && i.collection_method === 'send_invoice';
  if (!plan && !editable) return null;
  async function split() {
    setErr(null);
    // Equal parts; the first installment absorbs the rounding remainder.
    const total = i.amount_due;
    const part = Math.floor(total / n);
    const amounts_due = Array.from({ length: n }, (_, k) => ({ amount: k === 0 ? total - part * (n - 1) : part, days_until_due: k * gap, description: k === 0 ? 'Deposit' : `Installment ${k + 1}` }));
    try { await api('POST', `/v1/invoices/${i.id}`, { amounts_due }); toast('Payment plan set'); onChange(); } catch (e) { setErr(e); }
  }
  async function clear() {
    try { await api('POST', `/v1/invoices/${i.id}`, { amounts_due: '' }); toast('Payment plan removed'); onChange(); } catch (e) { setErr(e); }
  }
  const paid = (plan ?? []).filter((a) => a.status === 'paid').reduce((s, a) => s + a.amount, 0);
  return (
    <Card title="Payment plan" pad={false} actions={editable && plan ? <button className="btn btn-ghost btn-sm" onClick={clear}>Remove plan</button> : undefined}>
      <div style={{ padding: plan ? 0 : 16 }}>
        <ErrorNote error={err} />
        {plan ? (
          <table className="table">
            <thead><tr><th>Installment</th><th>Due</th><th>Status</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {plan.map((a, k) => (
                <tr key={k}><td>{a.description ?? `Installment ${k + 1}`}</td>
                  <td className="soft">{a.due_date ? dayOnly(a.due_date) : `${a.days_until_due} days after finalizing`}</td>
                  <td>{a.status === 'paid' ? <Badge kind="success">Paid</Badge> : a.due_date && a.due_date * 1000 < Date.now() && i.status === 'open' ? <Badge kind="danger">Overdue</Badge> : <Badge>{i.status === 'draft' ? 'Planned' : 'Open'}</Badge>}</td>
                  <td className="num amount">{money(a.amount, i.currency)}</td></tr>
              ))}
              {i.status !== 'draft' && <tr><td colSpan={3} className="soft">Paid so far</td><td className="num">{money(paid, i.currency)} of {money(i.amount_due, i.currency)}</td></tr>}
            </tbody>
          </table>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <p className="soft" style={{ margin: 0, flexBasis: '100%' }}>Let the customer pay {money(i.amount_due, i.currency)} in installments. They must add up to the amount due when you finalize.</p>
            <Field label="Installments"><select className="input" value={n} onChange={(e) => setN(Number(e.target.value))}>{[2, 3, 4, 6, 12].map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Every"><select className="input" value={gap} onChange={(e) => setGap(Number(e.target.value))}><option value={7}>Week</option><option value={14}>2 weeks</option><option value={30}>30 days</option></select></Field>
            <button className="btn btn-secondary" disabled={!i.amount_due} onClick={split}>Split invoice</button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ================================================================ Pause collection

const PAUSE_LABEL: Record<string, string> = { keep_as_draft: 'invoices stay as drafts', mark_uncollectible: 'invoices are marked uncollectible', void: 'invoices are voided' };

export function PauseBadge({ sub }: { sub: any }) {
  if (!sub.pause_collection) return null;
  return <Badge kind="warning">Collection paused{sub.pause_collection.resumes_at ? ` until ${dayOnly(sub.pause_collection.resumes_at)}` : ''}</Badge>;
}

export function PauseCollectionButton({ sub, onDone }: { sub: any; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ behavior: 'keep_as_draft', resumes: '' });
  const [err, setErr] = useState<any>(null);
  if (sub.pause_collection) {
    return <button className="btn btn-secondary" onClick={async () => { await api('POST', `/v1/subscriptions/${sub.id}`, { pause_collection: '' }); toast('Payment collection resumed'); onDone(); }}>Resume collection</button>;
  }
  async function save() {
    setErr(null);
    try {
      await api('POST', `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: f.behavior, ...(f.resumes ? { resumes_at: Math.floor(new Date(`${f.resumes}T00:00:00Z`).getTime() / 1000) } : {}) } });
      setOpen(false); toast('Payment collection paused'); onDone();
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <button className="btn btn-secondary" onClick={() => setOpen(true)}>Pause payments</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Pause payment collection" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={save}>Pause collection</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <p className="soft" style={{ margin: 0 }}>The subscription stays active and keeps renewing, but the customer isn't charged.</p>
          <Field label="Renewal invoices">
            <div className="stack">
              {Object.entries({ keep_as_draft: 'Keep as drafts, to collect later', mark_uncollectible: 'Mark uncollectible (offer the service for free)', void: 'Void (the service is not being provided)' }).map(([v, l]) => (
                <label key={v} className="choice"><input type="radio" name="behavior" checked={f.behavior === v} onChange={() => setF({ ...f, behavior: v })} /><div>{l}</div></label>
              ))}
            </div>
          </Field>
          <Field label="Resume on (optional)" hint="Leave empty to pause until you resume it."><input className="input" type="date" value={f.resumes} onChange={(e) => setF({ ...f, resumes: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

export const pauseDetail = (sub: any) => (sub.pause_collection ? `Paused: ${PAUSE_LABEL[sub.pause_collection.behavior]}${sub.pause_collection.resumes_at ? `, resumes ${dayOnly(sub.pause_collection.resumes_at)}` : ''}` : null);

// ================================================================ Search

const ID_ROUTES: [RegExp, (id: string) => string][] = [
  [/^cus_/, (id) => `/customers/${id}`], [/^pi_/, (id) => `/payments/${id}`], [/^in_/, (id) => `/invoices/${id}`], [/^sub_/, (id) => `/subscriptions/${id}`],
  [/^prod_/, (id) => `/products/${id}`], [/^dp_/, (id) => `/disputes/${id}`], [/^acct_/, (id) => `/connect/accounts/${id}`],
];

/** Top bar search: object IDs jump straight to the page; anything else opens /search. */
export function GlobalSearch() {
  const { navigate } = useRouter();
  const [q, setQ] = useState('');
  return (
    <form role="search" className="topbar-search" onSubmit={(e) => {
      e.preventDefault();
      const v = q.trim();
      if (!v) return;
      const hit = ID_ROUTES.find(([re]) => re.test(v));
      navigate(hit ? hit[1](v) : `/search?q=${encodeURIComponent(v)}`);
      setQ('');
    }}>
      <input className="input" type="search" aria-label="Search" placeholder="Search customers, payments, invoices…" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

const esc = (s: string) => s.replace(/["\\]/g, '');

/** Turns free text into one query per resource (or passes an advanced query through). */
function queriesFor(text: string): Record<string, string | null> {
  const t = esc(text.trim());
  const advanced = /[:~<>]/.test(text) ? text.trim() : null;
  if (advanced) return { customers: advanced, charges: advanced, invoices: advanced, subscriptions: advanced, products: advanced, payment_intents: advanced };
  const long = t.length >= 3;
  const digits = /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
  return {
    customers: long ? (t.includes('@') ? `email~"${t}"` : `email~"${t}" OR name~"${t}"`) : null,
    charges: digits !== null ? `amount:${digits}` : /^\d{4}$/.test(t) ? `payment_method_details.card.last4:"${t}"` : t.includes('@') ? `billing_details.email:"${t}"` : long ? `billing_details.name~"${t}"` : null,
    invoices: /^[A-Z0-9]+-\d{4}$/i.test(t) ? `number:"${t.toUpperCase()}"` : digits !== null ? `total:${digits}` : null,
    products: long && digits === null ? `name~"${t}"` : null,
    subscriptions: null,
    payment_intents: null,
  };
}

const RESOURCE_LABEL: Record<string, string> = { customers: 'Customers', charges: 'Payments', invoices: 'Invoices', products: 'Products', subscriptions: 'Subscriptions', payment_intents: 'Payment intents' };

export function SearchPage() {
  const { path, navigate } = useRouter();
  const q = new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const results = useLoad(async () => {
    if (!q.trim()) return null;
    const qs = queriesFor(q);
    const out: Record<string, any> = {};
    await Promise.all(Object.entries(qs).map(async ([res, query]) => {
      if (!query) return;
      try { out[res] = await api('GET', `/v1/${res}/search`, { query, limit: 20, 'expand[]': 'total_count' }); } catch (e: any) { if (/[:~<>]/.test(q)) out[res] = { error: e.message }; }
    }));
    return out;
  }, [q]);
  const row = (res: string, o: any) => {
    switch (res) {
      case 'customers': return [<Link key="l" to={`/customers/${o.id}`}>{o.name ?? o.email ?? o.id}</Link>, o.email ?? '', date(o.created)];
      case 'charges': return [<Link key="l" to={`/payments/${o.payment_intent ?? ''}`}>{money(o.amount, o.currency)}</Link>, `${o.payment_method_details?.card?.brand ?? ''} •••• ${o.payment_method_details?.card?.last4 ?? ''} · ${o.status}`, date(o.created)];
      case 'payment_intents': return [<Link key="l" to={`/payments/${o.id}`}>{money(o.amount, o.currency)}</Link>, o.status, date(o.created)];
      case 'invoices': return [<Link key="l" to={`/invoices/${o.id}`}>{o.number ?? o.id}</Link>, `${money(o.total, o.currency)} · ${o.status}`, date(o.created)];
      case 'products': return [<Link key="l" to={`/products/${o.id}`}>{o.name}</Link>, o.active ? 'Active' : 'Archived', date(o.created)];
      default: return [<Link key="l" to={`/subscriptions/${o.id}`}>{o.id}</Link>, o.status, date(o.created)];
    }
  };
  const all = results.data ? Object.entries(results.data) : [];
  // An advanced query only applies to resources that have its fields; show errors only if none do.
  const ok = all.filter(([, r]) => !r.error);
  const groups = ok.length ? ok : all.slice(0, 1);
  return (
    <>
      <PageHead title="Search" sub={<>Type a name, email, amount (12.50), card last 4 or invoice number. Or write a query such as <code>amount&gt;1000 AND currency:"usd"</code> or <code>metadata["order_id"]:"6735"</code>.</>} />
      <form className="row" style={{ marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(text)}`); }}>
        <input className="input" aria-label="Search query" value={text} onChange={(e) => setText(e.target.value)} style={{ maxWidth: 560 }} />
        <button className="btn btn-primary">Search</button>
      </form>
      {!q ? null : results.loading && !results.data ? <Card><Skeleton /></Card> : !groups.length ? <Card><Empty>Nothing matched “{q}”.</Empty></Card> : (
        <div className="stack">
          {groups.map(([res, r]) => (
            <Card key={res} title={<span>{RESOURCE_LABEL[res]} <span className="muted" style={{ fontWeight: 400 }}>{r.error ? '' : r.total_count}</span></span>} pad={false}>
              {r.error ? <div className="alert alert-warning" style={{ margin: 12 }}>{r.error}</div> : !r.data.length ? <Empty>No matches.</Empty> : (
                <table className="table"><tbody>{r.data.map((o: any) => { const [a, b, c] = row(res, o); return <tr key={o.id}><td>{a}</td><td className="soft">{b}</td><td className="soft num">{c}</td></tr>; })}</tbody></table>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
