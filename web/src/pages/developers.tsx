import { useState } from 'react';
import { api, copy, dash, date, dateLong, money, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton, StatusBadge } from '../ui.tsx';

const RESOURCES = ['customers', 'payment_intents', 'payment_methods', 'charges', 'refunds', 'balance', 'events', 'webhook_endpoints', 'checkout_sessions', 'radar', 'products', 'prices', 'coupons', 'subscriptions', 'invoices', 'test_clocks', 'accounts', 'transfers', 'payouts', 'application_fees', 'tokens'];

export function ApiKeys() {
  const toast = useToast();
  const keys = useLoad(() => dash('GET', '/keys'), []);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Reporting key');
  const [perms, setPerms] = useState<Record<string, string>>({ charges: 'read', balance: 'read' });
  const base = location.origin;
  const sk = keys.data?.data.find((k: any) => k.type === 'secret')?.token ?? 'sk_test_...';
  return (
    <>
      <PageHead title="API keys" sub="Test-mode keys. Secret and restricted keys stay on your server; the publishable key is safe in browsers." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Restricted key</button>} />
      <Card pad={false}>
        {!keys.data ? <Skeleton /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Token</th><th>Last used</th><th /></tr></thead>
            <tbody>{keys.data.data.map((k: any) => (
              <tr key={k.id}>
                <td>{k.name ?? k.type}<div className="muted" style={{ fontSize: 12 }}>{k.type}{k.expires ? ` · expires ${date(k.expires)}` : ''}{k.permissions ? ` · ${Object.entries(k.permissions).map(([r, l]) => `${r}:${l}`).join(', ')}` : ''}</div></td>
                <td><div className="secret">{k.type === 'publishable' || shown[k.id] ? k.token : `${k.token.slice(0, 8)}${'•'.repeat(24)}${k.token.slice(-4)}`}</div></td>
                <td className="soft">{k.last_used ? date(k.last_used) : '—'}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {k.type !== 'publishable' && <button className="btn btn-ghost btn-sm" onClick={() => setShown({ ...shown, [k.id]: !shown[k.id] })}>{shown[k.id] ? 'Hide' : 'Reveal'}</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(k.token, toast)}>Copy</button>
                  <button className="btn btn-ghost btn-sm" onClick={async () => { if (!confirm('Roll this key? The old key keeps working for 1 hour.')) return; await dash('POST', `/keys/${k.id}/roll`, { expires_in: 3600 }); toast('Key rolled'); keys.reload(); }}>Roll</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card title="Try it">
          <p className="soft" style={{ marginBottom: 8 }}>Any HTTP client works. The official Stripe SDKs work too if you point their host at this server.</p>
          <pre className="code">{`curl ${base}/v1/payment_intents \\
  -u ${sk}: \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d amount=2000 -d currency=usd \\
  -d payment_method=pm_card_visa -d confirm=true

// Node, official SDK
const stripe = require('stripe')('${sk.slice(0, 12)}...', { host: '${location.hostname}', port: ${location.port || 80}, protocol: 'http' });
await stripe.paymentIntents.create({ amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true });`}</pre>
        </Card>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Create restricted key"
        footer={<button className="btn btn-primary" onClick={async () => { await dash('POST', '/keys', { name, permissions: perms }); toast('Restricted key created'); setOpen(false); keys.reload(); }}>Create key</button>}>
        <div className="form-grid">
          <Field label="Key name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <table className="table"><tbody>{RESOURCES.map((r) => (
            <tr key={r}><td><code>{r}</code></td><td className="num">
              <select className="input" style={{ width: 120, height: 30 }} value={perms[r] ?? 'none'} onChange={(e) => setPerms({ ...perms, [r]: e.target.value })}><option value="none">None</option><option value="read">Read</option><option value="write">Write</option></select>
            </td></tr>
          ))}</tbody></table>
        </div>
      </Modal>
    </>
  );
}

const EVENT_TYPES = ['*', 'invoice.paid', 'invoice.payment_failed', 'invoice.finalized', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.created', 'payment_intent.canceled', 'charge.succeeded', 'charge.failed', 'charge.refunded', 'charge.captured', 'refund.created', 'checkout.session.completed', 'customer.created', 'review.opened', 'review.closed', 'account.updated', 'capability.updated', 'account.external_account.created', 'transfer.created', 'transfer.reversed', 'payment.created', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.paid', 'payout.failed', 'payout.canceled'];

const API_VERSIONS = ['2026-10-01', '2026-09-30', '2025-09-30', '2025-03-31', '2024-06-20', '2022-11-15', '2022-08-01', '2020-08-27'];

export function Webhooks() {
  const toast = useToast();
  const eps = useLoad(() => api('GET', '/v1/webhook_endpoints', { limit: 100 }), []);
  const [sel, setSel] = useState<string | null>(null);
  const deliveries = useLoad(async () => (sel ? api('GET', `/v1/tessera/webhook_endpoints/${sel}/deliveries`) : { data: [] }), [sel]);
  const [attempts, setAttempts] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('http://localhost:3000/webhook');
  const [events, setEvents] = useState<string[]>(['payment_intent.succeeded', 'payment_intent.payment_failed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [version, setVersion] = useState('');
  const [err, setErr] = useState<any>(null);
  return (
    <>
      <PageHead title="Webhooks" sub="Events are signed (HMAC-SHA256, Stripe-Signature format) and retried with exponential backoff for about 3 days." actions={<button className="btn btn-primary" onClick={() => { setSecret(null); setOpen(true); }}>+ Add endpoint</button>} />
      <Card pad={false}>
        {!eps.data ? <Skeleton /> : !eps.data.data.length ? <Empty>No endpoints yet.</Empty> : (
          <table className="table"><tbody>{eps.data.data.map((e: any) => (
            <tr key={e.id} className="clickable" onClick={() => setSel(e.id)} aria-selected={sel === e.id}>
              <td className="mono">{e.url}{e.connect && <div className="muted" style={{ fontFamily: 'inherit', fontSize: 12 }}>Connected accounts</div>}</td><td className="soft mono" style={{ fontSize: 12 }}>{e.api_version ?? 'default'}</td><td><StatusBadge obj={e} /></td><td className="soft">{e.enabled_events.join(', ')}</td>
              <td className="num"><button className="btn btn-ghost btn-sm" onClick={async (ev) => { ev.stopPropagation(); await api('POST', `/v1/webhook_endpoints/${e.id}`, { disabled: String(e.status === 'enabled') }); eps.reload(); }}>{e.status === 'enabled' ? 'Disable' : 'Enable'}</button></td>
            </tr>
          ))}</tbody></table>
        )}
      </Card>
      {sel && (
        <div style={{ marginTop: 16 }}>
          <Card title="Event deliveries" actions={<button className="btn btn-ghost btn-sm" onClick={deliveries.reload}>Refresh</button>} pad={false}>
            {!deliveries.data?.data.length ? <Empty>No deliveries yet.</Empty> : (
              <table className="table">
                <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Last response</th><th>Next retry</th><th /></tr></thead>
                <tbody>{deliveries.data.data.map((d: any) => (
                  <tr key={d.id}>
                    <td><code>{d.event_type}</code><div className="muted mono" style={{ fontSize: 12 }}>{d.event_id}</div></td>
                    <td><StatusBadge obj={d} /></td><td>{d.attempts}</td>
                    <td className="soft">{d.last_response_code ?? d.last_error ?? '—'}</td>
                    <td className="soft">{d.status === 'pending' && d.next_attempt_at ? date(d.next_attempt_at) : '—'}</td>
                    <td className="num">
                      <button className="btn btn-ghost btn-sm" onClick={async () => setAttempts(await api('GET', `/v1/tessera/webhook_deliveries/${d.id}/attempts`))}>Attempts</button>
                      <button className="btn btn-ghost btn-sm" onClick={async () => { await api('POST', `/v1/tessera/events/${d.event_id}/resend`, { webhook_endpoint: sel }); toast('Resend queued'); deliveries.reload(); }}>Resend</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          {attempts && <div style={{ marginTop: 16 }}><Card title="Delivery attempts"><Json value={attempts.data} /></Card></div>}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={secret ? 'Endpoint created' : 'Add webhook endpoint'}
        footer={secret ? <button className="btn btn-primary" onClick={() => setOpen(false)}>Done</button> : <button className="btn btn-primary" onClick={async () => { setErr(null); try { const ep = await api('POST', '/v1/webhook_endpoints', { url, enabled_events: events, connect: connect ? 'true' : undefined, api_version: version || undefined }); setSecret(ep.secret); eps.reload(); } catch (e) { setErr(e); } }}>Add endpoint</button>}>
        {secret ? (
          <div className="form-grid">
            <div className="alert alert-warning">Copy the signing secret now. It is only shown once.</div>
            <div className="row"><div className="secret">{secret}</div><button className="btn btn-secondary btn-sm" onClick={() => copy(secret, toast)}>Copy</button></div>
          </div>
        ) : (
          <div className="form-grid">
            <ErrorNote error={err} />
            <Field label="Endpoint URL"><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
            <Field label="Listen to">
              <select className="input" value={connect ? 'connect' : 'account'} onChange={(e) => setConnect(e.target.value === 'connect')}>
                <option value="account">Events on your account</option><option value="connect">Events on connected accounts</option>
              </select>
            </Field>
            <Field label="API version" hint="Events sent to this endpoint are rendered in this version. Your account default is used when left blank.">
              <select className="input" value={version} onChange={(e) => setVersion(e.target.value)}>
                <option value="">Account default</option>
                {API_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="Events to send">
              <div style={{ display: 'grid', gap: 4, maxHeight: 220, overflow: 'auto' }}>{EVENT_TYPES.map((t) => (
                <label key={t} className="row"><input type="checkbox" checked={events.includes(t)} onChange={(e) => setEvents(e.target.checked ? [...events, t] : events.filter((x) => x !== t))} /><code>{t}</code></label>
              ))}</div>
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}

export function Events() {
  const [type, setType] = useState('');
  const events = useLoad(() => api('GET', '/v1/events', { limit: 100, type: type || undefined }), [type]);
  const [sel, setSel] = useState<any>(null);
  return (
    <>
      <PageHead title="Events" sub="Immutable snapshots written in the same transaction as each change." />
      <div style={{ marginBottom: 12, maxWidth: 360 }}><input className="input" placeholder="Filter by exact type, e.g. charge.succeeded" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by event type" /></div>
      <div className="grid grid-2">
        <Card pad={false}>
          {!events.data ? <Skeleton /> : !events.data.data.length ? <Empty>No events.</Empty> : (
            <table className="table"><tbody>{events.data.data.map((e: any) => (
              <tr key={e.id} className="clickable" onClick={() => setSel(e)}><td><code>{e.type}</code><div className="muted mono" style={{ fontSize: 12 }}>{e.id}</div></td><td className="soft">{date(e.created)}</td></tr>
            ))}</tbody></table>
          )}
        </Card>
        <Card title={sel ? sel.type : 'Select an event'}>{sel ? <Json value={sel} /> : <span className="muted">Pick an event to see its payload.</span>}</Card>
      </div>
    </>
  );
}

export function Logs() {
  const logs = useLoad(() => api('GET', '/v1/tessera/request_logs', { limit: 100 }), []);
  const [sel, setSel] = useState<any>(null);
  return (
    <>
      <PageHead title="Logs" sub="Every API request with status, latency, API version and idempotency key. Card numbers are redacted." actions={<button className="btn btn-secondary" onClick={logs.reload}>Refresh</button>} />
      <div className="grid grid-2">
        <Card pad={false}>
          {!logs.data ? <Skeleton /> : (
            <table className="table"><tbody>{logs.data.data.map((l: any) => (
              <tr key={l.id} className="clickable" onClick={async () => setSel(await api('GET', `/v1/tessera/request_logs/${l.id}`))}>
                <td><Badge kind={l.status < 300 ? 'success' : l.status < 500 ? 'warning' : 'danger'}>{l.status}</Badge></td>
                <td><code>{l.method} {l.path}</code></td><td className="num soft">{l.duration_ms} ms</td><td className="soft">{date(l.created)}</td>
              </tr>
            ))}</tbody></table>
          )}
        </Card>
        <Card title={sel ? sel.id : 'Request details'}>
          {sel ? (
            <div className="stack">
              <dl className="kv"><dt>Request</dt><dd><code>{sel.method} {sel.path}</code></dd><dt>Status</dt><dd>{sel.status}</dd><dt>Time</dt><dd>{dateLong(sel.created)}</dd><dt>API version</dt><dd>{sel.api_version}</dd><dt>Idempotency key</dt><dd className="mono">{sel.idempotency_key ?? '—'}</dd><dt>Source</dt><dd>{sel.source}</dd></dl>
              <h3>Request body</h3><Json value={sel.request_body} />
              <h3>Response body</h3><Json value={sel.response_body} />
            </div>
          ) : <span className="muted">Pick a request.</span>}
        </Card>
      </div>
    </>
  );
}

export function Ledger() {
  const l = useLoad(() => api('GET', '/v1/tessera/ledger'), []);
  const v = useLoad(() => api('GET', '/v1/tessera/versions'), []);
  if (!l.data) return l.error ? <ErrorNote error={l.error} /> : <Card><Skeleton /></Card>;
  const accts = Object.entries(l.data.accounts as Record<string, Record<string, number>>);
  return (
    <>
      <PageHead title="Ledger" sub="Double-entry, append-only. Every group of entries sums to zero; clearing accounts should drain to zero once the network settles." actions={<button className="btn btn-secondary" onClick={l.reload}>Refresh</button>} />
      <div className="grid grid-4">
        <Card><div className="stat-label">Entry groups</div><div className="stat-value">{l.data.groups}</div></Card>
        <Card><div className="stat-label">Unbalanced groups</div><div className="stat-value" style={{ color: l.data.unbalanced_groups ? 'var(--color-danger-text)' : undefined }}>{l.data.unbalanced_groups}</div></Card>
        <Card><div className="stat-label">Clearing accounts</div><div className="stat-value">{l.data.clearing_zeroed ? <Badge kind="success">All zero</Badge> : <Badge kind="warning">Open balances</Badge>}</div></Card>
        <Card><div className="stat-label">Cards in vault · accesses</div><div className="stat-value">{l.data.vault.cards} · {l.data.vault.accesses}</div></Card>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="Account balances (debit +, credit −)" pad={false}>
          {!accts.length ? <Empty>No entries yet.</Empty> : (
            <table className="table"><tbody>{accts.flatMap(([a, cur]) => Object.entries(cur).map(([c, n]) => (
              <tr key={a + c}><td><code>{a}</code></td><td className="num">{money(n, c)}</td><td className="muted">{c.toUpperCase()}</td></tr>
            )))}</tbody></table>
          )}
        </Card>
        <Card title="API versions">
          <p className="soft" style={{ marginBottom: 8 }}>Responses are built in the latest shape and walked back through version changes. Send a <code>Stripe-Version</code> header to pin a request.</p>
          {v.data && <ul style={{ paddingLeft: 18, display: 'grid', gap: 6 }}>{v.data.changes.map((c: any) => <li key={c.version}><code>{c.version}</code>: {c.description}</li>)}</ul>}
        </Card>
      </div>
    </>
  );
}
