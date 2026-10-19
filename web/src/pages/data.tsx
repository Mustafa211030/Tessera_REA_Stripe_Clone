import { useRef, useState } from 'react';
import { api, ApiErr, copy, date, uploadFile, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHead, Skeleton, Tabs } from '../ui.tsx';

// ---------------------------------------------------------------- SQL

const DRAFT_KEY = 'tessera.sql.draft';
const readDraft = () => { try { return localStorage.getItem(DRAFT_KEY); } catch { return null; } };
const saveDraft = (v: string) => { try { localStorage.setItem(DRAFT_KEY, v); } catch { /* storage unavailable */ } };

function toCsv(columns: string[], rows: any[][]) {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

const cellText = (v: any) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Query your own data with SQL. Each run reads a fresh, read-only snapshot of the account. */
export function Sql() {
  const schema = useLoad(() => api('GET', '/v1/tessera/sigma/schema'), []);
  const templates = useLoad(() => api('GET', '/v1/tessera/sigma/templates'), []);
  const [sql, setSql] = useState(() => readDraft() ?? "SELECT id, amount / 100.0 AS amount, currency, status, customer_id, created\nFROM charges\nORDER BY created DESC\nLIMIT 50");
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>('charges');
  const ref = useRef<HTMLTextAreaElement>(null);

  async function run() {
    setBusy(true); setErr(null);
    saveDraft(sql);
    try { setRes(await api('POST', '/v1/tessera/sigma/query', { sql })); } catch (e) { setErr(e instanceof ApiErr ? e : { message: String(e) }); setRes(null); } finally { setBusy(false); }
  }
  function download() {
    if (!res) return;
    const url = URL.createObjectURL(new Blob([toCsv(res.columns, res.rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  function insert(text: string) {
    const el = ref.current;
    if (!el) return setSql(sql + text);
    const { selectionStart: a, selectionEnd: b } = el;
    const next = sql.slice(0, a) + text + sql.slice(b);
    setSql(next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + text.length; });
  }

  return (
    <>
      <PageHead title="SQL" sub="Query payments, customers, billing and payouts with SQL. Each run reads a fresh, read-only snapshot of this account." />
      <div className="sql-layout">
        <Card title="Tables" pad={false}>
          {!schema.data ? <Skeleton /> : (
            <ul className="schema-list">
              {schema.data.data.map((t: any) => (
                <li key={t.table}>
                  <button className="schema-table" aria-expanded={open === t.table} onClick={() => setOpen(open === t.table ? null : t.table)}>
                    <span className="mono">{t.table}</span><span className="muted">{t.rows}</span>
                  </button>
                  {open === t.table && (
                    <ul className="schema-cols">{t.columns.map((c: any) => (
                      <li key={c.name}><button className="schema-col" title="Insert column name" onClick={() => insert(c.name)}><span className="mono">{c.name}</span><span className="muted">{c.type}</span></button></li>
                    ))}</ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="stack" style={{ minWidth: 0 }}>
          <Card pad={false}>
            <div className="sql-toolbar">
              <select className="input" aria-label="Templates" value="" onChange={(e) => { const t = templates.data?.data.find((x: any) => x.name === e.target.value); if (t) setSql(t.sql); }} style={{ width: 'auto' }}>
                <option value="">Templates…</option>
                {templates.data?.data.map((t: any) => <option key={t.name}>{t.name}</option>)}
              </select>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: 12 }}>Ctrl + Enter to run</span>
              <button className="btn btn-primary btn-sm" disabled={busy || !sql.trim()} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
            </div>
            <textarea ref={ref} className="input sql-editor" aria-label="SQL query" spellCheck={false} rows={10} value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } }} />
          </Card>
          <ErrorNote error={err} />
          {res && (
            <Card pad={false} title={<span>{res.row_count.toLocaleString()} row{res.row_count === 1 ? '' : 's'} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {res.elapsed_ms} ms</span></span>}
              actions={<button className="btn btn-secondary btn-sm" disabled={!res.rows.length} onClick={download}>Download CSV</button>}>
              {res.truncated && <div className="alert alert-info" style={{ margin: 12 }}>Showing the first 1,000 rows. Add a LIMIT or aggregate to see everything.</div>}
              {!res.rows.length ? <Empty>The query returned no rows.</Empty> : (
                <div className="table-wrap sql-results">
                  <table className="table table-compact">
                    <thead><tr>{res.columns.map((c: string, i: number) => <th key={i} className="mono">{c}</th>)}</tr></thead>
                    <tbody>{res.rows.map((r: any[], i: number) => (
                      <tr key={i}>{r.map((v, j) => { const t = cellText(v); return <td key={j} className={typeof v === 'number' ? 'num mono' : 'mono'}>{t === null ? <span className="muted">null</span> : t.length > 80 ? <span title={t}>{t.slice(0, 80)}…</span> : t}</td>; })}</tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Files

export const PURPOSES: [string, string][] = [
  ['dispute_evidence', 'Dispute evidence'], ['identity_document', 'Identity document'], ['additional_verification', 'Additional verification'],
  ['business_logo', 'Business logo'], ['business_icon', 'Business icon'], ['customer_signature', 'Customer signature'],
  ['account_requirement', 'Account requirement'], ['tax_document_user_upload', 'Tax document'], ['pci_document', 'PCI document'],
];
const PURPOSE_LABEL: Record<string, string> = { ...Object.fromEntries(PURPOSES), finance_report_run: 'Financial report' };
const LINKABLE = new Set(['dispute_evidence', 'business_logo', 'business_icon', 'customer_signature', 'finance_report_run', 'terminal_reader_splashscreen']);
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function Files() {
  const toast = useToast();
  const [tab, setTab] = useState('all');
  const list = useLoad(() => api('GET', '/v1/files', { limit: 100, ...(tab === 'all' ? {} : { purpose: tab }) }), [tab]);
  const [open, setOpen] = useState(false);
  async function share(f: any) {
    try {
      const l = await api('POST', '/v1/file_links', { file: f.id, expires_at: Math.floor(Date.now() / 1000) + 7 * 86400 });
      copy(l.url, toast);
      toast('Link copied. It expires in 7 days.');
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <>
      <PageHead title="Files" sub="Uploads used as dispute evidence, identity documents and branding, plus generated report files." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>Upload file</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'All' }, { id: 'dispute_evidence', label: 'Dispute evidence' }, { id: 'identity_document', label: 'Identity' }, { id: 'finance_report_run', label: 'Reports' }]} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No files yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>File</th><th>Purpose</th><th>Type</th><th className="num">Size</th><th>Created</th><th /></tr></thead>
            <tbody>{list.data.data.map((f: any) => (
              <tr key={f.id}>
                <td><div>{f.filename}</div><div className="muted mono" style={{ fontSize: 12 }}>{f.id}</div></td>
                <td>{PURPOSE_LABEL[f.purpose] ?? f.purpose}</td>
                <td><Badge>{f.type.toUpperCase()}</Badge></td>
                <td className="num">{size(f.size)}</td>
                <td className="soft">{date(f.created)}</td>
                <td className="num">
                  <a className="btn btn-ghost btn-sm" href={`/v1/files/${f.id}/contents`} target="_blank" rel="noreferrer">Open</a>
                  {LINKABLE.has(f.purpose) && <button className="btn btn-ghost btn-sm" onClick={() => share(f)}>Copy link</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {open && <UploadModal onClose={() => setOpen(false)} onDone={(f) => { setOpen(false); toast(`Uploaded ${f.filename}`); list.reload(); }} />}
    </>
  );
}

function UploadModal({ onClose, onDone, purpose: fixed, headers }: { onClose: () => void; onDone: (f: any) => void; purpose?: string; headers?: Record<string, string> }) {
  const [purpose, setPurpose] = useState(fixed ?? 'dispute_evidence');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!file) return;
    setBusy(true); setErr(null);
    try { onDone(await uploadFile(purpose, file, headers)); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Upload a file"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!file || busy} onClick={submit}>{busy ? 'Uploading…' : 'Upload'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        {!fixed && <Field label="Purpose"><select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>{PURPOSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
        <Field label="File" hint="PDF, JPG or PNG for evidence and identity documents. Up to 5 MB for evidence, 10 MB for identity documents.">
          <input className="input" type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ paddingTop: 6 }} />
        </Field>
      </div>
    </Modal>
  );
}

/** A dispute evidence field that takes an uploaded file. */
export function EvidenceFile({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const info = useLoad(async () => (value ? api('GET', `/v1/files/${value}`) : null), [value]);
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true);
    try { const f = await uploadFile('dispute_evidence', file); onChange(f.id); toast(`Attached ${f.filename}`); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Field label={label}>
      <div className="row">
        {value ? <><a href={`/v1/files/${value}/contents`} target="_blank" rel="noreferrer">{info.data?.filename ?? value}</a><button className="btn btn-ghost btn-sm" onClick={() => onChange('')}>Remove</button></>
          : <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : 'Attach file'}<input type="file" accept=".pdf,.png,.jpg,.jpeg" hidden aria-label={label} onChange={(e) => pick(e.target.files?.[0])} /></label>}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------- Persons (Connect)

const ROLE_LABEL: Record<string, string> = { representative: 'Representative', owner: 'Owner', executive: 'Executive', director: 'Director' };
const TEST_PERSON = {
  first_name: 'Jenny', last_name: 'Rosen', email: 'jenny.rosen@example.com', phone: '+15555550100', dob: '1901-01-01', ssn_last_4: '0000', title: 'CEO', percent: '100',
  line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103',
};
type PersonForm = typeof TEST_PERSON & { roles: string[] };
const BLANK: PersonForm = { first_name: '', last_name: '', email: '', phone: '', dob: '', ssn_last_4: '', title: '', percent: '', line1: '', city: '', state: '', postal_code: '', roles: ['owner'] };

/** The people behind a company account: representative, owners, executives and directors. */
export function PersonsCard({ account, onChange }: { account: any; onChange: () => void }) {
  const toast = useToast();
  const id = account.id;
  const list = useLoad(() => api('GET', `/v1/accounts/${id}/persons`, { limit: 100 }), [id, account.requirements?.currently_due?.length]);
  const [form, setForm] = useState<PersonForm | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const docFor = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => { list.reload(); onChange(); };

  async function save() {
    if (!form) return;
    setErr(null);
    const [year, month, day] = form.dob ? form.dob.split('-').map(Number) : [];
    const body: any = {
      first_name: form.first_name, last_name: form.last_name, email: form.email || undefined, phone: form.phone || undefined,
      ...(year ? { dob: { day, month, year } } : {}), ...(form.ssn_last_4 ? { ssn_last_4: form.ssn_last_4 } : {}),
      address: { line1: form.line1, city: form.city, state: form.state, postal_code: form.postal_code },
      relationship: { ...Object.fromEntries(Object.keys(ROLE_LABEL).map((r) => [r, String(form.roles.includes(r))])), title: form.title, percent_ownership: form.roles.includes('owner') ? form.percent : '' },
    };
    try {
      await api('POST', editing ? `/v1/accounts/${id}/persons/${editing}` : `/v1/accounts/${id}/persons`, body);
      toast(editing ? 'Person updated' : 'Person added'); setForm(null); refresh();
    } catch (e) { setErr(e); }
  }
  async function act(fn: () => Promise<any>, msg: string) {
    try { await fn(); toast(msg); refresh(); } catch (e: any) { toast(e.message, 'error'); }
  }
  async function onDoc(file?: File) {
    const pid = docFor.current;
    if (!file || !pid) return;
    await act(async () => {
      const f = await uploadFile('identity_document', file, { 'Stripe-Account': id });
      await api('POST', `/v1/accounts/${id}/persons/${pid}`, { verification: { document: { front: f.id } } });
    }, 'Identity document uploaded');
    if (fileRef.current) fileRef.current.value = '';
  }
  const edit = (p: any) => {
    setEditing(p.id); setErr(null);
    setForm({
      ...BLANK, first_name: p.first_name ?? '', last_name: p.last_name ?? '', email: p.email ?? '', phone: p.phone ?? '', title: p.relationship.title ?? '',
      percent: p.relationship.percent_ownership === null ? '' : String(p.relationship.percent_ownership),
      dob: p.dob?.year ? `${p.dob.year}-${String(p.dob.month).padStart(2, '0')}-${String(p.dob.day).padStart(2, '0')}` : '',
      line1: p.address?.line1 ?? '', city: p.address?.city ?? '', state: p.address?.state ?? '', postal_code: p.address?.postal_code ?? '',
      roles: Object.keys(ROLE_LABEL).filter((r) => p.relationship[r]),
    });
  };
  const set = (k: keyof PersonForm) => (e: any) => form && setForm({ ...form, [k]: e.target.value });
  const persons: any[] = list.data?.data ?? [];

  return (
    <Card title="People" pad={false} actions={<button className="btn btn-ghost btn-sm" onClick={() => { setEditing(null); setErr(null); setForm({ ...BLANK, roles: persons.some((p) => p.relationship.representative) ? ['owner'] : ['representative', 'owner', 'executive'] }); }}>+ Add person</button>}>
      <input ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg" aria-label="Identity document" onChange={(e) => onDoc(e.target.files?.[0])} />
      {!list.data ? <Skeleton rows={2} /> : !persons.length ? <Empty>Add the account representative and anyone who owns 25% or more.</Empty> : (
        <table className="table table-compact"><tbody>{persons.map((p) => (
          <tr key={p.id}>
            <td>
              <div>{[p.first_name, p.last_name].filter(Boolean).join(' ') || <span className="muted">Unnamed</span>}{p.relationship.title && <span className="muted"> · {p.relationship.title}</span>}</div>
              <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {Object.keys(ROLE_LABEL).filter((r) => p.relationship[r]).map((r) => <Badge key={r}>{ROLE_LABEL[r]}{r === 'owner' && p.relationship.percent_ownership !== null ? ` ${p.relationship.percent_ownership}%` : ''}</Badge>)}
                <Badge kind={p.verification.status === 'verified' ? 'success' : 'warning'}>{p.verification.status === 'verified' ? 'Verified' : 'Unverified'}</Badge>
              </div>
              {p.verification.document?.details && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{p.verification.document.details}</div>}
            </td>
            <td className="num" style={{ whiteSpace: 'nowrap' }}>
              {p.verification.status !== 'verified' && <button className="btn btn-ghost btn-sm" onClick={() => { docFor.current = p.id; fileRef.current?.click(); }}>Upload ID</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => edit(p)}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('DELETE', `/v1/accounts/${id}/persons/${p.id}`), 'Person removed')}>Remove</button>
            </td>
          </tr>
        ))}</tbody></table>
      )}
      {account.company && (
        <div className="row" style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)' }}>
          <span className="soft" style={{ fontSize: 13 }}>{account.company.owners_provided ? 'All owners have been provided.' : 'Confirm once every owner with 25% or more is listed.'}</span>
          <span className="spacer" />
          {!account.company.owners_provided && <button className="btn btn-secondary btn-sm" onClick={() => act(() => api('POST', `/v1/accounts/${id}`, { company: { owners_provided: 'true' } }), 'Owners confirmed')}>Confirm owners</button>}
        </div>
      )}
      <Modal open={!!form} onClose={() => setForm(null)} title={editing ? 'Edit person' : 'Add a person'}
        footer={<><button className="btn btn-ghost" onClick={() => form && setForm({ ...form, ...TEST_PERSON })}>Use test data</button><span className="spacer" /><button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-primary" onClick={save}>{editing ? 'Save' : 'Add person'}</button></>}>
        {form && (
          <div className="form-grid">
            <ErrorNote error={err} />
            <Field label="Roles">
              <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>{Object.entries(ROLE_LABEL).map(([r, l]) => (
                <label key={r} className="row" style={{ gap: 6 }}><input type="checkbox" checked={form.roles.includes(r)} onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })} />{l}</label>
              ))}</div>
            </Field>
            <div className="form-row">
              <Field label="First name"><input className="input" value={form.first_name} onChange={set('first_name')} /></Field>
              <Field label="Last name"><input className="input" value={form.last_name} onChange={set('last_name')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Job title"><input className="input" value={form.title} onChange={set('title')} /></Field>
              {form.roles.includes('owner') && <Field label="Ownership %"><input className="input" inputMode="decimal" value={form.percent} onChange={set('percent')} /></Field>}
            </div>
            <div className="form-row">
              <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
              <Field label="Phone"><input className="input" type="tel" value={form.phone} onChange={set('phone')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Date of birth" hint="1901-01-01 verifies; 1902-01-01 needs a document."><input className="input" type="date" value={form.dob} onChange={set('dob')} /></Field>
              <Field label="Last 4 of SSN"><input className="input" inputMode="numeric" maxLength={4} value={form.ssn_last_4} onChange={set('ssn_last_4')} /></Field>
            </div>
            <Field label="Address"><input className="input" value={form.line1} onChange={set('line1')} /></Field>
            <div className="form-row">
              <Field label="City"><input className="input" value={form.city} onChange={set('city')} /></Field>
              <Field label="State"><input className="input" value={form.state} onChange={set('state')} /></Field>
              <Field label="ZIP"><input className="input" value={form.postal_code} onChange={set('postal_code')} /></Field>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

export { UploadModal };
