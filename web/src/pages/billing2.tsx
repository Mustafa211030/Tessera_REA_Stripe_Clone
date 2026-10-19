import { useEffect, useRef, useState } from 'react';
import { api, dash, date, dateLong, loadTessera, money, toMinor, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton, TestCards } from '../ui.tsx';

// ---------------------------------------------------------------- Settings → Billing

const SUB_AFTER: [string, string][] = [['cancel', 'Cancel the subscription'], ['unpaid', 'Mark the subscription unpaid'], ['past_due', 'Leave the subscription past due']];
const INV_AFTER: [string, string][] = [['open', 'Leave the invoice open'], ['uncollectible', 'Mark the invoice uncollectible']];

/** Settings → Billing: how failed subscription payments are retried, and what happens after. */
export function BillingSettings() {
  const toast = useToast();
  const s = useLoad(() => api('GET', '/v1/tessera/billing_settings'), []);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { if (s.data) setF({ ...s.data.retry, days: s.data.retry.schedule_days.join(', '), sub: s.data.after_failure.subscription, inv: s.data.after_failure.invoice }); }, [s.data]);
  if (!f) return <><PageHead title="Billing" /><ErrorNote error={s.error} />{!s.error && <Card><Skeleton /></Card>}</>;
  async function save() {
    setErr(null);
    try {
      const days = String(f.days).split(/[\s,]+/).filter(Boolean);
      await api('POST', '/v1/tessera/billing_settings', { retry: { mode: f.mode, schedule_days: days, max_attempts: f.max_attempts, window_days: f.window_days }, after_failure: { subscription: f.sub, invoice: f.inv } });
      toast('Billing settings saved'); s.reload();
    } catch (e) { setErr(e); }
  }
  const smart = f.mode === 'smart';
  return (
    <>
      <PageHead title="Billing" sub="How Tessera recovers failed subscription payments. These settings apply to invoices that are charged automatically." actions={<button className="btn btn-primary" onClick={save}>Save</button>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1">
        <div className="stack">
          <Card title="Retries for failed payments">
            <div className="stack">
              <div className="choice-grid" role="radiogroup" aria-label="Retry mode">
                <label className={`choice${smart ? ' on' : ''}`}><input type="radio" name="mode" checked={smart} onChange={() => setF({ ...f, mode: 'smart' })} /><div><strong>Smart retries</strong><div className="soft" style={{ fontSize: 13 }}>Tessera picks each retry time from the decline. Cards that cannot succeed (lost, stolen, expired, wrong number) are not retried; insufficient funds is retried on the next common payday (1st or 15th).</div></div></label>
                <label className={`choice${!smart ? ' on' : ''}`}><input type="radio" name="mode" checked={!smart} onChange={() => setF({ ...f, mode: 'schedule' })} /><div><strong>Custom schedule</strong><div className="soft" style={{ fontSize: 13 }}>Retry a fixed number of days after each failure, whatever the decline.</div></div></label>
              </div>
              {smart ? (
                <div className="form-row">
                  <Field label="Retry up to"><select className="input" value={f.max_attempts} onChange={(e) => setF({ ...f, max_attempts: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'time' : 'times'}</option>)}</select></Field>
                  <Field label="Within"><select className="input" value={f.window_days} onChange={(e) => setF({ ...f, window_days: Number(e.target.value) })}>{[7, 14, 21, 30, 60].map((n) => <option key={n} value={n}>{n === 7 ? '1 week' : n === 14 ? '2 weeks' : n === 21 ? '3 weeks' : n === 30 ? '1 month' : '2 months'}</option>)}</select></Field>
                </div>
              ) : (
                <Field label="Days after each failure" hint="Up to 8 retries, for example 3, 5, 7."><input className="input" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
              )}
            </div>
          </Card>
          <Card title="If all retries fail">
            <div className="form-row">
              <Field label="Subscription"><select className="input" value={f.sub} onChange={(e) => setF({ ...f, sub: e.target.value })}>{SUB_AFTER.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Invoice"><select className="input" value={f.inv} onChange={(e) => setF({ ...f, inv: e.target.value })}>{INV_AFTER.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </div>
            <p className="soft" style={{ fontSize: 13, margin: '8px 0 0' }}>An unpaid subscription keeps its items but stops renewing until the customer pays an open invoice.</p>
          </Card>
        </div>
        <Card title="What a failure looks like">
          <ol className="timeline">
            <li><span className="dot bad" /><div><strong>Day 0</strong><div className="soft" style={{ fontSize: 13 }}>Renewal payment fails. The subscription becomes past due.</div></div></li>
            {smart ? <>
              <li><span className="dot" /><div><strong>Next retries</strong><div className="soft" style={{ fontSize: 13 }}>Spaced 1, 2, 2, 3… days apart at 14:00 UTC, up to {f.max_attempts} attempts in {f.window_days} days.</div></div></li>
            </> : String(f.days).split(/[\s,]+/).filter(Boolean).map((d: string, i: number) => <li key={i}><span className="dot" /><div><strong>Retry {i + 1}</strong><div className="soft" style={{ fontSize: 13 }}>{d} days after the previous failure.</div></div></li>)}
            <li><span className="dot" /><div><strong>Retries run out</strong><div className="soft" style={{ fontSize: 13 }}>{SUB_AFTER.find(([v]) => v === f.sub)?.[1]}; {INV_AFTER.find(([v]) => v === f.inv)?.[1].toLowerCase()}.</div></div></li>
          </ol>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- invoice cards

/** Invoice detail: each failed attempt and when (and why) the next one is planned. */
export function InvoiceRetriesCard({ invoice }: { invoice: any }) {
  const r = useLoad(() => api('GET', `/v1/tessera/invoices/${invoice.id}/retries`), [invoice.id, invoice.attempt_count, invoice.status]);
  if (!r.data?.attempts?.length) return null;
  return (
    <Card title={<span className="row">Payment attempts <Badge kind={r.data.mode === 'smart' ? 'info' : 'neutral'}>{r.data.mode === 'smart' ? 'Smart retries' : 'Custom schedule'}</Badge></span>}>
      <ol className="timeline">
        {r.data.attempts.map((a: any, i: number) => (
          <li key={i}><span className="dot bad" /><div>
            <strong>Attempt {i + 1} failed</strong> <span className="soft">· {dateLong(a.at)}</span>
            <div style={{ fontSize: 13 }}>{a.message ?? 'The payment failed.'}{a.decline_code && <> <span className="mono soft">({a.decline_code})</span></>}</div>
            <div className="soft" style={{ fontSize: 13 }}>{a.reason}</div>
          </div></li>
        ))}
        {invoice.status === 'open' && invoice.next_payment_attempt && <li><span className="dot" /><div><strong>Next attempt</strong> <span className="soft">· {dateLong(invoice.next_payment_attempt)}</span></div></li>}
        {invoice.status === 'paid' && <li><span className="dot ok" /><div><strong>Paid</strong></div></li>}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------- features (entitlements)

/** Billing → Features: capabilities your app checks, attached to products. */
export function Features() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/entitlements/features', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', lookup_key: '' });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try { await api('POST', '/v1/entitlements/features', f); toast('Feature created'); setOpen(false); setF({ name: '', lookup_key: '' }); list.reload(); } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Features" sub="Features are what customers get from a product, such as API access or extra seats. Attach them to products; Tessera works out each customer's active entitlements from their subscriptions." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create feature</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No features yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Lookup key</th><th>Status</th><th>Created</th><th /></tr></thead>
            <tbody>{list.data.data.map((x: any) => (
              <tr key={x.id}>
                <td className="amount">{x.name}</td><td className="mono">{x.lookup_key}</td>
                <td>{x.active ? <Badge kind="success">Active</Badge> : <Badge>Archived</Badge>}</td>
                <td className="soft">{date(x.created)}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/entitlements/features/${x.id}`, { active: String(!x.active) }); toast(x.active ? 'Feature archived' : 'Feature restored'); list.reload(); }}>{x.active ? 'Archive' : 'Restore'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a feature" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Create</button></>}>
        <div className="stack">
          <ErrorNote error={err} />
          <Field label="Name"><input className="input" placeholder="API access" value={f.name} onChange={(e) => setF({ name: e.target.value, lookup_key: f.lookup_key || '' })} /></Field>
          <Field label="Lookup key" hint="What your code checks. Letters, digits, and _ . : - only."><input className="input mono" placeholder="api-access" value={f.lookup_key} onChange={(e) => setF({ ...f, lookup_key: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

/** Product detail: the features this product gives. */
export function ProductFeaturesCard({ productId }: { productId: string }) {
  const toast = useToast();
  const attached = useLoad(() => api('GET', `/v1/products/${productId}/features`), [productId]);
  const all = useLoad(() => api('GET', '/v1/entitlements/features', { limit: 100, archived: 'false' }), []);
  const [pick, setPick] = useState('');
  const have = new Set((attached.data?.data ?? []).map((pf: any) => pf.entitlement_feature.id));
  const options = (all.data?.data ?? []).filter((x: any) => !have.has(x.id));
  return (
    <Card title="Features" actions={options.length ? (
      <div className="row">
        <select className="input" style={{ height: 32, width: 'auto' }} aria-label="Feature to attach" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose a feature…</option>{options.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <button className="btn btn-secondary btn-sm" disabled={!pick} onClick={async () => { try { await api('POST', `/v1/products/${productId}/features`, { entitlement_feature: pick }); setPick(''); toast('Feature attached'); attached.reload(); } catch (e: any) { toast(e.message, 'error'); } }}>Attach</button>
      </div>
    ) : undefined}>
      {!attached.data ? <Skeleton rows={2} /> : !attached.data.data.length ? <p className="soft" style={{ margin: 0 }}>No features attached. Customers subscribed to this product get the features you attach here. <a href="/features">Manage features</a></p> : (
        <div className="stack" style={{ gap: 6 }}>
          {attached.data.data.map((pf: any) => (
            <div key={pf.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{pf.entitlement_feature.name} <span className="mono soft">{pf.entitlement_feature.lookup_key}</span>{!pf.entitlement_feature.active && <> <Badge>Archived</Badge></>}</span>
              <button className="btn btn-ghost btn-sm" onClick={async () => { await api('DELETE', `/v1/products/${productId}/features/${pf.id}`); toast('Feature removed'); attached.reload(); }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Customer detail: what the customer can use right now. */
export function EntitlementsCard({ customer }: { customer: string }) {
  const e = useLoad(() => api('GET', '/v1/entitlements/active_entitlements', { customer }), [customer]);
  return (
    <Card title="Entitlements">
      {!e.data ? <Skeleton rows={2} /> : !e.data.data.length ? <p className="soft" style={{ margin: 0, fontSize: 13 }}>No active entitlements. They come from features on the products of active, trialing or past-due subscriptions.</p> : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{e.data.data.map((x: any) => <Badge key={x.id} kind="success">{x.lookup_key}</Badge>)}</div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- billing credits

/** Customer detail: credit grants for usage-based charges, and the remaining balance. */
export function CreditGrantsCard({ customer, currency = 'usd' }: { customer: string; currency?: string }) {
  const toast = useToast();
  const grants = useLoad(() => api('GET', '/v1/billing/credit_grants', { customer, limit: 100 }), [customer]);
  const summary = useLoad(() => api('GET', '/v1/billing/credit_balance_summary', { customer, filter: { type: 'applicability_scope', applicability_scope: { price_type: 'metered' } } }), [customer]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ amount: '50.00', currency, name: '', category: 'paid', priority: '50', expires: '' });
  const [err, setErr] = useState<any>(null);
  const reload = () => { grants.reload(); summary.reload(); };
  async function create() {
    setErr(null);
    try {
      await api('POST', '/v1/billing/credit_grants', {
        customer, name: f.name || undefined, category: f.category, priority: f.priority,
        amount: { type: 'monetary', monetary: { currency: f.currency, value: toMinor(f.amount, f.currency) } },
        applicability_config: { scope: { price_type: 'metered' } },
        expires_at: f.expires ? Math.floor(new Date(f.expires + 'T23:59:59Z').getTime() / 1000) : undefined,
      });
      toast('Credit granted'); setOpen(false); reload();
    } catch (e) { setErr(e); }
  }
  const bal = summary.data?.balances ?? [];
  return (
    <Card title="Billing credits" actions={<button className="btn btn-ghost btn-sm" onClick={() => { setErr(null); setOpen(true); }}>+ Grant</button>}>
      <div className="stack" style={{ gap: 8 }}>
        <div>
          <div className="stat-label">Available for usage</div>
          <div className="amount" style={{ fontSize: 20 }}>{bal.length ? bal.map((b: any) => money(b.available_balance.monetary.value, b.available_balance.monetary.currency)).join(' · ') : money(0, currency)}</div>
        </div>
        {grants.data?.data.map((g: any) => {
          const ended = g.voided_at || (g.expires_at && g.expires_at * 1000 < Date.now());
          return (
            <div key={g.id} className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
              <span>
                {money(g.amount.monetary.value, g.amount.monetary.currency)} {g.name ?? (g.category === 'promotional' ? 'promotional credit' : 'credit')}
                {' '}{g.voided_at ? <Badge>Voided</Badge> : ended ? <Badge>Expired</Badge> : g.category === 'promotional' ? <Badge kind="info">Promo</Badge> : null}
                <div className="soft">priority {g.priority}{g.expires_at ? ` · expires ${date(g.expires_at)}` : ''}</div>
              </span>
              {!ended && <button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/billing/credit_grants/${g.id}/void`); toast('Credit grant voided'); reload(); }}>Void</button>}
            </div>
          );
        })}
        {grants.data && !grants.data.data.length && <p className="soft" style={{ margin: 0, fontSize: 13 }}>Credit is applied to metered usage on invoices, before tax.</p>}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Grant billing credits" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Grant credit</button></>}>
        <div className="stack">
          <ErrorNote error={err} />
          <div className="form-row">
            <Field label="Amount"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
          </div>
          <Field label="Name"><input className="input" placeholder="Optional, e.g. Welcome credit" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="Type"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="paid">Paid (prepaid by the customer)</option><option value="promotional">Promotional (free)</option></select></Field>
            <Field label="Priority" hint="Lower is used first."><input className="input" type="number" min={0} max={100} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field>
          </div>
          <Field label="Expires" hint="Optional."><input className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
          <p className="soft" style={{ margin: 0, fontSize: 13 }}>Applies to usage-based (metered) prices only.</p>
        </div>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- Developers → Elements

const THEMES: [string, string][] = [['stripe', 'Default'], ['night', 'Night'], ['flat', 'Flat']];
const SWATCHES = ['#0f766e', '#4f46e5', '#be123c', '#b45309', '#1c1917'];

/** Developers → Elements: try the Payment Element and Express Checkout against a real test PaymentIntent. */
export function ElementsPlayground() {
  const toast = useToast();
  const keys = useLoad(() => dash('GET', '/keys'), []);
  const pk = keys.data?.data.find((k: any) => k.type === 'publishable')?.token as string | undefined;
  const [cfg, setCfg] = useState({ amount: '49.00', currency: 'usd', theme: 'stripe', layout: 'tabs', color: SWATCHES[0]!, radius: 8, locale: 'en' });
  const [pi, setPi] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [nonce, setNonce] = useState(0);
  const expressRef = useRef<HTMLDivElement>(null);
  const paymentRef = useRef<HTMLDivElement>(null);
  const sdk = useRef<{ tessera: any; elements: any } | null>(null);

  async function newIntent() {
    setErr(null); setResult(null);
    try {
      const p = await api('POST', '/v1/payment_intents', { amount: toMinor(cfg.amount, cfg.currency), currency: cfg.currency, automatic_payment_methods: { enabled: 'true' }, description: 'Elements playground' });
      setPi(p); setNonce((n) => n + 1);
    } catch (e) { setErr(e); }
  }
  useEffect(() => { if (pk && !pi) newIntent(); }, [pk]);

  useEffect(() => {
    if (!pk || !pi) return;
    let payment: any, express: any;
    loadTessera().then((Tessera) => {
      const tessera = Tessera(pk);
      const appearance = { theme: cfg.theme, variables: { colorPrimary: cfg.color, borderRadius: `${cfg.radius}px` } };
      const elements = tessera.elements({ clientSecret: pi.client_secret, appearance, locale: cfg.locale, business: { name: 'Playground' } });
      express = elements.create('expressCheckout');
      express.mount(expressRef.current);
      express.on('confirm', async () => {
        const r = await tessera.confirmPayment({ elements, redirect: 'if_required' });
        setResult(r);
      });
      payment = elements.create('payment', { layout: cfg.layout });
      payment.mount(paymentRef.current);
      sdk.current = { tessera, elements };
    });
    return () => { payment?.unmount(); express?.unmount(); };
  }, [pk, pi?.id, nonce, cfg.theme, cfg.layout, cfg.color, cfg.radius, cfg.locale]);

  async function pay() {
    if (!sdk.current) return;
    setBusy(true); setResult(null);
    const { tessera, elements } = sdk.current;
    const v = await elements.submit();
    if (v.error) { setBusy(false); return; }
    const r = await tessera.confirmPayment({ elements, confirmParams: { return_url: `${location.origin}/developers/elements` }, redirect: 'if_required' });
    setBusy(false);
    setResult(r);
    if (r.paymentIntent) toast(`Payment ${r.paymentIntent.status.replace(/_/g, ' ')}`);
  }

  if (keys.error) return <><PageHead title="Elements" /><ErrorNote error={keys.error} /></>;
  const night = cfg.theme === 'night';
  const status = result?.paymentIntent?.status;
  return (
    <>
      <PageHead title="Elements" sub="Try the embeddable payment UI on a real test PaymentIntent. The Express Checkout row offers a device wallet and Quick pay; the Payment Element shows every method the PaymentIntent accepts in one form." actions={<button className="btn btn-secondary" onClick={newIntent}>New PaymentIntent</button>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1">
        <div className="stack">
          <div className={`playground${night ? ' night' : ''}`} style={{ background: night ? '#0c0a09' : undefined }}>
            <div className="playground-pane">
              {!pi ? <Skeleton /> : <>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                  <strong style={{ color: night ? '#f5f5f4' : undefined }}>Playground</strong>
                  <span className="amount" style={{ color: night ? '#f5f5f4' : undefined }}>{money(pi.amount, pi.currency)}</span>
                </div>
                <div ref={expressRef} data-testid="express" />
                <div className="or-divider" style={{ color: night ? '#a8a29e' : undefined }}><span>or</span></div>
                <div ref={paymentRef} data-testid="payment" />
                <button className="btn btn-primary" style={{ width: '100%', marginTop: 16, height: 44, background: cfg.color, borderColor: cfg.color }} disabled={busy || ['succeeded', 'processing'].includes(status)} onClick={pay}>{busy ? 'Processing…' : `Pay ${money(pi.amount, pi.currency)}`}</button>
              </>}
            </div>
          </div>
          {result && (result.error
            ? <div className="alert alert-error" role="alert">{result.error.message}</div>
            : <div className={`alert ${status === 'succeeded' ? 'alert-info' : 'alert-warning'}`} role="status">PaymentIntent <span className="mono">{result.paymentIntent.id}</span> is <strong>{status.replace(/_/g, ' ')}</strong>{result.paymentIntent.payment_method && <> with <span className="mono">{result.paymentIntent.payment_method}</span></>}.{status === 'processing' && ' Bank debits settle after a few minutes in test mode.'}{result.paymentIntent.next_action?.type === 'verify_with_microdeposits' && <> The bank account needs verifying first: <a href={result.paymentIntent.next_action.verify_with_microdeposits.hosted_verification_url} target="_blank" rel="noreferrer">enter the test deposits</a>.</>}</div>)}
          {result?.paymentIntent && <Card title="PaymentIntent"><Json value={result.paymentIntent} /></Card>}
        </div>
        <div className="stack">
          <Card title="Appearance">
            <div className="stack">
              <Field label="Theme"><div className="seg" role="radiogroup">{THEMES.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={cfg.theme === v} className={`seg-btn${cfg.theme === v ? ' on' : ''}`} onClick={() => setCfg({ ...cfg, theme: v })}>{l}</button>)}</div></Field>
              <Field label="Layout"><div className="seg" role="radiogroup">{[['tabs', 'Tabs'], ['accordion', 'Accordion']].map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={cfg.layout === v} className={`seg-btn${cfg.layout === v ? ' on' : ''}`} onClick={() => setCfg({ ...cfg, layout: v! })}>{l}</button>)}</div></Field>
              <Field label="Primary color"><div className="row" style={{ gap: 6 }}>{SWATCHES.map((c) => <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={cfg.color === c} onClick={() => setCfg({ ...cfg, color: c })} style={{ width: 26, height: 26, borderRadius: 13, border: cfg.color === c ? '2px solid var(--color-text)' : '2px solid transparent', background: c, cursor: 'pointer', boxShadow: 'inset 0 0 0 2px var(--color-surface)' }} />)}</div></Field>
              <Field label={`Corner radius · ${cfg.radius}px`}><input type="range" min={0} max={16} value={cfg.radius} onChange={(e) => setCfg({ ...cfg, radius: Number(e.target.value) })} /></Field>
              <Field label="Language"><select className="input" value={cfg.locale} onChange={(e) => setCfg({ ...cfg, locale: e.target.value })}>{[['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['ja', '日本語']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </div>
          </Card>
          <Card title="PaymentIntent">
            <div className="stack" style={{ gap: 8 }}>
              <div className="form-row">
                <Field label="Amount"><input className="input" value={cfg.amount} onChange={(e) => setCfg({ ...cfg, amount: e.target.value })} /></Field>
                <Field label="Currency"><select className="input" value={cfg.currency} onChange={(e) => setCfg({ ...cfg, currency: e.target.value })}>{['usd', 'eur', 'gbp'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
              </div>
              {pi && <div className="soft" style={{ fontSize: 13 }}><span className="mono">{pi.id}</span><br />Methods: {pi.payment_method_types.join(', ')}</div>}
              <p className="soft" style={{ fontSize: 12, margin: 0 }}>Which methods appear comes from Settings → Payment methods. Quick pay needs one-click checkout turned on there and a saved profile (test code 000000).</p>
            </div>
          </Card>
          <TestCards />
        </div>
      </div>
    </>
  );
}
