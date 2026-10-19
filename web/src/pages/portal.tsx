import { useEffect, useState } from 'react';
import { api, ApiErr, hosted, money, priceText, useLoad, useToast } from '../lib.tsx';

const date = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' });
import { Badge, Card, CardInput, Empty, ErrorNote, Field, Modal, PageHead, Skeleton, TestCards } from '../ui.tsx';

// ---------------------------------------------------------------- dashboard: portal settings

/** Billing → Customer portal: what customers may do in the hosted portal. */
export function PortalSettings() {
  const toast = useToast();
  const cfgs = useLoad(() => api('GET', '/v1/billing_portal/configurations', { limit: 10 }), []);
  const products = useLoad(() => api('GET', '/v1/prices', { active: 'true', type: 'recurring', limit: 100, expand: ['data.product'] }), []);
  const customers = useLoad(() => api('GET', '/v1/customers', { limit: 100 }), []);
  const cfg = cfgs.data?.data.find((c: any) => c.is_default) ?? cfgs.data?.data[0];
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [previewCustomer, setPreviewCustomer] = useState('');
  useEffect(() => {
    const src = cfg?.features;
    setF({
      headline: cfg?.business_profile?.headline ?? '',
      customer_update: src?.customer_update.enabled ?? true,
      invoice_history: src?.invoice_history.enabled ?? true,
      payment_method_update: src?.payment_method_update.enabled ?? true,
      cancel: src?.subscription_cancel.enabled ?? true,
      cancel_mode: src?.subscription_cancel.mode ?? 'at_period_end',
      update: src?.subscription_update.enabled ?? false,
      proration: src?.subscription_update.proration_behavior ?? 'create_prorations',
      promo: (src?.subscription_update.default_allowed_updates ?? []).includes('promotion_code'),
      prices: new Set<string>((src?.subscription_update.products ?? []).flatMap((p: any) => p.prices)),
    });
  }, [cfg?.id, cfgs.data]);
  if (!f || !cfgs.data) return <Card><Skeleton /></Card>;
  const recurring = (products.data?.data ?? []).filter((p: any) => p.recurring);
  async function save() {
    setErr(null);
    const byProduct: Record<string, string[]> = {};
    for (const p of recurring) if (f.prices.has(p.id)) (byProduct[p.product.id ?? p.product] ??= []).push(p.id);
    const body = {
      business_profile: { headline: f.headline },
      features: {
        customer_update: { enabled: String(f.customer_update), allowed_updates: ['email', 'name', 'address', 'phone'] },
        invoice_history: { enabled: String(f.invoice_history) },
        payment_method_update: { enabled: String(f.payment_method_update) },
        subscription_cancel: { enabled: String(f.cancel), mode: f.cancel_mode },
        subscription_update: { enabled: String(f.update), proration_behavior: f.proration, default_allowed_updates: ['price', 'quantity', ...(f.promo ? ['promotion_code'] : [])], products: Object.entries(byProduct).map(([product, prices]) => ({ product, prices })) },
      },
    };
    try {
      if (cfg) await api('POST', `/v1/billing_portal/configurations/${cfg.id}`, body);
      else await api('POST', '/v1/billing_portal/configurations', body);
      toast('Portal settings saved'); cfgs.reload();
    } catch (e) { setErr(e); }
  }
  async function preview() {
    try {
      const s = await api('POST', '/v1/billing_portal/sessions', { customer: previewCustomer, return_url: location.href });
      window.open(s.url, '_blank', 'noopener');
    } catch (e) { setErr(e); }
  }
  const toggle = (k: string, label: string, hint?: string) => (
    <label className="choice"><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /><div><strong>{label}</strong>{hint && <div className="muted" style={{ fontSize: 12 }}>{hint}</div>}</div></label>
  );
  return (
    <>
      <PageHead title="Customer portal" sub="A hosted page where customers manage their own subscriptions, cards and invoices. Your server creates a portal session and redirects them to it." actions={<button className="btn btn-primary" onClick={save}>Save</button>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1">
        <div className="stack">
          <Card title="What customers can do">
            <div className="stack">
              {toggle('customer_update', 'Update their details', 'Name, email, phone and billing address.')}
              {toggle('payment_method_update', 'Manage payment methods', 'Add cards with 3-D Secure, change the default, remove cards.')}
              {toggle('invoice_history', 'See invoice history', 'With links to hosted invoices and PDFs.')}
              {toggle('cancel', 'Cancel subscriptions')}
              {f.cancel && <Field label="When a customer cancels"><select className="input" value={f.cancel_mode} onChange={(e) => setF({ ...f, cancel_mode: e.target.value })}><option value="at_period_end">Cancel at the end of the billing period</option><option value="immediately">Cancel immediately</option></select></Field>}
              {toggle('update', 'Switch plans and quantities', 'Only to the prices you pick below.')}
              {f.update && toggle('promo', 'Accept promotion codes', 'Customers can enter a code when they change plans.')}
            </div>
          </Card>
          {f.update && (
            <Card title="Plans customers can switch between">
              <div className="stack">
                {!recurring.length ? <span className="muted">Create recurring prices under Products first.</span> : recurring.map((p: any) => (
                  <label key={p.id} className="row"><input type="checkbox" checked={f.prices.has(p.id)} onChange={(e) => { const s = new Set(f.prices); e.target.checked ? s.add(p.id) : s.delete(p.id); setF({ ...f, prices: s }); }} />{p.product?.name} · {priceText(p)}</label>
                ))}
                <Field label="Price differences"><select className="input" value={f.proration} onChange={(e) => setF({ ...f, proration: e.target.value })}><option value="create_prorations">Prorate onto the next invoice</option><option value="always_invoice">Prorate and charge now</option><option value="none">Don't prorate</option></select></Field>
              </div>
            </Card>
          )}
        </div>
        <div className="stack">
          <Card title="Branding">
            <Field label="Headline"><input className="input" value={f.headline} placeholder="Manage your subscription" onChange={(e) => setF({ ...f, headline: e.target.value })} /></Field>
          </Card>
          <Card title="Preview">
            <div className="form-grid">
              <Field label="Open the portal as"><select className="input" value={previewCustomer} onChange={(e) => setPreviewCustomer(e.target.value)}><option value="">Choose a customer…</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}</select></Field>
              <button className="btn btn-secondary" disabled={!previewCustomer} onClick={preview}>Open portal</button>
              <p className="muted" style={{ fontSize: 12 }}>Same as <code>POST /v1/billing_portal/sessions</code>. Save first so the preview uses your changes.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- hosted portal

const interval = (s: any) => `${s.interval_count > 1 ? `${s.interval_count} ` : ''}${s.interval}${s.interval_count > 1 ? 's' : ''}`;
const REASONS: [string, string][] = [['too_expensive', "It's too expensive"], ['missing_features', 'Missing features I need'], ['switched_service', "I'm switching to another service"], ['unused', "I don't use it enough"], ['other', 'Other reason']];

/** The customer-facing portal, reached through a portal session URL. */
export function Portal({ token }: { token: string }) {
  const v = useLoad(() => hosted('GET', `/portal/${token}`), [token]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | { kind: 'cancel' | 'change' | 'card' | 'details'; sub?: any }>(null);
  useEffect(() => { if (v.data) document.title = `Billing · ${v.data.business.name}`; }, [v.data]);
  if (v.loading && !v.data) return <div className="center-page"><Skeleton /></div>;
  if (v.error) return <div className="center-page"><div className="card card-body stack" style={{ width: 'min(420px, 100%)' }}><ErrorNote error={v.error} /></div></div>;
  const d = v.data;
  const f = d.features;
  const run = async (action: string, body: any, then?: () => void) => {
    setBusy(true); setErr(null);
    try { const r = await hosted('POST', `/portal/${token}/${action}`, body); v.reload(); then?.(); return r; } catch (e) { setErr(e instanceof ApiErr ? e.body.error ?? e : e); return null; } finally { setBusy(false); }
  };
  const card = d.payment_methods.find((p: any) => p.id === d.customer.default_payment_method);
  return (
    <div className="express-page">
      <div className="test-band" aria-hidden="true" />
      <header className="express-top">
        <a className="muted" href={d.return_url}>← Return to {d.business.name}</a>
        <span className="spacer" />
        <Badge kind="test">Test mode</Badge>
      </header>
      <main className="express-body stack" style={{ maxWidth: 760 }}>
        <div>
          <h1 style={{ margin: 0 }}>{d.business.name}</h1>
          <p className="soft">{d.business.headline ?? 'Manage your billing'}</p>
        </div>
        <ErrorNote error={err} />
        <Card title="Current plan">
          {!d.subscriptions.length ? <span className="muted">No active subscriptions.</span> : d.subscriptions.map((s: any) => (
            <div key={s.id} className="stack" style={{ gap: 6, paddingBottom: 12 }}>
              {s.items.map((it: any) => (
                <div key={it.id} className="row"><strong>{it.name}</strong>{it.quantity > 1 && <span className="muted">× {it.quantity}</span>}<span className="spacer" /><span className="amount">{it.metered ? `${it.summary} · billed on usage` : `${money(it.amount, s.currency)} per ${interval(it)}`}</span></div>
              ))}
              <div className="soft" style={{ fontSize: 13 }}>
                {s.status === 'trialing' && s.trial_end ? `Free trial ends ${date(s.trial_end)}. ` : ''}
                {s.cancel_at_period_end ? <>Cancels on {date(s.current_period_end)}.</> : <>Renews on {date(s.current_period_end)}.</>}
                {s.status === 'past_due' && <Badge kind="warning">Payment past due</Badge>}
                {s.status === 'incomplete' && <Badge kind="warning">Waiting for the first payment</Badge>}
              </div>
              <div className="row">
                {s.pay_url && <a className="btn btn-primary btn-sm" href={s.pay_url}>Pay invoice</a>}
                {['active', 'trialing'].includes(s.status) && f.subscription_update.enabled && d.plans.length > 0 && !s.cancel_at_period_end && <button className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'change', sub: s })}>Update plan</button>}
                {s.cancel_at_period_end ? <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run('renew', { subscription: s.id })}>Renew plan</button>
                  : f.subscription_cancel.enabled && <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'cancel', sub: s })}>Cancel plan</button>}
              </div>
            </div>
          ))}
        </Card>
        {f.payment_method_update.enabled && (
          <Card title="Payment method" actions={<button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'card' })}>+ Add payment method</button>}>
            {!d.payment_methods.length ? <span className="muted">No saved cards.</span> : d.payment_methods.map((pm: any) => (
              <div key={pm.id} className="row" style={{ padding: '6px 0' }}>
                <span style={{ textTransform: 'capitalize' }}>{pm.brand}</span> •••• {pm.last4}<span className="muted">Expires {String(pm.exp_month).padStart(2, '0')}/{pm.exp_year}</span>
                {pm.id === card?.id && <Badge>Default</Badge>}
                <span className="spacer" />
                {pm.id !== card?.id && <>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run('default_card', { payment_method: pm.id })}>Make default</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run('remove_card', { payment_method: pm.id })}>Delete</button>
                </>}
              </div>
            ))}
          </Card>
        )}
        {f.customer_update.enabled && (
          <Card title="Billing information" actions={<button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'details' })}>Update information</button>}>
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Name</dt><dd>{d.customer.name ?? '—'}</dd>
              <dt>Email</dt><dd>{d.customer.email ?? '—'}</dd>
              <dt>Address</dt><dd>{d.customer.address ? [d.customer.address.line1, d.customer.address.city, d.customer.address.state, d.customer.address.postal_code, d.customer.address.country].filter(Boolean).join(', ') : '—'}</dd>
            </dl>
          </Card>
        )}
        {f.invoice_history.enabled && (
          <Card title="Invoice history" pad={false}>
            {!d.invoices.length ? <Empty>No invoices yet.</Empty> : (
              <table className="table"><tbody>{d.invoices.map((i: any) => (
                <tr key={i.id}>
                  <td className="soft">{date(i.created)}</td>
                  <td className="num amount">{money(i.total, i.currency)}</td>
                  <td>{i.status === 'paid' ? <Badge kind="success">Paid</Badge> : i.status === 'open' ? <Badge kind="warning">Due</Badge> : <Badge>{i.status}</Badge>}</td>
                  <td className="num">{i.status === 'open' && <a className="btn btn-ghost btn-sm" href={i.hosted_invoice_url}>Pay</a>}{i.invoice_pdf && <a className="btn btn-ghost btn-sm" href={i.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}</td>
                </tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Powered by Tessera · local test mode</p>
      </main>
      {modal?.kind === 'cancel' && <CancelModal sub={modal.sub} busy={busy} onClose={() => setModal(null)} onConfirm={(reason) => run('cancel', { subscription: modal.sub.id, reason }, () => setModal(null))} immediately={f.subscription_cancel.mode === 'immediately'} />}
      {modal?.kind === 'change' && <ChangePlanModal token={token} sub={modal.sub} plans={d.plans} quantity={f.subscription_update.default_allowed_updates.includes('quantity')} promo={f.subscription_update.default_allowed_updates.includes('promotion_code')} onClose={() => setModal(null)} onDone={() => { setModal(null); v.reload(); }} />}
      {modal?.kind === 'card' && <AddCardModal token={token} pk={d.publishable_key} account={d.stripe_account} onClose={() => setModal(null)} onDone={async (pm) => { await run('default_card', { payment_method: pm }); setModal(null); }} />}
      {modal?.kind === 'details' && <DetailsModal c={d.customer} busy={busy} onClose={() => setModal(null)} onSave={(body) => run('customer', body, () => setModal(null))} />}
    </div>
  );
}

function CancelModal({ sub, busy, immediately, onClose, onConfirm }: { sub: any; busy: boolean; immediately: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title="Cancel your plan" footer={<><button className="btn btn-secondary" onClick={onClose}>Go back</button><button className="btn btn-danger" disabled={busy} onClick={() => onConfirm(reason)}>Cancel plan</button></>}>
      <div className="form-grid">
        <p>{immediately ? 'Your plan ends now.' : <>Your plan stays active until <strong>{date(sub.current_period_end)}</strong>, then it won't renew.</>}</p>
        <Field label="Why are you canceling? (optional)"><select className="input" value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Prefer not to say</option>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

function ChangePlanModal({ token, sub, plans, quantity, promo, onClose, onDone }: { token: string; sub: any; plans: any[]; quantity: boolean; promo?: boolean; onClose: () => void; onDone: () => void }) {
  const current = sub.items[0];
  const [price, setPrice] = useState(current.price);
  const [qty, setQty] = useState(String(current.quantity ?? 1));
  const [code, setCode] = useState('');
  const [applied, setApplied] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (price === current.price && Number(qty) === (current.quantity ?? 1) && !applied) { setPreview(null); return; }
    let live = true;
    setErr(null);
    hosted('POST', `/portal/${token}/preview`, { subscription: sub.id, price, quantity: qty, promotion_code: applied || undefined }).then((p) => live && setPreview(p), (e) => { if (!live) return; setErr(e.body?.error ?? e); if (applied) setApplied(''); });
    return () => { live = false; };
  }, [price, qty, applied]);
  async function confirm() {
    setBusy(true); setErr(null);
    try { await hosted('POST', `/portal/${token}/update`, { subscription: sub.id, price, quantity: qty, promotion_code: applied || undefined }); onDone(); } catch (e: any) { setErr(e.body?.error ?? e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Update your plan" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !preview} onClick={confirm}>Confirm</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <div className="stack">
          {plans.map((p) => (
            <label key={p.price} className="choice"><input type="radio" name="plan" checked={price === p.price} onChange={() => setPrice(p.price)} />
              <div><strong>{p.name}</strong> <span className="soft">{p.unit_amount !== null && !p.metered ? `${money(p.unit_amount, p.currency)} per ${interval(p)}` : p.summary}</span>{p.price === current.price && <Badge>Current</Badge>}</div></label>
          ))}
        </div>
        {promo && <Field label="Promotion code"><div className="row"><input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Enter a code" /><button type="button" className="btn btn-secondary" disabled={!code} onClick={() => setApplied(code)}>Apply</button></div></Field>}
        {applied && preview && <div className="soft">Code <strong>{applied}</strong> applied.</div>}
        {quantity && !plans.find((p) => p.price === price)?.metered && <Field label="Quantity"><input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>}
        {preview && (
          <div className="alert alert-info">
            {preview.due_now > 0 ? <>You'll be charged <strong>{money(preview.due_now, preview.currency)}</strong> today for the rest of this period. </> : preview.prorations !== 0 ? <>An adjustment of <strong>{money(preview.prorations, preview.currency)}</strong> for the rest of this period goes on your next invoice. </> : null}
            Your next invoice will be <strong>{money(preview.amount_due_next, preview.currency)}</strong> on {date(preview.next_payment_attempt)}.
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddCardModal({ token, pk, account, onClose, onDone }: { token: string; pk: string; account?: string | null; onClose: () => void; onDone: (pm: string) => void }) {
  const [sdk, setSdk] = useState<{ element: any; tessera: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  async function save() {
    if (!sdk) return;
    setBusy(true); setErr(null);
    try {
      const { client_secret } = await hosted('POST', `/portal/${token}/setup_card`, {});
      const r = await sdk.tessera.confirmCardSetup(client_secret, { payment_method: { card: sdk.element }, return_url: location.href });
      if (r.error) setErr(r.error); else onDone(r.setupIntent.payment_method);
    } catch (e: any) { setErr(e.body?.error ?? e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Add a payment method" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !sdk} onClick={save}>{busy ? 'Saving…' : 'Add'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <CardInput pk={pk} account={account ?? undefined} onReady={setSdk} />
        <p className="muted" style={{ fontSize: 12 }}>The new card becomes your default for future payments.</p>
        <TestCards />
      </div>
    </Modal>
  );
}

function DetailsModal({ c, busy, onClose, onSave }: { c: any; busy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const [f, setF] = useState({ name: c.name ?? '', email: c.email ?? '', line1: c.address?.line1 ?? '', city: c.address?.city ?? '', state: c.address?.state ?? '', postal_code: c.address?.postal_code ?? '', country: c.address?.country ?? 'US' });
  return (
    <Modal open onClose={onClose} title="Billing information" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => onSave({ name: f.name, email: f.email, address: { line1: f.line1, city: f.city, state: f.state, postal_code: f.postal_code, country: f.country } })}>Save</button></>}>
      <div className="form-grid">
        <div className="form-row"><Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field></div>
        <Field label="Address"><input className="input" value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} /></Field>
        <div className="form-row">
          <Field label="City"><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <Field label="State"><input className="input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} /></Field>
        </div>
        <div className="form-row">
          <Field label="Postal code"><input className="input" value={f.postal_code} onChange={(e) => setF({ ...f, postal_code: e.target.value })} /></Field>
          <Field label="Country"><input className="input" maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
        </div>
      </div>
    </Modal>
  );
}
