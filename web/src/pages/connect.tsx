import { PersonsCard } from './data.tsx';
import { useState, type ReactNode } from 'react';
import { api, ApiErr, date, dateLong, dash, Link, money, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, CardInput, Empty, ErrorNote, Field, Json, Modal, Money, PageHead, Skeleton, StatusBadge, Tabs, TestCards } from '../ui.tsx';

// ---------------------------------------------------------------- shared bits

const as = (id: string) => ({ 'Stripe-Account': id });
const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });

export function AccountStatus({ a }: { a: any }) {
  const reason: string | null = a.disabled_reason ?? a.requirements?.disabled_reason ?? null;
  if (reason?.startsWith('rejected')) return <Badge kind="danger">Rejected</Badge>;
  if (a.charges_enabled && a.payouts_enabled) return <Badge kind="success">Enabled</Badge>;
  if (a.payouts_enabled) return <Badge kind="success">Payouts enabled</Badge>;
  if (!a.details_submitted) return <Badge kind="warning">Onboarding incomplete</Badge>;
  return <Badge kind="warning">Restricted</Badge>;
}

const typeLabel = (t: string) => ({ express: 'Express', custom: 'Custom', standard: 'Standard' } as Record<string, string>)[t] ?? t;

const REQ_LABELS: Record<string, string> = {
  business_type: 'Business type', 'business_profile.mcc': 'Industry (MCC)', 'business_profile.url': 'Business website',
  'individual.first_name': 'First name', 'individual.last_name': 'Last name', 'individual.email': 'Email', 'individual.phone': 'Phone',
  'individual.dob.day': 'Date of birth', 'individual.dob.month': 'Date of birth', 'individual.dob.year': 'Date of birth',
  'individual.address.line1': 'Address', 'individual.address.city': 'City', 'individual.address.postal_code': 'Postal code', 'individual.address.state': 'State',
  'individual.ssn_last_4': 'Last 4 of SSN', 'individual.verification.document': 'Identity document',
  'company.name': 'Company name', 'company.tax_id': 'Tax ID (EIN)', 'company.phone': 'Company phone', 'company.address.line1': 'Company address',
  'company.address.city': 'Company city', 'company.address.postal_code': 'Company postal code', 'company.address.state': 'Company state',
  'tos_acceptance.date': 'Terms of service acceptance', 'tos_acceptance.ip': 'Terms of service acceptance', external_account: 'Bank account for payouts',
};
export const reqLabel = (r: string) => {
  if (REQ_LABELS[r]) return REQ_LABELS[r];
  if (r === 'company.owners_provided') return 'Confirmation that all owners are listed';
  if (r.startsWith('representative.')) return 'Account representative';
  if (/^person_[^.]+\.verification\.document$/.test(r)) return 'Identity document for a person';
  if (r.startsWith('person_')) return 'Details for a person on the account';
  return r;
};
const uniqueLabels = (reqs: string[]) => [...new Set(reqs.map(reqLabel))];

/** Complete test identity, matching the documented test values (verifies instantly). */
export const TEST_IDENTITY = {
  business_type: 'individual',
  business_profile: { mcc: '5734', url: 'https://seller.example.com' },
  individual: {
    first_name: 'Jenny', last_name: 'Rosen', email: 'jenny.rosen@example.com', phone: '+15555550100',
    dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
    address: { line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103' },
  },
};

export const TEST_COMPANY = {
  business_type: 'company',
  business_profile: { mcc: '5734', url: 'https://rosen.example.com' },
  company: { name: 'Rosen Ceramics LLC', tax_id: '000000000', phone: '+15555550100', owners_provided: 'true', address: { line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103' } },
};
export const TEST_REPRESENTATIVE = {
  first_name: 'Jenny', last_name: 'Rosen', email: 'jenny.rosen@example.com', phone: '+15555550100', dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
  address: { line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103' },
  relationship: { representative: 'true', owner: 'true', executive: 'true', percent_ownership: '100', title: 'CEO' },
};

/** Fill a custom account with verified test details (individual or company with a representative). */
async function provideTestIdentity(a: any) {
  const tos = { tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' } };
  if ((a.business_type ?? 'individual') === 'individual') return api('POST', `/v1/accounts/${a.id}`, { ...TEST_IDENTITY, ...tos });
  await api('POST', `/v1/accounts/${a.id}`, { ...TEST_COMPANY, business_type: a.business_type, ...tos });
  const persons = await api('GET', `/v1/accounts/${a.id}/persons`, { relationship: { representative: 'true' } });
  return persons.data[0] ? api('POST', `/v1/accounts/${a.id}/persons/${persons.data[0].id}`, TEST_REPRESENTATIVE) : api('POST', `/v1/accounts/${a.id}/persons`, TEST_REPRESENTATIVE);
}

const BANKS: [string, string][] = [
  ['000123456789', 'Payouts succeed'],
  ['000111111116', 'Payouts fail: no account'],
  ['000111111113', 'Payouts fail: account closed'],
  ['000222222227', 'Payouts fail: insufficient funds'],
  ['000333333335', 'Payouts fail: debit not authorized'],
];

function BalanceBlock({ bal }: { bal: any }) {
  if (!bal) return <Skeleton rows={2} />;
  return (
    <div className="grid grid-2">
      <div><div className="stat-label">Available</div>{bal.available.map((b: any) => <div key={b.currency} className="stat-value">{money(b.amount, b.currency)}</div>)}</div>
      <div><div className="stat-label">Pending</div>{bal.pending.map((b: any) => <div key={b.currency} className="stat-value">{money(b.amount, b.currency)}</div>)}</div>
      {bal.instant_available?.map((b: any) => <div key={b.currency} className="muted" style={{ fontSize: 13 }}>{money(b.amount, b.currency)} available for Instant Payouts</div>)}
    </div>
  );
}

function useAct(onDone?: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const run = async (fn: () => Promise<any>, msg?: string) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (msg) toast(msg); onDone?.(); return r; } catch (e) { setErr(e instanceof ApiErr ? e : { message: String(e) }); return undefined; } finally { setBusy(false); }
  };
  return { busy, err, setErr, run };
}

// ---------------------------------------------------------------- accounts list

export function ConnectedAccounts() {
  const { navigate } = useRouter();
  const ov = useLoad(() => api('GET', '/v1/tessera/connect/overview'), []);
  const [open, setOpen] = useState(false);
  const accts: any[] = ov.data?.accounts ?? [];
  const sum = (k: 'available' | 'pending') => accts.reduce((s, a) => s + (a.balance[k].find((b: any) => b.currency === 'usd')?.amount ?? 0), 0);
  const fees = ov.data?.application_fees;
  return (
    <>
      <PageHead title="Connected accounts" sub="Sellers and service providers your platform onboards, charges for and pays out." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create account</button>} />
      <ErrorNote error={ov.error} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card><div className="stat-label">Accounts</div><div className="stat-value">{ov.data ? accts.length : '—'}</div></Card>
        <Card><div className="stat-label">Fully enabled</div><div className="stat-value">{ov.data ? accts.filter((a) => a.charges_enabled && a.payouts_enabled).length : '—'}</div></Card>
        <Card><div className="stat-label">Held for accounts (USD)</div><div className="stat-value">{ov.data ? money(sum('available') + sum('pending')) : '—'}</div></Card>
        <Card><div className="stat-label">Net application fees</div><div className="stat-value">{fees ? money(fees.collected - fees.refunded) : '—'}</div></Card>
      </div>
      <Card pad={false}>
        {!ov.data ? <Skeleton /> : !accts.length ? <Empty>No connected accounts yet. Create one to onboard a seller.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Account</th><th>Type</th><th>Status</th><th className="num">Available</th><th className="num">Pending</th><th className="num">Volume</th><th>Created</th></tr></thead>
            <tbody>{accts.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => navigate(`/connect/accounts/${a.id}`)}>
                <td><div>{a.display_name ?? a.email ?? 'Unnamed account'}</div><div className="mono muted" style={{ fontSize: 12 }}>{a.id}</div></td>
                <td>{typeLabel(a.type)}</td>
                <td><AccountStatus a={a} />{a.currently_due > 0 && <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>{a.currently_due} due</span>}</td>
                <td className="num">{money(a.balance.available[0]?.amount ?? 0, a.balance.available[0]?.currency)}</td>
                <td className="num soft">{money(a.balance.pending[0]?.amount ?? 0, a.balance.pending[0]?.currency)}</td>
                <td className="num soft">{money(a.volume)}</td>
                <td className="soft">{date(a.created)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <CreateAccountModal open={open} onClose={() => setOpen(false)} onCreated={(id) => navigate(`/connect/accounts/${id}`)} />
    </>
  );
}

function CreateAccountModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ type: 'express', country: 'US', email: 'seller@example.com', name: 'Rosen Ceramics', prefill: true, schedule: 'daily', business_type: 'individual' });
  const { busy, err, run } = useAct();
  async function create() {
    const base: any = {
      type: f.type, country: f.country, email: f.email || undefined,
      business_profile: { name: f.name || undefined },
      capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
      settings: { payouts: { schedule: { interval: f.schedule } } },
    };
    const company = f.type === 'custom' && f.business_type === 'company';
    if (f.type === 'custom') base.business_type = f.business_type;
    if (f.type === 'custom' && f.prefill) {
      const id = company ? TEST_COMPANY : TEST_IDENTITY;
      Object.assign(base, id, { business_profile: { ...id.business_profile, name: f.name || undefined }, tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' }, external_account: 'btok_us_verified' });
    }
    const a = await run(async () => {
      const acct = await api('POST', '/v1/accounts', base, idem());
      if (company && f.prefill) await api('POST', `/v1/accounts/${acct.id}/persons`, TEST_REPRESENTATIVE);
      return acct;
    }, 'Account created');
    if (a) { onClose(); onCreated(a.id); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Create a connected account"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={create}>Create account</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Account type" hint={f.type === 'custom' ? 'Your platform collects all details through the API and owns the experience.' : f.type === 'express' ? 'Tessera-hosted onboarding and a light dashboard. Your platform sets payouts and pays fees.' : 'The seller has a full account and pays their own fees.'}>
          <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="express">Express</option><option value="custom">Custom</option><option value="standard">Standard</option>
          </select>
        </Field>
        <div className="form-row">
          <Field label="Country"><select className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{['US', 'CA', 'GB', 'AU', 'IE', 'DE', 'FR'].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Payout schedule"><select className="input" value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })}><option value="daily">Daily (automatic)</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="manual">Manual</option></select></Field>
        </div>
        <Field label="Business name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        {f.type === 'custom' && <Field label="Business type"><select className="input" value={f.business_type} onChange={(e) => setF({ ...f, business_type: e.target.value })}><option value="individual">Individual</option><option value="company">Company</option></select></Field>}
        {f.type === 'custom' ? (
          <label className="row"><input type="checkbox" checked={f.prefill} onChange={(e) => setF({ ...f, prefill: e.target.checked })} /> Fill in verified test identity, terms acceptance and a test bank account</label>
        ) : <div className="alert alert-info">After creating the account, use <strong>Onboarding link</strong> to complete Tessera-hosted onboarding.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- account detail

type DetailTab = 'payments' | 'transfers' | 'payouts' | 'fees' | 'events';

export function ConnectedAccountDetail({ id }: { id: string }) {
  const toast = useToast();
  const acct = useLoad(() => api('GET', `/v1/accounts/${id}`), [id]);
  const bal = useLoad(() => api('GET', '/v1/balance', undefined, as(id)), [id]);
  const [tab, setTab] = useState<DetailTab>('payments');
  const [nonce, setNonce] = useState(0);
  const [modal, setModal] = useState<'' | 'charge' | 'transfer' | 'payout' | 'bank' | 'reject'>('');
  const reload = () => { acct.reload(); bal.reload(); setNonce((n) => n + 1); };
  const { busy, err, run } = useAct(reload);
  if (acct.loading && !acct.data) return <Card><Skeleton rows={6} /></Card>;
  if (acct.error) return <ErrorNote error={acct.error} />;
  const a = acct.data;
  const name = a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? a.email ?? a.id;
  const due: string[] = a.requirements?.currently_due ?? [];
  const schedule = a.settings?.payouts?.schedule?.interval;

  async function onboarding() {
    const here = `${location.origin}/connect/accounts/${id}`;
    const type = a.type === 'custom' && a.details_submitted ? 'account_update' : 'account_onboarding';
    const link = await run(() => api('POST', '/v1/account_links', { account: id, type, refresh_url: here, return_url: here }));
    if (link) window.open(link.url, '_blank', 'noopener');
  }
  async function expressDashboard() {
    const link = await run(() => api('POST', `/v1/accounts/${id}/login_links`));
    if (link) window.open(link.url, '_blank', 'noopener');
  }

  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/connect/accounts">Connected accounts</Link> / <span className="mono">{id}</span></div>
      <PageHead title={name} sub={<span className="row"><AccountStatus a={a} /><Badge>{typeLabel(a.type)}</Badge><span className="muted">{a.country} · {a.email ?? 'no email'}</span></span>}
        actions={<>
          {a.type !== 'custom' || !a.details_submitted || due.length ? <button className="btn btn-primary" disabled={busy} onClick={onboarding}>Onboarding link</button> : <button className="btn btn-secondary" disabled={busy} onClick={onboarding}>Update link</button>}
          {a.type === 'express' && a.details_submitted && <button className="btn btn-secondary" disabled={busy} onClick={expressDashboard}>Express dashboard</button>}
          <button className="btn btn-secondary" disabled={!a.charges_enabled && !a.capabilities?.transfers} onClick={() => setModal('charge')}>Create charge</button>
          <button className="btn btn-secondary" onClick={() => setModal('transfer')}>Send funds</button>
        </>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 12 }}>
        <div className="stack">
          {due.length > 0 ? (
            <Card title="Requirements due">
              <div className="stack">
                <p className="soft">This account can't {a.charges_enabled ? 'receive payouts' : 'accept payments or receive payouts'} until these are provided. {a.type === 'custom' ? 'Collect them with the API or an account update link.' : 'Send the seller through Tessera-hosted onboarding.'}</p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{uniqueLabels(due).map((l) => <li key={l}>{l}</li>)}</ul>
                {a.requirements.errors?.map((e: any, i: number) => <div key={i} className="alert alert-error"><code>{e.code}</code> {e.reason}</div>)}
                {a.type === 'custom' && (
                  <div className="row">
                    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(() => provideTestIdentity(a), 'Test identity provided')}>Provide test identity</button>
                    {due.includes('individual.verification.document') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(() => api('POST', `/v1/accounts/${id}`, { individual: { verification: { document: { front: 'file_identity_document_success' } } } }), 'Document uploaded')}>Upload test ID document</button>}
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <div className="alert alert-info">{a.requirements?.disabled_reason?.startsWith('rejected') ? `This account was rejected (${a.requirements.disabled_reason.split('.')[1]}).` : 'All requirements are met. This account can accept payments and receive payouts.'}</div>
          )}
          <Card title="Balance" actions={<>
            {schedule === 'manual' && <button className="btn btn-secondary btn-sm" disabled={!a.payouts_enabled} onClick={() => setModal('payout')}>Pay out</button>}
            <button className="btn btn-ghost btn-sm" onClick={() => bal.reload()}>Refresh</button>
          </>}>
            <BalanceBlock bal={bal.data} />
          </Card>
          {a.business_type && a.business_type !== 'individual' && <PersonsCard account={a} onChange={reload} />}
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'payments', label: 'Payments' }, { id: 'transfers', label: 'Transfers' }, { id: 'payouts', label: 'Payouts' }, { id: 'fees', label: 'Application fees' }, { id: 'events', label: 'Events' }]} />
          <Card pad={false}><AccountTab id={id} tab={tab} nonce={nonce} /></Card>
          <Card title="Account object"><Json value={a} /></Card>
        </div>
        <div className="stack">
          <Card title="Capabilities">
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              {Object.entries(a.capabilities ?? {}).flatMap(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={k + 'v'}><Badge kind={v === 'active' ? 'success' : 'warning'}>{String(v)}</Badge></dd>])}
              <dt>Charges</dt><dd>{a.charges_enabled ? 'Enabled' : 'Disabled'}</dd>
              <dt>Payouts</dt><dd>{a.payouts_enabled ? 'Enabled' : 'Disabled'}</dd>
              <dt>Details</dt><dd>{a.details_submitted ? 'Submitted' : 'Not submitted'}</dd>
            </dl>
          </Card>
          <Card title="Payout schedule">
            <select className="input" value={schedule} aria-label="Payout schedule" onChange={(e) => run(() => api('POST', `/v1/accounts/${id}`, { settings: { payouts: { schedule: { interval: e.target.value } } } }), 'Payout schedule updated')}>
              <option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Automatic schedules pay out the available balance; manual accounts use <strong>Pay out</strong>.</p>
          </Card>
          <Card title="External accounts" actions={<button className="btn btn-ghost btn-sm" onClick={() => setModal('bank')}>+ Add</button>}>
            {a.external_accounts?.data.length ? a.external_accounts.data.map((b: any) => (
              <div key={b.id} className="row" style={{ padding: '6px 0', flexWrap: 'wrap' }}>
                <span>{b.object === 'card' ? `${b.brand} debit` : b.bank_name} •••• {b.last4}</span>{b.default_for_currency && <Badge>Default</Badge>}{b.available_payout_methods?.includes('instant') && <Badge kind="info">Instant</Badge>}{b.status === 'errored' && <Badge kind="danger">Errored</Badge>}
                <span className="spacer" />
                {!b.default_for_currency && <button className="btn btn-ghost btn-sm" onClick={() => run(() => api('POST', `/v1/accounts/${id}/external_accounts/${b.id}`, { default_for_currency: 'true' }), 'Default external account updated')}>Make default</button>}
              </div>
            )) : <span className="muted">No bank account or debit card yet.</span>}
          </Card>
          <Card title="Danger zone">
            <div className="stack">
              <button className="btn btn-danger btn-sm" disabled={!!a.requirements?.disabled_reason?.startsWith('rejected')} onClick={() => setModal('reject')}>Reject account</button>
            </div>
          </Card>
        </div>
      </div>
      <ConnectChargeModal open={modal === 'charge'} account={a} onClose={() => setModal('')} onDone={() => { reload(); toast('Charge created'); }} />
      <TransferModal open={modal === 'transfer'} destination={id} onClose={() => setModal('')} onDone={reload} />
      <PayoutModal open={modal === 'payout'} account={id} available={bal.data?.available?.[0]?.amount ?? 0} instant={!!bal.data?.instant_available?.length} onClose={() => setModal('')} onDone={reload} />
      <BankModal open={modal === 'bank'} account={id} onClose={() => setModal('')} onDone={reload} />
      <Modal open={modal === 'reject'} onClose={() => setModal('')} title="Reject this account?"
        footer={<><button className="btn btn-secondary" onClick={() => setModal('')}>Cancel</button><button className="btn btn-danger" disabled={busy} onClick={() => run(() => api('POST', `/v1/accounts/${id}/reject`, { reason: 'fraud' }), 'Account rejected').then(() => setModal(''))}>Reject for fraud</button></>}>
        <p>Charges and payouts are disabled immediately and can't be re-enabled.</p>
      </Modal>
    </>
  );
}

function AccountTab({ id, tab, nonce }: { id: string; tab: DetailTab; nonce: number }) {
  const { navigate } = useRouter();
  const data = useLoad(() => {
    if (tab === 'payments') return api('GET', '/v1/charges', { limit: 50 }, as(id));
    if (tab === 'transfers') return api('GET', '/v1/transfers', { destination: id, limit: 50 });
    if (tab === 'payouts') return api('GET', '/v1/payouts', { limit: 50 }, as(id));
    if (tab === 'fees') return api('GET', '/v1/application_fees', { account: id, limit: 50 });
    return api('GET', '/v1/events', { limit: 50 }, as(id));
  }, [id, tab, nonce]);
  if (!data.data) return data.error ? <div className="card-body"><ErrorNote error={data.error} /></div> : <Skeleton />;
  const rows: any[] = data.data.data;
  if (!rows.length) return <Empty>Nothing here yet.</Empty>;
  const wrap = (head: ReactNode, body: ReactNode) => <div className="table-wrap"><table className="table"><thead>{head}</thead><tbody>{body}</tbody></table></div>;
  if (tab === 'payments') return wrap(
    <tr><th className="num">Amount</th><th>Status</th><th>Kind</th><th className="num">Fee</th><th>Description</th><th>Date</th></tr>,
    rows.map((c) => <tr key={c.id}><td className="num"><Money amount={c.amount} currency={c.currency} /></td><td><StatusBadge obj={c} /></td><td className="soft">{c.source_transfer ? 'Platform transfer' : c.application ? 'Direct charge' : 'Card'}</td><td className="num soft">{c.application_fee_amount ? money(c.application_fee_amount, c.currency) : '—'}</td><td className="soft">{c.description ?? c.id}</td><td className="soft">{date(c.created)}</td></tr>),
  );
  if (tab === 'transfers') return wrap(
    <tr><th className="num">Amount</th><th className="num">Reversed</th><th>Source</th><th>Group</th><th>Date</th></tr>,
    rows.map((t) => <tr key={t.id} className="clickable" onClick={() => navigate(`/connect/transfers?focus=${t.id}`)}><td className="num"><Money amount={t.amount} currency={t.currency} /></td><td className="num soft">{t.amount_reversed ? money(t.amount_reversed, t.currency) : '—'}</td><td className="mono soft">{t.source_transaction ?? 'balance'}</td><td className="mono soft">{t.transfer_group ?? '—'}</td><td className="soft">{date(t.created)}</td></tr>),
  );
  if (tab === 'payouts') return <PayoutsTable rows={rows} account={id} />;
  if (tab === 'fees') return wrap(
    <tr><th className="num">Fee</th><th className="num">Refunded</th><th>Charge</th><th>Date</th></tr>,
    rows.map((f) => <tr key={f.id}><td className="num"><Money amount={f.amount} currency={f.currency} /></td><td className="num soft">{f.amount_refunded ? money(f.amount_refunded, f.currency) : '—'}</td><td className="mono soft">{f.originating_transaction}</td><td className="soft">{date(f.created)}</td></tr>),
  );
  return wrap(
    <tr><th>Event</th><th>Object</th><th>Date</th></tr>,
    rows.map((e) => <tr key={e.id}><td><code>{e.type}</code></td><td className="mono soft">{e.data.object.id}</td><td className="soft">{dateLong(e.created)}</td></tr>),
  );
}

export function PayoutsTable({ rows, account, onChange }: { rows: any[]; account?: string; onChange?: () => void }) {
  const toast = useToast();
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th className="num">Amount</th><th>Status</th><th>Type</th><th>Arrival</th><th>Details</th><th></th></tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={p.id}>
          <td className="num"><Money amount={p.amount} currency={p.currency} /></td>
          <td><StatusBadge obj={p} /></td>
          <td className="soft">{p.automatic ? 'Automatic' : 'Manual'}</td>
          <td className="soft" style={{ whiteSpace: 'nowrap' }}>{date(p.arrival_date)}</td>
          <td className="soft">{p.failure_message ?? p.description ?? p.id}</td>
          <td className="num">{p.status === 'pending' && <button className="btn btn-ghost btn-sm" onClick={() => api('POST', `/v1/payouts/${p.id}/cancel`, {}, account ? as(account) : {}).then(() => { toast('Payout canceled'); onChange?.(); }, (e) => toast(e.message, 'error'))}>Cancel</button>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

// ---------------------------------------------------------------- modals

function ConnectChargeModal({ open, account, onClose, onDone }: { open: boolean; account: any; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'destination' | 'direct'>('destination');
  const [amount, setAmount] = useState('100.00');
  const [fee, setFee] = useState('10.00');
  const [pm, setPm] = useState('pm_card_visa');
  const { busy, err, run } = useAct();
  async function submit() {
    const cur = account.default_currency ?? 'usd';
    const params: any = { amount: toMinor(amount, cur), currency: cur, payment_method: pm, confirm: 'true', description: kind === 'destination' ? `Destination charge for ${account.id}` : 'Direct charge' };
    if (fee && Number(fee) > 0) params.application_fee_amount = toMinor(fee, cur);
    if (kind === 'destination') params.transfer_data = { destination: account.id };
    const r = await run(() => api('POST', '/v1/payment_intents', params, { ...idem(), ...(kind === 'direct' ? as(account.id) : {}) }));
    if (r) { onClose(); onDone(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Create a Connect charge"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>Charge {money(toMinor(amount || '0'))}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Charge type" hint={kind === 'destination' ? 'Your platform charges the customer, then transfers the funds (minus your fee) to this account.' : 'The charge is made on this account (Stripe-Account header). Your fee moves to your platform.'}>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="destination">Destination charge</option><option value="direct">Direct charge</option></select>
        </Field>
        <div className="form-row">
          <Field label="Amount"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Application fee"><input className="input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        </div>
        <Field label="Test card">
          <select className="input" value={pm} onChange={(e) => setPm(e.target.value)}>
            <option value="pm_card_visa">Visa 4242 (succeeds)</option>
            <option value="pm_card_bypassPending">Visa 0077 (funds available immediately)</option>
            <option value="pm_card_chargeDeclined">Visa 0002 (declined)</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function TransferModal({ open, destination, onClose, onDone }: { open: boolean; destination?: string; onClose: () => void; onDone: () => void }) {
  const accts = useLoad(() => (destination ? Promise.resolve({ data: [] }) : api('GET', '/v1/accounts', { limit: 100 })), [open, destination]);
  const [dest, setDest] = useState('');
  const [amount, setAmount] = useState('25.00');
  const [group, setGroup] = useState('');
  const { busy, err, run } = useAct();
  async function submit() {
    const r = await run(() => api('POST', '/v1/transfers', { amount: toMinor(amount), currency: 'usd', destination: destination ?? dest, transfer_group: group || undefined }, idem()), 'Transfer sent');
    if (r) { onClose(); onDone(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Send funds"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || (!destination && !dest)} onClick={submit}>Send {money(toMinor(amount || '0'))}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <p className="soft">Moves funds from your platform's available balance to the connected account. Charge a 4000 0000 0000 0077 card first to add available funds.</p>
        {!destination && (
          <Field label="Destination">
            <select className="input" value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Choose an account…</option>
              {accts.data?.data.map((a: any) => <option key={a.id} value={a.id}>{a.settings?.dashboard?.display_name ?? a.email ?? a.id}</option>)}
            </select>
          </Field>
        )}
        <div className="form-row">
          <Field label="Amount (USD)"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Transfer group (optional)"><input className="input" value={group} placeholder="ORDER_1001" onChange={(e) => setGroup(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

const instantFee = (amount: number) => Math.max(50, Math.round(amount * 0.015));

function PayoutModal({ open, account, available, instant, onClose, onDone }: { open: boolean; account?: string; available: number; instant?: boolean; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'standard' | 'instant'>('standard');
  const { busy, err, run } = useAct();
  const isInstant = instant && method === 'instant';
  const max = isInstant ? Math.max(0, available - instantFee(available)) : available;
  const value = amount || (max / 100).toFixed(2);
  const fee = isInstant ? instantFee(toMinor(value || '0')) : 0;
  async function submit() {
    const r = await run(() => api('POST', '/v1/payouts', { amount: toMinor(value), currency: 'usd', method: isInstant ? 'instant' : undefined }, { ...idem(), ...(account ? as(account) : {}) }), isInstant ? 'Instant payout sent' : 'Payout created');
    if (r) { setAmount(''); onClose(); onDone(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Pay out"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>Pay out {money(toMinor(value || '0'))}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        {instant && (
          <Field label="Speed">
            <div className="stack">
              <label className="choice"><input type="radio" name="speed" checked={method === 'standard'} onChange={() => { setMethod('standard'); setAmount(''); }} /><div><strong>Standard</strong><div className="muted" style={{ fontSize: 12 }}>Arrives in 2 business days to the default account. Free.</div></div></label>
              <label className="choice"><input type="radio" name="speed" checked={method === 'instant'} onChange={() => { setMethod('instant'); setAmount(''); }} /><div><strong>Instant</strong><div className="muted" style={{ fontSize: 12 }}>Arrives in minutes on the debit card. 1.5% fee (min $0.50).</div></div></label>
            </div>
          </Field>
        )}
        <Field label="Amount (USD)" hint={`Available: ${money(available)}.${isInstant ? ` Fee: ${money(fee)}, total ${money(toMinor(value || '0') + fee)}.` : ' The test bank account number decides whether it arrives or fails.'}`}><input className="input" inputMode="decimal" value={value} onChange={(e) => setAmount(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

const DEBIT_CARDS: [string, string][] = [
  ['tok_visa_debit', 'Visa debit •••• 5556 · Instant and standard'],
  ['tok_mastercard_debit', 'Mastercard debit •••• 8210 · Instant and standard'],
  ['tok_visa_debit_us_transferFail', 'Visa debit •••• 0077 · Payouts fail'],
  ['tok_visa_debit_us_instantPayoutUnsupported', 'Visa debit •••• 0085 · Standard only'],
];

function BankModal({ open, account, onClose, onDone }: { open: boolean; account: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'bank' | 'card'>('bank');
  const [num, setNum] = useState('000123456789');
  const [card, setCard] = useState('tok_visa_debit');
  const [makeDefault, setDefault] = useState(true);
  const { busy, err, run } = useAct();
  async function submit() {
    const external_account = kind === 'card' ? card : { object: 'bank_account', country: 'US', currency: 'usd', routing_number: '110000000', account_number: num };
    const r = await run(() => api('POST', `/v1/accounts/${account}/external_accounts`, { external_account, default_for_currency: makeDefault ? 'true' : undefined }), kind === 'card' ? 'Debit card added' : 'Bank account added');
    if (r) { onClose(); onDone(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add an external account"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>{kind === 'card' ? 'Add debit card' : 'Add bank account'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Type">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="bank">Bank account</option><option value="card">Debit card (enables Instant Payouts)</option></select>
        </Field>
        {kind === 'bank' ? <>
          <Field label="Routing number"><input className="input" value="110000000" readOnly /></Field>
          <Field label="Test account number">
            <select className="input" value={num} onChange={(e) => setNum(e.target.value)}>{BANKS.map(([n, d]) => <option key={n} value={n}>{n} · {d}</option>)}</select>
          </Field>
        </> : (
          <Field label="Test debit card">
            <select className="input" value={card} onChange={(e) => setCard(e.target.value)}>{DEBIT_CARDS.map(([t, d]) => <option key={t} value={t}>{d}</option>)}</select>
          </Field>
        )}
        <label className="row"><input type="checkbox" checked={makeDefault} onChange={(e) => setDefault(e.target.checked)} /> Use as the default for USD payouts</label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- platform pages

export function Transfers() {
  const { path } = useRouter();
  const focus = new URLSearchParams(path.split('?')[1] ?? '').get('focus');
  const list = useLoad(() => api('GET', '/v1/transfers', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const [revAmt, setRevAmt] = useState('');
  const [refundFee, setRefundFee] = useState(true);
  const { busy, err, run } = useAct(() => list.reload());
  const selected = sel ?? (focus ? list.data?.data.find((t: any) => t.id === focus) : null);
  return (
    <>
      <PageHead title="Transfers" sub="Funds sent from your platform to connected accounts, including the transfers behind destination charges." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Send funds</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No transfers yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="num">Amount</th><th>Destination</th><th className="num">Reversed</th><th>Source</th><th>Group</th><th>Date</th></tr></thead>
            <tbody>{list.data.data.map((t: any) => (
              <tr key={t.id} className="clickable" onClick={() => { setSel(t); setRevAmt(((t.amount - t.amount_reversed) / 100).toFixed(2)); }}>
                <td className="num"><Money amount={t.amount} currency={t.currency} /></td>
                <td><Link to={`/connect/accounts/${t.destination}`} onClick={(e: any) => e.stopPropagation()} className="mono">{t.destination}</Link></td>
                <td className="num soft">{t.amount_reversed ? money(t.amount_reversed, t.currency) : '—'}</td>
                <td className="mono soft">{t.source_transaction ?? 'balance'}</td>
                <td className="mono soft">{t.transfer_group ?? '—'}</td>
                <td className="soft">{date(t.created)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <TransferModal open={open} onClose={() => setOpen(false)} onDone={() => list.reload()} />
      <Modal open={!!selected} onClose={() => setSel(null)} title={selected ? `Transfer ${selected.id}` : 'Transfer'}
        footer={selected && <><button className="btn btn-secondary" onClick={() => setSel(null)}>Close</button>{selected.amount > selected.amount_reversed && <button className="btn btn-danger" disabled={busy} onClick={() => run(() => api('POST', `/v1/transfers/${selected.id}/reversals`, { amount: toMinor(revAmt || '0', selected.currency), refund_application_fee: refundFee ? 'true' : undefined }, idem()), 'Transfer reversed').then(() => setSel(null))}>Reverse</button>}</>}>
        {selected && (
          <div className="form-grid">
            <ErrorNote error={err} />
            <dl className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
              <dt>Amount</dt><dd>{money(selected.amount, selected.currency)}</dd>
              <dt>Reversed</dt><dd>{money(selected.amount_reversed, selected.currency)}</dd>
              <dt>Destination</dt><dd className="mono">{selected.destination}</dd>
              <dt>Payment</dt><dd className="mono">{selected.destination_payment}</dd>
            </dl>
            {selected.amount > selected.amount_reversed && <>
              <Field label="Amount to reverse" hint="Pulled back from the connected account's available balance, which can go negative."><input className="input" value={revAmt} onChange={(e) => setRevAmt(e.target.value)} /></Field>
              <label className="row"><input type="checkbox" checked={refundFee} onChange={(e) => setRefundFee(e.target.checked)} /> Also refund the matching share of the application fee</label>
            </>}
          </div>
        )}
      </Modal>
    </>
  );
}

export function ApplicationFees() {
  const list = useLoad(() => api('GET', '/v1/application_fees', { limit: 100 }), []);
  const { busy, err, run } = useAct(() => list.reload());
  return (
    <>
      <PageHead title="Collected fees" sub="Application fees your platform kept from destination and direct charges." />
      <ErrorNote error={err} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No application fees yet. Create a destination or direct charge with an application fee.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="num">Fee</th><th className="num">Refunded</th><th>Account</th><th>Charge</th><th>Date</th><th></th></tr></thead>
            <tbody>{list.data.data.map((f: any) => (
              <tr key={f.id}>
                <td className="num"><Money amount={f.amount} currency={f.currency} /></td>
                <td className="num soft">{f.amount_refunded ? money(f.amount_refunded, f.currency) : '—'}</td>
                <td><Link to={`/connect/accounts/${f.account}`} className="mono">{f.account}</Link></td>
                <td className="mono soft">{f.originating_transaction}</td>
                <td className="soft">{date(f.created)}</td>
                <td className="num">{!f.refunded && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api('POST', `/v1/application_fees/${f.id}/refunds`, {}, idem()), 'Fee refunded to the account')}>Refund</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

/** The platform's own payouts, bank accounts and schedule. */
export function Payouts() {
  const acct = useLoad(() => api('GET', '/v1/account'), []);
  const bal = useLoad(() => api('GET', '/v1/balance'), []);
  const list = useLoad(() => api('GET', '/v1/payouts', { limit: 100 }), []);
  const [modal, setModal] = useState<'' | 'payout' | 'bank'>('');
  const reload = () => { acct.reload(); bal.reload(); list.reload(); };
  const { busy, err, run } = useAct(reload);
  const a = acct.data;
  const schedule = a?.settings?.payouts?.schedule?.interval;
  return (
    <>
      <PageHead title="Payouts" sub="Move your available balance to your bank account. Payouts go pending → in transit → paid." actions={<>
        <button className="btn btn-secondary" onClick={reload}>Refresh</button>
        <button className="btn btn-primary" disabled={schedule !== 'manual'} title={schedule !== 'manual' ? 'Switch to a manual schedule to pay out on demand' : undefined} onClick={() => setModal('payout')}>Pay out</button>
      </>} />
      <ErrorNote error={err ?? acct.error} />
      <div className="grid grid-3-1">
        <div className="stack">
          <Card title="Balance"><BalanceBlock bal={bal.data} /></Card>
          <Card title="Payouts" pad={false}>{!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No payouts yet.</Empty> : <PayoutsTable rows={list.data.data} onChange={reload} />}</Card>
        </div>
        <div className="stack">
          <Card title="Payout schedule">
            {a ? <select className="input" value={schedule} aria-label="Payout schedule" disabled={busy} onChange={(e) => run(() => api('POST', `/v1/accounts/${a.id}`, { settings: { payouts: { schedule: { interval: e.target.value } } } }), 'Payout schedule updated')}>
              <option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select> : <Skeleton rows={1} />}
          </Card>
          <Card title="Bank accounts" actions={<button className="btn btn-ghost btn-sm" onClick={() => setModal('bank')}>+ Add</button>}>
            {a?.external_accounts?.data.map((b: any) => (
              <div key={b.id} className="row" style={{ padding: '6px 0' }}>
                <span>{b.bank_name} •••• {b.last4}</span>{b.default_for_currency && <Badge>Default</Badge>}{b.status === 'errored' && <Badge kind="danger">Errored</Badge>}
                <span className="spacer" />
                {!b.default_for_currency && <button className="btn btn-ghost btn-sm" onClick={() => run(() => api('POST', `/v1/accounts/${a.id}/external_accounts/${b.id}`, { default_for_currency: 'true' }), 'Default external account updated')}>Make default</button>}
              </div>
            )) ?? <Skeleton rows={1} />}
          </Card>
        </div>
      </div>
      <PayoutModal open={modal === 'payout'} available={bal.data?.available?.[0]?.amount ?? 0} onClose={() => setModal('')} onDone={reload} />
      {a && <BankModal open={modal === 'bank'} account={a.id} onClose={() => setModal('')} onDone={reload} />}
    </>
  );
}

/** Used by the payment modal: list of accounts that can receive destination / direct charges. */
export function useConnectedAccounts(open: boolean) {
  return useLoad(() => (open ? api('GET', '/v1/accounts', { limit: 100 }) : Promise.resolve({ data: [] })), [open]);
}

void dash; void CardInput; void TestCards;
