import { useEffect, useState } from 'react';
import { api, ApiErr, copy, date, dateLong, hosted, Link, money, toMinor, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHead, Skeleton } from '../ui.tsx';

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
const PATHWAY: Record<string, string> = { enhanced_weathering: 'Enhanced weathering', biomass_carbon_removal_and_storage: 'Biomass removal and storage', direct_air_capture: 'Direct air capture' };

// ================================================================ Climate

const ORDER_BADGE: Record<string, any> = { open: 'info', confirmed: 'info', delivered: 'success', canceled: 'neutral' };

export function Climate() {
  const toast = useToast();
  const products = useLoad(() => api('GET', '/v1/climate/products'), []);
  const orders = useLoad(() => api('GET', '/v1/climate/orders', { limit: 100 }), []);
  const [buying, setBuying] = useState<any>(null);
  const reload = () => { orders.reload(); products.reload(); };
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); reload(); } catch (e: any) { toast(e.message, 'error'); } };
  const live = (orders.data?.data ?? []).filter((o: any) => o.status !== 'canceled');
  const tons = live.reduce((s: number, o: any) => s + Number(o.metric_tons), 0);
  const delivered = live.filter((o: any) => o.status === 'delivered').reduce((s: number, o: any) => s + Number(o.metric_tons), 0);
  const spent = live.reduce((s: number, o: any) => s + o.amount_total, 0);
  // Poll briefly while orders are waiting for supplier confirmation.
  useEffect(() => {
    if (!orders.data?.data.some((o: any) => o.status === 'open')) return;
    const t = setTimeout(() => orders.reload(), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.data]);
  return (
    <>
      <PageHead title="Climate" sub="Buy permanent carbon removal, paid from your available balance. Suppliers deliver it in the stated year; you get a certificate." />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card><div className="stat-label">Removal ordered</div><div className="stat-value">{tons.toLocaleString(undefined, { maximumFractionDigits: 3 })} t</div></Card>
        <Card><div className="stat-label">Delivered</div><div className="stat-value">{delivered.toLocaleString(undefined, { maximumFractionDigits: 3 })} t</div></Card>
        <Card><div className="stat-label">Spent</div><div className="stat-value">{money(spent)}</div></Card>
      </div>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        {!products.data ? <Card><Skeleton /></Card> : products.data.data.map((p: any) => (
          <Card key={p.id} title={p.name} actions={<button className="btn btn-primary btn-sm" onClick={() => setBuying(p)}>Buy removal</button>}>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
                <div><div className="stat-label">Per metric ton</div><div style={{ fontSize: 18, fontWeight: 600 }}>{money(p.current_prices_per_metric_ton.usd.amount_total)}</div><div className="muted" style={{ fontSize: 12 }}>incl. {money(p.current_prices_per_metric_ton.usd.amount_fees)} fees</div></div>
                <div><div className="stat-label">Delivery</div><div style={{ fontSize: 18, fontWeight: 600 }}>{p.delivery_year}</div></div>
                <div><div className="stat-label">Available</div><div style={{ fontSize: 18, fontWeight: 600 }}>{Number(p.metric_tons_available).toLocaleString()} t</div></div>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }} className="soft">
                {p.suppliers.map((s: any) => <li key={s.id}>{s.name} · {PATHWAY[s.removal_pathway] ?? s.removal_pathway} · {s.locations[0].city}, {s.locations[0].country}</li>)}
              </ul>
            </div>
          </Card>
        ))}
      </div>
      <Card title="Orders" pad={false}>
        {!orders.data ? <Skeleton /> : !orders.data.data.length ? <Empty>No orders yet. Buy removal from a portfolio above.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Order</th><th>Product</th><th className="num">Tons</th><th className="num">Total</th><th>Status</th><th>Delivery</th><th /></tr></thead>
            <tbody>{orders.data.data.map((o: any) => (
              <tr key={o.id}>
                <td><div className="mono" style={{ fontSize: 12 }}>{o.id}</div><div className="muted" style={{ fontSize: 12 }}>{date(o.created)}{o.beneficiary ? ` · for ${o.beneficiary.public_name}` : ''}</div></td>
                <td>{products.data?.data.find((p: any) => p.id === o.product)?.name ?? o.product}</td>
                <td className="num">{o.metric_tons}</td>
                <td className="num amount">{money(o.amount_total, o.currency)}</td>
                <td><Badge kind={ORDER_BADGE[o.status]}>{o.status[0].toUpperCase() + o.status.slice(1)}</Badge>{o.delayed_at && o.status !== 'delivered' && <Badge kind="warning">Delayed</Badge>}</td>
                <td className="soft">{o.status === 'delivered' ? date(o.delivered_at) : o.status === 'canceled' ? '—' : `Expected ${o.expected_delivery_year}`}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {o.certificate && <a className="btn btn-ghost btn-sm" href={o.certificate} target="_blank" rel="noreferrer">Certificate</a>}
                  {['open', 'confirmed'].includes(o.status) && <>
                    <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/climate/orders/${o.id}/deliver`), 'Order delivered')}>Deliver (test)</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/climate/orders/${o.id}/delay`), 'Delivery delayed a year')}>Delay</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/climate/orders/${o.id}/cancel`), 'Order canceled and refunded')}>Cancel</button>
                  </>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {buying && <BuyRemovalModal product={buying} onClose={() => setBuying(null)} onDone={() => { setBuying(null); toast('Order placed'); reload(); }} />}
    </>
  );
}

function BuyRemovalModal({ product, onClose, onDone }: { product: any; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'tons' | 'amount'>('tons');
  const [value, setValue] = useState('1');
  const [name, setName] = useState('');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const price = product.current_prices_per_metric_ton.usd;
  const total = mode === 'tons' ? Math.round(Number(value || 0) * price.amount_subtotal) + Math.round(Math.round(Number(value || 0) * price.amount_subtotal) * 0.03) : toMinor(value || '0');
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api('POST', '/v1/climate/orders', { product: product.id, ...(mode === 'tons' ? { metric_tons: value } : { amount: toMinor(value) }), ...(name ? { beneficiary: { public_name: name } } : {}) });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Buy ${product.name}`}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !Number(value)} onClick={submit}>Pay {money(total)} from balance</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Buy by">
          <select className="input" value={mode} onChange={(e) => { setMode(e.target.value as any); setValue(e.target.value === 'tons' ? '1' : '100.00'); }}>
            <option value="tons">Metric tons</option><option value="amount">Amount to spend (USD)</option>
          </select>
        </Field>
        <Field label={mode === 'tons' ? 'Metric tons' : 'Amount (USD)'} hint={mode === 'tons' ? `${money(price.amount_total)} per ton including fees. Minimum 0.001 t (1 kg).` : 'Tons are calculated from the amount, after the 3% fee.'}>
          <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Beneficiary name (optional)" hint="Shown on the certificate. Defaults to your business name."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** Public certificate for a delivered order. */
export function ClimateCertificate({ token }: { token: string }) {
  const c = useLoad(() => hosted('GET', `/climate/certificates/${token}`), [token]);
  useEffect(() => { document.title = 'Carbon removal certificate'; }, []);
  if (c.loading && !c.data) return <div className="center-page"><Skeleton /></div>;
  if (c.error) return <div className="center-page"><ErrorNote error={c.error} /></div>;
  const d = c.data;
  return (
    <div className="onboard-page">
      <div className="onboard-wrap">
        <div className="card card-body stack certificate">
          <div className="muted" style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 12 }}>Certificate of carbon removal</div>
          <h1 style={{ margin: 0, fontSize: 28 }}>{d.beneficiary}</h1>
          <p className="soft" style={{ margin: 0 }}>funded the permanent removal of</p>
          <div style={{ fontSize: 44, fontWeight: 700, lineHeight: 1 }}>{d.metric_tons} <span style={{ fontSize: 20 }}>metric tons of CO₂</span></div>
          <p className="soft" style={{ margin: 0 }}>through {d.product}, delivered {dateLong(d.delivered_at)}.</p>
          <table className="table table-compact"><thead><tr><th>Supplier</th><th>Location</th><th className="num">Tons</th></tr></thead>
            <tbody>{d.delivery_details.map((x: any) => <tr key={x.supplier.id}><td>{x.supplier.name}<div className="muted" style={{ fontSize: 12 }}>{PATHWAY[x.supplier.removal_pathway]}</div></td><td>{x.location.city}, {x.location.country}</td><td className="num">{x.metric_tons}</td></tr>)}</tbody>
          </table>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>Order {d.id} · Issued in Tessera test mode; no real removal took place.</p>
        </div>
      </div>
    </div>
  );
}

// ================================================================ Capital

const OFFER_BADGE: Record<string, any> = { undelivered: 'neutral', delivered: 'info', accepted: 'info', paid_out: 'warning', fully_repaid: 'success', rejected: 'neutral', expired: 'neutral', canceled: 'neutral' };
const offerLabel = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const p = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} style={{ height: 6, borderRadius: 3, background: 'var(--color-surface-sunken)', overflow: 'hidden', minWidth: 80 }}>
      <div style={{ width: `${p}%`, height: '100%', background: 'var(--color-brand)' }} />
    </div>
  );
}

export function Capital() {
  const toast = useToast();
  const offers = useLoad(() => api('GET', '/v1/tessera/capital/financing_offers'), []);
  const accounts = useLoad(() => api('GET', '/v1/accounts', { limit: 100 }), []);
  const [sel, setSel] = useState<string | null>(null);
  const txns = useLoad(async () => (sel ? api('GET', '/v1/capital/financing_transactions', { financing_offer: sel, limit: 100 }) : null), [sel, offers.data]);
  const [open, setOpen] = useState(false);
  const nameOf = (id: string) => accounts.data?.data.find((a: any) => a.id === id)?.settings?.dashboard?.display_name ?? (accounts.data?.data.some((a: any) => a.id === id) ? id : 'Your account');
  const act = async (fn: () => Promise<any>, msg?: string) => { try { const r = await fn(); if (msg) toast(msg); offers.reload(); return r; } catch (e: any) { toast(e.message, 'error'); } };
  useEffect(() => {
    if (!offers.data?.data.some((o: any) => o.status === 'accepted')) return;
    const t = setTimeout(() => offers.reload(), 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offers.data]);
  async function sendLink(o: any, openIt: boolean) {
    const l = await act(() => api('POST', `/v1/tessera/capital/financing_offers/${o.id}/application_link`));
    if (!l) return;
    if (openIt) window.open(l.url, '_blank', 'noopener');
    else { copy(l.url, toast); toast('Application link copied'); }
  }
  const outstanding = (offers.data?.data ?? []).filter((o: any) => o.status === 'paid_out').reduce((s: number, o: any) => s + o.progress.total - o.progress.paid, 0);
  return (
    <>
      <PageHead title="Capital" sub="Cash advances for your businesses, repaid automatically from a share of each sale." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>Create test offer</button>} />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card><div className="stat-label">Active financing</div><div className="stat-value">{(offers.data?.data ?? []).filter((o: any) => o.status === 'paid_out').length}</div></Card>
        <Card><div className="stat-label">Outstanding</div><div className="stat-value">{money(outstanding)}</div></Card>
        <Card><div className="stat-label">Open offers</div><div className="stat-value">{(offers.data?.data ?? []).filter((o: any) => ['undelivered', 'delivered'].includes(o.status)).length}</div></Card>
      </div>
      <Card title="Financing offers" pad={false}>
        {!offers.data ? <Skeleton /> : !offers.data.data.length ? <Empty>No offers yet. Create a test offer for your account or a connected account.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Business</th><th className="num">Advance</th><th className="num">Fee</th><th>Withholding</th><th>Status</th><th>Repaid</th><th /></tr></thead>
            <tbody>{offers.data.data.map((o: any) => {
              const t = o.accepted_terms ?? o.offered_terms;
              return (
                <tr key={o.id} className="clickable" aria-selected={sel === o.id} onClick={() => setSel(o.id)}>
                  <td>{o.account && accounts.data?.data.some((a: any) => a.id === o.account) ? <Link to={`/connect/accounts/${o.account}`} onClick={(e: any) => e.stopPropagation()}>{nameOf(o.account)}</Link> : nameOf(o.account)}<div className="muted mono" style={{ fontSize: 12 }}>{o.id}</div></td>
                  <td className="num amount">{money(t.advance_amount)}</td>
                  <td className="num">{money(t.fee_amount)}</td>
                  <td>{pct(t.withhold_rate)} of sales</td>
                  <td><Badge kind={OFFER_BADGE[o.status]}>{offerLabel(o.status)}</Badge></td>
                  <td style={{ minWidth: 140 }}>{['paid_out', 'fully_repaid'].includes(o.status) ? <><Progress value={o.progress.paid} max={o.progress.total} label="Repaid" /><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{money(o.progress.paid)} of {money(o.progress.total)}</div></> : <span className="muted">—</span>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {o.status === 'undelivered' && <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/capital/financing_offers/${o.id}/mark_delivered`), 'Offer marked delivered')}>Mark delivered</button>}
                    {o.status === 'delivered' && <>
                      <button className="btn btn-ghost btn-sm" onClick={() => sendLink(o, false)}>Copy link</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => sendLink(o, true)}>Open application</button>
                    </>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      {sel && (
        <div style={{ marginTop: 16 }}>
          <Card title="Financing transactions" pad={false}>
            {!txns.data ? <Skeleton /> : !txns.data.data.length ? <Empty>Nothing yet. Transactions appear when the advance is paid out and as sales repay it.</Empty> : (
              <table className="table">
                <thead><tr><th>Type</th><th>Description</th><th className="num">Advance</th><th className="num">Fee</th><th className="num">Total</th><th>Date</th></tr></thead>
                <tbody>{txns.data.data.map((t: any) => (
                  <tr key={t.id}><td><Badge kind={t.type === 'payout' ? 'info' : 'success'}>{t.type === 'payout' ? 'Paid out' : 'Repayment'}</Badge></td>
                    <td>{t.user_facing_description}{t.details.linked_payment && <div className="muted mono" style={{ fontSize: 12 }}>{t.details.linked_payment}</div>}</td>
                    <td className="num">{money(t.details.advance_amount)}</td><td className="num">{money(t.details.fee_amount)}</td><td className="num amount">{money(t.details.total_amount)}</td><td className="soft">{date(t.created_at)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
        </div>
      )}
      {open && <CreateOfferModal accounts={accounts.data?.data ?? []} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast('Offer created'); offers.reload(); }} />}
    </>
  );
}

function CreateOfferModal({ accounts, onClose, onDone }: { accounts: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ account: '', advance: '5000.00', fee: '500.00', rate: '10' });
  const [err, setErr] = useState<any>(null);
  async function submit() {
    setErr(null);
    try {
      await api('POST', '/v1/test_helpers/capital/financing_offers/create', { advance_amount: toMinor(f.advance), fee_amount: toMinor(f.fee), withhold_rate: String(Number(f.rate) / 100) }, f.account ? { 'Stripe-Account': f.account } : {});
      onDone();
    } catch (e) { setErr(e); }
  }
  return (
    <Modal open onClose={onClose} title="Create a test financing offer"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Create offer</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Business">
          <select className="input" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>
            <option value="">Your account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.settings?.dashboard?.display_name ?? a.email ?? a.id}</option>)}
          </select>
        </Field>
        <div className="form-row">
          <Field label="Advance (USD)"><input className="input" inputMode="decimal" value={f.advance} onChange={(e) => setF({ ...f, advance: e.target.value })} /></Field>
          <Field label="Flat fee (USD)"><input className="input" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></Field>
        </div>
        <Field label="Withholding rate (%)" hint="Share of each sale's net amount that goes to repayment, up to 30%."><input className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** Hosted page where a business reviews and accepts its financing offer. */
export function CapitalApply({ token }: { token: string }) {
  const v = useLoad(() => hosted('GET', `/capital/${token}`), [token]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [agree, setAgree] = useState(false);
  useEffect(() => { if (v.data) document.title = `Financing offer · ${v.data.platform}`; }, [v.data]);
  if (v.loading && !v.data) return <div className="center-page"><Skeleton /></div>;
  if (v.error) return <div className="center-page"><ErrorNote error={v.error} /></div>;
  const d = v.data;
  const t = d.terms;
  async function decide(decision: 'accept' | 'decline') {
    setBusy(true); setErr(null);
    try { await hosted('POST', `/capital/${token}`, { decision }); v.reload(); } catch (e) { setErr(e instanceof ApiErr ? e.body.error ?? e : e); } finally { setBusy(false); }
  }
  return (
    <div className="onboard-page">
      <div className="onboard-wrap">
        <div className="onboard-head"><div className="mark" aria-hidden="true">{d.platform.slice(0, 1)}</div><div><strong>{d.platform}</strong><div className="muted" style={{ fontSize: 12 }}>financing provided through Tessera</div></div><span className="spacer" style={{ flex: 1 }} /><Badge kind="test">Test mode</Badge></div>
        <div className="card card-body stack">
          {d.status === 'delivered' ? <>
            <div><h1 style={{ margin: 0, fontSize: 24 }}>{d.business}, you're pre-approved</h1><p className="soft" style={{ margin: '6px 0 0' }}>Get {money(t.advance_amount)} now and repay it automatically as you make sales. No credit check and no fixed payment schedule.</p></div>
            <ErrorNote error={err} />
            <dl className="kv" style={{ gridTemplateColumns: '180px 1fr' }}>
              <dt>Funding</dt><dd className="amount">{money(t.advance_amount)}</dd>
              <dt>Flat fee</dt><dd>{money(t.fee_amount)}</dd>
              <dt>Total to repay</dt><dd><strong>{money(t.advance_amount + t.fee_amount)}</strong></dd>
              <dt>Repayment</dt><dd>{pct(t.withhold_rate)} of each sale until repaid</dd>
              <dt>Offer expires</dt><dd>{dateLong(d.expires_after)}</dd>
            </dl>
            <label className="row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to the financing terms and authorize repayment from my sales.</label>
            <div className="row">
              <button className="btn btn-secondary" disabled={busy} onClick={() => decide('decline')}>No thanks</button>
              <span className="spacer" />
              <button className="btn btn-primary" disabled={busy || !agree} onClick={() => decide('accept')}>Accept {money(t.advance_amount)}</button>
            </div>
          </> : (
            <div className="stack" role="status">
              <h1 style={{ margin: 0, fontSize: 24 }}>{d.status === 'rejected' ? 'Offer declined' : d.status === 'accepted' ? 'Accepted. Your funds are on the way' : d.status === 'paid_out' ? 'Funds sent to your balance' : d.status === 'fully_repaid' ? 'Fully repaid' : `This offer is ${offerLabel(d.status).toLowerCase()}`}</h1>
              <p className="soft" style={{ margin: 0 }}>{d.status === 'accepted' || d.status === 'paid_out' ? `${money(t.advance_amount)} arrives in your available balance. ${pct(t.withhold_rate)} of each sale goes to repayment until ${money(t.advance_amount + t.fee_amount)} is repaid.` : d.status === 'rejected' ? `You can ask ${d.platform} about financing later.` : `Contact ${d.platform} for details.`}</p>
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 16 }}>Local test mode. No real money is lent or repaid.</p>
      </div>
    </div>
  );
}

// ================================================================ Financial Connections

const balanceText = (a: any) => {
  if (!a.balance) return '—';
  if (a.balance.type === 'cash') return money(a.balance.cash.available.usd);
  return `${money(a.balance.credit.used.usd)} used`;
};

/** Hosted flow where a customer links bank accounts. */
export function LinkAccounts({ secret }: { secret: string }) {
  const v = useLoad(() => hosted('GET', `/financial-connections/${secret}`), [secret]);
  const [inst, setInst] = useState<any>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const embedded = new URLSearchParams(location.search).get('embedded') === '1';
  const post = (msg: any) => { if (embedded) window.parent.postMessage({ type: 'tessera:financial_connections', ...msg }, location.origin); };
  useEffect(() => { if (v.data) document.title = `Link your bank · ${v.data.merchant}`; }, [v.data]);
  if (v.loading && !v.data) return <div className="center-page"><Skeleton /></div>;
  if (v.error) return <div className="center-page"><ErrorNote error={v.error} /></div>;
  const d = v.data;
  const PERM: Record<string, string> = { balances: 'Account balances', ownership: 'Account owner details', payment_method: 'Account and routing numbers, to make payments', transactions: 'Transactions from the last 30 days' };
  async function link() {
    setBusy(true); setErr(null);
    try {
      const r = await hosted('POST', `/financial-connections/${secret}`, { institution: inst.id, accounts: picked });
      setDone(r);
      setTimeout(() => post({ event: 'linked', session: r.session, accounts: r.accounts }), 1200);
    } catch (e) { setErr(e instanceof ApiErr ? e.body.error ?? e : e); } finally { setBusy(false); }
  }
  const head = <div className="onboard-head"><div className="mark" aria-hidden="true">{d.merchant.slice(0, 1)}</div><div><strong>{d.merchant}</strong><div className="muted" style={{ fontSize: 12 }}>uses Tessera to link your accounts</div></div><span className="spacer" style={{ flex: 1 }} /><Badge kind="test">Test mode</Badge>{embedded && <button type="button" className="btn btn-ghost btn-sm" onClick={() => post(done ? { event: 'linked', session: done.session, accounts: done.accounts } : { event: 'closed' })}>Close</button>}</div>;
  return (
    <div className="onboard-page">
      <div className="onboard-wrap">
        {head}
        <div className="card card-body stack">
          {d.completed && !done ? (
            <div role="status" className="stack"><h1 style={{ margin: 0, fontSize: 24 }}>Accounts already linked</h1><p className="soft" style={{ margin: 0 }}>You can return to {d.merchant}.</p>{d.return_url && <a className="btn btn-primary" href={d.return_url}>Return to {d.merchant}</a>}</div>
          ) : done ? (
            <div role="status" className="stack">
              <h1 style={{ margin: 0, fontSize: 24 }}>Linked {done.accounts.length} account{done.accounts.length === 1 ? '' : 's'}</h1>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{done.accounts.map((a: any) => <li key={a.id}>{a.institution_name} {a.display_name} •••• {a.last4}</li>)}</ul>
              {d.return_url && !embedded && <a className="btn btn-primary" href={d.return_url}>Return to {d.merchant}</a>}
            </div>
          ) : !inst ? (
            <>
              <div><h1 style={{ margin: 0, fontSize: 24 }}>Select your bank</h1><p className="soft" style={{ margin: '6px 0 0' }}>{d.merchant} will be able to see:</p></div>
              <ul style={{ margin: 0, paddingLeft: 18 }} className="soft">{d.permissions.map((p: string) => <li key={p}>{PERM[p] ?? p}</li>)}</ul>
              <div className="stack" style={{ gap: 8 }}>
                {d.institutions.map((i: any) => (
                  <button key={i.id} type="button" className="choice" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => { setInst(i); setPicked(i.accounts.slice(0, 1).map((a: any) => a.key)); setErr(null); }}>
                    <div><strong>{i.name}</strong><div className="muted" style={{ fontSize: 12 }}>{i.down ? 'Test: the bank is unavailable' : `${i.accounts.length} test account${i.accounts.length === 1 ? '' : 's'}`}</div></div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div><h1 style={{ margin: 0, fontSize: 24 }}>{inst.name}</h1><p className="soft" style={{ margin: '6px 0 0' }}>Choose the accounts to share with {d.merchant}.</p></div>
              <ErrorNote error={err} />
              {inst.accounts.length ? inst.accounts.map((a: any) => (
                <label key={a.key} className="choice"><input type="checkbox" checked={picked.includes(a.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.key] : picked.filter((x) => x !== a.key))} />
                  <div><strong>{a.display_name}</strong><div className="muted" style={{ fontSize: 12 }}>{a.subcategory.replace('_', ' ')} •••• {a.last4}</div></div></label>
              )) : <div className="muted">No accounts at this bank.</div>}
              <div className="row">
                <button className="btn btn-secondary" onClick={() => { setInst(null); setErr(null); }}>Back</button>
                <span className="spacer" />
                <button className="btn btn-primary" disabled={busy || (!inst.down && !picked.length)} onClick={link}>{busy ? 'Linking…' : 'Link accounts'}</button>
              </div>
            </>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 16 }}>Local test mode. These banks and balances are simulated.</p>
      </div>
    </div>
  );
}

async function startLinking(customer: string) {
  const s = await api('POST', '/v1/financial_connections/sessions', {
    account_holder: { type: 'customer', customer }, permissions: ['balances', 'ownership', 'payment_method', 'transactions'], prefetch: ['balances'],
    return_url: location.href,
  });
  window.open(`/link-accounts/${encodeURIComponent(s.client_secret)}`, '_blank', 'noopener');
}

/** Linked bank accounts on the customer page. */
export function LinkedAccountsCard({ customer }: { customer: any }) {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/financial_connections/accounts', { account_holder: { customer: customer.id }, limit: 20 }), [customer.id]);
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); list.reload(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <Card title="Linked bank accounts" actions={<>
      <button className="btn btn-ghost btn-sm" onClick={() => list.reload()}>Refresh</button>
      <button className="btn btn-ghost btn-sm" onClick={() => startLinking(customer.id).catch((e) => toast(e.message, 'error'))}>Link account</button>
    </>}>
      {!list.data ? <Skeleton rows={2} /> : !list.data.data.length ? <span className="muted">None yet. <strong>Link account</strong> opens the customer's linking flow in a new tab.</span> : (
        <div className="stack" style={{ gap: 8 }}>{list.data.data.map((a: any) => (
          <div key={a.id} className="row" style={{ flexWrap: 'wrap' }}>
            <div><div>{a.institution_name} {a.display_name} •••• {a.last4}</div><div className="muted" style={{ fontSize: 12 }}>{balanceText(a)}{a.status !== 'active' && ` · ${a.status}`}</div></div>
            <span className="spacer" />
            {a.status === 'active' && a.supported_payment_method_types.includes('us_bank_account') && a.permissions.includes('payment_method') && (
              <button className="btn btn-ghost btn-sm" onClick={() => act(async () => {
                const pm = await api('POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { financial_connections_account: a.id } });
                await api('POST', `/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
              }, 'Saved as a payment method')}>Save for payments</button>
            )}
          </div>
        ))}</div>
      )}
    </Card>
  );
}

/** All linked accounts, with balances and transactions. */
export function LinkedAccounts() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/financial_connections/accounts', { limit: 100 }), []);
  const customers = useLoad(() => api('GET', '/v1/customers', { limit: 100 }), []);
  const [sel, setSel] = useState<any>(null);
  const txns = useLoad(async () => (sel && sel.permissions.includes('transactions') ? api('GET', '/v1/financial_connections/transactions', { account: sel.id, limit: 100 }) : null), [sel?.id, sel?.transaction_refresh?.id]);
  const [linkFor, setLinkFor] = useState('');
  const act = async (a: any, fn: () => Promise<any>, msg: string) => {
    try { const r = await fn(); toast(msg); list.reload(); if (sel?.id === a.id) setSel(r); } catch (e: any) { toast(e.message, 'error'); }
  };
  const cusName = (id: string) => { const c = customers.data?.data.find((x: any) => x.id === id); return c ? c.name ?? c.email ?? id : id; };
  return (
    <>
      <PageHead title="Linked accounts" sub="Bank accounts your customers linked with Financial Connections. Read balances, owners and transactions with their permission."
        actions={<div className="row">
          <select className="input" aria-label="Customer to link" value={linkFor} onChange={(e) => setLinkFor(e.target.value)} style={{ width: 220 }}>
            <option value="">Choose a customer…</option>
            {customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!linkFor} onClick={() => startLinking(linkFor).catch((e) => toast(e.message, 'error'))}>Link an account</button>
        </div>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No linked accounts yet. Choose a customer and start the linking flow.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Account</th><th>Customer</th><th className="num">Balance</th><th>Status</th><th>Refreshed</th><th /></tr></thead>
            <tbody>{list.data.data.map((a: any) => (
              <tr key={a.id} className="clickable" aria-selected={sel?.id === a.id} onClick={() => setSel(a)}>
                <td>{a.institution_name} {a.display_name} •••• {a.last4}<div className="muted" style={{ fontSize: 12 }}>{a.subcategory.replace('_', ' ')}</div></td>
                <td>{a.account_holder.customer ? <Link to={`/customers/${a.account_holder.customer}`} onClick={(e: any) => e.stopPropagation()}>{cusName(a.account_holder.customer)}</Link> : a.account_holder.account}</td>
                <td className="num amount">{balanceText(a)}</td>
                <td><Badge kind={a.status === 'active' ? 'success' : 'neutral'}>{a.status}</Badge></td>
                <td className="soft">{a.balance_refresh ? date(a.balance_refresh.last_attempted_at) : '—'}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                  {a.status === 'active' && <>
                    {a.permissions.includes('balances') && <button className="btn btn-ghost btn-sm" onClick={() => act(a, () => api('POST', `/v1/financial_connections/accounts/${a.id}/refresh`, { features: ['balance'] }), 'Balance refreshed')}>Refresh balance</button>}
                    {a.permissions.includes('transactions') && <button className="btn btn-ghost btn-sm" onClick={() => act(a, () => api('POST', `/v1/financial_connections/accounts/${a.id}/refresh`, { features: ['transactions'] }), 'Transactions refreshed')}>Refresh transactions</button>}
                    <button className="btn btn-ghost btn-sm" onClick={() => act(a, () => api('POST', `/v1/financial_connections/accounts/${a.id}/disconnect`), 'Account disconnected')}>Disconnect</button>
                  </>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {sel && (
        <div style={{ marginTop: 16 }}>
          <Card title={`Transactions · ${sel.display_name} •••• ${sel.last4}`} pad={false}>
            {!sel.permissions.includes('transactions') ? <Empty>The customer didn't share transactions for this account.</Empty>
              : !txns.data ? <Skeleton /> : !txns.data.data.length ? <Empty>No transactions yet. Use <strong>Refresh transactions</strong> to fetch the last 30 days.</Empty> : (
                <table className="table">
                  <thead><tr><th>Date</th><th>Description</th><th>Status</th><th className="num">Amount</th></tr></thead>
                  <tbody>{txns.data.data.map((t: any) => (
                    <tr key={t.id}><td className="soft">{new Date(t.transacted_at * 1000).toLocaleDateString()}</td><td>{t.description}</td><td>{t.status === 'pending' ? <Badge kind="warning">Pending</Badge> : <Badge>Posted</Badge>}</td>
                      <td className="num amount" style={{ color: t.amount > 0 ? 'var(--color-success-text, inherit)' : undefined }}>{t.amount > 0 ? '+' : '−'}{money(Math.abs(t.amount))}</td></tr>
                  ))}</tbody>
                </table>
              )}
          </Card>
        </div>
      )}
    </>
  );
}

// ================================================================ Revenue recognition

function RevenueChart({ months }: { months: any[] }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.billed, m.recognized]));
  const W = 960, H = 200, pad = 8, bw = (W - pad) / months.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label="Billed and recognized revenue by month" style={{ width: '100%', height: 'auto' }}>
      <line x1={pad} x2={W} y1={H} y2={H} stroke="var(--color-border-strong)" />
      {months.map((m, i) => {
        const x = pad + i * bw;
        const h1 = (m.billed / max) * (H - 10), h2 = (m.recognized / max) * (H - 10);
        return (
          <g key={m.month} opacity={m.future ? 0.45 : 1}>
            <rect x={x + bw * 0.14} y={H - h1} width={bw * 0.32} height={h1} rx={2} fill="var(--color-border-strong)"><title>{`${m.month}: billed ${money(m.billed)}`}</title></rect>
            <rect x={x + bw * 0.5} y={H - h2} width={bw * 0.32} height={h2} rx={2} fill="var(--color-brand)"><title>{`${m.month}: recognized ${money(m.recognized)}`}</title></rect>
            <text x={x + bw / 2} y={H + 16} textAnchor="middle" fontSize="12" fill="var(--color-text-muted, currentColor)">{m.month.slice(2)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function RevenueRecognition() {
  const toast = useToast();
  const now = new Date();
  const [range, setRange] = useState(6);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - range + 1, 1) / 1000;
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 7, 1) / 1000;
  const r = useLoad(() => api('GET', '/v1/tessera/revenue_recognition', { interval_start: start, interval_end: end }), [range]);
  const [busy, setBusy] = useState(false);
  async function journal() {
    setBusy(true);
    try {
      const run = await api('POST', '/v1/reporting/report_runs', { report_type: 'revenue_recognition.debits_and_credits.1', parameters: { interval_start: start, interval_end: Math.floor(Date.now() / 1000) } });
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 700));
        const x = await api('GET', `/v1/reporting/report_runs/${run.id}`);
        if (x.status === 'succeeded') { window.location.href = `/v1/files/${x.result.id}/contents`; return; }
        if (x.status === 'failed') throw new Error(x.error ?? 'The report failed.');
      }
      toast('The report is still running. Find it under Reports.');
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const d = r.data;
  return (
    <>
      <PageHead title="Revenue recognition" sub="Accrual revenue from invoices and payments. Subscription periods are recognized evenly over the service period; one-time charges when billed."
        actions={<>
          <select className="input" aria-label="Range" value={range} onChange={(e) => setRange(Number(e.target.value))} style={{ width: 'auto' }}><option value={3}>Last 3 months</option><option value={6}>Last 6 months</option><option value={12}>Last 12 months</option></select>
          <button className="btn btn-secondary" disabled={busy} onClick={journal}>{busy ? 'Preparing…' : 'Download journal (CSV)'}</button>
        </>} />
      {!d ? <Card><Skeleton rows={6} /></Card> : <>
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Card><div className="stat-label">Recognized to date</div><div className="stat-value">{money(d.totals.recognized_to_date, d.currency)}</div></Card>
          <Card><div className="stat-label">Deferred revenue</div><div className="stat-value">{money(d.totals.deferred_revenue, d.currency)}</div></Card>
          <Card><div className="stat-label">Accounts receivable</div><div className="stat-value">{money(d.totals.accounts_receivable, d.currency)}</div></Card>
          <Card><div className="stat-label">Refunds and credits</div><div className="stat-value">{money(d.totals.contra_revenue, d.currency)}</div></Card>
        </div>
        <Card title="Billed and recognized by month" actions={<span className="row muted" style={{ fontSize: 12, gap: 12 }}><span className="row" style={{ gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--color-border-strong)', display: 'inline-block' }} />Billed</span><span className="row" style={{ gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--color-brand)', display: 'inline-block' }} />Recognized</span><span>Faded: scheduled</span></span>}>
          <RevenueChart months={d.months} />
        </Card>
        <div style={{ marginTop: 16 }}>
          <Card title="Monthly waterfall" pad={false}>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Month</th><th className="num">Deferred, start</th><th className="num">Billed</th><th className="num">Recognized</th><th className="num">Refunds</th><th className="num">Credit notes</th><th className="num">Net revenue</th><th className="num">Deferred, end</th></tr></thead>
              <tbody>{d.months.map((m: any) => (
                <tr key={m.month} style={m.future ? { opacity: 0.6 } : undefined}>
                  <td>{m.month}{m.future && <span className="muted" style={{ fontSize: 12 }}> · scheduled</span>}</td>
                  <td className="num">{money(m.deferred_revenue_start, d.currency)}</td><td className="num">{money(m.billed, d.currency)}</td>
                  <td className="num amount">{money(m.recognized, d.currency)}</td><td className="num">{money(m.refunds, d.currency)}</td><td className="num">{money(m.credit_notes, d.currency)}</td>
                  <td className="num amount">{money(m.net_revenue, d.currency)}</td><td className="num">{money(m.deferred_revenue_end, d.currency)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        </div>
        <div style={{ marginTop: 16 }}>
          <Card title="By product (to date)" pad={false}>
            {!d.products.length ? <Empty>No invoiced revenue yet.</Empty> : (
              <table className="table"><thead><tr><th>Product</th><th className="num">Recognized</th><th className="num">Deferred</th></tr></thead>
                <tbody>{d.products.map((p: any) => <tr key={p.product ?? 'none'}><td>{p.product ? <Link to={`/products/${p.product}`}>{p.name}</Link> : p.name}</td><td className="num amount">{money(p.recognized, d.currency)}</td><td className="num">{money(p.deferred, d.currency)}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </div>
      </>}
    </>
  );
}
