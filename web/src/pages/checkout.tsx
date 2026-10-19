import { useState } from 'react';
import { api, copy, date, isMetered, Link, money, priceAmount, priceText, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton, StatusBadge, Tabs } from '../ui.tsx';

const linkStatus = (l: any) => {
  const r = l.restrictions?.completed_sessions;
  if (!l.active && r && r.count >= r.limit) return <Badge kind="warning">Limit reached</Badge>;
  return l.active ? <Badge kind="success">Active</Badge> : <Badge>Inactive</Badge>;
};
const linkTotal = (l: any) => l._items?.reduce((s: number, li: any) => s + (isMetered(li.price) ? 0 : priceAmount(li.price, li.quantity)), 0) ?? 0;

/** Shipping settings shared by the link and session forms (one-time payments only). */
function ShippingFields({ value, onChange }: { value: { collect: boolean; rates: string[] }; onChange: (v: { collect: boolean; rates: string[] }) => void }) {
  const rates = useLoad(() => api('GET', '/v1/shipping_rates', { active: 'true', limit: 100 }), []);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="row"><input type="checkbox" checked={value.collect} onChange={(e) => onChange({ ...value, collect: e.target.checked })} /> Collect a shipping address (US and Canada)</label>
      {value.collect && (rates.data?.data.length ? rates.data.data.map((r: any) => (
        <label key={r.id} className="row" style={{ paddingLeft: 24 }}><input type="checkbox" checked={value.rates.includes(r.id)} onChange={(e) => onChange({ ...value, rates: e.target.checked ? [...value.rates, r.id] : value.rates.filter((x) => x !== r.id) })} /> Offer {r.display_name} ({r.fixed_amount.amount ? money(r.fixed_amount.amount, r.fixed_amount.currency) : 'free'})</label>
      )) : <span className="soft" style={{ paddingLeft: 24 }}>No shipping rates yet. <Link to="/shipping-rates">Create one</Link> to charge for shipping.</span>)}
    </div>
  );
}
const shippingParams = (v: { collect: boolean; rates: string[] }) => (v.collect ? { shipping_address_collection: { allowed_countries: ['US', 'CA'] }, ...(v.rates.length ? { shipping_options: v.rates.map((r) => ({ shipping_rate: r })) } : {}) } : {});

type Collect = { terms: boolean; promotions: boolean; taxId: boolean; field: string; fieldType: string; options: string };
const NO_COLLECT: Collect = { terms: false, promotions: false, taxId: false, field: '', fieldType: 'text', options: 'Small, Medium, Large' };

/** Extra things to collect on the page: consent, business tax IDs and one custom field. */
function CollectFields({ value, onChange, setupMode }: { value: Collect; onChange: (v: Collect) => void; setupMode?: boolean }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="row"><input type="checkbox" checked={value.terms} onChange={(e) => onChange({ ...value, terms: e.target.checked })} /> Require agreement to your terms of service</label>
      <label className="row"><input type="checkbox" checked={value.promotions} onChange={(e) => onChange({ ...value, promotions: e.target.checked })} /> Ask for consent to promotional emails</label>
      {!setupMode && <label className="row"><input type="checkbox" checked={value.taxId} onChange={(e) => onChange({ ...value, taxId: e.target.checked })} /> Let business customers enter a tax ID (VAT reverse charge)</label>}
      <div className="form-row">
        <Field label="Custom field (optional)"><input className="input" placeholder="e.g. Gift message" maxLength={50} value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })} /></Field>
        {value.field && <Field label="Type"><select className="input" value={value.fieldType} onChange={(e) => onChange({ ...value, fieldType: e.target.value })}><option value="text">Text</option><option value="numeric">Numbers only</option><option value="dropdown">Dropdown</option></select></Field>}
      </div>
      {value.field && value.fieldType === 'dropdown' && <Field label="Options (comma separated)"><input className="input" value={value.options} onChange={(e) => onChange({ ...value, options: e.target.value })} /></Field>}
    </div>
  );
}
const collectParams = (v: Collect, setupMode = false) => {
  const out: any = {};
  if (v.terms || v.promotions) out.consent_collection = { ...(v.terms ? { terms_of_service: 'required' } : {}), ...(v.promotions ? { promotions: 'auto' } : {}) };
  if (v.taxId && !setupMode) out.tax_id_collection = { enabled: 'true' };
  if (v.field) {
    const opts = v.options.split(',').map((x) => x.trim()).filter(Boolean);
    out.custom_fields = [{
      key: v.field.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'field1', label: { type: 'custom', custom: v.field }, type: v.fieldType,
      ...(v.fieldType === 'dropdown' ? { dropdown: { options: opts.map((o) => ({ label: o, value: o.replace(/[^A-Za-z0-9]/g, '') || 'option' })) } } : {}),
    }];
  }
  return out;
};

/** Payment links (shareable URLs) plus the Checkout Sessions they and the API create. */
export function CheckoutLinks() {
  const [tab, setTab] = useState<'links' | 'sessions'>('links');
  const [openLink, setOpenLink] = useState(false);
  const [openSession, setOpenSession] = useState(false);
  const { navigate } = useRouter();
  return (
    <>
      <PageHead title="Payment links" sub="Share a link to sell products or subscriptions. Every visit opens a new Checkout Session."
        actions={tab === 'links' ? <button className="btn btn-primary" onClick={() => setOpenLink(true)}>+ Create payment link</button> : <button className="btn btn-primary" onClick={() => setOpenSession(true)}>+ New checkout session</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'links', label: 'Payment links' }, { id: 'sessions', label: 'Checkout sessions' }]} />
      {tab === 'links' ? <LinksTable /> : <SessionsTable />}
      {openLink && <CreateLinkModal onClose={() => setOpenLink(false)} onDone={(l) => navigate(`/payment-links/${l.id}`)} />}
      {openSession && <NewSessionModal onClose={() => setOpenSession(false)} />}
    </>
  );
}

function LinksTable() {
  const toast = useToast();
  const { navigate } = useRouter();
  const list = useLoad(async () => {
    const l = await api('GET', '/v1/payment_links', { limit: 100 });
    // Line items aren't on the object (like the real API); fetch them for the totals column.
    await Promise.all(l.data.map(async (x: any) => { x._items = (await api('GET', `/v1/payment_links/${x.id}/line_items`, { expand: ['data.price.product'] })).data; }));
    return l;
  }, []);
  if (!list.data) return <Card><Skeleton /></Card>;
  if (!list.data.data.length) return <Card><Empty>No payment links yet. Create one to sell a product with a shareable URL.</Empty></Card>;
  return (
    <Card pad={false}>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Link</th><th>Selling</th><th className="num">Price</th><th>Status</th><th className="num">Purchases</th><th>Created</th><th /></tr></thead>
        <tbody>{list.data.data.map((l: any) => (
          <tr key={l.id} className="clickable" onClick={() => navigate(`/payment-links/${l.id}`)}>
            <td className="mono soft" style={{ fontSize: 12 }}>{l.url.replace(/^https?:\/\//, '')}</td>
            <td>{l._items.map((li: any) => `${li.price.product?.name ?? li.description}${li.quantity > 1 ? ` × ${li.quantity}` : ''}`).join(', ')}</td>
            <td className="num amount">{money(linkTotal(l), l.currency)}{l._items.some((li: any) => li.price.recurring) && <span className="muted"> / {l._items.find((li: any) => li.price.recurring).price.recurring.interval}</span>}</td>
            <td>{linkStatus(l)}</td>
            <td className="num">{l.restrictions?.completed_sessions ? `${l.restrictions.completed_sessions.count} / ${l.restrictions.completed_sessions.limit}` : '—'}</td>
            <td className="soft">{date(l.created)}</td>
            <td className="num" onClick={(e) => e.stopPropagation()}><button className="btn btn-ghost btn-sm" onClick={() => copy(l.url, toast)}>Copy link</button></td>
          </tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

function CreateLinkModal({ onClose, onDone }: { onClose: () => void; onDone: (l: any) => void }) {
  const prices = useLoad(() => api('GET', '/v1/prices', { active: 'true', limit: 100, expand: ['data.product'] }), []);
  const [lines, setLines] = useState<{ price: string; quantity: string; adjustable: boolean; min: string; max: string }[]>([{ price: '', quantity: '1', adjustable: false, min: '1', max: '10' }]);
  const [f, setF] = useState({ after: 'hosted_confirmation', message: '', redirect: 'https://example.com/thanks', promo: false, tax: false, limit: '', trial: '' });
  const [shipping, setShipping] = useState({ collect: false, rates: [] as string[] });
  const [collect, setCollect] = useState<Collect>(NO_COLLECT);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const all = prices.data?.data ?? [];
  const chosen = lines.map((l) => all.find((p: any) => p.id === (l.price || all[0]?.id)));
  const recurring = chosen.some((p: any) => p?.recurring);
  const total = chosen.reduce((s: number, p: any, i: number) => s + (p && !isMetered(p) ? priceAmount(p, Number(lines[i]!.quantity) || 1) : 0), 0);
  const set = (i: number, patch: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  async function create() {
    setBusy(true); setErr(null);
    try {
      const link = await api('POST', '/v1/payment_links', {
        line_items: lines.map((l, i) => ({
          price: chosen[i]?.id,
          ...(isMetered(chosen[i]) ? {} : { quantity: l.quantity }),
          ...(l.adjustable && !isMetered(chosen[i]) ? { adjustable_quantity: { enabled: 'true', minimum: l.min, maximum: l.max } } : {}),
        })),
        after_completion: f.after === 'redirect' ? { type: 'redirect', redirect: { url: f.redirect } } : { type: 'hosted_confirmation', hosted_confirmation: f.message ? { custom_message: f.message } : {} },
        allow_promotion_codes: String(f.promo),
        automatic_tax: { enabled: String(f.tax) },
        ...(f.limit ? { restrictions: { completed_sessions: { limit: f.limit } } } : {}),
        ...(recurring && f.trial ? { subscription_data: { trial_period_days: f.trial } } : {}),
        ...(recurring ? {} : shippingParams(shipping)),
        ...collectParams(collect),
      });
      onDone(link);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Create a payment link" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !all.length} onClick={create}>{busy ? 'Creating…' : 'Create link'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        {prices.data && !all.length && <div className="alert alert-info">Payment links sell catalog prices. <Link to="/products">Add a product</Link> first.</div>}
        {lines.map((l, i) => (
          <div key={i} className="stack" style={{ gap: 8, paddingBottom: 8, borderBottom: '1px solid var(--color-border)' }}>
            <div className="form-row">
              <Field label={i === 0 ? 'Product' : `Product ${i + 1}`}>
                <select className="input" value={l.price} onChange={(e) => set(i, { price: e.target.value })}>
                  {all.map((p: any) => <option key={p.id} value={p.id}>{p.product?.name} · {priceText(p)}</option>)}
                </select>
              </Field>
              {!isMetered(chosen[i]) && <Field label="Quantity"><input className="input" type="number" min={1} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></Field>}
            </div>
            {!isMetered(chosen[i]) && <label className="row"><input type="checkbox" checked={l.adjustable} onChange={(e) => set(i, { adjustable: e.target.checked })} /> Let customers adjust quantity</label>}
            {l.adjustable && <div className="form-row">
              <Field label="Minimum"><input className="input" type="number" min={0} value={l.min} onChange={(e) => set(i, { min: e.target.value })} /></Field>
              <Field label="Maximum"><input className="input" type="number" min={1} value={l.max} onChange={(e) => set(i, { max: e.target.value })} /></Field>
            </div>}
            {lines.length > 1 && <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLines([...lines, { price: '', quantity: '1', adjustable: false, min: '1', max: '10' }])}>+ Add another product</button>
        {recurring && <Field label="Free trial (days)"><input className="input" type="number" min={0} placeholder="None" value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} /></Field>}
        <Field label="After payment">
          <select className="input" value={f.after} onChange={(e) => setF({ ...f, after: e.target.value })}>
            <option value="hosted_confirmation">Show a confirmation page</option>
            <option value="redirect">Redirect to your website</option>
          </select>
        </Field>
        {f.after === 'redirect'
          ? <Field label="Redirect URL"><input className="input" value={f.redirect} onChange={(e) => setF({ ...f, redirect: e.target.value })} /></Field>
          : <Field label="Custom message (optional)"><input className="input" value={f.message} placeholder="Thanks for your order!" onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>}
        <label className="row"><input type="checkbox" checked={f.promo} onChange={(e) => setF({ ...f, promo: e.target.checked })} /> Allow promotion codes</label>
        <label className="row"><input type="checkbox" checked={f.tax} onChange={(e) => setF({ ...f, tax: e.target.checked })} /> Collect tax automatically</label>
        {!recurring && <ShippingFields value={shipping} onChange={setShipping} />}
        <CollectFields value={collect} onChange={setCollect} />
        <Field label="Limit the number of payments (optional)" hint="The link deactivates itself once this many purchases complete."><input className="input" type="number" min={1} placeholder="No limit" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></Field>
        {!!all.length && <div className="soft">Customers pay <strong>{money(total, chosen[0]?.currency ?? 'usd')}</strong>{recurring ? ` per ${chosen.find((p: any) => p?.recurring)?.recurring.interval}` : ''}{chosen.some((p: any) => isMetered(p)) ? ' plus usage' : ''}.</div>}
      </div>
    </Modal>
  );
}

export function PaymentLinkDetail({ id }: { id: string }) {
  const toast = useToast();
  const link = useLoad(() => api('GET', `/v1/payment_links/${id}`), [id]);
  const items = useLoad(() => api('GET', `/v1/payment_links/${id}/line_items`, { expand: ['data.price.product'] }), [id]);
  const sessions = useLoad(() => api('GET', '/v1/checkout/sessions', { payment_link: id, limit: 50 }), [id]);
  const [err, setErr] = useState<any>(null);
  if (!link.data) return link.error ? <ErrorNote error={link.error} /> : <Card><Skeleton /></Card>;
  const l = link.data;
  const toggle = async () => { setErr(null); try { await api('POST', `/v1/payment_links/${id}`, { active: String(!l.active) }); toast(l.active ? 'Link deactivated' : 'Link activated'); link.reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/checkout">Payment links</Link> / <span className="mono">{id}</span></div>
      <PageHead title={items.data?.data.map((li: any) => li.price.product?.name ?? li.description).join(', ') ?? 'Payment link'} sub={<span className="row">{linkStatus(l)}<span className="mono soft">{l.url}</span></span>} actions={<>
        <button className="btn btn-secondary" onClick={() => copy(l.url, toast)}>Copy link</button>
        <a className="btn btn-secondary" href={l.url} target="_blank" rel="noreferrer">Open</a>
        <button className={l.active ? 'btn btn-danger' : 'btn btn-primary'} onClick={toggle}>{l.active ? 'Deactivate' : 'Activate'}</button>
      </>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 8 }}>
        <div className="stack">
          <Card title="Line items" pad={false}>
            {!items.data ? <Skeleton /> : (
              <table className="table"><thead><tr><th>Product</th><th>Price</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
                <tbody>{items.data.data.map((li: any) => (
                  <tr key={li.id}><td>{li.price.product?.name ?? li.description}</td><td className="soft">{priceText(li.price)}</td>
                    <td className="num">{li.quantity ?? '—'}{li.adjustable_quantity && <span className="muted"> ({li.adjustable_quantity.minimum}–{li.adjustable_quantity.maximum})</span>}</td>
                    <td className="num amount">{isMetered(li.price) ? 'usage' : money(li.amount_total, li.currency)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card title="Checkout sessions from this link" pad={false}>
            {!sessions.data ? <Skeleton /> : !sessions.data.data.length ? <Empty>Nobody has opened this link yet.</Empty> : (
              <table className="table"><thead><tr><th className="num">Total</th><th>Status</th><th>Payment</th><th>Customer</th><th>Created</th></tr></thead>
                <tbody>{sessions.data.data.map((s: any) => (
                  <tr key={s.id}><td className="num amount">{money(s.amount_total, s.currency)}</td><td><StatusBadge obj={s} /></td><td>{s.payment_status}</td><td className="soft">{s.customer_details?.email ?? '—'}</td><td className="soft">{date(s.created)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card title="Payment link object"><Json value={l} /></Card>
        </div>
        <Card title="Settings">
          <dl className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
            <dt>Mode</dt><dd>{l.subscription_data ? 'Subscription' : 'One-time payment'}</dd>
            {l.subscription_data?.trial_period_days && <><dt>Free trial</dt><dd>{l.subscription_data.trial_period_days} days</dd></>}
            <dt>After payment</dt><dd>{l.after_completion.type === 'redirect' ? <>Redirect to <span className="mono">{l.after_completion.redirect.url}</span></> : l.after_completion.hosted_confirmation.custom_message ?? 'Confirmation page'}</dd>
            <dt>Promotion codes</dt><dd>{l.allow_promotion_codes ? 'Allowed' : 'Off'}</dd>
            <dt>Automatic tax</dt><dd>{l.automatic_tax.enabled ? 'On' : 'Off'}</dd>
            <dt>Purchase limit</dt><dd>{l.restrictions?.completed_sessions ? `${l.restrictions.completed_sessions.count} of ${l.restrictions.completed_sessions.limit} used` : 'None'}</dd>
            <dt>Created</dt><dd>{date(l.created)}</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}

function SessionsTable() {
  const toast = useToast();
  const sessions = useLoad(() => api('GET', '/v1/checkout/sessions', { limit: 50 }), []);
  if (!sessions.data) return <Card><Skeleton /></Card>;
  if (!sessions.data.data.length) return <Card><Empty>No checkout sessions yet.</Empty></Card>;
  return (
    <Card pad={false}>
      <div className="table-wrap"><table className="table">
        <thead><tr><th className="num">Total</th><th>Type</th><th>Status</th><th>Payment</th><th>Source</th><th>Created</th><th></th></tr></thead>
        <tbody>{sessions.data.data.map((s: any) => (
          <tr key={s.id}><td className="num amount">{s.mode === 'setup' ? '—' : money(s.amount_total, s.currency)}</td><td className="soft">{s.mode}</td><td><StatusBadge obj={s} /></td><td>{s.payment_status}</td>
            <td className="soft">{s.payment_link ? <Link to={`/payment-links/${s.payment_link}`}>Payment link</Link> : 'API'}</td><td className="soft">{date(s.created)}</td>
            <td className="num"><a className="btn btn-ghost btn-sm" href={s.url} target="_blank" rel="noreferrer">Open</a><button className="btn btn-ghost btn-sm" onClick={() => copy(s.url, toast)}>Copy URL</button></td></tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

/** A one-off Checkout Session, as an integration would create through the API. */
function NewSessionModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: 'Coffee beans, 1 kg', price: '24.00', qty: '1', currency: 'usd', email: '', catalog: '', trial: '', tax: false, physical: true, promo: false });
  const [shipping, setShipping] = useState({ collect: false, rates: [] as string[] });
  const prices = useLoad(() => api('GET', '/v1/prices', { active: 'true', limit: 100, expand: ['data.product'] }), []);
  const chosen = prices.data?.data.find((p: any) => p.id === f.catalog);
  const setupMode = f.catalog === '__setup';
  const [collect, setCollect] = useState<Collect>(NO_COLLECT);
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try {
      const s = await api('POST', '/v1/checkout/sessions', {
        success_url: `${location.origin}/pay/{CHECKOUT_SESSION_ID}?success=1`,
        cancel_url: `${location.origin}/checkout`,
        customer_email: f.email || undefined,
        automatic_tax: f.tax && !setupMode ? { enabled: 'true' } : undefined,
        allow_promotion_codes: f.promo && !setupMode ? 'true' : undefined,
        ...(!setupMode && chosen?.type !== 'recurring' ? shippingParams(shipping) : {}),
        ...collectParams(collect, setupMode),
        ...(setupMode ? { mode: 'setup', currency: 'usd' } : chosen
          ? { mode: chosen.type === 'recurring' ? 'subscription' : 'payment', line_items: [{ price: chosen.id, ...(isMetered(chosen) ? {} : { quantity: f.qty }) }], subscription_data: chosen.type === 'recurring' && f.trial ? { trial_period_days: f.trial } : undefined }
          : { mode: 'payment', line_items: [{ quantity: f.qty, price_data: { currency: f.currency, unit_amount: toMinor(f.price, f.currency), tax_behavior: 'exclusive', product_data: { name: f.name, tax_code: f.physical ? 'txcd_99999999' : 'txcd_10000000' } } }] }),
      });
      onClose();
      copy(s.url, toast);
      window.open(s.url, '_blank', 'noopener');
    } catch (e) { setErr(e); }
  }
  return (
    <Modal open onClose={onClose} title="New checkout session" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={create}>Create and open</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="What are you selling?" hint="Recurring catalog prices create a subscription checkout.">
          <select className="input" value={f.catalog} onChange={(e) => setF({ ...f, catalog: e.target.value })}>
            <option value="">Custom one-time amount</option>
            <option value="__setup">Save a card (no charge)</option>
            {prices.data?.data.map((p: any) => <option key={p.id} value={p.id}>{p.product?.name} · {priceText(p)}</option>)}
          </select>
        </Field>
        {!chosen && !setupMode && <>
          <Field label="Product name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="Price"><input className="input" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'eur', 'gbp'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
          </div>
        </>}
        {!setupMode && <div className="form-row">
          {!isMetered(chosen) && <Field label="Quantity"><input className="input" type="number" min={1} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>}
          {chosen?.recurring && <Field label="Free trial (days)"><input className="input" type="number" min={0} value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} /></Field>}
        </div>}
        {!setupMode && <label className="row"><input type="checkbox" checked={f.tax} onChange={(e) => setF({ ...f, tax: e.target.checked })} /> Collect tax automatically (asks the customer for their address)</label>}
        {!setupMode && !chosen && f.tax && <label className="row"><input type="checkbox" checked={f.physical} onChange={(e) => setF({ ...f, physical: e.target.checked })} /> Physical goods (tax code txcd_99999999)</label>}
        {!setupMode && <label className="row"><input type="checkbox" checked={f.promo} onChange={(e) => setF({ ...f, promo: e.target.checked })} /> Allow promotion codes</label>}
        {!setupMode && chosen?.type !== 'recurring' && <ShippingFields value={shipping} onChange={setShipping} />}
        <CollectFields value={collect} onChange={setCollect} setupMode={setupMode} />
        <Field label="Customer email (optional)"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
