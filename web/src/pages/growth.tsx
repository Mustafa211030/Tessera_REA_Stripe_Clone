import { useState } from 'react';
import { api, copy, date, isMetered, Link, money, priceText, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton } from '../ui.tsx';

const dayOnly = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ---------------- Meters ----------------
export function Meters() {
  const { navigate } = useRouter();
  const list = useLoad(() => api('GET', '/v1/billing/meters', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: 'API requests', event: 'api_requests', formula: 'sum' });
  const [err, setErr] = useState<any>(null);
  return (
    <>
      <PageHead title="Meters" sub="Record usage events and bill for them with usage-based (metered) prices." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create meter</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No meters yet. A meter turns usage events into billable quantities.</Empty> : (
          <table className="table"><thead><tr><th>Meter</th><th>Event name</th><th>Aggregation</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{list.data.data.map((m: any) => (
              <tr key={m.id} className="clickable" onClick={() => navigate(`/meters/${m.id}`)}>
                <td><strong>{m.display_name}</strong><div className="mono muted" style={{ fontSize: 12 }}>{m.id}</div></td>
                <td className="mono">{m.event_name}</td><td>{m.default_aggregation.formula}</td>
                <td>{m.status === 'active' ? <Badge kind="success">Active</Badge> : <Badge>Inactive</Badge>}</td><td className="soft">{date(m.created)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a meter" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try { const m = await api('POST', '/v1/billing/meters', { display_name: f.name, event_name: f.event, default_aggregation: { formula: f.formula } }); setOpen(false); navigate(`/meters/${m.id}`); } catch (e) { setErr(e); }
      }}>Create meter</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Display name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Event name" hint="Your integration sends meter events with this name."><input className="input mono" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })} /></Field>
          <Field label="Aggregation">
            <select className="input" value={f.formula} onChange={(e) => setF({ ...f, formula: e.target.value })}>
              <option value="sum">Sum of values</option><option value="count">Count of events</option><option value="last">Last value in the period</option>
            </select>
          </Field>
        </div>
      </Modal>
    </>
  );
}

export function MeterDetail({ id }: { id: string }) {
  const toast = useToast();
  const meter = useLoad(() => api('GET', `/v1/billing/meters/${id}`), [id]);
  const customers = useLoad(() => api('GET', '/v1/customers', { limit: 100 }), []);
  const [cus, setCus] = useState('');
  const [value, setValue] = useState('25');
  const [err, setErr] = useState<any>(null);
  const customer = cus || customers.data?.data[0]?.id || '';
  const now = Math.floor(Date.now() / 1000);
  const summary = useLoad(() => (customer ? api('GET', `/v1/billing/meters/${id}/event_summaries`, { customer, start_time: now - 6 * 86400 - (now % 86400), end_time: now - (now % 86400) + 86400, value_grouping_window: 'day' }) : Promise.resolve(null)), [id, customer]);
  if (!meter.data) return meter.error ? <ErrorNote error={meter.error} /> : <Card><Skeleton /></Card>;
  const m = meter.data;
  const days = (summary.data?.data ?? []).slice().reverse();
  const max = Math.max(1, ...days.map((d: any) => d.aggregated_value));
  async function send() {
    setErr(null);
    try {
      await api('POST', '/v1/billing/meter_events', { event_name: m.event_name, payload: { [m.customer_mapping.event_payload_key]: customer, [m.value_settings.event_payload_key]: value } });
      toast('Usage recorded'); summary.reload();
    } catch (e) { setErr(e); }
  }
  const snippet = `curl ${location.origin}/v1/billing/meter_events \\\n  -u sk_test_…: \\\n  -d event_name=${m.event_name} \\\n  -d "payload[${m.customer_mapping.event_payload_key}]=${customer || 'cus_…'}" \\\n  -d "payload[${m.value_settings.event_payload_key}]=${value}"`;
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/meters">Meters</Link> / <span className="mono">{id}</span></div>
      <PageHead title={m.display_name} sub={<span className="row">{m.status === 'active' ? <Badge kind="success">Active</Badge> : <Badge>Inactive</Badge>}<span className="mono soft">{m.event_name}</span></span>}
        actions={<button className="btn btn-secondary" onClick={async () => { await api('POST', `/v1/billing/meters/${id}/${m.status === 'active' ? 'deactivate' : 'reactivate'}`); meter.reload(); }}>{m.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 8 }}>
        <div className="stack">
          <Card title="Usage, last 7 days" actions={<select className="input" style={{ width: 'auto' }} value={customer} onChange={(e) => setCus(e.target.value)}>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}</select>}>
            {!customer ? <Empty>Create a customer to record usage.</Empty> : !summary.data ? <Skeleton /> : (
              <div className="usage-bars" role="img" aria-label="Daily usage">
                {days.map((d: any) => (
                  <div key={d.start_time} className="usage-bar"><div className="usage-fill" style={{ height: `${(d.aggregated_value / max) * 100}%` }} title={`${d.aggregated_value}`} /><span className="muted">{new Date(d.start_time * 1000).toLocaleDateString('en-US', { weekday: 'short' })}</span><strong>{d.aggregated_value.toLocaleString()}</strong></div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Send a test event">
            <div className="form-grid">
              <div className="form-row">
                <Field label={m.default_aggregation.formula === 'count' ? 'Value (ignored for count)' : 'Value'}><input className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
                <div style={{ alignSelf: 'end' }}><button className="btn btn-primary" disabled={!customer || m.status !== 'active'} onClick={send}>Record usage</button></div>
              </div>
              <pre className="code" style={{ margin: 0 }}>{snippet}</pre>
              <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", width: "auto" }} onClick={() => copy(snippet, toast)}>Copy</button>
            </div>
          </Card>
        </div>
        <Card title="Meter object"><Json value={m} /></Card>
      </div>
    </>
  );
}

// ---------------- Promotion codes (shown on the Coupons page) ----------------
export function PromotionCodes({ coupons }: { coupons: any[] }) {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/promotion_codes', { limit: 100 }), [coupons.length]);
  const customers = useLoad(() => api('GET', '/v1/customers', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ coupon: '', code: 'WELCOME', max: '', expires: '', first: false, minimum: '', customer: '' });
  const [err, setErr] = useState<any>(null);
  return (
    <>
      <Card title="Promotion codes" actions={<button className="btn btn-secondary btn-sm" disabled={!coupons.length} onClick={() => setOpen(true)}>+ Create code</button>} pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No promotion codes. Codes are what customers type at checkout; each points at a coupon.</Empty> : (
          <table className="table"><thead><tr><th>Code</th><th>Coupon</th><th>Restrictions</th><th className="num">Redemptions</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.data.map((p: any) => (
              <tr key={p.id}>
                <td><strong className="mono">{p.code}</strong><div className="mono muted" style={{ fontSize: 12 }}>{p.id}</div></td>
                <td>{(() => { const c = coupons.find((x) => x.id === p.promotion.coupon); return c ? <>{c.name ?? c.id} <span className="soft">({c.percent_off ? `${c.percent_off}%` : money(c.amount_off, c.currency)} off)</span></> : <span className="mono">{p.promotion.coupon}</span>; })()}</td>
                <td className="soft">{[p.restrictions.first_time_transaction && 'First order only', p.restrictions.minimum_amount && `Min ${money(p.restrictions.minimum_amount, p.restrictions.minimum_amount_currency)}`, p.customer && 'One customer', p.expires_at && `Expires ${dayOnly(p.expires_at)}`].filter(Boolean).join(' · ') || '—'}</td>
                <td className="num">{p.times_redeemed}{p.max_redemptions ? ` / ${p.max_redemptions}` : ''}</td>
                <td>{p.active ? <Badge kind="success">Active</Badge> : <Badge>Inactive</Badge>}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={async () => { try { await api('POST', `/v1/promotion_codes/${p.id}`, { active: String(!p.active) }); list.reload(); } catch (e) { toast((e as any).message); } }}>{p.active ? 'Deactivate' : 'Activate'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a promotion code" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try {
          await api('POST', '/v1/promotion_codes', {
            coupon: f.coupon || coupons[0]?.id, code: f.code || undefined, max_redemptions: f.max || undefined, customer: f.customer || undefined,
            expires_at: f.expires ? Math.floor(new Date(f.expires + 'T23:59:59').getTime() / 1000) : undefined,
            restrictions: { first_time_transaction: String(f.first), ...(f.minimum ? { minimum_amount: toMinor(f.minimum), minimum_amount_currency: 'usd' } : {}) },
          });
          setOpen(false); list.reload(); toast('Promotion code created');
        } catch (e) { setErr(e); }
      }}>Create code</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <div className="form-row">
            <Field label="Coupon"><select className="input" value={f.coupon} onChange={(e) => setF({ ...f, coupon: e.target.value })}>{coupons.filter((c) => c.valid).map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}</select></Field>
            <Field label="Code" hint="Letters and digits; customers type this."><input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          </div>
          <label className="row"><input type="checkbox" checked={f.first} onChange={(e) => setF({ ...f, first: e.target.checked })} /> Only for first-time customers</label>
          <div className="form-row">
            <Field label="Minimum order (USD)"><input className="input" placeholder="None" value={f.minimum} onChange={(e) => setF({ ...f, minimum: e.target.value })} /></Field>
            <Field label="Max redemptions"><input className="input" type="number" min={1} placeholder="Unlimited" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Expires on"><input className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
            <Field label="Limit to customer"><select className="input" value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })}><option value="">Anyone</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}</select></Field>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------- Subscription schedules ----------------
const SCHED: Record<string, ['neutral' | 'info' | 'success' | 'warning', string]> = { not_started: ['info', 'Not started'], active: ['success', 'Active'], completed: ['neutral', 'Completed'], released: ['neutral', 'Released'], canceled: ['neutral', 'Canceled'] };
export const ScheduleStatus = ({ s }: { s: string }) => <Badge kind={SCHED[s]?.[0] ?? 'neutral'}>{SCHED[s]?.[1] ?? s}</Badge>;

export function Schedules() {
  const { navigate } = useRouter();
  const list = useLoad(() => api('GET', '/v1/subscription_schedules', { limit: 100, expand: ['data.customer'] }), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Subscription schedules" sub="Plan price changes ahead of time: intro offers, future start dates, switches to annual." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create schedule</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No schedules yet.</Empty> : (
          <table className="table"><thead><tr><th>Customer</th><th>Status</th><th className="num">Phases</th><th>Current phase</th><th>Then</th><th>Subscription</th></tr></thead>
            <tbody>{list.data.data.map((s: any) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/subscription-schedules/${s.id}`)}>
                <td>{s.customer?.name ?? s.customer?.email ?? s.customer?.id}</td><td><ScheduleStatus s={s.status} /></td><td className="num">{s.phases.length}</td>
                <td className="soft">{s.current_phase ? `${dayOnly(s.current_phase.start_date)} → ${dayOnly(s.current_phase.end_date)}` : s.status === 'not_started' ? `Starts ${dayOnly(s.phases[0].start_date)}` : '—'}</td>
                <td className="soft">{s.end_behavior === 'cancel' ? 'Cancel' : 'Keep subscription'}</td>
                <td className="mono soft">{s.subscription ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {open && <CreateScheduleModal onClose={() => setOpen(false)} onDone={(s) => navigate(`/subscription-schedules/${s.id}`)} />}
    </>
  );
}

type PhaseForm = { price: string; quantity: string; iterations: string };

function CreateScheduleModal({ onClose, onDone, subscription }: { onClose: () => void; onDone: (s: any) => void; subscription?: any }) {
  const customers = useLoad(() => api('GET', '/v1/customers', { limit: 100 }), []);
  const prices = useLoad(() => api('GET', '/v1/prices', { type: 'recurring', active: 'true', limit: 100, expand: ['data.product'] }), []);
  const [customer, setCustomer] = useState('');
  const [start, setStart] = useState('now');
  const [startDate, setStartDate] = useState(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [phases, setPhases] = useState<PhaseForm[]>([{ price: '', quantity: '1', iterations: '3' }, { price: '', quantity: '1', iterations: '1' }]);
  const [trial, setTrial] = useState(false);
  const [end, setEnd] = useState('release');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const all = prices.data?.data ?? [];
  const priceOf = (ph: PhaseForm, i: number) => all.find((p: any) => p.id === ph.price) ?? all[Math.min(i, all.length - 1)];
  const set = (i: number, patch: Partial<PhaseForm>) => setPhases(phases.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  async function create() {
    setBusy(true); setErr(null);
    try {
      const cus = customer || customers.data?.data[0]?.id;
      if (!cus) throw new Error('Create a customer first.');
      const pms = await api('GET', '/v1/payment_methods', { customer: cus, type: 'card' });
      if (!pms.data.length) {
        const pm = await api('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: cus });
        await api('POST', `/v1/customers/${cus}`, { invoice_settings: { default_payment_method: pm.id } });
      }
      const s = await api('POST', '/v1/subscription_schedules', {
        customer: cus, end_behavior: end,
        start_date: start === 'now' ? 'now' : Math.floor(new Date(startDate + 'T12:00:00Z').getTime() / 1000),
        phases: phases.map((ph, i) => {
          const p = priceOf(ph, i);
          return { items: [{ price: p?.id, ...(isMetered(p) ? {} : { quantity: ph.quantity }) }], duration: { interval: p?.recurring?.interval ?? 'month', interval_count: Number(ph.iterations) * (p?.recurring?.interval_count ?? 1) }, ...(i === 0 && trial ? { trial: 'true' } : {}) };
        }),
      }, { 'Idempotency-Key': crypto.randomUUID() });
      onDone(s);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  void subscription;
  return (
    <Modal open onClose={onClose} title="Create a subscription schedule" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !all.length} onClick={create}>{busy ? 'Creating…' : 'Create schedule'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Customer"><select className="input" value={customer} onChange={(e) => setCustomer(e.target.value)}>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}{c.test_clock ? ' (test clock)' : ''}</option>)}</select></Field>
        <div className="form-row">
          <Field label="Starts"><select className="input" value={start} onChange={(e) => setStart(e.target.value)}><option value="now">Now</option><option value="date">On a date</option></select></Field>
          {start === 'date' && <Field label="Start date"><input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>}
        </div>
        {phases.map((ph, i) => {
          const p = priceOf(ph, i);
          return (
            <div key={i} className="phase-edit">
              <div className="row"><strong>Phase {i + 1}</strong><span className="spacer" />{phases.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPhases(phases.filter((_, j) => j !== i))}>Remove</button>}</div>
              <div className="form-row">
                <Field label="Price"><select className="input" value={p?.id ?? ''} onChange={(e) => set(i, { price: e.target.value })}>{all.map((x: any) => <option key={x.id} value={x.id}>{x.product?.name} · {priceText(x)}</option>)}</select></Field>
                {!isMetered(p) && <Field label="Qty"><input className="input" type="number" min={1} value={ph.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></Field>}
                <Field label={`Billing periods${p?.recurring ? ` (${p.recurring.interval}s)` : ''}`}><input className="input" type="number" min={1} value={ph.iterations} onChange={(e) => set(i, { iterations: e.target.value })} /></Field>
              </div>
              {i === 0 && <label className="row"><input type="checkbox" checked={trial} onChange={(e) => setTrial(e.target.checked)} /> This phase is a free trial</label>}
            </div>
          );
        })}
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPhases([...phases, { price: '', quantity: '1', iterations: '1' }])}>+ Add phase</button>
        <Field label="When the last phase ends"><select className="input" value={end} onChange={(e) => setEnd(e.target.value)}><option value="release">Keep the subscription going on the last phase's prices</option><option value="cancel">Cancel the subscription</option></select></Field>
      </div>
    </Modal>
  );
}

export function ScheduleDetail({ id }: { id: string }) {
  const toast = useToast();
  const sched = useLoad(() => api('GET', `/v1/subscription_schedules/${id}`, { expand: ['customer'] }), [id]);
  const prices = useLoad(() => api('GET', '/v1/prices', { limit: 100, expand: ['data.product'] }), []);
  const [err, setErr] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  if (!sched.data) return sched.error ? <ErrorNote error={sched.error} /> : <Card><Skeleton /></Card>;
  const s = sched.data;
  const priceById = (pid: string) => prices.data?.data.find((p: any) => p.id === pid);
  const live = ['not_started', 'active'].includes(s.status);
  const act = async (path: string, msg: string) => { setErr(null); try { await api('POST', `/v1/subscription_schedules/${id}/${path}`); toast(msg); sched.reload(); } catch (e) { setErr(e); } };
  const nowIdx = s.current_phase ? s.phases.findIndex((p: any) => p.start_date === s.current_phase.start_date) : -1;
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/subscription-schedules">Subscription schedules</Link> / <span className="mono">{id}</span></div>
      <PageHead title={`Schedule for ${s.customer?.name ?? s.customer?.email ?? 'customer'}`} sub={<ScheduleStatus s={s.status} />} actions={live && <>
        <button className="btn btn-secondary" onClick={() => setAdding(true)}>+ Add phase</button>
        <button className="btn btn-secondary" onClick={() => act('release', 'Schedule released')}>Release</button>
        <button className="btn btn-danger" onClick={() => confirm('Cancel the schedule and its subscription?') && act('cancel', 'Schedule canceled')}>Cancel schedule</button>
      </>} />
      <ErrorNote error={err} />
      <div className="grid grid-3-1" style={{ marginTop: 8 }}>
        <div className="stack">
          <Card title="Timeline">
            <ol className="phase-timeline">
              {s.phases.map((ph: any, i: number) => (
                <li key={i} className={i === nowIdx ? 'tl-current' : i < nowIdx || ['completed', 'released', 'canceled'].includes(s.status) ? 'tl-past' : ''}>
                  <div className="row"><strong>Phase {i + 1}</strong>{i === nowIdx && <Badge kind="success">Current</Badge>}{ph.trial_end && <Badge kind="info">Trial until {dayOnly(ph.trial_end)}</Badge>}<span className="spacer" /><span className="soft">{dayOnly(ph.start_date)} → {dayOnly(ph.end_date)}</span></div>
                  {ph.items.map((it: any, j: number) => { const p = priceById(it.price); return <div key={j} className="soft">{it.quantity ? `${it.quantity} × ` : ''}{p?.product?.name ?? it.price} · {p ? priceText(p) : ''}</div>; })}
                  {ph.discounts?.[0] && <div className="soft">Discount: {ph.discounts[0].promotion_code ?? ph.discounts[0].coupon}</div>}
                </li>
              ))}
              <li className="tl-end"><span className="soft">Then: {s.end_behavior === 'cancel' ? 'the subscription is canceled' : 'the subscription continues on its last prices'}</span></li>
            </ol>
          </Card>
          <Card title="Schedule object"><Json value={s} /></Card>
          {adding && <AddPhaseModal sched={s} onClose={() => setAdding(false)} onDone={() => { setAdding(false); toast('Phase added'); sched.reload(); }} />}
        </div>
        <Card title="Details">
          <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
            <dt>Customer</dt><dd><Link to={`/customers/${s.customer.id}`}>{s.customer.email ?? s.customer.id}</Link></dd>
            <dt>Subscription</dt><dd>{s.subscription ? <Link to={`/subscriptions/${s.subscription}`}>{s.subscription}</Link> : 'Created when phase 1 starts'}</dd>
            <dt>Billing</dt><dd>{s.default_settings.collection_method === 'send_invoice' ? 'Send invoice' : 'Charge automatically'}</dd>
            <dt>Created</dt><dd>{date(s.created)}</dd>
            {s.released_at && <><dt>Released</dt><dd>{date(s.released_at)}</dd></>}
            {s.completed_at && <><dt>Completed</dt><dd>{date(s.completed_at)}</dd></>}
            {s.canceled_at && <><dt>Canceled</dt><dd>{date(s.canceled_at)}</dd></>}
            {s.test_clock && <><dt>Test clock</dt><dd><Link to={`/test-clocks/${s.test_clock}`}>{s.test_clock}</Link></dd></>}
          </dl>
        </Card>
      </div>
    </>
  );
}

/** Compact schedule summary shown on a subscription's page. */
export function ScheduleCard({ id }: { id: string }) {
  const s = useLoad(() => api('GET', `/v1/subscription_schedules/${id}`), [id]);
  const prices = useLoad(() => api('GET', '/v1/prices', { limit: 100, expand: ['data.product'] }), []);
  if (!s.data) return null;
  const idx = s.data.current_phase ? s.data.phases.findIndex((p: any) => p.start_date === s.data.current_phase.start_date) : -1;
  const next = s.data.phases[idx + 1];
  const p = next ? prices.data?.data.find((x: any) => x.id === next.items[0].price) : null;
  return (
    <Card title="Schedule">
      <div className="stack" style={{ gap: 6 }}>
        <div className="row"><ScheduleStatus s={s.data.status} /><span className="soft">Phase {idx + 1} of {s.data.phases.length}</span></div>
        {next ? <div className="soft">From {dayOnly(next.start_date)}: {p ? `${next.items[0].quantity ? `${next.items[0].quantity} × ` : ''}${p.product?.name} · ${priceText(p)}` : next.items[0].price}</div> : <div className="soft">Last phase ends {s.data.current_phase ? dayOnly(s.data.current_phase.end_date) : '—'}, then {s.data.end_behavior === 'cancel' ? 'cancels' : 'continues'}.</div>}
        <Link to={`/subscription-schedules/${id}`}>View schedule</Link>
      </div>
    </Card>
  );
}

/** Adds a phase after the existing ones (keeps past and current phases as they are). */
export function AddPhaseModal({ sched, onClose, onDone }: { sched: any; onClose: () => void; onDone: () => void }) {
  const prices = useLoad(() => api('GET', '/v1/prices', { type: 'recurring', active: 'true', limit: 100, expand: ['data.product'] }), []);
  const [f, setF] = useState({ price: '', quantity: '1', count: '1', interval: 'month', promo: '' });
  const [err, setErr] = useState<any>(null);
  const all = (prices.data?.data ?? []).filter((p: any) => p.currency === sched.phases[0].currency);
  const p = all.find((x: any) => x.id === f.price) ?? all[0];
  async function save() {
    setErr(null);
    try {
      const from = sched.status === 'active' ? sched.phases.findIndex((x: any) => x.start_date === sched.current_phase.start_date) : 0;
      const keep = sched.phases.slice(from).map((ph: any, i: number) => ({
        items: ph.items.map((it: any) => ({ price: it.price, ...(it.quantity === null ? {} : { quantity: it.quantity }) })),
        ...(i === 0 ? { start_date: ph.start_date } : {}), end_date: ph.end_date,
        ...(ph.trial_end ? { trial_end: ph.trial_end } : {}),
        ...(ph.discounts?.[0] ? { discounts: [ph.discounts[0].promotion_code ? { promotion_code: ph.discounts[0].promotion_code } : { coupon: ph.discounts[0].coupon }] } : {}),
      }));
      await api('POST', `/v1/subscription_schedules/${sched.id}`, {
        phases: [...keep, { items: [{ price: p.id, ...(isMetered(p) ? {} : { quantity: f.quantity }) }], duration: { interval: f.interval, interval_count: f.count }, ...(f.promo ? { discounts: [{ promotion_code: f.promo }] } : {}) }],
      });
      onDone();
    } catch (e) { setErr(e); }
  }
  const promos = useLoad(() => api('GET', '/v1/promotion_codes', { active: 'true', limit: 100 }), []);
  return (
    <Modal open onClose={onClose} title="Add a phase" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!p} onClick={save}>Add phase</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <p className="soft">Starts {dayOnly(sched.phases[sched.phases.length - 1].end_date)}, when the current last phase ends.</p>
        <div className="form-row">
          <Field label="Price"><select className="input" value={p?.id ?? ''} onChange={(e) => setF({ ...f, price: e.target.value })}>{all.map((x: any) => <option key={x.id} value={x.id}>{x.product?.name} · {priceText(x)}</option>)}</select></Field>
          {!isMetered(p) && <Field label="Qty"><input className="input" type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>}
        </div>
        <div className="form-row">
          <Field label="Lasts"><input className="input" type="number" min={1} value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} /></Field>
          <Field label="Unit"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="month">Months</option><option value="year">Years</option><option value="week">Weeks</option><option value="day">Days</option></select></Field>
        </div>
        <Field label="Promotion code (optional)"><select className="input" value={f.promo} onChange={(e) => setF({ ...f, promo: e.target.value })}><option value="">None</option>{promos.data?.data.map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></Field>
      </div>
    </Modal>
  );
}
