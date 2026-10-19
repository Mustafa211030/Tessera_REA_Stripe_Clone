import { useState } from 'react';
import { api, ApiErr, dash, date, dateLong, Link, money, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Card, CardInput, Empty, ErrorNote, Field, Json, Modal, Money, PageHead, Skeleton, StatusBadge, Tabs, TestCards } from '../ui.tsx';

const WALLET_LABEL: Record<string, string> = { device_wallet: 'Device wallet', oneclick: 'One-click checkout' };

type Filter = 'all' | 'succeeded' | 'refunded' | 'uncaptured' | 'failed';

export function chargeMatches(c: any, f: Filter) {
  if (f === 'all') return true;
  if (f === 'succeeded') return c.status === 'succeeded' && c.captured && !c.refunded;
  if (f === 'refunded') return c.amount_refunded > 0 && c.captured;
  if (f === 'uncaptured') return c.status === 'succeeded' && !c.captured && !c.refunded;
  return c.status === 'failed';
}

export function PaymentsTable({ charges }: { charges: any[] }) {
  const { navigate } = useRouter();
  if (!charges.length) return <Empty>No payments yet. Create a test payment to see it here.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th className="num">Amount</th><th>Status</th><th>Payment method</th><th>Description</th><th>Risk</th><th>Date</th></tr></thead>
        <tbody>
          {charges.map((c) => (
            <tr key={c.id} className={c.payment_intent ? 'clickable' : undefined} onClick={() => c.payment_intent && navigate(`/payments/${c.payment_intent}`)}>
              <td className="num"><Money amount={c.amount} currency={c.currency} /></td>
              <td><StatusBadge obj={c} /></td>
              <td>{(c.payment_method_details?.card ?? c.payment_method_details?.card_present) ? <><span className="soft">{(c.payment_method_details.card ?? c.payment_method_details.card_present).brand}</span> •••• {(c.payment_method_details.card ?? c.payment_method_details.card_present).last4}{c.payment_method_details.card_present && <span className="muted" style={{ fontSize: 12 }}> · in person</span>}{c.payment_method_details.card?.wallet && <span className="muted" style={{ fontSize: 12 }}> · {WALLET_LABEL[c.payment_method_details.card.wallet.type] ?? 'wallet'}</span>}</>
                : c.payment_method_details?.us_bank_account ? <><span className="soft">ACH</span> {c.payment_method_details.us_bank_account.bank_name} •••• {c.payment_method_details.us_bank_account.last4}</>
                : c.payment_method_details?.quartet ? <span className="soft">Pay in 4 · Quartet</span>
                : <span className="soft">Transfer</span>}{c.transfer && <span className="muted" style={{ fontSize: 12 }}> → connected</span>}</td>
              <td className="soft" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description ?? c.payment_intent}</td>
              <td><RiskPill outcome={c.outcome} /></td>
              <td className="soft" style={{ whiteSpace: 'nowrap' }}>{date(c.created)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskPill({ outcome }: { outcome: any }) {
  if (!outcome) return null;
  const color = outcome.risk_level === 'highest' ? 'var(--color-danger-text)' : outcome.risk_level === 'elevated' ? 'var(--color-warning-text)' : 'var(--color-text-quiet)';
  return <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>{outcome.risk_score}</span>;
}

export function Payments() {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api('GET', '/v1/charges', { limit: 100 }), []);
  const rows = (data?.data ?? []).filter((c: any) => chargeMatches(c, filter));
  return (
    <>
      <PageHead title="Payments" sub="Every charge attempt, including declines and fraud blocks." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create payment</button>} />
      <Tabs value={filter} onChange={setFilter} tabs={[{ id: 'all', label: 'All' }, { id: 'succeeded', label: 'Succeeded' }, { id: 'refunded', label: 'Refunded' }, { id: 'uncaptured', label: 'Uncaptured' }, { id: 'failed', label: 'Failed' }]} />
      <Card pad={false}>{loading && !data ? <Skeleton /> : error ? <div className="card-body"><ErrorNote error={error} /></div> : <PaymentsTable charges={rows} />}</Card>
      <CreatePaymentModal open={open} onClose={() => setOpen(false)} onDone={reload} />
    </>
  );
}

/** Creates a PaymentIntent server-side, then confirms it client-side with the card element. */
export function CreatePaymentModal({ open, onClose, onDone, customer }: { open: boolean; onClose: () => void; onDone: () => void; customer?: string }) {
  const toast = useToast();
  const [amount, setAmount] = useState('25.00');
  const [currency, setCurrency] = useState('usd');
  const [description, setDescription] = useState('Test payment');
  const [capture, setCapture] = useState<'automatic_async' | 'manual'>('automatic_async');
  const [connect, setConnect] = useState<'' | 'destination' | 'direct'>('');
  const [connAcct, setConnAcct] = useState('');
  const [appFee, setAppFee] = useState('');
  const accts = useLoad(() => (open ? api('GET', '/v1/accounts', { limit: 100 }) : Promise.resolve({ data: [] })), [open]);
  const eligible = (accts.data?.data ?? []).filter((a: any) => (connect === 'direct' ? a.charges_enabled : a.capabilities?.transfers === 'active'));
  const direct = connect === 'direct' && connAcct ? connAcct : undefined;
  const [sdk, setSdk] = useState<{ element: any; tessera: any } | null>(null);
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const keys = useLoad(() => dash('GET', '/keys'), [open]);
  const pk = keys.data?.data.find((k: any) => k.type === 'publishable')?.token;

  async function submit() {
    if (!sdk) return;
    setBusy(true);
    setError(null);
    try {
      if (connect && !connAcct) throw { message: 'Choose a connected account.' };
      const extra: any = {};
      if (connect && appFee) extra.application_fee_amount = toMinor(appFee, currency);
      if (connect === 'destination') extra.transfer_data = { destination: connAcct };
      const pi = await api('POST', '/v1/payment_intents', { amount: toMinor(amount, currency), currency, description, capture_method: capture, customer: direct ? undefined : customer, ...extra }, { 'Idempotency-Key': crypto.randomUUID(), ...(direct ? { 'Stripe-Account': direct } : {}) });
      const r = await sdk.tessera.confirmCardPayment(pi.client_secret, { payment_method: { card: sdk.element }, return_url: `${location.origin}/payments/${pi.id}` });
      if (r.error) {
        setError(r.error);
        if (r.error.payment_intent) onDone();
      } else {
        toast(r.paymentIntent.status === 'succeeded' ? 'Payment succeeded' : `Payment ${r.paymentIntent.status.replace(/_/g, ' ')}`);
        sdk.element.clear();
        onDone();
        onClose();
      }
    } catch (e) {
      setError(e instanceof ApiErr ? e : { message: (e as any)?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create a test payment"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !sdk} onClick={submit}>{busy ? 'Processing…' : `Pay ${money(toMinor(amount || '0', currency), currency)}`}</button></>}>
      <div className="form-grid">
        <ErrorNote error={error} />
        <div className="form-row">
          <Field label="Amount"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Currency">
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>{['usd', 'eur', 'gbp', 'cad', 'aud', 'nzd', 'jpy', 'inr', 'sgd', 'chf', 'sek', 'mxn', 'brl'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>
          </Field>
        </div>
        <Field label="Description"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Capture">
          <select className="input" value={capture} onChange={(e) => setCapture(e.target.value as any)}><option value="automatic_async">Automatically</option><option value="manual">Manually (authorize only)</option></select>
        </Field>
        <div className="form-row">
          <Field label="Connect">
            <select className="input" value={connect} onChange={(e) => { setConnect(e.target.value as any); setConnAcct(''); }}>
              <option value="">None (your account)</option><option value="destination">Destination charge</option><option value="direct">Direct charge on account</option>
            </select>
          </Field>
          {connect && <Field label="Application fee"><input className="input" inputMode="decimal" placeholder="0.00" value={appFee} onChange={(e) => setAppFee(e.target.value)} /></Field>}
        </div>
        {connect && (
          <Field label="Connected account" hint={eligible.length ? undefined : 'No eligible accounts. Create and onboard one under Connect.'}>
            <select className="input" value={connAcct} onChange={(e) => setConnAcct(e.target.value)}>
              <option value="">Choose…</option>
              {eligible.map((a: any) => <option key={a.id} value={a.id}>{a.settings?.dashboard?.display_name ?? a.email ?? a.id}</option>)}
            </select>
          </Field>
        )}
        {open && pk && <CardInput key={direct ?? 'platform'} pk={pk} account={direct} onReady={setSdk} />}
        <TestCards />
      </div>
    </Modal>
  );
}

export function PaymentDetail({ id }: { id: string }) {
  const toast = useToast();
  const pi = useLoad(() => api('GET', `/v1/payment_intents/${id}`, { expand: ['latest_charge', 'payment_method', 'customer'] }), [id]);
  const events = useLoad(() => api('GET', '/v1/events', { related_object: id, limit: 100 }), [id]);
  const chargeEvents = useLoad(async () => (pi.data?.latest_charge?.id ? api('GET', '/v1/events', { related_object: pi.data.latest_charge.id, limit: 100 }) : { data: [] }), [pi.data?.latest_charge?.id]);
  const ledger = useLoad(async () => {
    const ch = pi.data?.latest_charge;
    if (!ch?.id) return { data: [] };
    // The charge's own group, plus the Connect groups (transfer, application fee) that span two accounts.
    const sources = [ch.id, ch.transfer, ch.application_fee].filter(Boolean);
    const parts = await Promise.all(sources.map((s: string) => api('GET', `/v1/tessera/ledger/${s}`)));
    return { data: parts.flatMap((x: any) => x.data) };
  }, [pi.data?.latest_charge?.id]);
  const refunds = useLoad(() => api('GET', '/v1/refunds', { payment_intent: id, limit: 100 }), [id]);
  const disputes = useLoad(() => api('GET', '/v1/disputes', { payment_intent: id }), [id]);
  const efws = useLoad(() => api('GET', '/v1/radar/early_fraud_warnings', { payment_intent: id }), [id]);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmt, setRefundAmt] = useState('');
  const [reverse, setReverse] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  if (pi.loading && !pi.data) return <Card><Skeleton rows={6} /></Card>;
  if (pi.error) return <ErrorNote error={pi.error} />;
  const p = pi.data;
  const ch = p.latest_charge;
  const reloadAll = () => { pi.reload(); events.reload(); chargeEvents.reload(); ledger.reload(); refunds.reload(); disputes.reload(); efws.reload(); };
  const dispute = disputes.data?.data[0];
  const efw = efws.data?.data[0];
  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true); setErr(null);
    try { await fn(); toast(msg); reloadAll(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const refundable = ch ? ch.amount_captured - (ch.amount_refunded - (ch.amount - ch.amount_captured)) : 0;
  const allEvents = [...(events.data?.data ?? []), ...(chargeEvents.data?.data ?? [])].sort((a, b) => b.created - a.created);

  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/payments">Payments</Link> / <span className="mono">{p.id}</span></div>
      <PageHead title={money(p.amount, p.currency)} sub={<span className="row"><StatusBadge obj={ch ?? p} />{p.description}</span>}
        actions={<>
          {p.status === 'requires_capture' && <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api('POST', `/v1/payment_intents/${p.id}/capture`), 'Payment captured')}>Capture</button>}
          {['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action'].includes(p.status) && <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => api('POST', `/v1/payment_intents/${p.id}/cancel`, { cancellation_reason: 'requested_by_customer' }), 'Payment canceled')}>Cancel</button>}
          {p.status === 'succeeded' && refundable > 0 && <button className="btn btn-secondary" onClick={() => { setRefundAmt((refundable / 100).toFixed(2)); setRefundOpen(true); }}>Refund</button>}
        </>} />
      <ErrorNote error={err} />
      {dispute && <div className={`alert ${dispute.status.endsWith('needs_response') ? 'alert-warning' : 'alert-info'}`} style={{ marginTop: 12 }}>
        This payment is disputed ({dispute.reason.replace(/_/g, ' ')}), status <strong>{dispute.status.replace(/_/g, ' ')}</strong>. <Link to={`/disputes/${dispute.id}`}>{dispute.status.endsWith('needs_response') ? 'Respond to the dispute' : 'View dispute'}</Link>
      </div>}
      {efw?.actionable && <div className="alert alert-warning" style={{ marginTop: 12 }}>The issuer sent an early fraud warning ({efw.fraud_type.replace(/_/g, ' ')}). Refunding now usually prevents a dispute.</div>}
      <div className="grid grid-3-1" style={{ marginTop: 12 }}>
        <div className="stack">
          <Card title="Timeline">
            {allEvents.length ? (
              <ul className="timeline">{allEvents.map((e: any) => (
                <li key={e.id}><span className={`dot ${/succeeded|captured|completed/.test(e.type) ? 'ok' : /failed|blocked/.test(e.type) ? 'bad' : ''}`} /><div><div><code>{e.type}</code></div><div className="muted" style={{ fontSize: 12 }}>{dateLong(e.created)} · {e.id}</div></div></li>
              ))}</ul>
            ) : <span className="muted">No events.</span>}
          </Card>
          {ch && (
            <Card title="Risk evaluation">
              <div className="stack">
                <div className="row"><strong>{ch.outcome?.risk_level === 'normal' ? 'Normal risk' : ch.outcome?.risk_level === 'elevated' ? 'Elevated risk' : 'Highest risk'}</strong><span className="muted">score {ch.outcome?.risk_score}</span><span className="spacer" /><code>{ch.outcome?.type}</code></div>
                <div className="risk-meter" aria-hidden="true"><span style={{ left: `${ch.outcome?.risk_score ?? 0}%` }} /></div>
                <p className="soft">{ch.outcome?.seller_message}{ch.outcome?.rule && <> Rule: <code>{ch.outcome.rule.predicate}</code></>}</p>
                {ch.failure_message && <div className="alert alert-error">{ch.failure_code}: {ch.failure_message}</div>}
              </div>
            </Card>
          )}
          {!!refunds.data?.data.length && (
            <Card title="Refunds" pad={false}>
              <table className="table"><tbody>{refunds.data.data.map((r: any) => <tr key={r.id}><td><Money amount={r.amount} currency={r.currency} /></td><td><StatusBadge obj={r} /></td><td className="soft">{r.reason ?? '—'}</td><td className="soft">{date(r.created)}</td></tr>)}</tbody></table>
            </Card>
          )}
          {!!ledger.data?.data.length && (
            <Card title="Ledger entries" pad={false}>
              <table className="table">
                <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th>Description</th></tr></thead>
                <tbody>{ledger.data.data.map((l: any, i: number) => <tr key={i}><td><code>{l.ledger_account}</code>{l.account_id?.startsWith('acct_') && ch?.destination === l.account_id && <div className="muted" style={{ fontSize: 11 }}>connected account</div>}</td><td className="num">{l.amount > 0 ? money(l.amount, l.currency) : ''}</td><td className="num">{l.amount < 0 ? money(-l.amount, l.currency) : ''}</td><td className="soft">{l.description}</td></tr>)}</tbody>
              </table>
            </Card>
          )}
          <Card title="PaymentIntent object"><Json value={p} /></Card>
        </div>
        <div className="stack">
          <Card title="Details">
            <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
              <dt>Status</dt><dd><code>{p.status}</code></dd>
              <dt>Created</dt><dd>{dateLong(p.created)}</dd>
              <dt>Capture</dt><dd>{p.capture_method}</dd>
              <dt>Received</dt><dd>{money(p.amount_received, p.currency)}</dd>
              {p.customer && <><dt>Customer</dt><dd><Link to={`/customers/${p.customer.id}`}>{p.customer.email ?? p.customer.id}</Link></dd></>}
              {p.review && <><dt>Review</dt><dd><Link to="/reviews">{p.review}</Link></dd></>}
            </dl>
          </Card>
          {p.payment_method?.us_bank_account && (
            <Card title="Payment method (ACH Direct Debit)">
              <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                <dt>Bank</dt><dd>{p.payment_method.us_bank_account.bank_name} •••• {p.payment_method.us_bank_account.last4}</dd>
                <dt>Routing</dt><dd className="mono">{p.payment_method.us_bank_account.routing_number}</dd>
                <dt>Account</dt><dd>{p.payment_method.us_bank_account.account_holder_type}, {p.payment_method.us_bank_account.account_type}</dd>
                <dt>Verified</dt><dd>{p.payment_method.us_bank_account.financial_connections_account ? 'Instantly (Financial Connections)' : 'Microdeposits'}</dd>
                {ch?.payment_method_details?.us_bank_account?.mandate && <><dt>Mandate</dt><dd className="mono">{ch.payment_method_details.us_bank_account.mandate}</dd></>}
              </dl>
            </Card>
          )}
          {p.payment_method?.type === 'quartet' && (
            <Card title="Payment method (Pay in 4)">
              <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                <dt>Provider</dt><dd>Quartet (test)</dd>
                <dt>Shopper</dt><dd>{p.payment_method.billing_details.name} · {p.payment_method.billing_details.email}</dd>
                <dt>Plan</dt><dd>4 payments of {money(Math.floor(p.amount / 4), p.currency)}, every 2 weeks</dd>
                {ch?.payment_method_details?.quartet?.reference && <><dt>Reference</dt><dd className="mono">{ch.payment_method_details.quartet.reference}</dd></>}
              </dl>
            </Card>
          )}
          {p.payment_method && (() => { const pmc = p.payment_method.card ?? p.payment_method.card_present; return pmc && (
            <Card title={p.payment_method.type === 'card_present' ? 'Payment method (in person)' : 'Payment method'}>
              <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                <dt>Card</dt><dd>{pmc.brand} •••• {pmc.last4}</dd>
                {p.payment_method.card?.wallet && <><dt>Wallet</dt><dd>{WALLET_LABEL[p.payment_method.card.wallet.type] ?? p.payment_method.card.wallet.type}{p.payment_method.card.wallet.dynamic_last4 ? ` (device number •••• ${p.payment_method.card.wallet.dynamic_last4})` : ''}{p.payment_method.card.wallet.oneclick ? ` · ${p.payment_method.card.wallet.oneclick.email}` : ''}</dd></>}
                <dt>Expires</dt><dd>{String(pmc.exp_month).padStart(2, '0')}/{pmc.exp_year}</dd>
                <dt>Country</dt><dd>{pmc.country}</dd>
                <dt>Funding</dt><dd>{pmc.funding}</dd>
                {p.payment_method.card ? <><dt>CVC check</dt><dd>{p.payment_method.card.checks.cvc_check ?? '—'}</dd></> : <><dt>Read method</dt><dd>{pmc.read_method?.replace(/_/g, ' ')}</dd></>}
                <dt>Fingerprint</dt><dd className="mono">{pmc.fingerprint}</dd>
              </dl>
            </Card>
          ); })()}
          {(ch?.transfer || ch?.application_fee || p.transfer_data) && (
            <Card title="Connect">
              <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                {p.transfer_data && <><dt>Destination</dt><dd><Link to={`/connect/accounts/${p.transfer_data.destination}`} className="mono">{p.transfer_data.destination}</Link></dd></>}
                {ch?.transfer && <><dt>Transfer</dt><dd><Link to={`/connect/transfers?focus=${ch.transfer}`} className="mono">{ch.transfer}</Link></dd></>}
                {p.application_fee_amount != null && <><dt>App fee</dt><dd>{money(p.application_fee_amount, p.currency)}</dd></>}
                {p.transfer_group && <><dt>Group</dt><dd className="mono">{p.transfer_group}</dd></>}
              </dl>
            </Card>
          )}
          {ch?.receipt_url && <a className="btn btn-secondary" href={ch.receipt_url} target="_blank" rel="noreferrer">View receipt</a>}
        </div>
      </div>
      <Modal open={refundOpen} onClose={() => setRefundOpen(false)} title="Refund payment"
        footer={<><button className="btn btn-secondary" onClick={() => setRefundOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => act(() => api('POST', '/v1/refunds', { payment_intent: p.id, amount: toMinor(refundAmt, p.currency), reason: 'requested_by_customer', ...(ch?.transfer && reverse ? { reverse_transfer: 'true', refund_application_fee: ch.application_fee ? 'true' : undefined } : {}) }, { 'Idempotency-Key': crypto.randomUUID() }), 'Refund created').then(() => setRefundOpen(false))}>Refund</button></>}>
        <Field label="Amount" hint={`Up to ${money(refundable, p.currency)}. Processing fees are not returned.`}><input className="input" value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} /></Field>
        {ch?.transfer && <label className="row" style={{ marginTop: 12 }}><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> Reverse the transfer to the connected account{ch.application_fee ? ' and refund the application fee' : ''} in proportion</label>}
      </Modal>
    </>
  );
}
