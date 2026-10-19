import { useState } from 'react';
import { intlLocale, LANGUAGES, resolveLang, translator, type Lang } from '../i18n.ts';
import { ApiErr, dateLong, hosted, money, useLoad } from '../lib.tsx';
import { Badge, CardInput, ErrorNote, Field, Skeleton, TestCards } from '../ui.tsx';

export { Pay } from './pay.tsx';
import { MethodIcon } from './pay.tsx';

/** Simulated 3-D Secure challenge (the issuer's page in real life). */
export function Authenticate({ id }: { id: string }) {
  const secret = new URLSearchParams(location.search).get('client_secret') ?? '';
  const info = useLoad(() => hosted('GET', `/authenticate/${id}?client_secret=${encodeURIComponent(secret)}`), [id]);
  const [done, setDone] = useState<any>(null);
  const finish = async (result: 'success' | 'fail') => {
    const r = await hosted('POST', `/authenticate/${id}`, { client_secret: secret, result });
    setDone(r);
    if (r.return_url) setTimeout(() => location.assign(r.return_url), 900);
  };
  return (
    <div className="center-page">
      <div className="card card-body stack" style={{ width: 'min(420px, 100%)', padding: 28 }}>
        <div className="row"><strong>3-D Secure test page</strong><Badge kind="test">Test mode</Badge></div>
        {info.error ? <ErrorNote error={info.error} /> : !info.data ? <Skeleton /> : done ? (
          <div className={`alert ${done.status === 'succeeded' ? 'alert-info' : 'alert-error'}`} role="status">
            {done.status === 'succeeded' ? 'Authentication complete. Returning to the merchant…' : done.last_payment_error ?? `Status: ${done.status}`}
          </div>
        ) : (
          <>
            <p className="soft">This page stands in for the card issuer's challenge. Approve to {info.data.kind === 'setup' ? <>let {info.data.merchant} save this card for future payments</> : <>authenticate a {money(info.data.amount, info.data.currency)} payment to {info.data.merchant}</>}.</p>
            <div className="row"><button className="btn btn-primary" onClick={() => finish('success')}>Complete authentication</button><button className="btn btn-danger" onClick={() => finish('fail')}>Fail authentication</button></div>
          </>
        )}
      </div>
    </div>
  );
}

export function Receipt({ id }: { id: string }) {
  const r = useLoad(() => hosted('GET', `/receipts/${id}`), [id]);
  return (
    <div className="center-page">
      <div className="card card-body stack" style={{ width: 'min(420px, 100%)', padding: 28 }}>
        {r.error ? <ErrorNote error={r.error} /> : !r.data ? <Skeleton /> : (
          <>
            <div className="row"><strong>Receipt from {r.data.merchant}</strong><Badge kind="test">Test</Badge></div>
            <div className="pay-total" style={{ margin: 0 }}>{money(r.data.amount, r.data.currency)}</div>
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Date</dt><dd>{dateLong(r.data.created)}</dd>
              <dt>Payment method</dt><dd>{r.data.brand} •••• {r.data.last4}</dd>
              <dt>Receipt</dt><dd className="mono">{r.data.id}</dd>
              {r.data.description && <><dt>For</dt><dd>{r.data.description}</dd></>}
              {r.data.amount_refunded > 0 && <><dt>Refunded</dt><dd>{money(r.data.amount_refunded, r.data.currency)}</dd></>}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}

/** Hosted invoice page: customers pay an open invoice by card (in the customer's language). */
export function InvoicePay({ id }: { id: string }) {
  const inv = useLoad(() => hosted('GET', `/invoices/${id}`), [id]);
  const [sdk, setSdk] = useState<{ element: any; tessera: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [whole, setWhole] = useState(false);
  const [lang, setLang] = useState<Lang | null>(null);
  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!sdk) return;
    setBusy(true);
    setError(null);
    try {
      const t = await sdk.tessera.createPaymentMethod({ card: sdk.element });
      if (t.error) throw t.error;
      const r = await hosted('POST', `/invoices/${id}/pay`, { payment_method: t.paymentMethod.id, installment: inv.data?.amounts_due && !whole ? true : undefined });
      if (r.next_action?.redirect_to_url) { location.assign(r.next_action.redirect_to_url.url); return; }
      inv.reload();
    } catch (err) {
      setError(err instanceof ApiErr ? err.body.error ?? err : err);
    } finally {
      setBusy(false);
    }
  }
  if (inv.loading && !inv.data) return <div className="center-page"><Skeleton /></div>;
  if (inv.error) return <div className="center-page"><ErrorNote error={inv.error} /></div>;
  const d = inv.data;
  const L: Lang = lang ?? resolveLang(d.locale);
  const t = translator(L);
  const loc = intlLocale(L);
  const m = (a: number) => money(a, d.currency, loc);
  const next = d.amounts_due?.find((a: any) => a.status === 'open');
  const fmtDay = (x: number) => new Date(x * 1000).toLocaleDateString(loc, { dateStyle: 'medium' });
  const payAmount = next && !whole ? next.amount : d.amount_remaining;
  return (
    <div className="pay-page" lang={L}>
      <section className="pay-summary" aria-label="Invoice">
        <div>
          <div className="row"><strong>{d.merchant}</strong><Badge kind="test">{t('test_mode')}</Badge></div>
          <div className="soft" style={{ marginTop: 24 }}>{t('invoice_no', { number: d.number })}</div>
          <div className="pay-total">{m(d.amount_due)}</div>
          {d.due_date && <div className="soft" style={{ marginBottom: 16 }}>{t('due_on', { date: fmtDay(d.due_date) })}</div>}
          {d.lines.map((l: any) => <div key={l.id} className="line-item"><span>{l.description}</span><span>{m(l.amount)}</span></div>)}
          {d.discount > 0 && <div className="line-item"><span className="soft">{t('discount')}</span><span>−{m(d.discount)}</span></div>}
          {d.tax_lines?.map((x: any) => <div key={x.label} className="line-item"><span className="soft">{x.label}</span><span>{m(x.amount)}</span></div>)}
          {d.invoice_pdf && <a className="muted" style={{ fontSize: 13 }} href={d.invoice_pdf} target="_blank" rel="noreferrer">{t('download_pdf')}</a>}
          {d.reverse_charge && <div className="soft" style={{ fontSize: 13, padding: '6px 0' }}>{t('reverse_charge_short')}</div>}
          {d.customer_tax_ids?.map((x: any) => <div key={x.value} className="soft" style={{ fontSize: 13 }}>{x.type.replace('_', ' ').toUpperCase()} {x.value}</div>)}
          {d.amount_paid > 0 && d.status !== 'paid' && <div className="line-item"><span className="soft">{t('paid_so_far')}</span><span>−{m(d.amount_paid)}</span></div>}
          <div className="line-item" style={{ fontWeight: 600, borderBottom: 0 }}><span>{d.amount_paid > 0 && d.status !== 'paid' ? t('remaining') : t('amount_due')}</span><span>{m(d.status === 'paid' ? d.amount_due : d.amount_remaining)}</span></div>
          {d.amounts_due && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('schedule')}</div>
              {d.amounts_due.map((a: any, i: number) => (
                <div key={i} className="line-item">
                  <span>{a.description ?? t('installment', { n: i + 1 })}<span className="muted" style={{ display: 'block', fontSize: 12 }}>{a.status === 'paid' ? t('paid_on', { date: fmtDay(a.paid_at) }) : `${t('due_on', { date: fmtDay(a.due_date) })}${a.due_date * 1000 < Date.now() ? ` · ${t('overdue')}` : ''}`}</span></span>
                  <span>{a.status === 'paid' ? <Badge kind="success">{t('paid')}</Badge> : m(a.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      <section className="pay-form">
        <div>
          {d.status === 'paid' ? (
            <div className="stack" role="status"><h2>{t('invoice_paid')}</h2><p className="soft">{t('invoice_paid_body', { amount: m(d.amount_paid), merchant: d.merchant })}</p></div>
          ) : d.status !== 'open' ? (
            <div className="alert alert-warning">{t('invoice_status', { status: d.status })}</div>
          ) : (
            <form className="form-grid" onSubmit={pay}>
              <h2>{t('pay_invoice')}</h2>
              {d.last_error && !error && <div className="alert alert-error">{d.last_error}</div>}
              <ErrorNote error={error} />
              {next && (
                <div className="stack" style={{ gap: 8 }}>
                  <label className="choice"><input type="radio" name="what" checked={!whole} onChange={() => setWhole(false)} /><div><strong>{t('pay_next', { what: next.description ?? t('next_installment'), amount: m(next.amount) })}</strong><div className="muted" style={{ fontSize: 12 }}>{t('due_on', { date: fmtDay(next.due_date) })}</div></div></label>
                  <label className="choice"><input type="radio" name="what" checked={whole} onChange={() => setWhole(true)} /><div><strong>{t('pay_full', { amount: m(d.amount_remaining) })}</strong></div></label>
                </div>
              )}
              <CardInput pk={d.publishable_key} account={d.stripe_account ?? undefined} onReady={setSdk} label={t('card_info')} locale={L} />
              <button className="btn btn-primary btn-lg" disabled={busy || !sdk}>{busy ? t('processing') : t('pay_amount', { amount: m(payAmount) })}</button>
              <TestCards label={t('test_cards')} />
            </form>
          )}
          <LanguagePicker value={L} onChange={setLang} label={t('language')} />
        </div>
      </section>
    </div>
  );
}

export function LanguagePicker({ value, onChange, label }: { value: Lang; onChange: (l: Lang) => void; label: string }) {
  return (
    <div className="pay-footer">
      <label><span className="muted">{label}</span>
        <select className="input input-sm" value={value} onChange={(e) => onChange(e.target.value as Lang)} aria-label={label}>
          {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
    </div>
  );
}

/** Quartet's (simulated) page where the shopper approves the Pay in 4 plan. */
export function QuartetApprove({ id }: { id: string }) {
  const secret = new URLSearchParams(location.search).get('client_secret') ?? '';
  const v = useLoad(() => hosted('GET', `/quartet/${id}?client_secret=${encodeURIComponent(secret)}`), [id]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const decide = async (result: 'approve' | 'decline') => {
    setBusy(true);
    try {
      const r = await hosted('POST', `/quartet/${id}`, { client_secret: secret, result });
      setDone(r);
      if (r.return_url) setTimeout(() => location.assign(r.return_url), 900);
    } finally { setBusy(false); }
  };
  const fmtDay = (x: number) => new Date(x * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return (
    <div className="center-page quartet-page">
      <div className="card card-body stack" style={{ width: 'min(440px, 100%)', padding: 28 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong className="quartet-logo" aria-label="Quartet"><MethodIcon m="quartet" /> quartet</strong><Badge kind="test">Test mode</Badge>
        </div>
        {v.error ? <ErrorNote error={v.error} /> : !v.data ? <Skeleton /> : done ? (
          <div className={`alert ${done.status === 'succeeded' ? 'alert-info' : 'alert-error'}`} role="status">
            {done.status === 'succeeded' ? `Plan approved. Returning to ${v.data.merchant}…` : `Not approved. Returning to ${v.data.merchant} to choose another way to pay…`}
          </div>
        ) : !v.data.pending ? (
          <div className="alert alert-warning">This payment is {v.data.status.replace(/_/g, ' ')}.{v.data.return_url && <> <a href={v.data.return_url}>Return to {v.data.merchant}</a></>}</div>
        ) : (
          <>
            <h2 style={{ margin: 0 }}>Pay {money(v.data.amount, v.data.currency)} in 4</h2>
            <p className="soft" style={{ margin: 0 }}>Interest-free, one payment every two weeks, for your purchase from {v.data.merchant.replace(/\.$/, '')}.{v.data.shopper?.email ? ` Signed in as ${v.data.shopper.email}.` : ''}</p>
            <ol className="quartet-schedule">
              {v.data.schedule.map((x: any, i: number) => (
                <li key={i}><span className="dot" aria-hidden="true" style={{ opacity: 1 - i * 0.2 }} /><span>{i === 0 ? 'Today' : fmtDay(x.due)}</span><strong>{money(x.amount, v.data.currency)}</strong></li>
              ))}
            </ol>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Test mode: Quartet is a simulated provider. Approving pays {v.data.merchant.replace(/\.$/, '')} in full now; no real installments are collected.</p>
            <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => decide('approve')}>Approve plan</button><button className="btn btn-secondary" disabled={busy} onClick={() => decide('decline')}>Decline</button></div>
          </>
        )}
      </div>
    </div>
  );
}

/** Hosted microdeposit verification for an ACH debit. */
export function VerifyMicrodeposits({ id }: { id: string }) {
  const secret = new URLSearchParams(location.search).get('client_secret') ?? '';
  const v = useLoad(() => hosted('GET', `/microdeposits/${id}?client_secret=${encodeURIComponent(secret)}`), [id]);
  const [mode, setMode] = useState<'code' | 'amounts'>('code');
  const [code, setCode] = useState('SM');
  const [amounts, setAmounts] = useState(['', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await hosted('POST', `/microdeposits/${id}`, mode === 'code' ? { client_secret: secret, descriptor_code: code } : { client_secret: secret, amounts: amounts.map((a) => Math.round(Number(a) * 100)) });
      setDone(r);
      if (r.return_url) setTimeout(() => location.assign(r.return_url), 1200);
    } catch (err) { setError(err instanceof ApiErr ? err.body.error ?? err : err); v.reload(); } finally { setBusy(false); }
  }
  return (
    <div className="center-page">
      <div className="card card-body stack" style={{ width: 'min(440px, 100%)', padding: 28 }}>
        <div className="row"><strong>Verify your bank account</strong><Badge kind="test">Test mode</Badge></div>
        {v.error ? <ErrorNote error={v.error} /> : !v.data ? <Skeleton /> : done ? (
          <div className="alert alert-info" role="status">Bank account verified. Your payment of {money(v.data.amount, v.data.currency)} to {v.data.merchant} is processing.</div>
        ) : !v.data.waiting ? (
          <div className="alert alert-warning">There is nothing to verify for this payment (status: {v.data.status.replace(/_/g, ' ')}).</div>
        ) : (
          <form className="form-grid" onSubmit={submit}>
            <p className="soft" style={{ margin: 0 }}>{v.data.merchant} sent a small deposit to {v.data.bank?.bank_name} •••• {v.data.bank?.last4} to confirm the account before debiting {money(v.data.amount, v.data.currency)}.</p>
            <div className="seg" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'code'} className={`btn btn-sm ${mode === 'code' ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => setMode('code')}>Statement code</button>
              <button type="button" role="tab" aria-selected={mode === 'amounts'} className={`btn btn-sm ${mode === 'amounts' ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => setMode('amounts')}>Two amounts</button>
            </div>
            <ErrorNote error={error} />
            {mode === 'code' ? (
              <Field label="6-character code from your statement" hint="It starts with SM. Test code: SM11AA."><input className="input mono" required maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>
            ) : (
              <div className="form-row">
                <Field label="First amount" hint="Test: 0.32"><input className="input mono" required inputMode="decimal" placeholder="0.00" value={amounts[0]} onChange={(e) => setAmounts([e.target.value, amounts[1]!])} /></Field>
                <Field label="Second amount" hint="Test: 0.45"><input className="input mono" required inputMode="decimal" placeholder="0.00" value={amounts[1]} onChange={(e) => setAmounts([amounts[0]!, e.target.value])} /></Field>
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>{v.data.attempts_left} attempts left.</p>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Shown when a payment link is deactivated, has reached its limit, or doesn't exist. */
export function LinkUnavailable({ code }: { code: string }) {
  const info = useLoad(() => hosted('GET', `/links/${code}`).catch(() => null), [code]);
  return (
    <div className="center-page">
      <div className="card card-body stack" style={{ maxWidth: 420, textAlign: 'center' }}>
        <h2 style={{ margin: 0 }}>This link is no longer available</h2>
        <p className="soft" style={{ margin: 0 }}>{info.data?.merchant_name ? `${info.data.merchant_name} has stopped accepting payments through this link.` : 'The payment link you followed is inactive or does not exist.'} Contact the seller for a new link.</p>
      </div>
    </div>
  );
}
