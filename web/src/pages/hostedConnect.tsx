import { useEffect, useState } from 'react';
import { ApiErr, date, hosted, money, useLoad } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Skeleton, StatusBadge } from '../ui.tsx';
import { reqLabel } from './connect.tsx';

const MCCS: [string, string][] = [
  ['5734', 'Software'], ['5999', 'Retail (other)'], ['5812', 'Restaurants'], ['5970', 'Art and crafts'], ['7299', 'Personal services'], ['8999', 'Professional services'],
];
const TEST_ACCOUNTS: [string, string][] = [
  ['000123456789', 'Payouts succeed'], ['000111111116', 'Payouts fail (no account)'], ['000111111113', 'Payouts fail (account closed)'],
];

type Form = {
  business_type: 'individual' | 'company'; url: string; mcc: string;
  first_name: string; last_name: string; email: string; phone: string; dob: string; ssn_last_4: string;
  line1: string; city: string; state: string; postal_code: string;
  company_name: string; tax_id: string; title: string;
  account_number: string; tos: boolean;
};
const EMPTY: Form = { business_type: 'individual', url: '', mcc: '5734', first_name: '', last_name: '', email: '', phone: '', dob: '', ssn_last_4: '', line1: '', city: '', state: '', postal_code: '', company_name: '', tax_id: '', title: '', account_number: '', tos: false };
const TEST: Partial<Form> = { url: 'https://seller.example.com', first_name: 'Jenny', last_name: 'Rosen', email: 'jenny.rosen@example.com', phone: '+15555550100', dob: '1901-01-01', ssn_last_4: '0000', line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103', company_name: 'Rosen Ceramics LLC', tax_id: '000000000', title: 'CEO', account_number: '000123456789' };

/** Tessera-hosted onboarding, reached through an Account Link. */
export function Onboarding({ token }: { token: string }) {
  const page = useLoad(() => hosted('GET', `/connect/onboarding/${token}`), [token]);
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const set = (k: keyof Form) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  useEffect(() => {
    const a = page.data?.account;
    if (!a) return;
    document.title = `Set up payouts · ${page.data.platform.name}`;
    const i = a.individual ?? a.representative ?? {};
    setF((x) => ({
      ...x,
      business_type: a.business_type === 'company' ? 'company' : 'individual',
      url: a.business_profile?.url ?? x.url, mcc: a.business_profile?.mcc ?? x.mcc,
      email: i.email ?? a.email ?? x.email, first_name: i.first_name ?? '', last_name: i.last_name ?? '', phone: i.phone ?? '',
      dob: i.dob?.year ? `${i.dob.year}-${String(i.dob.month).padStart(2, '0')}-${String(i.dob.day).padStart(2, '0')}` : '',
      line1: i.address?.line1 ?? a.company?.address?.line1 ?? '', city: i.address?.city ?? a.company?.address?.city ?? '', state: i.address?.state ?? a.company?.address?.state ?? '', postal_code: i.address?.postal_code ?? a.company?.address?.postal_code ?? '',
      company_name: a.company?.name ?? a.business_profile?.name ?? '', title: a.representative?.relationship?.title ?? '',
    }));
  }, [page.data]);

  if (page.loading && !page.data) return <div className="center-page"><Skeleton /></div>;
  if (page.error) return <div className="center-page"><ErrorNote error={page.error} /></div>;
  const d = page.data;
  if (d.expired) {
    return (
      <div className="onboard-page"><div className="onboard-wrap"><Card>
        <div className="stack">
          <h2>This link has expired</h2>
          <p className="soft">Onboarding links work once and expire after 5 minutes. Ask for a fresh one to continue.</p>
          <a className="btn btn-primary" href={d.refresh_url}>Get a new link</a>
        </div>
      </Card></div></div>
    );
  }
  const a = d.account;
  const hasBank = a.external_accounts.length > 0;
  const steps = ['Business', f.business_type === 'company' ? 'Company' : 'Personal details', 'Payouts', 'Review'];

  async function submit() {
    setBusy(true); setError(null);
    const [year, month, day] = f.dob ? f.dob.split('-').map(Number) : [undefined, undefined, undefined];
    const address = { line1: f.line1, city: f.city, state: f.state, postal_code: f.postal_code, country: a.country };
    const body: any = {
      business_type: f.business_type,
      business_profile: { url: f.url, mcc: f.mcc, ...(f.company_name && f.business_type === 'company' ? { name: f.company_name } : {}) },
      email: f.email || undefined,
      accept_tos: f.tos,
    };
    if (f.business_type === 'individual') body.individual = { first_name: f.first_name, last_name: f.last_name, email: f.email, phone: f.phone, dob: { day, month, year }, address, ...(f.ssn_last_4 ? { ssn_last_4: f.ssn_last_4 } : {}) };
    else {
      body.company = { name: f.company_name, phone: f.phone, address, owners_provided: true, ...(f.tax_id ? { tax_id: f.tax_id } : {}) };
      // The person completing onboarding is the representative (and, here, the sole owner).
      body.representative = {
        first_name: f.first_name, last_name: f.last_name, email: f.email, phone: f.phone, dob: { day, month, year }, address, ...(f.ssn_last_4 ? { ssn_last_4: f.ssn_last_4 } : {}),
        relationship: { representative: true, owner: true, executive: true, percent_ownership: 100, title: f.title || 'Owner' },
      };
    }
    if (f.account_number) body.external_account = { object: 'bank_account', country: a.country, currency: 'usd', routing_number: '110000000', account_number: f.account_number, account_holder_name: f.business_type === 'company' ? f.company_name : `${f.first_name} ${f.last_name}`.trim() };
    try {
      setDone(await hosted('POST', `/connect/onboarding/${token}`, body));
    } catch (e) {
      setError(e instanceof ApiErr ? e.body.error ?? e : e);
    } finally { setBusy(false); }
  }

  const head = (
    <div className="onboard-head">
      <div className="mark" aria-hidden="true">{d.platform.name.slice(0, 1).toUpperCase()}</div>
      <div><strong>{d.platform.name}</strong><div className="muted" style={{ fontSize: 12 }}>partners with Tessera for payments and payouts</div></div>
      <span className="spacer" /><Badge kind="test">Test mode</Badge>
    </div>
  );

  if (done) {
    const due: string[] = done.account.requirements.currently_due;
    return (
      <div className="onboard-page"><div className="onboard-wrap">{head}<Card>
        <div className="stack" role="status">
          {due.length ? <>
            <h2>A few details are still needed</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{[...new Set(due.map(reqLabel))].map((l) => <li key={l}>{l}</li>)}</ul>
            {done.account.requirements.errors?.map((e: any, i: number) => <div key={i} className="alert alert-warning">{e.reason}</div>)}
            <p className="soft">You can return to {d.platform.name} now; they will send you a new link to finish.</p>
          </> : <>
            <h2>You're all set</h2>
            <p className="soft">Your account can accept payments, and payouts will go to your bank account ending in {done.account.external_accounts[0]?.last4}.</p>
          </>}
          <a className="btn btn-primary" href={done.return_url}>Return to {d.platform.name}</a>
        </div>
      </Card></div></div>
    );
  }

  const valid = [
    !!f.url && !!f.mcc,
    f.business_type === 'company' ? !!f.company_name && !!f.line1 && !!f.first_name && !!f.last_name && !!f.dob : !!f.first_name && !!f.last_name && !!f.dob && !!f.line1,
    hasBank || !!f.account_number,
    f.tos,
  ];

  return (
    <div className="onboard-page"><div className="onboard-wrap">
      {head}
      <ol className="steps" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((s, i) => <li key={s} data-done={i <= step} />)}</ol>
      <Card title={steps[step]} actions={<button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, ...TEST })}>Use test data</button>}>
        <div className="form-grid">
          <ErrorNote error={error} />
          {step === 0 && <>
            <Field label="Type of business">
              <div className="stack">
                {(['individual', 'company'] as const).map((t) => (
                  <label key={t} className="choice"><input type="radio" name="bt" checked={f.business_type === t} onChange={() => setF({ ...f, business_type: t })} />
                    <div><strong>{t === 'individual' ? 'Individual or sole proprietor' : 'Company'}</strong><div className="muted" style={{ fontSize: 12 }}>{t === 'individual' ? 'You sell as yourself.' : 'A registered business with a tax ID.'}</div></div></label>
                ))}
              </div>
            </Field>
            <Field label="Industry"><select className="input" value={f.mcc} onChange={set('mcc')}>{MCCS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></Field>
            <Field label="Business website" hint="Or a social profile where customers can find you."><input className="input" type="url" value={f.url} onChange={set('url')} placeholder="https://" /></Field>
          </>}
          {step === 1 && f.business_type === 'individual' && <>
            <div className="form-row">
              <Field label="First name"><input className="input" value={f.first_name} onChange={set('first_name')} autoComplete="given-name" /></Field>
              <Field label="Last name"><input className="input" value={f.last_name} onChange={set('last_name')} autoComplete="family-name" /></Field>
            </div>
            <div className="form-row">
              <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
              <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></Field>
            </div>
            <div className="form-row">
              <Field label="Date of birth" hint="Test: 1901-01-01 verifies, 1902-01-01 fails."><input className="input" type="date" value={f.dob} onChange={set('dob')} /></Field>
              {a.country === 'US' && <Field label="Last 4 of SSN" hint="Test: 0000"><input className="input" inputMode="numeric" maxLength={4} value={f.ssn_last_4} onChange={set('ssn_last_4')} /></Field>}
            </div>
            <AddressFields f={f} set={set} />
          </>}
          {step === 1 && f.business_type === 'company' && <>
            <Field label="Legal business name"><input className="input" value={f.company_name} onChange={set('company_name')} autoComplete="organization" /></Field>
            <div className="form-row">
              <Field label="Employer ID (EIN)" hint="9 digits. Test: 000000000"><input className="input" inputMode="numeric" maxLength={9} value={f.tax_id} onChange={set('tax_id')} /></Field>
              <Field label="Business phone"><input className="input" type="tel" value={f.phone} onChange={set('phone')} /></Field>
            </div>
            <AddressFields f={f} set={set} />
            <h3 style={{ margin: '8px 0 0', fontSize: 15 }}>Your details</h3>
            <p className="soft" style={{ margin: 0, fontSize: 13 }}>You're the account representative: someone with authority to act for the business. We'll list you as its sole owner.</p>
            <div className="form-row">
              <Field label="First name"><input className="input" value={f.first_name} onChange={set('first_name')} autoComplete="given-name" /></Field>
              <Field label="Last name"><input className="input" value={f.last_name} onChange={set('last_name')} autoComplete="family-name" /></Field>
            </div>
            <div className="form-row">
              <Field label="Job title"><input className="input" value={f.title} onChange={set('title')} /></Field>
              <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
            </div>
            <div className="form-row">
              <Field label="Date of birth" hint="Test: 1901-01-01 verifies."><input className="input" type="date" value={f.dob} onChange={set('dob')} /></Field>
              {a.country === 'US' && <Field label="Last 4 of SSN" hint="Test: 0000"><input className="input" inputMode="numeric" maxLength={4} value={f.ssn_last_4} onChange={set('ssn_last_4')} /></Field>}
            </div>
          </>}
          {step === 2 && <>
            {hasBank && <div className="alert alert-info">Payouts already go to {a.external_accounts[0].bank_name} •••• {a.external_accounts[0].last4}. Add another account below to replace it.</div>}
            <Field label="Routing number"><input className="input" value="110000000" readOnly /></Field>
            <Field label="Account number" hint="Test account numbers decide whether payouts arrive.">
              <select className="input" value={f.account_number} onChange={set('account_number')}>
                <option value="">{hasBank ? 'Keep current bank account' : 'Choose a test account…'}</option>
                {TEST_ACCOUNTS.map(([n, l]) => <option key={n} value={n}>{n} · {l}</option>)}
              </select>
            </Field>
          </>}
          {step === 3 && <>
            <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
              <dt>Business</dt><dd>{f.business_type === 'company' ? f.company_name : `${f.first_name} ${f.last_name}`}</dd>
              <dt>Website</dt><dd>{f.url}</dd>
              <dt>Address</dt><dd>{[f.line1, f.city, f.state, f.postal_code].filter(Boolean).join(', ')}</dd>
              <dt>Payouts to</dt><dd>{f.account_number ? `•••• ${f.account_number.slice(-4)}` : hasBank ? `•••• ${a.external_accounts[0].last4}` : '—'}</dd>
            </dl>
            <label className="row"><input type="checkbox" checked={f.tos} onChange={set('tos')} /> I agree to the Tessera Connected Account Agreement and confirm these details are correct.</label>
          </>}
          <div className="row">
            {step > 0 && <button className="btn btn-secondary" onClick={() => setStep(step - 1)}>Back</button>}
            <span className="spacer" />
            {step < 3 ? <button className="btn btn-primary" disabled={!valid[step]} onClick={() => setStep(step + 1)}>Continue</button>
              : <button className="btn btn-primary" disabled={busy || !f.tos} onClick={submit}>{busy ? 'Submitting…' : 'Agree and submit'}</button>}
          </div>
        </div>
      </Card>
      <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 16 }}>Local test mode. Nothing you enter here is verified with a real service.</p>
    </div></div>
  );
}

function AddressFields({ f, set }: { f: Form; set: (k: keyof Form) => (e: any) => void }) {
  return <>
    <Field label="Address"><input className="input" value={f.line1} onChange={set('line1')} autoComplete="address-line1" /></Field>
    <div className="form-row">
      <Field label="City"><input className="input" value={f.city} onChange={set('city')} autoComplete="address-level2" /></Field>
      <Field label="State"><input className="input" value={f.state} onChange={set('state')} autoComplete="address-level1" /></Field>
      <Field label="Postal code"><input className="input" value={f.postal_code} onChange={set('postal_code')} autoComplete="postal-code" /></Field>
    </div>
  </>;
}

/** Express dashboard, reached through a login link. */
export function ExpressDashboard({ token }: { token: string }) {
  const d = useLoad(() => hosted('GET', `/connect/express/${token}`), [token]);
  useEffect(() => { if (d.data) document.title = `${d.data.account.display_name ?? 'Your account'} · Express`; }, [d.data]);
  if (d.loading && !d.data) return <div className="center-page"><Skeleton /></div>;
  if (d.error) return <div className="center-page"><ErrorNote error={d.error} /></div>;
  const x = d.data;
  const bank = x.account.external_accounts.find((b: any) => b.default_for_currency) ?? x.account.external_accounts[0];
  return (
    <div className="express-page">
      <div className="test-band" aria-hidden="true" />
      <header className="express-top">
        <strong>{x.account.display_name ?? x.account.email}</strong>
        <span className="muted">via {x.platform.name}</span>
        <span className="spacer" />
        <Badge kind="test">Test mode</Badge>
        <span className="muted" style={{ fontSize: 12 }}>Express · Tessera</span>
      </header>
      <main className="express-body stack">
        <div className="grid grid-2">
          <Card title="Available to pay out">{x.balance.available.map((b: any) => <div key={b.currency} className="stat-value">{money(b.amount, b.currency)}</div>)}</Card>
          <Card title="On the way">{x.balance.pending.map((b: any) => <div key={b.currency} className="stat-value">{money(b.amount, b.currency)}</div>)}<div className="muted" style={{ fontSize: 12 }}>{x.account.schedule?.interval === 'manual' ? 'Paid out when the platform sends a payout' : `Paid out ${x.account.schedule?.interval}`}{bank && ` to •••• ${bank.last4}`}</div></Card>
        </div>
        <Card title="Payouts" pad={false}>
          {!x.payouts.length ? <Empty>No payouts yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th className="num">Amount</th><th>Status</th><th>Arrives</th><th></th></tr></thead>
              <tbody>{x.payouts.map((p: any) => <tr key={p.id}><td className="num">{money(p.amount, p.currency)}</td><td><StatusBadge obj={{ ...p, object: 'payout' }} /></td><td className="soft">{date(p.arrival_date)}</td><td className="soft">{p.failure_message ?? ''}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Recent payments" pad={false}>
          {!x.payments.length ? <Empty>No payments yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th className="num">Amount</th><th>Source</th><th>Description</th><th>Date</th></tr></thead>
              <tbody>{x.payments.map((p: any) => <tr key={p.id}><td className="num">{money(p.amount, p.currency)}{p.amount_refunded > 0 && <span className="muted"> ({money(p.amount_refunded, p.currency)} refunded)</span>}</td><td className="soft">{p.kind === 'transfer' ? `From ${x.platform.name}` : 'Card'}</td><td className="soft">{p.description ?? p.id}</td><td className="soft">{date(p.created)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </main>
    </div>
  );
}
