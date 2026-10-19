import { useState } from 'react';
import { api, ApiErr, date, money, toMinor, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHead, Skeleton, Tabs } from '../ui.tsx';

const COUNTRIES = ['US', 'CA', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'BE', 'AT', 'SE', 'DK', 'PL', 'PT', 'FI', 'CH', 'NO', 'AU', 'NZ', 'JP', 'SG', 'IN', 'MX'];
const US_STATES = ['CA', 'NY', 'TX', 'WA', 'FL', 'IL', 'MA', 'PA', 'NJ', 'GA', 'CO', 'AZ', 'OR', 'DE', 'MT', 'NH', 'AK'];
const TAX_CODES: [string, string][] = [['txcd_10000000', 'Digital services (default)'], ['txcd_99999999', 'Physical goods'], ['txcd_00000000', 'Nontaxable']];
const REASONS: Record<string, string> = {
  standard_rated: 'Taxed at the standard rate', not_collecting: 'Not registered here, so not collected', customer_exempt: 'Customer is tax exempt',
  reverse_charge: 'Reverse charge: the business customer accounts for VAT', product_exempt: 'Product is nontaxable', not_subject_to_tax: 'Not taxed in this jurisdiction',
};

export function Tax() {
  const [tab, setTab] = useState<'rates' | 'registrations' | 'calculator'>('registrations');
  return (
    <>
      <PageHead title="Tax" sub="Automatic tax collects only where you are registered, using the customer's address. Manual tax rates can be added to any invoice, subscription, quote or payment link." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'registrations', label: 'Registrations' }, { id: 'rates', label: 'Tax rates' }, { id: 'calculator', label: 'Calculator' }]} />
      {tab === 'rates' ? <Rates /> : tab === 'registrations' ? <Registrations /> : <Calculator />}
    </>
  );
}

function Rates() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/tax_rates', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ display_name: 'VAT', percentage: '20', inclusive: 'false', country: 'GB', state: '', jurisdiction: '' });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try { await api('POST', '/v1/tax_rates', { ...f, state: f.state || undefined, jurisdiction: f.jurisdiction || undefined }); toast('Tax rate created'); setOpen(false); list.reload(); } catch (e) { setErr(e); }
  }
  const rows = (list.data?.data ?? []) as any[];
  return (
    <>
      <Card title="Tax rates" pad={false} actions={<button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>+ New tax rate</button>}>
        {!list.data ? <Skeleton /> : !rows.length ? <Empty>No tax rates. Automatic tax creates them as it calculates; you can also add your own.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th className="num">Rate</th><th>Type</th><th>Region</th><th>Source</th><th>Status</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{r.display_name}<div className="mono muted" style={{ fontSize: 12 }}>{r.id}</div></td>
                <td className="num">{r.percentage}%</td>
                <td>{r.inclusive ? 'Inclusive' : 'Exclusive'}</td>
                <td className="soft">{[r.jurisdiction, r.state, r.country].filter(Boolean).join(' · ') || '—'}</td>
                <td className="soft">{r.metadata && r.tax_type && r.jurisdiction_level ? 'Automatic' : 'Manual'}</td>
                <td>{r.active ? <Badge kind="success">Active</Badge> : <Badge>Archived</Badge>}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/tax_rates/${r.id}`, { active: String(!r.active) }); list.reload(); }}>{r.active ? 'Archive' : 'Restore'}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New tax rate" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Create</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <div className="form-row">
            <Field label="Display name"><input className="input" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
            <Field label="Percentage"><input className="input" inputMode="decimal" value={f.percentage} onChange={(e) => setF({ ...f, percentage: e.target.value })} /></Field>
          </div>
          <Field label="Price behaviour" hint="Inclusive rates are already inside the price; exclusive rates are added on top. This can't be changed later.">
            <select className="input" value={f.inclusive} onChange={(e) => setF({ ...f, inclusive: e.target.value })}><option value="false">Exclusive (added to the price)</option><option value="true">Inclusive (part of the price)</option></select>
          </Field>
          <div className="form-row">
            <Field label="Country"><select className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="State (optional)"><input className="input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} /></Field>
          </div>
        </div>
      </Modal>
    </>
  );
}

function Registrations() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/tax/registrations', { limit: 100 }), []);
  const [country, setCountry] = useState('US');
  const [state, setState] = useState('CA');
  const [oss, setOss] = useState(false);
  const [err, setErr] = useState<any>(null);
  const eu = ['DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'BE', 'AT', 'SE', 'DK', 'PL', 'PT', 'FI'].includes(country);
  async function add() {
    setErr(null);
    const cc = country.toLowerCase();
    try {
      await api('POST', '/v1/tax/registrations', { country, active_from: 'now', country_options: { [cc]: country === 'US' ? { state, type: 'state_sales_tax' } : { type: eu && oss ? 'oss_union' : 'standard' } } });
      toast('Registration added'); list.reload();
    } catch (e) { setErr(e instanceof ApiErr ? e : { message: String(e) }); }
  }
  const rows = (list.data?.data ?? []) as any[];
  return (
    <div className="grid grid-3-1">
      <Card title="Where you collect tax" pad={false}>
        {!list.data ? <Skeleton /> : !rows.length ? <Empty>No registrations yet, so automatic tax collects nothing. Add the places you're registered.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Region</th><th>Type</th><th>Status</th><th>Active from</th><th></th></tr></thead>
            <tbody>{rows.map((r) => {
              const o = r.country_options[r.country.toLowerCase()];
              return (
                <tr key={r.id}>
                  <td><strong>{r.country}{o.state ? ` · ${o.state}` : ''}</strong></td>
                  <td className="soft">{o.type === 'oss_union' ? 'EU One-Stop Shop (all EU)' : o.type.replace(/_/g, ' ')}</td>
                  <td>{r.status === 'active' ? <Badge kind="success">Active</Badge> : <Badge>{r.status}</Badge>}</td>
                  <td className="soft">{date(r.active_from)}</td>
                  <td className="num">{r.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/tax/registrations/${r.id}`, { expires_at: 'now' }); list.reload(); }}>End</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      <Card title="Add a registration">
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Country"><select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          {country === 'US' && <Field label="State"><select className="input" value={state} onChange={(e) => setState(e.target.value)}>{US_STATES.map((s) => <option key={s}>{s}</option>)}</select></Field>}
          {eu && <label className="row"><input type="checkbox" checked={oss} onChange={(e) => setOss(e.target.checked)} /> One-Stop Shop (covers every EU country)</label>}
          <button className="btn btn-primary" onClick={add}>Add registration</button>
        </div>
      </Card>
    </div>
  );
}

function Calculator() {
  const [f, setF] = useState({ country: 'US', state: 'NY', amount: '100.00', currency: 'usd', behavior: 'exclusive', code: 'txcd_10000000', override: 'none' });
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  async function run() {
    setErr(null);
    try {
      setRes(await api('POST', '/v1/tax/calculations', {
        currency: f.currency, line_items: [{ amount: toMinor(f.amount, f.currency), reference: 'item', tax_behavior: f.behavior, tax_code: f.code }],
        customer_details: { address: { country: f.country, state: f.state || undefined }, address_source: 'billing', taxability_override: f.override },
      }));
    } catch (e) { setErr(e); setRes(null); }
  }
  const b = res?.tax_breakdown?.[0];
  return (
    <div className="grid grid-2">
      <Card title="Calculate tax">
        <div className="form-grid">
          <ErrorNote error={err} />
          <div className="form-row">
            <Field label="Country"><select className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value, state: '' })}>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            {(f.country === 'US' || f.country === 'CA') && <Field label={f.country === 'US' ? 'State' : 'Province'}><input className="input" maxLength={2} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} /></Field>}
          </div>
          <div className="form-row">
            <Field label="Amount"><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></Field>
          </div>
          <div className="form-row">
            <Field label="Price is"><select className="input" value={f.behavior} onChange={(e) => setF({ ...f, behavior: e.target.value })}><option value="exclusive">Before tax</option><option value="inclusive">Tax included</option></select></Field>
            <Field label="Product"><select className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>{TAX_CODES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></Field>
          </div>
          <Field label="Customer"><select className="input" value={f.override} onChange={(e) => setF({ ...f, override: e.target.value })}><option value="none">Consumer</option><option value="customer_exempt">Tax exempt</option><option value="reverse_charge">Business (reverse charge)</option></select></Field>
          <button className="btn btn-primary" onClick={run}>Calculate</button>
        </div>
      </Card>
      <Card title="Result">
        {!res ? <span className="muted">Run a calculation to see the breakdown. It's the same engine invoices, quotes and checkout use.</span> : (
          <div className="stack">
            <div><div className="stat-label">Tax</div><div className="stat-value">{money(res.tax_amount_exclusive + res.tax_amount_inclusive, res.currency)}</div></div>
            <dl className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
              <dt>Total charged</dt><dd>{money(res.amount_total, res.currency)}</dd>
              <dt>Rate</dt><dd>{Number(b?.tax_rate_details?.percentage_decimal ?? 0)}% {b?.tax_rate_details?.tax_type?.replace('_', ' ') ?? ''}</dd>
              <dt>Taxable amount</dt><dd>{money(b?.taxable_amount ?? 0, res.currency)}</dd>
              <dt>Reason</dt><dd>{REASONS[b?.taxability_reason] ?? b?.taxability_reason}</dd>
            </dl>
            <p className="muted mono" style={{ fontSize: 12 }}>{res.id}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
