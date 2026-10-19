import { useEffect, useRef, useState } from 'react';
import { intlLocale, LANGUAGES, resolveLang, SUGGESTED_CURRENCY, translator, type Lang } from '../i18n.ts';
import { ApiErr, hosted, isZeroDecimal, loadTessera, money, useLoad } from '../lib.tsx';
import { Badge, CardInput, ErrorNote, Field, Skeleton, TestCards } from '../ui.tsx';

type Method = 'card' | 'us_bank_account' | 'quartet';
type Oneclick = { token: string; email: string; name: string | null; default_card: string | null; cards: { id: string; brand: string; last4: string; exp_month: number; exp_year: number }[] };
const errOf = (e: unknown) => (e instanceof ApiErr ? e.body.error ?? e : e);
const BRAND: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };

/** Hosted payment page for a Checkout Session. */
export function Pay({ id }: { id: string }) {
  const s = useLoad(() => hosted('GET', `/checkout/${id}`), [id]);
  const [sdk, setSdk] = useState<{ element: any; tessera: any } | null>(null);
  const [tess, setTess] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [override, setOverride] = useState<any>(null);
  const [addr, setAddr] = useState({ country: 'US', state: '', postal_code: '', line1: '', city: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState({ terms_of_service: false, promotions: false });
  const [biz, setBiz] = useState({ on: false, type: 'eu_vat', value: '' });
  const [bizErr, setBizErr] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang | null>(null);
  const [method, setMethod] = useState<Method>('card');
  const [bank, setBank] = useState<{ id: string; bank_name: string; last4: string; instant: boolean } | null>(null);
  const [manual, setManual] = useState<null | { routing_number: string; account_number: string; account_type: string }>(null);
  const [saveOc, setSaveOc] = useState(false);
  const [ocChallenge, setOcChallenge] = useState<{ challenge: string; masked_email: string } | null>(null);
  const [ocCode, setOcCode] = useState('');
  const [ocErr, setOcErr] = useState<string | null>(null);
  const [oc, setOc] = useState<Oneclick | null>(null);
  const [ocCard, setOcCard] = useState<string | null>(null);
  const looked = useRef<string>('');
  const pr = useRef<any>(null);
  const [walletReady, setWalletReady] = useState(false);
  const walletRef = useRef<HTMLDivElement>(null);

  async function saveTaxId(next: typeof biz) {
    setBiz(next); setBizErr(null);
    if (next.on && !next.value) return;
    try { setOverride(await hosted('POST', `/checkout/${id}/tax_id`, next.on ? { type: next.type, value: next.value } : {})); } catch (e) { setBizErr(e instanceof ApiErr ? e.body.error?.message ?? 'Invalid tax ID.' : 'Invalid tax ID.'); }
  }
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const f of s.data?.custom_fields ?? []) if (f.default_value) init[f.key] = f.default_value;
    if (Object.keys(init).length) setFields((x) => ({ ...init, ...x }));
  }, [s.data?.id]);
  const [ship, setShip] = useState({ name: '', line1: '', city: '', state: '', postal_code: '', country: '' });
  useEffect(() => { const sd = s.data?.shipping?.details; if (sd) setShip({ name: sd.name ?? '', line1: sd.address?.line1 ?? '', city: sd.address?.city ?? '', state: sd.address?.state ?? '', postal_code: sd.address?.postal_code ?? '', country: sd.address?.country ?? '' }); }, [s.data?.shipping?.details?.address?.line1]);
  async function saveShipping(next: typeof ship) {
    setShip(next);
    const country = next.country || s.data?.shipping?.allowed_countries?.[0];
    if (!next.line1 || !country || ((country === 'US' || country === 'CA') && next.state.length < 2)) return;
    try { setOverride(await hosted('POST', `/checkout/${id}/shipping`, { name: next.name || name, address: { ...next, country } })); setError(null); } catch (e) { setError(errOf(e)); }
  }
  async function chooseRate(rate: string) {
    try { setOverride(await hosted('POST', `/checkout/${id}/shipping`, { shipping_rate: rate })); } catch (e) { setError(errOf(e)); }
  }
  const [code, setCode] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  async function applyCode(value: string) {
    setCodeErr(null);
    try { setOverride(await hosted('POST', `/checkout/${id}/promotion_code`, { code: value })); if (!value) setCode(''); } catch (e) { setCodeErr(e instanceof ApiErr ? e.body.error?.message ?? 'This code is invalid.' : 'This code is invalid.'); }
  }
  async function setQty(line: string, quantity: number) {
    try { setOverride(await hosted('POST', `/checkout/${id}/quantity`, { line_item: line, quantity })); } catch (e) { setError(errOf(e)); }
  }
  async function setCurrency(c: string) {
    try { setOverride(await hosted('POST', `/checkout/${id}/currency`, { currency: c })); } catch (e) { setError(errOf(e)); }
  }
  useEffect(() => { if (s.data?.status === 'complete' && s.data.auto_redirect && s.data.success_url && s.data.payment_status === 'paid') location.assign(s.data.success_url.replace('{CHECKOUT_SESSION_ID}', s.data.id)); }, [s.data?.status]);
  useEffect(() => { if (s.data?.customer_email) setEmail(s.data.customer_email); if (s.data?.address) setAddr((a) => ({ ...a, ...s.data.address })); document.title = s.data ? `Pay ${s.data.merchant_name}` : 'Checkout'; }, [s.data]);

  // The client library: device wallet sheet and bank linking (the card element loads its own copy).
  useEffect(() => {
    if (!s.data?.publishable_key) return;
    loadTessera().then((T) => setTess(T(s.data.publishable_key, s.data.stripe_account ? { stripeAccount: s.data.stripe_account } : undefined)));
  }, [s.data?.publishable_key]);
  async function updateAddress(next: typeof addr) {
    setAddr(next);
    if (!next.country || ((next.country === 'US' || next.country === 'CA') && next.state.length < 2)) return;
    try { setOverride(await hosted('POST', `/checkout/${id}/address`, { address: next })); } catch (e) { setError(errOf(e)); }
  }

  const d = s.data ? (override ? { ...s.data, ...override } : s.data) : null;
  const L: Lang = lang ?? resolveLang(d?.locale);
  const t = translator(L);
  const loc = intlLocale(L);
  // Adaptive pricing: amounts shown in the currency the customer chose.
  const cc = d?.currency_conversion && d.currency_conversion.source_currency === d.currency ? d.currency_conversion : null;
  const cur: string = cc ? cc.currency : d?.currency ?? 'usd';
  const cv = (a: number) => {
    if (!cc) return a;
    const major = isZeroDecimal(d.currency) ? a : a / 100;
    return Math.round(isZeroDecimal(cc.currency) ? major * Number(cc.fx_rate) : major * Number(cc.fx_rate) * 100);
  };
  const fmt = (a: number) => money(cv(a), cur, loc);
  const totalDue: number = cc ? cc.amount_total : d?.amount_total ?? 0;
  const totalLabel = money(totalDue, cur, loc);
  // A local currency rules out methods that only work in others (ACH is USD only).
  const QUARTET_CURRENCIES = ['usd', 'cad', 'aud', 'gbp', 'eur'];
  const types: Method[] = (d?.payment_method_types ?? ['card']).filter((m: Method) => !cc || (m === 'us_bank_account' ? cc.currency === 'usd' : m === 'quartet' ? QUARTET_CURRENCIES.includes(cc.currency) : true));
  const flags = d?.methods ?? { card: true, device_wallet: false, oneclick: false };
  useEffect(() => { if (types.length && !types.includes(method)) setMethod(types[0]!); }, [types.join()]);
  const walletOn = !!d && flags.device_wallet && types.includes('card') && d.status === 'open';

  // Device wallet: a payment request for the current total, re-mounted when the amount changes.
  useEffect(() => {
    if (!tess || !walletOn || !walletRef.current) return;
    if (!pr.current) {
      pr.current = tess.paymentRequest({ country: 'US', currency: cur, total: { label: d.merchant_name, amount: d.trial_period_days ? 0 : totalDue }, requestPayerName: true, requestPayerEmail: true, locale: loc });
      pr.current.canMakePayment().then((r: any) => {
        if (!r) return;
        tess.elements().create('paymentRequestButton', { paymentRequest: pr.current, style: { label: t('wallet') } }).mount(walletRef.current);
        setWalletReady(true);
      });
    } else pr.current.update({ currency: cur, total: { label: d.merchant_name, amount: d.trial_period_days ? 0 : totalDue }, locale: loc });
  }, [tess, walletOn, totalDue, cur, L]);
  useEffect(() => {
    if (!pr.current) return;
    const handler = async (ev: any) => {
      try {
        const r = await hosted('POST', `/checkout/${id}/pay`, { payment_method: ev.paymentMethod.id, email: ev.payerEmail || email, name: ev.payerName || name, custom_fields: fields, consent });
        ev.complete('success');
        if (r.status === 'requires_action' && r.next_action?.redirect_to_url) { location.assign(r.next_action.redirect_to_url.url); return; }
        setOverride(null);
        setTimeout(() => s.reload(), 700);
      } catch (e) { ev.complete('fail'); setError(errOf(e)); }
    };
    pr.current._listeners.paymentmethod = [handler];
  });

  // One-click: when the email belongs to a saved profile, a code is sent to sign in.
  async function lookupEmail() {
    const e = email.trim().toLowerCase();
    if (!flags.oneclick || oc || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || looked.current === e || d?.status !== 'open') return;
    looked.current = e;
    try {
      const r = await hosted('POST', '/oneclick/lookup', { checkout_session: id, email: e });
      setOcChallenge(r.exists ? { challenge: r.challenge, masked_email: r.masked_email } : null);
      setOcCode(''); setOcErr(null);
    } catch { /* lookup is best effort */ }
  }
  async function verifyCode(c: string) {
    setOcCode(c);
    if (c.replace(/\D/g, '').length !== 6 || !ocChallenge) return;
    try {
      const r = await hosted('POST', '/oneclick/verify', { challenge: ocChallenge.challenge, code: c });
      setOc(r); setOcCard(r.default_card); setOcChallenge(null); setOcErr(null);
      if (r.name && !name) setName(r.name);
    } catch (e) { setOcErr(e instanceof ApiErr ? e.body.error?.message ?? 'Incorrect code.' : 'Incorrect code.'); }
  }
  async function signOut() {
    if (oc) await hosted('POST', '/oneclick/logout', { token: oc.token }).catch(() => undefined);
    setOc(null); setOcChallenge(null); looked.current = email.trim().toLowerCase();
  }

  // Bank debits: link an account with Financial Connections, or enter it by hand.
  async function linkBank() {
    setError(null);
    try {
      const r = await hosted('POST', `/checkout/${id}/bank_session`, { email, name });
      const res = await tess.collectFinancialConnectionsAccounts({ clientSecret: r.client_secret });
      const acct = res.financialConnectionsSession?.accounts?.[0];
      if (!acct) return;
      const pm = await hosted('POST', `/checkout/${id}/payment_method`, { type: 'us_bank_account', financial_connections_account: acct.id, email, name });
      setBank({ id: pm.id, ...pm.bank });
      setManual(null);
    } catch (e) { setError(errOf(e)); }
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: any = { email, name, custom_fields: fields, consent };
      if (oc) body.oneclick = { token: oc.token, card: ocCard };
      else if (method === 'card') {
        if (!sdk) throw new Error('The card form is still loading.');
        const tk = await sdk.tessera.createPaymentMethod({ card: sdk.element, billing_details: { email, name } });
        if (tk.error) throw tk.error;
        body.payment_method = tk.paymentMethod.id;
        if (saveOc) body.save_oneclick = true;
      } else if (method === 'us_bank_account') {
        let pmId = bank?.id;
        if (!pmId) {
          if (!manual) throw new Error(t('link_bank'));
          const pm = await hosted('POST', `/checkout/${id}/payment_method`, { type: 'us_bank_account', ...manual, email, name });
          pmId = pm.id;
        }
        body.payment_method = pmId;
      } else {
        const pm = await hosted('POST', `/checkout/${id}/payment_method`, { type: 'quartet', email, name });
        body.payment_method = pm.id;
      }
      const r = await hosted('POST', `/checkout/${id}/pay`, body);
      if (r.status === 'requires_action' && r.next_action?.redirect_to_url) { location.assign(r.next_action.redirect_to_url.url); return; }
      setOverride(null);
      s.reload();
    } catch (err) {
      setError(errOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (s.loading && !s.data) return <div className="center-page"><Skeleton /></div>;
  if (s.error) return <div className="center-page"><ErrorNote error={s.error} /></div>;
  const paid = d.status === 'complete';
  const needsAddress = d.mode !== 'setup' && d.billing_address_collection === 'required' && !oc && method === 'card';
  const taxPending = d.automatic_tax?.enabled && d.automatic_tax.status !== 'complete';
  const termsMissing = d.consent_collection?.terms_of_service === 'required' && !consent.terms_of_service;
  const quarter = Math.floor(totalDue / 4);
  const asyncPending = paid && d.async_payment && d.payment_status === 'unpaid';
  const verify = d.next_action?.type === 'verify_with_microdeposits' ? d.next_action.verify_with_microdeposits : null;
  const submitLabel = busy ? t('processing')
    : d.mode === 'subscription' ? (d.trial_period_days ? t('start_trial') : t('subscribe'))
    : d.mode === 'setup' ? t('save_card')
    : !oc && method === 'quartet' ? t('continue_quartet')
    : t('pay_amount', { amount: totalLabel });
  return (
    <div className="pay-page" lang={L}>
      <div className="test-band" style={{ position: 'fixed', top: 0, left: 0, right: 0 }} aria-hidden="true" />
      <section className="pay-summary" aria-label="Order summary">
        <div>
          <div className="row"><strong>{d.merchant_name}</strong><Badge kind="test">{t('test_mode')}</Badge></div>
          <div className="soft" style={{ marginTop: 24 }}>{d.mode === 'subscription' ? t('subscribe_to', { item: d.line_items[0].description }) : t('pay_merchant', { merchant: d.merchant_name })}</div>
          <div className="pay-total">{totalLabel}{d.mode === 'subscription' && <span className="soft" style={{ fontSize: 16, fontWeight: 400 }}> {d.line_items.find((l: any) => l.interval)?.interval}</span>}</div>
          {d.trial_period_days && <div className="alert alert-info" style={{ marginBottom: 12 }}>{t('trial', { days: d.trial_period_days })}</div>}
          {d.line_items.map((li: any) => (
            <div key={li.id} className="line-item">
              <span>{li.description}
                {li.adjustable && !paid && d.status === 'open' ? (
                  <span className="qty-stepper" style={{ marginLeft: 8 }}>
                    <button type="button" className="btn btn-secondary" aria-label="Decrease quantity" disabled={li.quantity <= li.adjustable.minimum} onClick={() => setQty(li.id, li.quantity - 1)}>−</button>
                    <span aria-live="polite">{li.quantity}</span>
                    <button type="button" className="btn btn-secondary" aria-label="Increase quantity" disabled={li.quantity >= li.adjustable.maximum} onClick={() => setQty(li.id, li.quantity + 1)}>+</button>
                  </span>
                ) : li.quantity > 1 && <span className="muted"> × {li.quantity}</span>}
                {li.metered ? <span className="muted"> · {li.unit}, {t('billed_on_usage')}</span> : li.interval && <span className="muted"> · {t('billed', { interval: li.interval.replace('/ ', '') })}</span>}</span>
              <span>{li.metered ? <span className="muted">{t('usage')}</span> : fmt(li.amount_subtotal ?? li.amount_total)}</span></div>
          ))}
          {d.amount_subtotal !== undefined && (d.tax_lines?.length > 0 || d.automatic_tax?.enabled || d.discount || d.allow_promotion_codes) && <div className="line-item"><span className="soft">{t('subtotal')}</span><span>{fmt(d.amount_subtotal)}</span></div>}
          {d.discount && <div className="line-item"><span className="soft">{d.discount.code ? <><span className="badge badge-neutral mono">{d.discount.code}</span> </> : null}{d.discount.name}{d.discount.percent_off ? ` (${d.discount.percent_off}%)` : ''}{!paid && d.discount.code && <button type="button" className="btn btn-ghost btn-sm" aria-label={t('remove_promo')} onClick={() => applyCode('')}>✕</button>}</span><span>−{fmt(d.discount.amount)}</span></div>}
          {d.shipping_cost && <div className="line-item"><span className="soft">{t('shipping')} · {d.shipping_options.find((o: any) => o.id === d.shipping_cost.rate)?.display_name ?? 'Standard'}</span><span>{d.shipping_cost.amount ? fmt(d.shipping_cost.amount) : t('free')}</span></div>}
          {d.allow_promotion_codes && !d.discount && !paid && d.status === 'open' && (
            codeOpen ? (
              <form className="stack" style={{ gap: 4, padding: '8px 0' }} onSubmit={(e) => { e.preventDefault(); applyCode(code); }}>
                <div className="promo-row"><input className="input" aria-label={t('promo')} placeholder={t('promo')} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus /><button className="btn btn-secondary" disabled={!code}>{t('apply')}</button></div>
                {codeErr && <span className="field-error" role="alert" style={{ color: 'var(--color-danger-text)', fontSize: 13 }}>{codeErr}</span>}
              </form>
            ) : <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => setCodeOpen(true)}>{t('add_promo')}</button>
          )}
          {d.tax_lines?.map((x: any, i: number) => <div key={i} className="line-item"><span className="soft">{x.reverse_charge ? `${x.display_name} · reverse charge` : <>{x.display_name}{x.jurisdiction ? ` · ${x.jurisdiction}` : ''} ({x.percentage}%{x.inclusive ? ', incl.' : ''})</>}</span><span>{fmt(x.amount)}</span></div>)}
          {taxPending && <div className="line-item"><span className="soft">{t('tax')}</span><span className="muted">{t('enter_address_tax')}</span></div>}
          {d.reverse_charge && <div className="alert alert-info" style={{ margin: '8px 0' }}>{t('reverse_charge')}</div>}
          <div className="line-item" style={{ fontWeight: 600, borderBottom: 0 }}><span>{d.trial_period_days ? t('total_due_today') : t('total_due')}</span><span>{d.trial_period_days ? money(0, cur, loc) : totalLabel}</span></div>
          {cc && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t('converted', { from: d.currency.toUpperCase(), rate: Number(cc.fx_rate).toLocaleString(loc, { maximumFractionDigits: 4 }), to: cc.currency.toUpperCase() })}</p>}
          {!paid && d.status === 'open' && types.includes('quartet') && totalDue >= 100 && <p className="soft" style={{ fontSize: 13, marginTop: 8 }}>{t('m_quartet')}: {t('quartet_line', { amount: money(quarter, cur, loc) })}</p>}
        </div>
      </section>
      <section className="pay-form">
        <div>
          {paid ? (
            <div className="stack" role="status">
              {asyncPending ? (
                d.async_payment.failed
                  ? <><h2>{t('processing_title')}</h2><div className="alert alert-error">{t('async_failed', { merchant: d.merchant_name })}</div></>
                  : <><h2>{t('processing_title')}</h2><p className="soft">{t('processing_body', { merchant: d.merchant_name, amount: totalLabel })}</p></>
              ) : <>
                <h2>{d.mode === 'subscription' ? t('sub_title') : d.mode === 'setup' ? t('setup_title') : t('paid_title')}</h2>
                <p className="soft">{d.mode === 'subscription' ? t('sub_body', { item: d.line_items[0].description }) : d.mode === 'setup' ? t('setup_body', { merchant: d.merchant_name }) : t('paid_body', { amount: totalLabel, merchant: d.merchant_name })}</p>
              </>}
              {d.custom_message && <div className="confirm-message">{d.custom_message}</div>}
              {d.success_url && <a className="btn btn-primary" href={d.success_url.replace('{CHECKOUT_SESSION_ID}', d.id)}>{d.auto_redirect && d.payment_status === 'paid' ? t('redirecting') : t('continue')}</a>}
            </div>
          ) : d.status !== 'open' ? (
            <div className="alert alert-warning">{t('link_status', { status: d.status })}</div>
          ) : verify ? (
            <div className="stack" role="status">
              <h2>{t('verify_title')}</h2>
              <p className="soft">{t('verify_body')}</p>
              <a className="btn btn-primary" href={verify.hosted_verification_url}>{t('verify_now')}</a>
            </div>
          ) : (
            <form className="form-grid" onSubmit={pay}>
              {walletOn && <div className="stack" style={{ gap: 12 }}>
                <div ref={walletRef} style={{ minHeight: walletReady ? 44 : 0 }} />
                {walletReady && <div className="divider-text"><span>{t('or_other')}</span></div>}
              </div>}
              {d.last_error && !error && <div className="alert alert-error">{d.last_error}</div>}
              <ErrorNote error={error} />
              {oc ? (
                <div className="oneclick-box stack" style={{ gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><span className="soft" style={{ overflowWrap: 'anywhere' }}>{t('signed_in', { email: oc.email })}</span><button type="button" className="btn btn-ghost btn-sm" onClick={signOut}>{t('use_other')}</button></div>
                  <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label={t('saved_cards')}>
                    {oc.cards.map((c) => (
                      <label key={c.id} className="choice"><input type="radio" name="occard" checked={ocCard === c.id} onChange={() => setOcCard(c.id)} />
                        <div><strong>{BRAND[c.brand] ?? c.brand} •••• {c.last4}</strong><div className="muted" style={{ fontSize: 12 }}>{t('expires', { date: `${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}` })}</div></div></label>
                    ))}
                  </div>
                </div>
              ) : (
                <Field label={t('email')}>
                  <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} onBlur={lookupEmail} autoComplete="email" />
                </Field>
              )}
              {ocChallenge && !oc && (
                <div className="oneclick-box stack" style={{ gap: 8 }}>
                  <span>{t('welcome_back', { email: ocChallenge.masked_email })}</span>
                  <input className="input mono" aria-label={t('code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={ocCode} onChange={(e) => verifyCode(e.target.value)} style={{ letterSpacing: '0.3em', fontSize: 18 }} autoFocus />
                  {ocErr && <span role="alert" style={{ color: 'var(--color-danger-text)', fontSize: 13 }}>{ocErr}</span>}
                  <span className="muted" style={{ fontSize: 12 }}>{t('code_hint')} <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOcChallenge(null)}>{t('not_you')}</button></span>
                </div>
              )}
              {d.custom_fields?.map((f: any) => (
                <Field key={f.key} label={`${f.label}${f.optional ? ` ${t('optional')}` : ''}`}>
                  {f.type === 'dropdown' ? (
                    <select className="input" required={!f.optional} value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}>
                      <option value="">{t('select')}</option>{f.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input className="input" required={!f.optional} inputMode={f.type === 'numeric' ? 'numeric' : undefined} pattern={f.type === 'numeric' ? '[0-9]*' : undefined}
                      minLength={f.minimum_length ?? undefined} maxLength={f.maximum_length ?? 255} value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
                  )}
                </Field>
              ))}
              {d.tax_id_collection?.enabled && d.mode !== 'setup' && (
                <div className="stack" style={{ gap: 8 }}>
                  <label className="row"><input type="checkbox" checked={biz.on} onChange={(e) => saveTaxId({ ...biz, on: e.target.checked })} /> {t('business')}</label>
                  {biz.on && <div className="form-row">
                    <Field label={t('tax_id_type')}><select className="input" value={biz.type} onChange={(e) => setBiz({ ...biz, type: e.target.value })}>
                      {[['eu_vat', 'EU VAT'], ['gb_vat', 'UK VAT'], ['au_abn', 'Australian ABN'], ['ch_vat', 'Swiss VAT'], ['no_vat', 'Norwegian VAT'], ['ca_bn', 'Canadian BN'], ['us_ein', 'US EIN']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select></Field>
                    <Field label={t('tax_id')}><input className="input" placeholder={biz.type === 'eu_vat' ? 'DE123456789' : ''} value={biz.value} onChange={(e) => setBiz({ ...biz, value: e.target.value })} onBlur={() => saveTaxId(biz)} /></Field>
                  </div>}
                  {bizErr && <span role="alert" style={{ color: 'var(--color-danger-text)', fontSize: 13 }}>{bizErr}</span>}
                </div>
              )}
              {d.shipping && <fieldset className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t('shipping_address')}</legend>
                <Field label={t('full_name')}><input className="input" required value={ship.name} onChange={(e) => setShip({ ...ship, name: e.target.value })} onBlur={() => saveShipping(ship)} autoComplete="shipping name" /></Field>
                <Field label={t('address')}><input className="input" required value={ship.line1} onChange={(e) => setShip({ ...ship, line1: e.target.value })} onBlur={() => saveShipping(ship)} autoComplete="shipping address-line1" /></Field>
                <div className="form-row">
                  <Field label={t('city')}><input className="input" required value={ship.city} onChange={(e) => setShip({ ...ship, city: e.target.value })} onBlur={() => saveShipping(ship)} autoComplete="shipping address-level2" /></Field>
                  <Field label={t('shipping_country')}><select className="input" value={ship.country || d.shipping.allowed_countries[0]} onChange={(e) => saveShipping({ ...ship, country: e.target.value, state: '' })} autoComplete="shipping country">{d.shipping.allowed_countries.map((c: string) => <option key={c}>{c}</option>)}</select></Field>
                </div>
                <div className="form-row">
                  {['US', 'CA'].includes(ship.country || d.shipping.allowed_countries[0]) && <Field label={(ship.country || d.shipping.allowed_countries[0]) === 'US' ? t('state') : t('province')}><input className="input" maxLength={2} required value={ship.state} onChange={(e) => setShip({ ...ship, state: e.target.value.toUpperCase() })} onBlur={() => saveShipping(ship)} autoComplete="shipping address-level1" /></Field>}
                  <Field label={t('postal')}><input className="input" value={ship.postal_code} onChange={(e) => setShip({ ...ship, postal_code: e.target.value })} onBlur={() => saveShipping(ship)} autoComplete="shipping postal-code" /></Field>
                </div>
              </fieldset>}
              {d.shipping_options?.length > 0 && <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t('shipping_method')}</legend>
                {d.shipping_options.map((o: any) => (
                  <label key={o.id} className="ship-option"><input type="radio" name="shipping" checked={d.shipping_cost?.rate === o.id} onChange={() => chooseRate(o.id)} />
                    <span style={{ flex: 1 }}>{o.display_name}{o.estimate && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{o.estimate}</span>}</span><strong>{o.amount ? fmt(o.amount) : t('free')}</strong></label>
                ))}
              </fieldset>}

              {!oc && <>
                <h2 style={{ margin: '4px 0 0', fontSize: 16 }}>{d.mode === 'setup' ? t('save_your_card') : types.length > 1 ? t('payment_method') : t('pay_with_card')}</h2>
                {d.mode === 'setup' && <p className="soft" style={{ margin: 0 }}>{t('setup_note', { merchant: d.merchant_name })}</p>}
                {types.length > 1 && (
                  <div className="method-tabs" role="tablist" aria-label={t('payment_method')}>
                    {types.map((m) => (
                      <button key={m} type="button" role="tab" aria-selected={method === m} className={`method-tab ${method === m ? 'active' : ''}`} onClick={() => { setMethod(m); setError(null); }}>
                        <MethodIcon m={m} /><span>{m === 'card' ? t('m_card') : m === 'us_bank_account' ? t('m_bank') : t('m_quartet')}</span>
                      </button>
                    ))}
                  </div>
                )}
                {method === 'card' && <>
                  <CardInput pk={d.publishable_key} account={d.stripe_account ?? undefined} onReady={setSdk} label={t('card_info')} locale={L} />
                  {needsAddress && <>
                    <Field label={t('billing_address')}><input className="input" placeholder={t('address')} value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} autoComplete="address-line1" /></Field>
                    <div className="form-row">
                      <Field label={t('country')}><select className="input" value={addr.country} onChange={(e) => updateAddress({ ...addr, country: e.target.value, state: '' })} autoComplete="country">{['US', 'CA', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'AU', 'NZ', 'JP', 'SG', 'IN', 'MX'].map((c) => <option key={c}>{c}</option>)}</select></Field>
                      {(addr.country === 'US' || addr.country === 'CA') && <Field label={addr.country === 'US' ? t('state') : t('province')}><input className="input" maxLength={2} placeholder={addr.country === 'US' ? 'CA' : 'ON'} value={addr.state} onChange={(e) => updateAddress({ ...addr, state: e.target.value.toUpperCase() })} autoComplete="address-level1" /></Field>}
                      <Field label={t('postal')}><input className="input" value={addr.postal_code} onChange={(e) => setAddr({ ...addr, postal_code: e.target.value })} onBlur={() => updateAddress(addr)} autoComplete="postal-code" /></Field>
                    </div>
                  </>}
                  <Field label={t('name_on_card')}><input className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="cc-name" /></Field>
                  {flags.oneclick && (
                    <label className="choice" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={saveOc} onChange={(e) => setSaveOc(e.target.checked)} />
                      <div><strong style={{ fontSize: 14 }}>{t('save_oneclick')}</strong><div className="muted" style={{ fontSize: 12 }}>{t('save_oneclick_note')}</div></div></label>
                  )}
                </>}
                {method === 'us_bank_account' && <div className="stack" style={{ gap: 12 }}>
                  <Field label={t('bank_name')}><input className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
                  {bank ? (
                    <div className="choice" style={{ alignItems: 'center' }}><MethodIcon m="us_bank_account" /><div style={{ flex: 1 }}><strong>{t('linked', { bank: bank.bank_name, last4: bank.last4 })}</strong>{bank.instant && <div className="muted" style={{ fontSize: 12 }}>{t('instant_badge')}</div>}</div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setBank(null)}>{t('change')}</button></div>
                  ) : manual ? (
                    <div className="form-grid">
                      <div className="form-row">
                        <Field label={t('routing')}><input className="input mono" required inputMode="numeric" maxLength={9} value={manual.routing_number} onChange={(e) => setManual({ ...manual, routing_number: e.target.value.replace(/\D/g, '') })} placeholder="110000000" /></Field>
                        <Field label={t('account_no')}><input className="input mono" required inputMode="numeric" maxLength={17} value={manual.account_number} onChange={(e) => setManual({ ...manual, account_number: e.target.value.replace(/\D/g, '') })} placeholder="000123456789" /></Field>
                      </div>
                      <Field label={t('account_type')}><select className="input" value={manual.account_type} onChange={(e) => setManual({ ...manual, account_type: e.target.value })}><option value="checking">{t('checking')}</option><option value="savings">{t('savings')}</option></select></Field>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setManual(null)}>{t('link_bank')}</button>
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      <button type="button" className="btn btn-secondary" onClick={linkBank} disabled={!tess || !email}>{t('link_bank')}</button>
                      {d.bank_verification !== 'instant' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManual({ routing_number: '', account_number: '', account_type: 'checking' })}>{t('manual_bank')}</button>}
                    </div>
                  )}
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>{t('mandate', { merchant: d.merchant_name, amount: totalLabel })}</p>
                </div>}
                {method === 'quartet' && <div className="stack" style={{ gap: 12 }}>
                  <Field label={t('full_name')}><input className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
                  <QuartetPlan amount={totalDue} fmt={(a) => money(a, cur, loc)} line={t('quartet_line', { amount: money(quarter, cur, loc) })} />
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>{t('quartet_note')}</p>
                </div>}
              </>}
              {d.consent_collection?.promotions === 'auto' && <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={consent.promotions} onChange={(e) => setConsent({ ...consent, promotions: e.target.checked })} /> <span>{t('promotions', { merchant: d.merchant_name })}</span></label>}
              {d.consent_collection?.terms_of_service === 'required' && <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" required checked={consent.terms_of_service} onChange={(e) => setConsent({ ...consent, terms_of_service: e.target.checked })} /> <span>{d.custom_text?.terms_of_service_acceptance?.message ?? (d.terms_url ? <a href={d.terms_url} target="_blank" rel="noreferrer">{t('terms', { merchant: d.merchant_name })}</a> : t('terms', { merchant: d.merchant_name }))}</span></label>}
              <button className="btn btn-primary btn-lg" disabled={busy || (!oc && method === 'card' && !sdk) || (!oc && method === 'us_bank_account' && !bank && !manual) || taxPending || termsMissing}>{submitLabel}</button>
              {d.custom_text?.submit?.message && <p className="muted" style={{ fontSize: 13, margin: 0, textAlign: 'center' }}>{d.custom_text.submit.message}</p>}
              {d.cancel_url && <a className="muted" style={{ textAlign: 'center' }} href={d.cancel_url}>{t('cancel_return')}</a>}
              {!oc && method === 'card' && <TestCards label={t('test_cards')} />}
            </form>
          )}
          <div className="pay-footer">
            <label><span className="muted">{t('language')}</span>
              <select className="input input-sm" value={L} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('language')}>
                {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {d.adaptive_pricing && d.status === 'open' && (
              <label><span className="muted">{t('currency')}</span>
                <select className="input input-sm" value={cc ? cc.currency : d.currency} onChange={(e) => setCurrency(e.target.value)} aria-label={t('currency')}>
                  <option value={d.currency}>{d.currency.toUpperCase()} · {money(d.amount_total, d.currency, loc)}</option>
                  {[...d.presentment_options].sort((a: any, b: any) => (a.currency === SUGGESTED_CURRENCY[L] ? -1 : b.currency === SUGGESTED_CURRENCY[L] ? 1 : a.currency.localeCompare(b.currency))).map((o: any) => <option key={o.currency} value={o.currency}>{o.currency.toUpperCase()} · {money(o.amount_total, o.currency, loc)}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function QuartetPlan({ amount, fmt, line }: { amount: number; fmt: (a: number) => string; line: string }) {
  const part = Math.floor(amount / 4);
  const parts = [amount - part * 3, part, part, part];
  return (
    <div className="quartet-plan" aria-label={line}>
      <strong style={{ fontSize: 14 }}>{line}</strong>
      <ol>{parts.map((p, i) => <li key={i}><span className="dot" aria-hidden="true" style={{ opacity: 1 - i * 0.2 }} /><span>{fmt(p)}</span></li>)}</ol>
    </div>
  );
}

export function MethodIcon({ m }: { m: string }) {
  const paths: Record<string, string> = {
    card: 'M3 6h18v12H3zM3 10h18',
    us_bank_account: 'M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z',
    quartet: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v9h9',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d={paths[m] ?? paths.card} /></svg>;
}
