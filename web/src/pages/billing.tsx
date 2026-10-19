import { PauseBadge, PauseCollectionButton, PaymentPlanCard, pauseDetail } from './b2b.tsx';
import { useState } from 'react';
import { api, date, dateLong, isMetered, Link, money, priceAmount, priceText, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { PromotionCodes, ScheduleCard } from './growth.tsx';
import { CreditNotesCard } from './finance.tsx';
import { InvoiceRetriesCard, ProductFeaturesCard } from './billing2.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton, StatusBadge, Tabs } from '../ui.tsx';

const interval = (price: any) => (price?.recurring ? (price.recurring.interval_count === 1 ? `/ ${price.recurring.interval}` : `every ${price.recurring.interval_count} ${price.recurring.interval}s`) : 'one-time');
const priceLabel = (price: any) => priceText(price);
void interval;
const itemName = (it: any) => it.price.nickname ? `${it.price.product?.name ?? ''} ${it.price.nickname}`.trim() : it.price.product?.name ?? it.price.product;
const dayOnly = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function SubStatus({ s }: { s: string }) {
  const kind: any = { active: 'success', trialing: 'info', past_due: 'warning', incomplete: 'warning', canceled: 'neutral', incomplete_expired: 'neutral', unpaid: 'danger' }[s] ?? 'neutral';
  return <Badge kind={kind}>{s.replace(/_/g, ' ')}</Badge>;
}

export function InvoiceStatus({ s }: { s: string }) {
  const kind: any = { paid: 'success', open: 'info', draft: 'neutral', void: 'neutral', uncollectible: 'danger' }[s] ?? 'neutral';
  return <Badge kind={kind}>{s}</Badge>;
}

/** Monthly-normalised recurring revenue for a subscription. */
function mrr(sub: any) {
  if (!['active', 'past_due'].includes(sub.status)) return 0;
  return sub.items.data.reduce((sum: number, it: any) => {
    const r = it.price.recurring;
    const perMonth = { day: 30, week: 4.345, month: 1, year: 1 / 12 }[r.interval as string] ?? 1;
    return sum + (isMetered(it.price) ? 0 : (priceAmount(it.price, it.quantity) * perMonth) / r.interval_count);
  }, 0);
}

// ---------------- Products ----------------
export function Products() {
  const { navigate } = useRouter();
  const toast = useToast();
  const products = useLoad(() => api('GET', '/v1/products', { limit: 100, expand: ['data.default_price'] }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: 'Pro plan', description: '', amount: '29.00', currency: 'usd', type: 'recurring', interval: 'month' });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try {
      const p = await api('POST', '/v1/products', {
        name: f.name,
        description: f.description || undefined,
        default_price_data: { currency: f.currency, unit_amount: toMinor(f.amount, f.currency), recurring: f.type === 'recurring' ? { interval: f.interval } : undefined },
      });
      toast('Product created');
      setOpen(false);
      navigate(`/products/${p.id}`);
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Product catalog" sub="Products and their prices, used by subscriptions, invoices and payment links." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Add product</button>} />
      <Card pad={false}>
        {!products.data ? <Skeleton /> : !products.data.data.length ? <Empty>No products yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Default price</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{products.data.data.map((p: any) => (
              <tr key={p.id} className="clickable" onClick={() => navigate(`/products/${p.id}`)}>
                <td><strong>{p.name}</strong>{p.description && <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>}</td>
                <td>{p.default_price ? priceLabel(p.default_price) : '—'}</td>
                <td>{p.active ? <Badge kind="success">Active</Badge> : <Badge>Archived</Badge>}</td>
                <td className="soft">{date(p.created)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a product" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Add product</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Description (optional)"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="Price"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'eur', 'gbp'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
          </div>
          <div className="form-row">
            <Field label="Type"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="recurring">Recurring</option><option value="one_time">One-time</option></select></Field>
            {f.type === 'recurring' && <Field label="Billing period"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option></select></Field>}
          </div>
        </div>
      </Modal>
    </>
  );
}

export function ProductDetail({ id }: { id: string }) {
  const toast = useToast();
  const product = useLoad(() => api('GET', `/v1/products/${id}`), [id]);
  const prices = useLoad(() => api('GET', '/v1/prices', { product: id, limit: 100 }), [id]);
  const [open, setOpen] = useState(false);
  const BLANK = { amount: '290.00', currency: 'usd', type: 'recurring', interval: 'year', nickname: '', model: 'standard', usage: 'licensed', meter: '', divide: '100' };
  const [f, setF] = useState(BLANK);
  const [tiers, setTiers] = useState([{ up_to: '1000', unit: '0.05', flat: '' }, { up_to: '', unit: '0.03', flat: '' }]);
  const meters = useLoad(() => api('GET', '/v1/billing/meters', { status: 'active', limit: 100 }), [open]);
  const [err, setErr] = useState<any>(null);
  const setTier = (i: number, patch: any) => setTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  // Sub-cent unit amounts are fine for usage pricing: send unit_amount_decimal when needed.
  const unit = (v: string) => (Number.isInteger(toMinor(v, f.currency) ) && Math.abs(Number(v) * 100 - Math.round(Number(v) * 100)) < 1e-9 ? { unit_amount: toMinor(v, f.currency) } : { unit_amount_decimal: String(Number(v) * 100) });
  function priceBody() {
    const recurring = f.type === 'recurring' ? { interval: f.interval, ...(f.usage === 'metered' ? { usage_type: 'metered', meter: f.meter || meters.data?.data[0]?.id } : {}) } : undefined;
    const base: any = { product: id, nickname: f.nickname || undefined, currency: f.currency, recurring };
    if (f.model === 'graduated' || f.model === 'volume') {
      return { ...base, billing_scheme: 'tiered', tiers_mode: f.model, tiers: tiers.map((t, i) => ({ up_to: i === tiers.length - 1 ? 'inf' : t.up_to, ...(t.unit ? unit(t.unit) : {}), ...(t.flat ? { flat_amount: toMinor(t.flat, f.currency) } : {}) })) };
    }
    if (f.model === 'package') return { ...base, unit_amount: toMinor(f.amount, f.currency), transform_quantity: { divide_by: f.divide, round: 'up' } };
    return { ...base, ...unit(f.amount) };
  }
  if (!product.data) return product.error ? <ErrorNote error={product.error} /> : <Card><Skeleton /></Card>;
  const p = product.data;
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/products">Products</Link> / <span className="mono">{id}</span></div>
      <PageHead title={p.name} sub={p.description} actions={<>
        <button className="btn btn-secondary" onClick={async () => { await api('POST', `/v1/products/${id}`, { active: String(!p.active) }); toast(p.active ? 'Product archived' : 'Product restored'); product.reload(); }}>{p.active ? 'Archive' : 'Restore'}</button>
        <button className="btn btn-primary" onClick={() => { setF(BLANK); setErr(null); setOpen(true); }}>+ Add price</button>
      </>} />
      <Card title="Prices" pad={false}>
        {!prices.data ? <Skeleton /> : (
          <table className="table">
            <thead><tr><th>Price</th><th>Nickname</th><th>ID</th><th>Status</th><th /></tr></thead>
            <tbody>{prices.data.data.map((pr: any) => (
              <tr key={pr.id}>
                <td className="amount">{priceLabel(pr)} {p.default_price === pr.id && <Badge kind="info">Default</Badge>}</td>
                <td className="soft">{pr.nickname ?? '—'}</td>
                <td className="mono soft">{pr.id}</td>
                <td>{pr.active ? <Badge kind="success">Active</Badge> : <Badge>Archived</Badge>}</td>
                <td className="num">
                  {p.default_price !== pr.id && pr.active && <button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/products/${id}`, { default_price: pr.id }); product.reload(); }}>Make default</button>}
                  <button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/prices/${pr.id}`, { active: String(!pr.active) }); prices.reload(); }}>{pr.active ? 'Archive' : 'Restore'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <div style={{ marginTop: 16 }}><ProductFeaturesCard productId={id} /></div>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a price" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try { await api('POST', '/v1/prices', priceBody()); setOpen(false); prices.reload(); toast('Price added'); } catch (e) { setErr(e); }
      }}>Add price</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Pricing model">
            <select className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
              <option value="standard">Standard: one price per unit</option>
              <option value="package">Package: price per bundle of units</option>
              <option value="graduated">Graduated: each tier priced separately</option>
              <option value="volume">Volume: all units at the tier reached</option>
            </select>
          </Field>
          <div className="form-row">
            <Field label="Type"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, usage: e.target.value === 'one_time' ? 'licensed' : f.usage })}><option value="recurring">Recurring</option><option value="one_time">One-time</option></select></Field>
            {f.type === 'recurring' && <Field label="Billing period"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option></select></Field>}
            <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'eur', 'gbp'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
          </div>
          {f.type === 'recurring' && <div className="form-row">
            <Field label="Charge for"><select className="input" value={f.usage} onChange={(e) => setF({ ...f, usage: e.target.value })}><option value="licensed">A quantity set on the subscription</option><option value="metered">Usage reported to a meter</option></select></Field>
            {f.usage === 'metered' && <Field label="Meter">{meters.data?.data.length ? <select className="input" value={f.meter} onChange={(e) => setF({ ...f, meter: e.target.value })}>{meters.data.data.map((m: any) => <option key={m.id} value={m.id}>{m.display_name} ({m.event_name})</option>)}</select> : <span className="soft">No meters yet. <Link to="/meters">Create one</Link>.</span>}</Field>}
          </div>}
          {(f.model === 'standard' || f.model === 'package') && <div className="form-row">
            <Field label={f.model === 'package' ? 'Price per package' : f.usage === 'metered' ? 'Price per unit' : 'Amount'}><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            {f.model === 'package' && <Field label="Units per package" hint="Partial packages round up."><input className="input" type="number" min={2} value={f.divide} onChange={(e) => setF({ ...f, divide: e.target.value })} /></Field>}
          </div>}
          {(f.model === 'graduated' || f.model === 'volume') && <div className="stack" style={{ gap: 6 }}>
            {tiers.map((t, i) => (
              <div key={i} className="tier-row">
                <Field label={i === 0 ? 'Up to (units)' : i === tiers.length - 1 ? 'Then, above that' : 'Next tier up to'}>{i === tiers.length - 1 ? <input className="input" disabled value="∞" /> : <input className="input" type="number" min={1} value={t.up_to} onChange={(e) => setTier(i, { up_to: e.target.value })} />}</Field>
                <Field label="Per unit"><input className="input" value={t.unit} onChange={(e) => setTier(i, { unit: e.target.value })} /></Field>
                <Field label="Flat fee"><input className="input" placeholder="0.00" value={t.flat} onChange={(e) => setTier(i, { flat: e.target.value })} /></Field>
                <button type="button" className="btn btn-ghost btn-sm" disabled={tiers.length < 3} onClick={() => setTiers(tiers.filter((_, j) => j !== i))} aria-label="Remove tier">✕</button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', justifySelf: 'start', width: 'auto' }} onClick={() => setTiers([...tiers.slice(0, -1), { up_to: String(Number(tiers[tiers.length - 2]?.up_to ?? 0) * 2 || 100), unit: tiers[tiers.length - 1]!.unit, flat: '' }, tiers[tiers.length - 1]!])}>+ Add tier</button>
          </div>}
          <Field label="Nickname"><input className="input" placeholder="Optional, e.g. Monthly" value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------- Subscriptions ----------------
export function CreateSubscriptionModal({ open, onClose, onDone, customer }: { open: boolean; onClose: () => void; onDone: (sub: any) => void; customer?: string }) {
  const customers = useLoad(() => (customer ? Promise.resolve({ data: [] }) : api('GET', '/v1/customers', { limit: 100 })), [open]);
  const prices = useLoad(() => api('GET', '/v1/prices', { type: 'recurring', active: 'true', limit: 100, expand: ['data.product'] }), [open]);
  const coupons = useLoad(() => api('GET', '/v1/coupons', { limit: 100 }), [open]);
  const promos = useLoad(() => api('GET', '/v1/promotion_codes', { active: 'true', limit: 100 }), [open]);
  const [f, setF] = useState({ customer: '', price: '', quantity: '1', trial: '', coupon: '', card: 'pm_card_visa', threshold: '' });
  const selected = prices.data?.data.find((p: any) => p.id === (f.price || prices.data?.data[0]?.id));
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const cus = customer ?? f.customer;
      if (!cus) throw new Error('Pick a customer.');
      const pm = await api('POST', `/v1/payment_methods/${f.card}/attach`, { customer: cus });
      const sub = await api('POST', '/v1/subscriptions', { customer: cus, items: [{ price: selected?.id, ...(isMetered(selected) ? {} : { quantity: f.quantity }) }], default_payment_method: pm.id, trial_period_days: f.trial || undefined, ...(isMetered(selected) && f.threshold ? { billing_thresholds: { amount_gte: toMinor(f.threshold) } } : {}), ...(f.coupon.startsWith('promo_') ? { promotion_code: f.coupon } : { coupon: f.coupon || undefined }) }, { 'Idempotency-Key': crypto.randomUUID() });
      onDone(sub);
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Create a subscription" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create subscription'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        {!customer && (
          <Field label="Customer">
            <select className="input" value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })}>
              <option value="">Select a customer…</option>
              {customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}{c.test_clock ? ' (test clock)' : ''}</option>)}
            </select>
          </Field>
        )}
        <div className="form-row">
          <Field label="Price">
            <select className="input" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })}>
              {!prices.data?.data.length && <option value="">Create a recurring product first</option>}
              {prices.data?.data.map((p: any) => <option key={p.id} value={p.id}>{p.product?.name} · {priceLabel(p)}</option>)}
            </select>
          </Field>
          {!isMetered(selected) && <Field label="Quantity"><input className="input" type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>}
          {isMetered(selected) && <Field label="Invoice early at usage of (USD)"><input className="input" placeholder="No threshold" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} /></Field>}
        </div>
        <div className="form-row">
          <Field label="Free trial (days)"><input className="input" type="number" min={0} placeholder="None" value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} /></Field>
          <Field label="Coupon">
            <select className="input" value={f.coupon} onChange={(e) => setF({ ...f, coupon: e.target.value })}>
              <option value="">None</option>
              {coupons.data?.data.filter((c: any) => c.valid).map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.id} ({c.percent_off ? `${c.percent_off}%` : money(c.amount_off, c.currency)} off, {c.duration})</option>)}
              {promos.data?.data.map((p: any) => <option key={p.id} value={p.id}>Code {p.code}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Test card to attach as default" hint="The declined card shows the past-due and retry flow at the next renewal.">
          <select className="input" value={f.card} onChange={(e) => setF({ ...f, card: e.target.value })}>
            <option value="pm_card_visa">Visa 4242 (succeeds)</option>
            <option value="pm_card_chargeDeclined">Visa 0002 (declines)</option>
            <option value="pm_card_chargeDeclinedInsufficientFunds">Visa 9995 (insufficient funds)</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export function Subscriptions() {
  const { navigate } = useRouter();
  const [tab, setTab] = useState<'all' | 'active' | 'trialing' | 'past_due' | 'canceled'>('all');
  const [open, setOpen] = useState(false);
  const list = useLoad(() => api('GET', '/v1/subscriptions', { status: 'all', limit: 100, expand: ['data.customer', 'data.items.data.price.product'] }), []);
  const rows = (list.data?.data ?? []).filter((s: any) => tab === 'all' || s.status === tab || (tab === 'canceled' && s.status === 'incomplete_expired'));
  const totalMrr = (list.data?.data ?? []).filter((s: any) => s.currency === 'usd').reduce((t: number, s: any) => t + mrr(s), 0);
  const count = (st: string) => (list.data?.data ?? []).filter((s: any) => s.status === st).length;
  return (
    <>
      <PageHead title="Subscriptions" actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create subscription</button>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card card-body"><div className="stat-label">MRR (USD)</div><div className="stat-value">{money(Math.round(totalMrr), 'usd')}</div></div>
        <div className="card card-body"><div className="stat-label">Active</div><div className="stat-value">{count('active')}</div></div>
        <div className="card card-body"><div className="stat-label">Trialing</div><div className="stat-value">{count('trialing')}</div></div>
        <div className="card card-body"><div className="stat-label">Past due</div><div className="stat-value">{count('past_due')}</div></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'trialing', label: 'Trialing' }, { id: 'past_due', label: 'Past due' }, { id: 'canceled', label: 'Canceled' }]} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !rows.length ? <Empty>No subscriptions here.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Customer</th><th>Product</th><th>Status</th><th className="num">Amount</th><th>Current period</th></tr></thead>
            <tbody>{rows.map((s: any) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/subscriptions/${s.id}`)}>
                <td>{s.customer?.name ?? s.customer?.email ?? s.customer?.id}{s.test_clock && <span className="muted"> · clock</span>}</td>
                <td className="soft">{s.items.data.map((it: any) => (it.quantity === null ? `${itemName(it)} (usage)` : `${it.quantity} × ${itemName(it)}`)).join(', ')}{s.schedule && <Badge kind="info">Scheduled</Badge>}</td>
                <td><SubStatus s={s.status} />{s.cancel_at_period_end && s.status !== 'canceled' && <span className="muted" style={{ fontSize: 12 }}> · cancels {dayOnly(s.current_period_end)}</span>}</td>
                <td className="num amount">{money(s.items.data.reduce((t: number, it: any) => t + it.price.unit_amount * it.quantity, 0), s.currency)} <span className="muted" style={{ fontWeight: 400 }}>{interval(s.items.data[0].price)}</span></td>
                <td className="soft">{dayOnly(s.current_period_start)} → {dayOnly(s.current_period_end)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <CreateSubscriptionModal open={open} onClose={() => setOpen(false)} onDone={(s) => navigate(`/subscriptions/${s.id}`)} />
    </>
  );
}

export function SubscriptionDetail({ id }: { id: string }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const sub = useLoad(() => api('GET', `/v1/subscriptions/${id}`, { expand: ['customer', 'default_payment_method', 'items.data.price.product'] }), [id]);
  const invoices = useLoad(() => api('GET', '/v1/invoices', { subscription: id, limit: 100 }), [id]);
  const upcoming = useLoad(() => api('GET', '/v1/invoices/upcoming', { subscription: id }).catch(() => null), [id, sub.data?.items?.data?.[0]?.quantity, sub.data?.status]);
  const prices = useLoad(() => api('GET', '/v1/prices', { type: 'recurring', active: 'true', limit: 100, expand: ['data.product'] }), []);
  const [edit, setEdit] = useState(false);
  const [ef, setEf] = useState({ price: '', quantity: '1', proration: 'create_prorations' });
  const [err, setErr] = useState<any>(null);
  const reload = () => { sub.reload(); invoices.reload(); upcoming.reload(); };
  if (!sub.data) return sub.error ? <ErrorNote error={sub.error} /> : <Card><Skeleton /></Card>;
  const s = sub.data;
  const item = s.items.data[0];
  const live = ['active', 'trialing', 'past_due', 'incomplete'].includes(s.status);
  const act = async (fn: () => Promise<any>, msg: string) => { setErr(null); try { await fn(); toast(msg); reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/subscriptions">Subscriptions</Link> / <span className="mono">{id}</span></div>
      <PageHead title={`${s.customer?.name ?? s.customer?.email ?? 'Customer'} on ${itemName(item)}`} sub={<span className="row"><SubStatus s={s.status} />{s.cancel_at_period_end && s.status !== 'canceled' && <Badge kind="warning">Cancels {dayOnly(s.current_period_end)}</Badge>}{s.discount && <Badge kind="info">{s.discount.coupon.name ?? s.discount.coupon.id}</Badge>}<PauseBadge sub={s} /></span>}
        actions={live && <>
          <button className="btn btn-secondary" onClick={() => { setEf({ price: item.price.id, quantity: String(item.quantity ?? 1), proration: 'create_prorations' }); setEdit(true); }}>Update</button>
          {!s.schedule && <button className="btn btn-secondary" onClick={() => act(async () => { const sc = await api('POST', '/v1/subscription_schedules', { from_subscription: id }); navigate(`/subscription-schedules/${sc.id}`); }, 'Schedule created')}>Schedule changes</button>}
          {s.status === 'trialing' && <button className="btn btn-secondary" onClick={() => act(() => api('POST', `/v1/subscriptions/${id}`, { trial_end: 'now' }), 'Trial ended')}>End trial now</button>}
          {s.status !== 'incomplete' && <PauseCollectionButton sub={s} onDone={reload} />}
          <button className="btn btn-secondary" onClick={() => act(() => api('POST', `/v1/subscriptions/${id}`, { cancel_at_period_end: String(!s.cancel_at_period_end) }), s.cancel_at_period_end ? 'Cancellation removed' : 'Will cancel at period end')}>{s.cancel_at_period_end ? "Don't cancel" : 'Cancel at period end'}</button>
          <button className="btn btn-danger" onClick={() => confirm('Cancel immediately?') && act(() => api('DELETE', `/v1/subscriptions/${id}`), 'Subscription canceled')}>Cancel now</button>
        </>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 8 }}>
        <div className="stack">
          <Card title="Items" pad={false}>
            <table className="table"><thead><tr><th>Price</th><th className="num">Qty</th><th className="num">Total</th></tr></thead>
              <tbody>{s.items.data.map((it: any) => <tr key={it.id}><td>{itemName(it)} · {priceLabel(it.price)}{isMetered(it.price) && <> · <Link to={`/meters/${it.price.recurring.meter}`}>meter</Link></>}</td><td className="num">{it.quantity ?? '—'}</td><td className="num amount">{isMetered(it.price) ? <span className="soft">billed in arrears</span> : money(priceAmount(it.price, it.quantity), it.price.currency)}</td></tr>)}</tbody>
            </table>
          </Card>
          {upcoming.data && (
            <Card title={`Upcoming invoice · ${dayOnly(upcoming.data.period_end)}`} pad={false}>
              <table className="table"><tbody>
                {upcoming.data.lines.data.map((l: any, i: number) => <tr key={i}><td>{l.description}{l.proration && <Badge kind="info">proration</Badge>}</td><td className="num">{money(l.amount, l.currency)}</td></tr>)}
                {!!upcoming.data.total_discount_amounts.length && <tr><td className="soft">Discount</td><td className="num">−{money(upcoming.data.total_discount_amounts[0].amount, upcoming.data.currency)}</td></tr>}
                <TaxRows amounts={upcoming.data.total_tax_amounts} currency={upcoming.data.currency} />
                <tr><td><strong>Amount due</strong></td><td className="num amount">{money(upcoming.data.amount_due, upcoming.data.currency)}</td></tr>
              </tbody></table>
            </Card>
          )}
          <Card title="Invoices" pad={false}><InvoiceTable invoices={invoices.data?.data} /></Card>
          <Card title="Subscription object"><Json value={s} /></Card>
        </div>
        <div className="stack">
          <Card title="Details">
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Customer</dt><dd><Link to={`/customers/${s.customer.id}`}>{s.customer.email ?? s.customer.id}</Link></dd>
              <dt>Started</dt><dd>{dayOnly(s.start_date)}</dd>
              <dt>Period</dt><dd>{dayOnly(s.current_period_start)} → {dayOnly(s.current_period_end)}</dd>
              {s.trial_end && <><dt>Trial ends</dt><dd>{dayOnly(s.trial_end)}</dd></>}
              <dt>Billing</dt><dd>{s.collection_method === 'charge_automatically' ? 'Charge automatically' : `Send invoice (${s.days_until_due} days)`}</dd>
              <dt>Payment method</dt><dd>{s.default_payment_method ? `${s.default_payment_method.card.brand} •••• ${s.default_payment_method.card.last4}` : 'Customer default'}</dd>
              {s.ended_at && <><dt>Ended</dt><dd>{dayOnly(s.ended_at)} ({s.cancellation_details?.reason?.replace(/_/g, ' ')})</dd></>}
              {s.test_clock && <><dt>Test clock</dt><dd><Link to={`/test-clocks/${s.test_clock}`}>{s.test_clock}</Link></dd></>}
              {s.billing_thresholds && <><dt>Threshold</dt><dd>Invoice early at {money(s.billing_thresholds.amount_gte, s.currency)} of usage{s.billing_thresholds.reset_billing_cycle_anchor ? ' (resets the cycle)' : ''}</dd></>}
              {s.pause_collection && <><dt>Collection</dt><dd>{pauseDetail(s)}</dd></>}
              {s.schedule && <><dt>Schedule</dt><dd><Link to={`/subscription-schedules/${s.schedule}`}>{s.schedule}</Link></dd></>}
              {s.discount?.promotion_code && <><dt>Promotion code</dt><dd className="mono">{s.discount.promotion_code}</dd></>}
            </dl>
          </Card>
          {s.schedule && <ScheduleCard id={s.schedule} />}
        </div>
      </div>
      <Modal open={edit} onClose={() => setEdit(false)} title="Update subscription" footer={<button className="btn btn-primary" onClick={() => act(() => api('POST', `/v1/subscriptions/${id}`, { items: [{ id: item.id, price: ef.price, ...(isMetered(prices.data?.data.find((p: any) => p.id === ef.price)) ? {} : { quantity: ef.quantity }) }], proration_behavior: ef.proration }), 'Subscription updated').then(() => setEdit(false))}>Save</button>}>
        <div className="form-grid">
          <Field label="Price"><select className="input" value={ef.price} onChange={(e) => setEf({ ...ef, price: e.target.value })}>{prices.data?.data.filter((p: any) => p.currency === s.currency).map((p: any) => <option key={p.id} value={p.id}>{p.product?.name} · {priceLabel(p)}</option>)}</select></Field>
          {!isMetered(prices.data?.data.find((p: any) => p.id === ef.price)) && <Field label="Quantity"><input className="input" type="number" min={1} value={ef.quantity} onChange={(e) => setEf({ ...ef, quantity: e.target.value })} /></Field>}
          <Field label="Proration" hint="Changing the billing interval resets the cycle and invoices immediately.">
            <select className="input" value={ef.proration} onChange={(e) => setEf({ ...ef, proration: e.target.value })}>
              <option value="create_prorations">Prorate on the next invoice</option>
              <option value="always_invoice">Prorate and invoice now</option>
              <option value="none">No proration</option>
            </select>
          </Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------- Invoices ----------------
export function InvoiceTable({ invoices }: { invoices?: any[] }) {
  const { navigate } = useRouter();
  if (!invoices) return <Skeleton />;
  if (!invoices.length) return <Empty>No invoices.</Empty>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th className="num">Amount</th><th>Status</th><th>Number</th><th>Reason</th><th>Customer</th><th>Created</th></tr></thead>
      <tbody>{invoices.map((i: any) => (
        <tr key={i.id} className="clickable" onClick={() => navigate(`/invoices/${i.id}`)}>
          <td className="num amount">{money(i.total, i.currency)}</td>
          <td><InvoiceStatus s={i.status} />{i.status === 'open' && i.attempt_count > 0 && <span className="muted" style={{ fontSize: 12 }}> · {i.attempt_count} failed</span>}</td>
          <td className="mono soft">{i.number ?? '—'}</td>
          <td className="soft">{i.billing_reason.replace(/_/g, ' ')}</td>
          <td className="soft">{i.customer_email ?? i.customer}</td>
          <td className="soft">{dayOnly(i.created)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export function Invoices() {
  const { navigate } = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'>('all');
  const list = useLoad(() => api('GET', '/v1/invoices', { limit: 100, status: tab === 'all' ? undefined : tab }), [tab]);
  const customers = useLoad(() => api('GET', '/v1/customers', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ customer: '', description: 'Consulting services', amount: '450.00', collection: 'send_invoice', days: '30' });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try {
      if (!f.customer) throw new Error('Pick a customer.');
      await api('POST', '/v1/invoiceitems', { customer: f.customer, amount: toMinor(f.amount), currency: 'usd', description: f.description });
      const inv = await api('POST', '/v1/invoices', { customer: f.customer, collection_method: f.collection, days_until_due: f.collection === 'send_invoice' ? f.days : undefined, pending_invoice_items_behavior: 'include' });
      toast('Draft invoice created');
      setOpen(false);
      navigate(`/invoices/${inv.id}`);
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Invoices" actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create invoice</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'All' }, { id: 'draft', label: 'Draft' }, { id: 'open', label: 'Open' }, { id: 'paid', label: 'Paid' }, { id: 'void', label: 'Void' }, { id: 'uncollectible', label: 'Uncollectible' }]} />
      <Card pad={false}><InvoiceTable invoices={list.data?.data} /></Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a one-off invoice" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Create draft</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Customer"><select className="input" value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })}><option value="">Select…</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}</select></Field>
          <div className="form-row">
            <Field label="Item"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <Field label="Amount (USD)"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Payment"><select className="input" value={f.collection} onChange={(e) => setF({ ...f, collection: e.target.value })}><option value="send_invoice">Email invoice with pay link</option><option value="charge_automatically">Charge the default card</option></select></Field>
            {f.collection === 'send_invoice' && <Field label="Due in (days)"><input className="input" type="number" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>}
          </div>
        </div>
      </Modal>
    </>
  );
}

export function InvoiceDetail({ id }: { id: string }) {
  const toast = useToast();
  const inv = useLoad(() => api('GET', `/v1/invoices/${id}`, { expand: ['payment_intent'] }), [id]);
  const [err, setErr] = useState<any>(null);
  if (!inv.data) return inv.error ? <ErrorNote error={inv.error} /> : <Card><Skeleton /></Card>;
  const i = inv.data;
  const act = async (fn: () => Promise<any>, msg: string) => { setErr(null); try { await fn(); toast(msg); inv.reload(); } catch (e) { setErr(e); inv.reload(); } };
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/invoices">Invoices</Link> / <span className="mono">{i.number ?? i.id}</span></div>
      <PageHead title={money(i.total, i.currency)} sub={<span className="row"><InvoiceStatus s={i.status} />{i.number && <span className="mono">{i.number}</span>}{i.customer_email}</span>}
        actions={<>
          {i.status === 'draft' && <button className="btn btn-primary" onClick={() => act(() => api('POST', `/v1/invoices/${id}/finalize`), 'Invoice finalized')}>Finalize</button>}
          {i.status === 'draft' && <button className="btn btn-danger" onClick={() => act(() => api('DELETE', `/v1/invoices/${id}`), 'Draft deleted')}>Delete draft</button>}
          {i.status === 'open' && <button className="btn btn-primary" onClick={() => act(() => api('POST', `/v1/invoices/${id}/pay`), 'Payment attempted')}>Charge customer</button>}
          {i.status === 'open' && <button className="btn btn-secondary" onClick={() => act(() => api('POST', `/v1/invoices/${id}/pay`, { paid_out_of_band: 'true' }), 'Marked paid')}>Mark paid</button>}
          {i.status === 'open' && <button className="btn btn-secondary" onClick={() => act(() => api('POST', `/v1/invoices/${id}/mark_uncollectible`), 'Marked uncollectible')}>Uncollectible</button>}
          {['open', 'uncollectible'].includes(i.status) && <button className="btn btn-danger" onClick={() => act(() => api('POST', `/v1/invoices/${id}/void`), 'Invoice voided')}>Void</button>}
          {i.hosted_invoice_url && <a className="btn btn-secondary" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">Hosted page</a>}
          {i.invoice_pdf && <a className="btn btn-secondary" href={i.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}
        </>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 8 }}>
        <div className="stack">
          <Card title="Line items" pad={false}>
            <table className="table">
              <thead><tr><th>Description</th><th>Period</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {i.lines.data.map((l: any) => <tr key={l.id}><td>{l.description}{l.proration && <> <Badge kind="info">proration</Badge></>}</td><td className="soft">{l.period.start !== l.period.end ? `${dayOnly(l.period.start)} → ${dayOnly(l.period.end)}` : '—'}</td><td className="num">{money(l.amount, l.currency)}</td></tr>)}
                <tr><td colSpan={2} className="soft">Subtotal</td><td className="num">{money(i.subtotal, i.currency)}</td></tr>
                {!!i.total_discount_amounts.length && <tr><td colSpan={2} className="soft">Discount</td><td className="num">−{money(i.total_discount_amounts[0].amount, i.currency)}</td></tr>}
                {!!i.total_pretax_credit_amounts?.length && <tr><td colSpan={2} className="soft">Billing credits ({i.total_pretax_credit_amounts.length} {i.total_pretax_credit_amounts.length === 1 ? 'grant use' : 'grant uses'})</td><td className="num">−{money(i.total_pretax_credit_amounts.reduce((s: number, a: any) => s + a.amount, 0), i.currency)}</td></tr>}
                <TaxRows amounts={i.total_tax_amounts} currency={i.currency} colSpan={2} />
                {i.automatic_tax?.status === 'requires_location_inputs' && <tr><td colSpan={3}><div className="alert alert-warning">Automatic tax needs the customer's address (country, and state for the US and Canada).</div></td></tr>}
                <tr><td colSpan={2} className="soft">Total</td><td className="num">{money(i.total, i.currency)}</td></tr>
                {i.ending_balance !== null && i.ending_balance !== i.starting_balance && <tr><td colSpan={2} className="soft">{i.starting_balance < 0 ? 'Applied customer credit' : 'Previous balance owed'}</td><td className="num">{money(i.starting_balance - i.ending_balance, i.currency)}</td></tr>}
                {!!i.pre_payment_credit_notes_amount && <tr><td colSpan={2} className="soft">Credit notes</td><td className="num">−{money(i.pre_payment_credit_notes_amount, i.currency)}</td></tr>}
                <tr><td colSpan={2}><strong>Amount due</strong></td><td className="num amount">{money(i.amount_due, i.currency)}</td></tr>
                <tr><td colSpan={2} className="soft">Amount paid</td><td className="num">{money(i.amount_paid, i.currency)}</td></tr>
              </tbody>
            </table>
          </Card>
          {i.payment_intent?.last_payment_error && <div className="alert alert-error">Last attempt: {i.payment_intent.last_payment_error.message}</div>}
          <InvoiceRetriesCard invoice={i} />
          <PaymentPlanCard invoice={i} onChange={() => inv.reload()} />
          {i.status !== 'draft' && <CreditNotesCard invoice={{ ...i, payment_intent: i.payment_intent?.id ?? i.payment_intent }} onChange={() => inv.reload()} />}
          <Card title="Invoice object"><Json value={i} /></Card>
        </div>
        <Card title="Details">
          <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
            <dt>Created</dt><dd>{dateLong(i.created)}</dd>
            <dt>Billing reason</dt><dd>{i.billing_reason.replace(/_/g, ' ')}</dd>
            <dt>Collection</dt><dd>{i.collection_method.replace(/_/g, ' ')}</dd>
            {i.due_date && <><dt>Due</dt><dd>{dayOnly(i.due_date)}</dd></>}
            {!!i.customer_tax_ids?.length && <><dt>Customer tax ID</dt><dd className="mono">{i.customer_tax_ids.map((t: any) => t.value).join(', ')}</dd></>}
            <dt>Attempts</dt><dd>{i.attempt_count}</dd>
            {i.next_payment_attempt && <><dt>Next retry</dt><dd>{dateLong(i.next_payment_attempt)}</dd></>}
            {i.subscription && <><dt>Subscription</dt><dd><Link to={`/subscriptions/${i.subscription}`}>{i.subscription}</Link></dd></>}
            {i.payment_intent && <><dt>Payment</dt><dd><Link to={`/payments/${i.payment_intent.id}`}>{i.payment_intent.id}</Link></dd></>}
          </dl>
        </Card>
      </div>
    </>
  );
}

// ---------------- Coupons ----------------
export function Coupons() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/coupons', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ id: 'LAUNCH20', name: 'Launch 20%', kind: 'percent', value: '20', duration: 'repeating', months: '3' });
  const [err, setErr] = useState<any>(null);
  return (
    <>
      <PageHead title="Coupons" sub="Discounts applied to subscriptions, invoices and checkouts. Promotion codes are the customer-facing codes for a coupon." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create coupon</button>} />
      <div className="stack">
      <Card title="Coupons" pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No coupons yet.</Empty> : (
          <table className="table"><thead><tr><th>Coupon</th><th>Discount</th><th>Duration</th><th className="num">Redemptions</th><th>Status</th></tr></thead>
            <tbody>{list.data.data.map((c: any) => (
              <tr key={c.id}><td><strong>{c.name ?? c.id}</strong><div className="mono muted" style={{ fontSize: 12 }}>{c.id}</div></td><td>{c.percent_off ? `${c.percent_off}% off` : `${money(c.amount_off, c.currency)} off`}</td><td className="soft">{c.duration === 'repeating' ? `${c.duration_in_months} months` : c.duration}</td><td className="num">{c.times_redeemed}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}</td><td>{c.valid ? <Badge kind="success">Valid</Badge> : <Badge>Expired</Badge>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <PromotionCodes coupons={list.data?.data ?? []} />
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a coupon" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try {
          await api('POST', '/v1/coupons', { id: f.id || undefined, name: f.name || undefined, duration: f.duration, duration_in_months: f.duration === 'repeating' ? f.months : undefined, ...(f.kind === 'percent' ? { percent_off: f.value } : { amount_off: toMinor(f.value), currency: 'usd' }) });
          setOpen(false); list.reload(); toast('Coupon created');
        } catch (e) { setErr(e); }
      }}>Create coupon</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <div className="form-row">
            <Field label="Code (ID)"><input className="input" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} /></Field>
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">Percentage</option><option value="amount">Fixed amount (USD)</option></select></Field>
            <Field label={f.kind === 'percent' ? 'Percent off' : 'Amount off'}><input className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Duration"><select className="input" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })}><option value="once">Once</option><option value="repeating">Multiple months</option><option value="forever">Forever</option></select></Field>
            {f.duration === 'repeating' && <Field label="Months"><input className="input" type="number" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></Field>}
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------- Test clocks ----------------
export function TestClocks() {
  const { navigate } = useRouter();
  const list = useLoad(() => api('GET', '/v1/test_helpers/test_clocks', { limit: 100 }), []);
  const [name, setName] = useState('Renewal test');
  return (
    <>
      <PageHead title="Test clocks" sub="Freeze time for a group of customers, then move it forward to watch renewals, trials and payment retries happen." actions={<>
        <input className="input" style={{ width: 200 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Clock name" />
        <button className="btn btn-primary" onClick={async () => { const c = await api('POST', '/v1/test_helpers/test_clocks', { frozen_time: Math.floor(Date.now() / 1000), name }); navigate(`/test-clocks/${c.id}`); }}>+ New clock</button>
      </>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No test clocks yet.</Empty> : (
          <table className="table"><tbody>{list.data.data.map((c: any) => (
            <tr key={c.id} className="clickable" onClick={() => navigate(`/test-clocks/${c.id}`)}><td><strong>{c.name ?? c.id}</strong></td><td>{dateLong(c.frozen_time)}</td><td className="mono soft">{c.id}</td></tr>
          ))}</tbody></table>
        )}
      </Card>
    </>
  );
}

export function TestClockDetail({ id }: { id: string }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const clock = useLoad(() => api('GET', `/v1/test_helpers/test_clocks/${id}`), [id]);
  const subs = useLoad(() => api('GET', '/v1/subscriptions', { test_clock: id, status: 'all', limit: 100, expand: ['data.customer', 'data.items.data.price.product'] }), [id, clock.data?.frozen_time]);
  const invs = useLoad(async () => {
    const all = await api('GET', '/v1/invoices', { limit: 100 });
    return all.data.filter((i: any) => i.test_clock === id);
  }, [id, clock.data?.frozen_time]);
  const [busy, setBusy] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [cusId, setCusId] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  if (!clock.data) return clock.error ? <ErrorNote error={clock.error} /> : <Card><Skeleton /></Card>;
  const c = clock.data;
  const advance = async (seconds: number, label: string) => {
    setBusy(true); setErr(null);
    try { await api('POST', `/v1/test_helpers/test_clocks/${id}/advance`, { frozen_time: c.frozen_time + seconds }); toast(`Advanced ${label}`); clock.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const newCustomer = async () => {
    const cus = await api('POST', '/v1/customers', { name: `Clock customer ${Math.floor(Math.random() * 1000)}`, email: `clock${Date.now()}@example.com`, test_clock: id });
    setCusId(cus.id);
    setSubOpen(true);
  };
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/test-clocks">Test clocks</Link> / <span className="mono">{id}</span></div>
      <PageHead title={c.name ?? 'Test clock'} sub={<>Frozen at <strong>{dateLong(c.frozen_time)}</strong></>} actions={<button className="btn btn-primary" onClick={newCustomer}>+ Customer with subscription</button>} />
      <ErrorNote error={err} />
      <Card title="Advance time">
        <div className="row">
          {[[86400, '1 day'], [7 * 86400, '1 week'], [31 * 86400, '1 month'], [92 * 86400, '3 months'], [366 * 86400, '1 year']].map(([s, l]) => (
            <button key={l as string} className="btn btn-secondary" disabled={busy} onClick={() => advance(s as number, l as string)}>+ {l}</button>
          ))}
          {busy && <span className="muted">Running billing…</span>}
        </div>
      </Card>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="Subscriptions on this clock" pad={false}>
          {!subs.data?.data.length ? <Empty>None yet.</Empty> : (
            <table className="table"><tbody>{subs.data.data.map((s: any) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/subscriptions/${s.id}`)}><td>{s.customer?.name}</td><td><SubStatus s={s.status} /></td><td className="soft">to {dayOnly(s.current_period_end)}</td></tr>
            ))}</tbody></table>
          )}
        </Card>
        <Card title="Invoices on this clock" pad={false}><InvoiceTable invoices={invs.data} /></Card>
      </div>
      {cusId && <CreateSubscriptionModal open={subOpen} customer={cusId} onClose={() => setSubOpen(false)} onDone={() => { subs.reload(); invs.reload(); }} />}
    </>
  );
}

/** Tax lines (one per tax rate) for invoice-like totals tables. */
export function TaxRows({ amounts, currency, colSpan = 1 }: { amounts?: any[]; currency: string; colSpan?: number }) {
  const rates = useLoad(() => (amounts?.length ? api('GET', '/v1/tax_rates', { limit: 100 }) : Promise.resolve({ data: [] })), [JSON.stringify(amounts?.map((a) => a.tax_rate))]);
  if (!amounts?.length) return null;
  const byId = Object.fromEntries((rates.data?.data ?? []).map((r: any) => [r.id, r]));
  return <>{amounts.map((t: any) => {
    const r = byId[t.tax_rate];
    return <tr key={t.tax_rate}><td colSpan={colSpan} className="soft">{t.taxability_reason === 'reverse_charge' ? `${r?.display_name ?? 'VAT'} · reverse charge (customer accounts for VAT)` : r ? `${r.display_name}${r.jurisdiction ? ` · ${r.jurisdiction}` : ''} (${r.percentage}%${t.inclusive ? ', included' : ''})` : 'Tax'}</td><td className="num">{money(t.amount, currency)}</td></tr>;
  })}</>;
}
