import { useState } from 'react';
import { LANGUAGES } from '../i18n.ts';
import { api, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, ErrorNote, Field, PageHead, Skeleton } from '../ui.tsx';
import { useSession } from './settings.tsx';
import { MethodIcon } from './pay.tsx';

const METHODS: { key: string; label: string; icon: string; description: string; details: string }[] = [
  { key: 'card', label: 'Cards', icon: 'card', description: 'Visa, Mastercard, American Express and Discover typed into the card form.', details: 'All currencies · 2.9% + 30¢' },
  { key: 'device_wallet', label: 'Device wallets', icon: 'card', description: 'A wallet button on the payment page. Customers confirm a card saved on their phone or browser; no 3-D Secure needed.', details: 'All currencies · card pricing · simulated wallet sheet in test mode' },
  { key: 'oneclick', label: 'One-click checkout', icon: 'card', description: 'Customers who save their details can pay at any Tessera business by confirming a code sent to their email.', details: 'All currencies · card pricing' },
  { key: 'us_bank_account', label: 'ACH Direct Debit', icon: 'us_bank_account', description: 'Debits from US bank accounts, verified instantly with Financial Connections or with microdeposits. Payments stay processing for a few days.', details: 'USD · one-time payments in Checkout · 0.8%, capped at $5.00' },
  { key: 'quartet', label: 'Pay in 4 (Quartet)', icon: 'quartet', description: 'Shoppers split a purchase into 4 interest-free payments every two weeks with Quartet, a fictional test provider. You are paid in full up front.', details: 'USD, CAD, AUD $1–$4,000 · GBP, EUR 1–1,000 · 6% + 30¢' },
];

/** Settings → Payment methods: what Checkout and automatic payment methods offer. */
export function PaymentMethodsSettings() {
  const toast = useToast();
  const session = useSession();
  const cfg = useLoad(() => api('GET', '/v1/payment_method_configurations').then((r) => r.data[0]), []);
  const canEdit = ['owner', 'admin', 'developer'].includes(session?.user?.role);
  async function toggle(key: string, on: boolean) {
    try {
      await api('POST', `/v1/payment_method_configurations/${cfg.data.id}`, { [key]: { display_preference: { preference: on ? 'on' : 'off' } } });
      cfg.reload();
      toast(`${METHODS.find((m) => m.key === key)!.label} turned ${on ? 'on' : 'off'}`);
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <>
      <PageHead title="Payment methods" sub="Checkout Sessions without payment_method_types, and PaymentIntents with automatic_payment_methods, offer every method turned on here that fits the payment." />
      <div className="grid grid-3-1">
        <Card title="Default configuration" actions={cfg.data && <span className="mono muted" style={{ fontSize: 12 }}>{cfg.data.id}</span>}>
          {cfg.error ? <ErrorNote error={cfg.error} /> : !cfg.data ? <Skeleton /> : (
            <ul className="method-list">
              {METHODS.map((m) => {
                const on = cfg.data[m.key]?.display_preference?.value === 'on';
                return (
                  <li key={m.key}>
                    <span className="method-icon"><MethodIcon m={m.icon} /></span>
                    <div style={{ flex: 1 }}>
                      <div className="row"><strong>{m.label}</strong>{on ? <Badge kind="success">On</Badge> : <Badge>Off</Badge>}</div>
                      <p className="soft" style={{ margin: '4px 0' }}>{m.description}</p>
                      <span className="muted" style={{ fontSize: 12 }}>{m.details}</span>
                    </div>
                    <label className="switch"><input type="checkbox" role="switch" aria-label={`${m.label} ${on ? 'on' : 'off'}`} checked={on} disabled={!canEdit} onChange={(e) => toggle(m.key, e.target.checked)} /><span /></label>
                  </li>
                );
              })}
            </ul>
          )}
          {!canEdit && <p className="muted" style={{ marginBottom: 0 }}>Your role can view these settings but not change them.</p>}
        </Card>
        <PreviewCheckout />
      </div>
    </>
  );
}

/** Creates a test Checkout Session with the current settings and opens it. */
function PreviewCheckout() {
  const [locale, setLocale] = useState('auto');
  const [currency, setCurrency] = useState('usd');
  const [amount, setAmount] = useState('49.00');
  const [adaptive, setAdaptive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  async function open() {
    setBusy(true); setError(null);
    try {
      const minor = Math.round(Number(amount) * (currency === 'jpy' ? 1 : 100));
      const s = await api('POST', '/v1/checkout/sessions', {
        mode: 'payment', locale, success_url: `${location.origin}/payments`, cancel_url: `${location.origin}/settings/payment-methods`,
        line_items: [{ price_data: { currency, unit_amount: minor, product_data: { name: 'Preview item' } }, quantity: 1 }],
        ...(adaptive ? { adaptive_pricing: { enabled: true } } : {}),
      });
      window.open(s.url, '_blank', 'noopener');
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Card title="Preview Checkout">
      <div className="form-grid">
        <p className="soft" style={{ margin: 0 }}>Open a test payment page with the methods turned on, in a language and currency of your choice.</p>
        <ErrorNote error={error} />
        <div className="form-row">
          <Field label="Amount"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Currency"><select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>{['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
        </div>
        <Field label="Language (locale)"><select className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
          <option value="auto">Automatic (browser language)</option>
          {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} style={{ marginTop: 3 }} /> <span>Let customers pay in their own currency (adaptive pricing)</span></label>
        <button className="btn btn-primary" disabled={busy} onClick={open}>{busy ? 'Creating…' : 'Open test payment page'}</button>
      </div>
    </Card>
  );
}
