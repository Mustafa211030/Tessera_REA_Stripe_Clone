import { createContext, useContext, useEffect, useState } from 'react';
import { api, ApiErr, copy, dash, date, dateLong, hosted, Link, setCsrf, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHead, Skeleton, Tabs } from '../ui.tsx';

/** The signed-in user, role and permissions (from /dashboard-api/session). */
export const SessionCtx = createContext<any>(null);
export const useSession = () => useContext(SessionCtx);

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including the team, API keys and resetting data.',
  admin: 'Everything an owner can do except managing other owners.',
  developer: 'All payments data and API keys, webhooks and settings for developers. Not the team.',
  analyst: 'Read everything; run reports and SQL. Cannot change data.',
  support: 'Read everything; manage customers, refunds, disputes, invoices and subscriptions.',
  view_only: 'Read everything. Cannot change anything.',
};

const ACTION_LABEL: Record<string, string> = {
  'account.created': 'Account created', 'user.login': 'Signed in', 'user.login_failed': 'Sign-in failed', 'user.two_step_enabled': 'Two-step authentication turned on',
  'user.two_step_disabled': 'Two-step authentication turned off', 'team.invited': 'Invited a team member', 'team.invitation_revoked': 'Revoked an invitation',
  'team.member_joined': 'Joined the team', 'team.role_changed': 'Changed a role', 'team.member_removed': 'Removed a team member', 'api_key.created': 'Created an API key',
  'api_key.rolled': 'Rolled an API key', 'sandbox.exported': 'Exported account data', 'sandbox.reset': 'Reset account data', 'settings.emails_updated': 'Changed email settings',
  'dashboard.change': 'Changed data in the dashboard',
};

function NoAccess({ what }: { what: string }) {
  const s = useSession();
  return <Card><Empty>Your role ({s?.user.role_label}) can't {what}. Ask an owner or administrator.</Empty></Card>;
}

// ================================================================ Team

export function Team() {
  const toast = useToast();
  const s = useSession();
  const t = useLoad(() => dash('GET', '/team'), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: '', role: 'developer' });
  const [err, setErr] = useState<any>(null);
  const [link, setLink] = useState<string | null>(null);
  if (!s.permissions.team) return <><PageHead title="Team" /><NoAccess what="manage the team" /></>;
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); t.reload(); } catch (e: any) { toast(e.message, 'error'); } };
  async function invite() {
    setErr(null);
    try { const r = await dash('POST', '/team/invitations', f); setLink(r.url); toast('Invitation sent'); t.reload(); } catch (e) { setErr(e); }
  }
  const roles: any[] = t.data?.roles ?? [];
  return (
    <>
      <PageHead title="Team" sub="Invite people and choose what they can do. Invitations arrive in the simulated inbox (Developers → Emails)." actions={<button className="btn btn-primary" onClick={() => { setOpen(true); setLink(null); setErr(null); setF({ email: '', role: 'developer' }); }}>Invite member</button>} />
      <Card pad={false} title="Members">
        {!t.data ? <Skeleton /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Member</th><th>Role</th><th>Two-step</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>{t.data.members.map((m: any) => (
              <tr key={m.id}>
                <td><div>{m.name ?? m.email}{m.id === t.data.me && <span className="muted"> (you)</span>}</div>{m.name && <div className="muted" style={{ fontSize: 12 }}>{m.email}</div>}</td>
                <td>{m.id === t.data.me ? <Badge>{roles.find((r) => r.id === m.role)?.label ?? m.role}</Badge> : (
                  <select className="input" aria-label={`Role for ${m.email}`} value={m.role} style={{ width: 'auto' }} onChange={(e) => act(() => dash('POST', `/team/members/${m.id}`, { role: e.target.value }), 'Role updated')}>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                )}</td>
                <td>{m.two_step ? <Badge kind="success">On</Badge> : <Badge>Off</Badge>}</td>
                <td className="soft">{m.last_login ? date(m.last_login) : 'Never'}</td>
                <td className="num">{m.id !== t.data.me && <button className="btn btn-ghost btn-sm" onClick={() => confirm(`Remove ${m.email} from the team?`) && act(() => dash('DELETE', `/team/members/${m.id}`), 'Member removed')}>Remove</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {!!t.data?.invitations.length && (
        <div style={{ marginTop: 16 }}>
          <Card pad={false} title="Pending invitations">
            <table className="table"><tbody>{t.data.invitations.map((i: any) => (
              <tr key={i.id}><td>{i.email}</td><td>{roles.find((r) => r.id === i.role)?.label ?? i.role}</td><td className="soft">Invited by {i.invited_by} · expires {date(i.expires)}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={() => act(() => dash('DELETE', `/team/invitations/${i.id}`), 'Invitation revoked')}>Revoke</button></td></tr>
            ))}</tbody></table>
          </Card>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <Card title="Roles">
          <dl className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>{roles.flatMap((r) => [<dt key={r.id}>{r.label}</dt>, <dd key={r.id + 'd'}>{ROLE_HELP[r.id]}</dd>])}</dl>
        </Card>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Invite a team member"
        footer={link ? <button className="btn btn-primary" onClick={() => setOpen(false)}>Done</button> : <><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!f.email} onClick={invite}>Send invitation</button></>}>
        {link ? (
          <div className="form-grid">
            <div className="alert alert-info">The invitation email is in Developers → Emails. You can also share the link directly; it works once and expires in 7 days.</div>
            <div className="row"><div className="secret" style={{ flex: 1 }}>{link}</div><button className="btn btn-secondary btn-sm" onClick={() => copy(link, toast)}>Copy</button></div>
          </div>
        ) : (
          <div className="form-grid">
            <ErrorNote error={err} />
            <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Role" hint={ROLE_HELP[f.role]}>
              <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.filter((r) => r.id !== 'owner' || s.user.role === 'owner').map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}

/** Hosted page: accept a team invitation and choose a password. */
export function AcceptInvite({ token }: { token: string }) {
  const v = useLoad(() => hosted('GET', `/invitations/${token}`), [token]);
  const [f, setF] = useState({ name: '', password: '' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (v.data) document.title = `Join ${v.data.account} · Tessera`; }, [v.data]);
  if (v.loading && !v.data) return <div className="center-page"><Skeleton /></div>;
  if (v.error) return <div className="auth-page"><div className="auth-card"><div className="card card-body stack"><h2>Invitation unavailable</h2><ErrorNote error={v.error} /><a className="btn btn-secondary" href="/">Go to sign in</a></div></div></div>;
  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { const r = await hosted('POST', `/invitations/${token}`, f); setCsrf(r.csrf); location.assign('/'); } catch (e2) { setErr(e2 instanceof ApiErr ? e2.body.error ?? e2 : e2); } finally { setBusy(false); }
  }
  return (
    <div className="auth-page">
      <div className="auth-card stack">
        <form className="card card-body form-grid" onSubmit={accept} style={{ padding: 28 }}>
          <h2>Join {v.data.account}</h2>
          <p className="soft" style={{ margin: 0 }}>{v.data.invited_by} invited <strong>{v.data.email}</strong> as <strong>{v.data.role_label}</strong>.</p>
          <ErrorNote error={err} />
          <Field label="Your name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
          <Field label="Choose a password" hint="At least 8 characters."><input className="input" type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
          <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Joining…' : 'Accept and continue'}</button>
        </form>
      </div>
    </div>
  );
}

// ================================================================ Security

/** Test mode: a built-in authenticator, so two-step works without a phone. */
async function totpInBrowser(secret: string) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const c of secret.replace(/\s/g, '').toUpperCase()) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const step = Math.floor(Date.now() / 30000);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, step);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = h[h.length - 1]! & 15;
  const n = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

export function Security() {
  const toast = useToast();
  const s = useSession();
  const [stage, setStage] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<any>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState<any>(null);
  const [testCode, setTestCode] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const log = useLoad(async () => (s.permissions.team ? dash('GET', `/audit?limit=100${filter ? `&action=${encodeURIComponent(filter)}` : ''}`) : null), [filter]);
  useEffect(() => {
    if (stage !== 'scan' || !setup) return;
    let alive = true;
    const tick = () => totpInBrowser(setup.secret).then((c) => alive && setTestCode(c));
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [stage, setup]);
  async function start() {
    setErr(null);
    try { setSetup(await dash('POST', '/2fa/setup', { password })); setStage('scan'); setPassword(''); } catch (e) { setErr(e); }
  }
  async function enable() {
    setErr(null);
    try { const r = await dash('POST', '/2fa/enable', { code }); setCodes(r.backup_codes); setStage('codes'); setCode(''); toast('Two-step authentication is on'); } catch (e) { setErr(e); }
  }
  async function disable() {
    setErr(null);
    try { await dash('POST', '/2fa/disable', { password }); setStage('idle'); setPassword(''); toast('Two-step authentication is off'); location.reload(); } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Security" sub="Protect your sign-in with an authenticator app, and review your team's security history." />
      <Card title="Two-step authentication" actions={s.user.two_step ? <Badge kind="success">On</Badge> : <Badge kind="warning">Off</Badge>}>
        <div className="stack">
          <ErrorNote error={err} />
          {stage === 'idle' && (s.user.two_step
            ? <div className="row"><span className="soft">You'll be asked for a code from your authenticator app each time you sign in.</span><span className="spacer" /><button className="btn btn-secondary" onClick={() => { setStage('disable'); setErr(null); }}>Turn off</button></div>
            : <div className="row"><span className="soft">Require a 6-digit code from an authenticator app (any TOTP app) when you sign in.</span><span className="spacer" /><button className="btn btn-primary" onClick={() => { setStage('password'); setErr(null); }}>Set up</button></div>)}
          {(stage === 'password' || stage === 'disable') && (
            <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); stage === 'password' ? start() : disable(); }}>
              <Field label="Confirm your password"><input className="input" type="password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
              <button className="btn btn-primary">{stage === 'password' ? 'Continue' : 'Turn off two-step'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setStage('idle')}>Cancel</button>
            </form>
          )}
          {stage === 'scan' && setup && (
            <div className="grid grid-2">
              <div className="stack">
                <div><strong>1. Add Tessera to your authenticator app</strong><p className="soft" style={{ margin: '4px 0 0' }}>Choose "enter a setup key" and type this key (time-based, 6 digits):</p></div>
                <div className="row"><code className="secret" style={{ fontSize: 16, letterSpacing: '.08em' }}>{setup.secret}</code><button className="btn btn-ghost btn-sm" onClick={() => copy(setup.secret.replace(/\s/g, ''), toast)}>Copy</button></div>
                <details><summary className="soft" style={{ cursor: 'pointer' }}>Setup link (otpauth)</summary><code style={{ wordBreak: 'break-all', fontSize: 12 }}>{setup.otpauth_uri}</code></details>
              </div>
              <form className="stack" onSubmit={(e) => { e.preventDefault(); enable(); }}>
                <strong>2. Enter the code it shows</strong>
                <Field label="6-digit code"><input className="input" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" /></Field>
                <div className="alert alert-info" style={{ fontSize: 13 }}>Test mode: no phone handy? The built-in test authenticator shows <button type="button" className="btn btn-ghost btn-sm mono" onClick={() => testCode && setCode(testCode)}>{testCode ?? '······'}</button> for this key right now.</div>
                <div className="row"><button className="btn btn-primary" disabled={code.length !== 6}>Turn on</button><button type="button" className="btn btn-ghost" onClick={() => setStage('idle')}>Cancel</button></div>
              </form>
            </div>
          )}
          {stage === 'codes' && (
            <div className="stack">
              <div className="alert alert-warning">Save these backup codes somewhere safe. Each one signs you in once if you lose your authenticator. They won't be shown again.</div>
              <div className="backup-codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
              <div className="row"><button className="btn btn-secondary" onClick={() => copy(codes.join('\n'), toast)}>Copy codes</button><span className="spacer" /><button className="btn btn-primary" onClick={() => location.reload()}>Done</button></div>
            </div>
          )}
        </div>
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card title="Security history" pad={false} actions={s.permissions.team && (
          <select className="input" aria-label="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All activity</option><option value="user.">Sign-ins and two-step</option><option value="team.">Team changes</option><option value="api_key.">API keys</option><option value="sandbox.">Data export and reset</option><option value="dashboard.">Dashboard changes</option>
          </select>
        )}>
          {!s.permissions.team ? <Empty>Only owners and administrators can see the security history.</Empty> : !log.data ? <Skeleton /> : !log.data.data.length ? <Empty>No activity yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Activity</th><th>Who</th><th>Details</th><th>When</th></tr></thead>
              <tbody>{log.data.data.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.action === 'user.login_failed' ? <Badge kind="danger">{ACTION_LABEL[a.action]}</Badge> : ACTION_LABEL[a.action] ?? a.action}</td>
                  <td>{a.actor ?? '—'}</td>
                  <td className="soft" style={{ maxWidth: 380 }}>{[a.target && a.target !== a.actor ? a.target : null, a.details ? Object.entries(a.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : null, a.ip ? `IP ${a.ip}` : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="soft">{dateLong(a.created)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}

// ================================================================ Emails

export function Emails() {
  const toast = useToast();
  const s = useSession();
  const [kind, setKind] = useState('');
  const list = useLoad(() => api('GET', '/v1/tessera/emails', { limit: 100, ...(kind ? { kind } : {}) }), [kind]);
  const settings = useLoad(() => dash('GET', '/email-settings'), []);
  const [sel, setSel] = useState<string | null>(null);
  const msg = useLoad(async () => (sel ? api('GET', `/v1/tessera/emails/${sel}`) : null), [sel]);
  const [tab, setTab] = useState<'inbox' | 'settings'>('inbox');
  const kinds: Record<string, string> = settings.data?.kinds ?? {};
  async function toggle(k: string, v: boolean) {
    try { await dash('POST', '/email-settings', { [k]: v }); settings.reload(); toast(v ? 'Emails turned on' : 'Emails turned off'); } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <>
      <PageHead title="Emails" sub="Every email Tessera would send to customers and teammates, delivered to this simulated inbox instead of real addresses." actions={<button className="btn btn-ghost" onClick={() => list.reload()}>Refresh</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'inbox', label: 'Inbox' }, { id: 'settings', label: 'Settings' }]} />
      {tab === 'settings' ? (
        <Card title="Send these emails">
          {!settings.data ? <Skeleton /> : (
            <div className="stack">
              {Object.entries(kinds).map(([k, label]) => (
                <label key={k} className="row"><input type="checkbox" disabled={!s.permissions.team} checked={!!settings.data.settings[k]} onChange={(e) => toggle(k, e.target.checked)} /> {label}</label>
              ))}
              {!s.permissions.team && <p className="muted" style={{ margin: 0 }}>Only owners and administrators can change these.</p>}
            </div>
          )}
        </Card>
      ) : (
        <div className="inbox">
          <Card pad={false}>
            <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--color-border)' }}>
              <select className="input" aria-label="Filter emails" value={kind} onChange={(e) => { setKind(e.target.value); setSel(null); }}>
                <option value="">All emails</option>{Object.entries(kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No emails yet. Receipts, invoices and invitations appear here.</Empty> : (
              <ul className="inbox-list">{list.data.data.map((e: any) => (
                <li key={e.id}><button className="inbox-item" aria-current={sel === e.id ? 'true' : undefined} onClick={() => setSel(e.id)}>
                  <span className="row" style={{ justifyContent: 'space-between' }}><strong style={{ fontSize: 13 }}>{e.to}</strong><span className="muted" style={{ fontSize: 12 }}>{date(e.created)}</span></span>
                  <span style={{ fontSize: 13 }}>{e.subject}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{e.preview}</span>
                </button></li>
              ))}</ul>
            )}
          </Card>
          <Card pad={false}>
            {!sel ? <Empty>Select an email to read it.</Empty> : !msg.data ? <Skeleton /> : (
              <div>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ fontWeight: 600 }}>{msg.data.subject}</div>
                  <div className="muted" style={{ fontSize: 13 }}>From {msg.data.from} · To {msg.data.to} · {dateLong(msg.data.created)}</div>
                  {msg.data.related && <div style={{ fontSize: 13, marginTop: 4 }}>About <RelatedLink r={msg.data.related} /></div>}
                </div>
                <iframe title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={msg.data.html.replace('<head>', '<head><base target="_blank">').replace('<html><body', '<html><head><base target="_blank"></head><body')} style={{ width: '100%', height: 560, border: 0, background: '#f6f5f2' }} />
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function RelatedLink({ r }: { r: { type: string; id: string } }) {
  const to = r.type === 'invoice' ? `/invoices/${r.id}` : r.type === 'subscription' ? `/subscriptions/${r.id}` : null;
  return to ? <Link to={to} className="mono">{r.id}</Link> : <span className="mono">{r.id}</span>;
}

// ================================================================ Data tools

export function DataTools() {
  const toast = useToast();
  const s = useSession();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ password: '', confirm: '', keep_api_keys: true, keep_webhook_endpoints: true });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const name = s.account.settings?.dashboard?.display_name ?? '';
  async function reset() {
    setBusy(true); setErr(null);
    try { setDone(await dash('POST', '/sandbox/reset', f)); toast('Account data reset'); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead title="Data" sub="Export everything in this test account, or start over with an empty account." />
      <div className="grid grid-2">
        <Card title="Export">
          <div className="stack">
            <p className="soft" style={{ margin: 0 }}>Download a JSON file with every object (customers, payments, invoices, subscriptions, events, …), your connected accounts and the ledger.</p>
            {s.permissions.keys ? <a className="btn btn-secondary" style={{ justifySelf: 'start', alignSelf: 'flex-start' }} href="/dashboard-api/sandbox/export" download>Download export</a> : <span className="muted">Your role can't export data.</span>}
          </div>
        </Card>
        <Card title="Reset test data">
          <div className="stack">
            <p className="soft" style={{ margin: 0 }}>Delete all payments, customers, billing, Connect accounts, events, logs and files. Your team, settings and security history stay.</p>
            {s.permissions.sandbox ? <button className="btn btn-danger" style={{ alignSelf: 'flex-start' }} onClick={() => { setOpen(true); setDone(null); setErr(null); setF({ password: '', confirm: '', keep_api_keys: true, keep_webhook_endpoints: true }); }}>Reset account data…</button> : <span className="muted">Only owners and administrators can reset data.</span>}
          </div>
        </Card>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Reset account data"
        footer={done ? <button className="btn btn-primary" onClick={() => location.assign('/')}>Go to Home</button> : <><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-danger" disabled={busy || f.confirm !== name || !f.password} onClick={reset}>{busy ? 'Resetting…' : 'Delete all data'}</button></>}>
        {done ? (
          <div className="form-grid">
            <div className="alert alert-info">Deleted {done.objects_deleted.toLocaleString()} objects{done.connected_accounts_deleted ? ` and ${done.connected_accounts_deleted} connected accounts` : ''}.</div>
            {done.new_keys && <><p style={{ margin: 0 }}>Your new secret key (shown once):</p><div className="row"><div className="secret" style={{ flex: 1 }}>{done.new_keys.secret}</div><button className="btn btn-secondary btn-sm" onClick={() => copy(done.new_keys.secret, toast)}>Copy</button></div></>}
          </div>
        ) : (
          <div className="form-grid">
            <ErrorNote error={err} />
            <div className="alert alert-warning">This can't be undone. Export your data first if you might need it.</div>
            <label className="row"><input type="checkbox" checked={f.keep_api_keys} onChange={(e) => setF({ ...f, keep_api_keys: e.target.checked })} /> Keep my API keys (otherwise new keys are issued)</label>
            <label className="row"><input type="checkbox" checked={f.keep_webhook_endpoints} onChange={(e) => setF({ ...f, keep_webhook_endpoints: e.target.checked })} /> Keep webhook endpoints</label>
            <Field label={`Type ${name} to confirm`}><input className="input" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
            <Field label="Your password"><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

// ================================================================ Scheduled reports

const REPORT_LABELS: Record<string, string> = {
  'balance.summary.1': 'Balance summary', 'balance_change_from_activity.itemized.1': 'Balance change from activity', 'payouts.summary.1': 'Payouts summary',
  'payouts.itemized.1': 'Itemized payouts', 'revenue_recognition.summary.1': 'Revenue recognition: monthly summary', 'revenue_recognition.debits_and_credits.1': 'Revenue recognition: debits and credits',
};

export function ScheduledReports() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/tessera/report_schedules'), []);
  const runs = useLoad(() => api('GET', '/v1/sigma/scheduled_query_runs', { limit: 20 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ kind: 'sql', name: 'Daily gross volume', interval: 'daily', sql: "SELECT date_trunc('day', created)::date AS day, count(*) AS payments, sum(amount) / 100.0 AS gross\nFROM charges WHERE status = 'succeeded'\nGROUP BY 1 ORDER BY 1 DESC", report_type: 'balance.summary.1' });
  const [err, setErr] = useState<any>(null);
  const reload = () => { list.reload(); runs.reload(); };
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); reload(); } catch (e: any) { toast(e.message, 'error'); } };
  async function create() {
    setErr(null);
    try { await api('POST', '/v1/tessera/report_schedules', f.kind === 'sql' ? { kind: 'sql', name: f.name, interval: f.interval, sql: f.sql } : { kind: 'report', name: f.name || REPORT_LABELS[f.report_type], interval: f.interval, report_type: f.report_type }); setOpen(false); toast('Schedule created'); reload(); } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHead title="Scheduled reports" sub={<>Run SQL or financial reports daily, weekly or monthly. Each SQL run sends <code>sigma.scheduled_query_run.created</code> and each report <code>reporting.report_run.succeeded</code> to your webhooks, with a CSV file.</>}
        actions={<button className="btn btn-primary" onClick={() => { setOpen(true); setErr(null); }}>New schedule</button>} />
      <Card pad={false} title="Schedules">
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No schedules yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Runs</th><th>Every</th><th>Next run</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.data.map((x: any) => (
              <tr key={x.id}>
                <td><div>{x.name}</div><div className="muted" style={{ fontSize: 12 }}>{x.kind === 'sql' ? 'SQL query' : REPORT_LABELS[x.report_type] ?? x.report_type}</div></td>
                <td>{x.runs}{x.last_run_at && <span className="muted" style={{ fontSize: 12 }}> · last {date(x.last_run_at)}</span>}</td>
                <td>{x.interval === 'daily' ? 'Day' : x.interval === 'weekly' ? 'Week' : '30 days'}</td>
                <td className="soft">{x.active ? date(x.next_run_at) : '—'}</td>
                <td>{x.active ? <Badge kind="success">Active</Badge> : <Badge>Paused</Badge>}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/tessera/report_schedules/${x.id}/run`), 'Run started')}>Run now</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/tessera/report_schedules/${x.id}`, { active: String(!x.active) }), x.active ? 'Schedule paused' : 'Schedule resumed')}>{x.active ? 'Pause' : 'Resume'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api('DELETE', `/v1/tessera/report_schedules/${x.id}`), 'Schedule deleted')}>Delete</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card pad={false} title="Recent SQL runs" actions={<span className="row"><Link to="/reports">Report runs</Link></span>}>
          {!runs.data ? <Skeleton /> : !runs.data.data.length ? <Empty>No runs yet. Use <strong>Run now</strong> to try a schedule.</Empty> : (
            <table className="table"><tbody>{runs.data.data.map((r: any) => (
              <tr key={r.id}><td>{r.title}<div className="muted mono" style={{ fontSize: 12 }}>{r.id}</div></td>
                <td>{r.status === 'completed' ? <Badge kind="success">Completed</Badge> : <Badge kind="danger">Failed</Badge>}{r.error && <div className="muted" style={{ fontSize: 12 }}>{r.error.message}</div>}</td>
                <td className="soft">{dateLong(r.created)}</td>
                <td className="num">{r.file && <a className="btn btn-ghost btn-sm" href={`/v1/files/${r.file.id}/contents`}>Download CSV</a>}</td></tr>
            ))}</tbody></table>
          )}
        </Card>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New scheduled report" footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Create schedule</button></>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="What to run"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="sql">A SQL query</option><option value="report">A financial report</option></select></Field>
          <div className="form-row">
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Every"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="daily">Day</option><option value="weekly">Week</option><option value="monthly">30 days</option></select></Field>
          </div>
          {f.kind === 'sql'
            ? <Field label="SQL" hint="Checked when you save. Tables are the same as on the SQL page."><textarea className="input" rows={6} value={f.sql} onChange={(e) => setF({ ...f, sql: e.target.value })} spellCheck={false} /></Field>
            : <Field label="Report"><select className="input" value={f.report_type} onChange={(e) => setF({ ...f, report_type: e.target.value })}>{Object.entries(REPORT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        </div>
      </Modal>
    </>
  );
}
