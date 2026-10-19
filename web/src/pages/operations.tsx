import { useEffect, useState } from 'react';
import { api, date, Link, money, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton, Tabs } from '../ui.tsx';
import { DisputeTransactionModal, IssuingDisputesTable } from './treasury.tsx';

// ======================= Terminal =======================

const DEVICE_LABEL: Record<string, string> = { simulated_wisepos_e: 'Simulated countertop reader', simulated_stripe_s700: 'Simulated handheld reader' };
const READER_TEST_CARDS: [string, string][] = [
  ['4242424242424242', 'Visa (approved)'], ['5555555555554444', 'Mastercard (approved)'], ['378282246310005', 'Amex (approved)'],
  ['4000000000000002', 'Declined'], ['4000000000009995', 'Insufficient funds'], ['4000000000000069', 'Expired card'],
];

const actionBadge = (a: any) => !a ? <Badge>Idle</Badge> : a.status === 'in_progress' ? <Badge kind="info">Waiting for card</Badge> : a.status === 'succeeded' ? <Badge kind="success">Last action succeeded</Badge> : <Badge kind="danger">Last action failed</Badge>;

export function Terminal() {
  const toast = useToast();
  const { navigate } = useRouter();
  const locations = useLoad(() => api('GET', '/v1/terminal/locations', { limit: 100 }), []);
  const readers = useLoad(() => api('GET', '/v1/terminal/readers', { limit: 100 }), []);
  const [locOpen, setLocOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [lf, setLf] = useState({ name: 'Main Street shop', line1: '510 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' });
  const [rf, setRf] = useState({ code: 'simulated-wpe', location: '', label: 'Front counter' });
  const [err, setErr] = useState<any>(null);
  const locName = (id: string) => locations.data?.data.find((l: any) => l.id === id)?.display_name ?? id;
  return (
    <>
      <PageHead title="Terminal" sub="In-person payments on simulated card readers." actions={<>
        <button className="btn btn-secondary" onClick={() => { setErr(null); setLocOpen(true); }}>+ New location</button>
        <button className="btn btn-primary" disabled={!locations.data?.data.length} onClick={() => { setErr(null); setReaderOpen(true); }}>+ Register reader</button>
      </>} />
      <div className="stack">
        <Card title="Readers" pad={false}>
          {!readers.data ? <Skeleton /> : !readers.data.data.length ? <Empty>{locations.data?.data.length ? 'No readers yet. Register a simulated reader to take in-person payments.' : 'Create a location first, then register a reader to it.'}</Empty> : (
            <table className="table"><thead><tr><th>Reader</th><th>Device</th><th>Location</th><th>Status</th><th>Activity</th></tr></thead>
              <tbody>{readers.data.data.map((r: any) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/terminal/readers/${r.id}`)}><td><strong>{r.label}</strong><div className="mono muted" style={{ fontSize: 12 }}>{r.serial_number}</div></td><td className="soft">{DEVICE_LABEL[r.device_type] ?? r.device_type}</td><td>{locName(r.location)}</td><td><Badge kind="success">Online</Badge></td><td>{actionBadge(r.action)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Locations" pad={false}>
          {!locations.data ? <Skeleton /> : !locations.data.data.length ? <Empty>No locations yet.</Empty> : (
            <table className="table"><thead><tr><th>Name</th><th>Address</th><th className="num">Readers</th><th /></tr></thead>
              <tbody>{locations.data.data.map((l: any) => (
                <tr key={l.id}><td><strong>{l.display_name}</strong><div className="mono muted" style={{ fontSize: 12 }}>{l.id}</div></td><td className="soft">{[l.address.line1, l.address.city, l.address.state, l.address.postal_code, l.address.country].filter(Boolean).join(', ')}</td>
                  <td className="num">{readers.data?.data.filter((r: any) => r.location === l.id).length ?? 0}</td>
                  <td className="num"><button className="btn btn-ghost btn-sm" onClick={async () => { if (!confirm('Delete this location?')) return; await api('DELETE', `/v1/terminal/locations/${l.id}`); locations.reload(); toast('Location deleted'); }}>Delete</button></td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>
      <Modal open={locOpen} onClose={() => setLocOpen(false)} title="New location" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try { await api('POST', '/v1/terminal/locations', { display_name: lf.name, address: { line1: lf.line1, city: lf.city, state: lf.state, postal_code: lf.postal_code, country: lf.country } }); setLocOpen(false); locations.reload(); toast('Location created'); } catch (e) { setErr(e); }
      }}>Create location</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Name"><input className="input" value={lf.name} onChange={(e) => setLf({ ...lf, name: e.target.value })} /></Field>
          <Field label="Street address"><input className="input" value={lf.line1} onChange={(e) => setLf({ ...lf, line1: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="City"><input className="input" value={lf.city} onChange={(e) => setLf({ ...lf, city: e.target.value })} /></Field>
            <Field label="State"><input className="input" value={lf.state} onChange={(e) => setLf({ ...lf, state: e.target.value.toUpperCase() })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Postal code"><input className="input" value={lf.postal_code} onChange={(e) => setLf({ ...lf, postal_code: e.target.value })} /></Field>
            <Field label="Country"><input className="input" maxLength={2} value={lf.country} onChange={(e) => setLf({ ...lf, country: e.target.value.toUpperCase() })} /></Field>
          </div>
        </div>
      </Modal>
      <Modal open={readerOpen} onClose={() => setReaderOpen(false)} title="Register a reader" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try { const r = await api('POST', '/v1/terminal/readers', { registration_code: rf.code, location: rf.location || locations.data?.data[0]?.id, label: rf.label }); navigate(`/terminal/readers/${r.id}`); } catch (e) { setErr(e); }
      }}>Register</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Registration code" hint="Real readers show a code on screen. In test mode, these codes register a simulated reader.">
            <select className="input" value={rf.code} onChange={(e) => setRf({ ...rf, code: e.target.value })}><option value="simulated-wpe">simulated-wpe (countertop)</option><option value="simulated-s700">simulated-s700 (handheld)</option></select>
          </Field>
          <Field label="Location"><select className="input" value={rf.location} onChange={(e) => setRf({ ...rf, location: e.target.value })}>{locations.data?.data.map((l: any) => <option key={l.id} value={l.id}>{l.display_name}</option>)}</select></Field>
          <Field label="Label"><input className="input" value={rf.label} onChange={(e) => setRf({ ...rf, label: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

/** One reader: start a payment on it and act as the customer on its screen. */
export function ReaderDetail({ id }: { id: string }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const reader = useLoad(() => api('GET', `/v1/terminal/readers/${id}`), [id]);
  const [amount, setAmount] = useState('18.50');
  const [capture, setCapture] = useState('automatic');
  const [card, setCard] = useState(READER_TEST_CARDS[0]![0]);
  const [tip, setTip] = useState('0');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const pi = useLoad(() => {
    const piId = reader.data?.action?.process_payment_intent?.payment_intent;
    return piId ? api('GET', `/v1/payment_intents/${piId}`) : Promise.resolve(null);
  }, [reader.data?.action?.process_payment_intent?.payment_intent, reader.data?.action?.status]);
  if (!reader.data) return reader.error ? <ErrorNote error={reader.error} /> : <Card><Skeleton /></Card>;
  const r = reader.data;
  const a = r.action;
  const run = async (fn: () => Promise<any>, msg?: string) => { setBusy(true); setErr(null); try { await fn(); if (msg) toast(msg); reader.reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  async function collect() {
    await run(async () => {
      const cents = toMinor(amount, 'usd');
      await api('POST', `/v1/terminal/readers/${id}/set_reader_display`, { type: 'cart', cart: { currency: 'usd', line_items: [{ amount: cents, description: 'In-store purchase', quantity: 1 }], total: cents } });
      const p = await api('POST', '/v1/payment_intents', { amount: cents, currency: 'usd', allowed_payment_method_types: ['card_present'], capture_method: capture, description: `In-person payment on ${r.label}` });
      await api('POST', `/v1/terminal/readers/${id}/process_payment_intent`, { payment_intent: p.id, process_config: { tipping: { amount_eligible: cents } } });
    }, 'Sent to the reader');
  }
  const waiting = a?.status === 'in_progress';
  const screen = waiting
    ? a.type === 'refund_payment' ? { title: 'Refund', lines: [`Refund ${a.refund_payment.amount ? money(a.refund_payment.amount, 'usd') : 'in full'}`, 'Tap, insert or swipe the original card'] }
      : { title: pi.data ? money(pi.data.amount, pi.data.currency) : '…', lines: ['Tap, insert or swipe card'] }
    : a?.type === 'set_reader_display' ? { title: money(a.set_reader_display.cart.total, a.set_reader_display.cart.currency), lines: a.set_reader_display.cart.line_items.map((l: any) => `${l.quantity} × ${l.description}`) }
      : a?.status === 'succeeded' ? { title: 'Approved', lines: ['Thank you!'] }
        : a?.status === 'failed' ? { title: a.failure_code === 'canceled' ? 'Canceled' : 'Declined', lines: [a.failure_message ?? ''] }
          : { title: 'Welcome', lines: [r.label] };
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/terminal">Terminal</Link> / <span className="mono">{r.serial_number}</span></div>
      <PageHead title={r.label} sub={<span className="row"><Badge kind="success">Online</Badge><span className="soft">{DEVICE_LABEL[r.device_type]}</span>{actionBadge(a)}</span>} actions={<>
        {waiting && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api('POST', `/v1/terminal/readers/${id}/cancel_action`), 'Action canceled')}>Cancel action</button>}
        <button className="btn btn-danger" onClick={async () => { if (!confirm('Remove this reader?')) return; await api('DELETE', `/v1/terminal/readers/${id}`); navigate('/terminal'); }}>Remove</button>
      </>} />
      <ErrorNote error={err} />
      <div className="grid grid-2" style={{ marginTop: 8, alignItems: 'start' }}>
        <div className="stack">
          <Card title="Collect a payment">
            <div className="form-grid">
              <div className="form-row">
                <Field label="Amount (USD)"><input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
                <Field label="Capture"><select className="input" value={capture} onChange={(e) => setCapture(e.target.value)}><option value="automatic">Automatically</option><option value="manual">Later (authorize only)</option></select></Field>
              </div>
              <button className="btn btn-primary" disabled={busy || waiting} onClick={collect}>Send to reader</button>
              {pi.data && <div className="soft">PaymentIntent <Link to={`/payments/${pi.data.id}`}>{pi.data.id}</Link> · {pi.data.status.replace(/_/g, ' ')}</div>}
            </div>
          </Card>
          <Card title="Reader object"><Json value={r} /></Card>
        </div>
        <div className="stack">
          <div className="reader-device" aria-label="Simulated reader screen">
            <div className="reader-screen" role="status" aria-live="polite">
              <div className="reader-title">{screen.title}</div>
              {screen.lines.map((l: string, i: number) => <div key={i} className="reader-line">{l}</div>)}
              {waiting && <div className="reader-contactless" aria-hidden="true">)))</div>}
            </div>
            <div className="reader-controls">
              <Field label="Test card"><select className="input" value={card} onChange={(e) => setCard(e.target.value)}>{READER_TEST_CARDS.map(([n, l]) => <option key={n} value={n}>{l} · {n.slice(-4)}</option>)}</select></Field>
              {waiting && a.type === 'process_payment_intent' && !a.process_payment_intent.process_config?.skip_tipping && <Field label="Customer adds a tip (USD)"><input className="input" value={tip} onChange={(e) => setTip(e.target.value)} /></Field>}
              <button className="btn btn-primary" disabled={busy || !waiting} onClick={() => run(() => api('POST', `/v1/test_helpers/terminal/readers/${id}/present_payment_method`, { type: 'card_present', card_present: { number: card }, ...(Number(tip) > 0 ? { amount_tip: toMinor(tip, 'usd') } : {}) }))}>Present card</button>
              {!waiting && <p className="muted" style={{ fontSize: 12, margin: 0 }}>When the reader is waiting for a card, present one here as the customer would.</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ======================= Issuing =======================

const CATEGORY_LABEL: Record<string, string> = {
  eating_places_restaurants: 'Restaurants', fast_food_restaurants: 'Fast food', grocery_stores_supermarkets: 'Groceries', automated_fuel_dispensers: 'Fuel',
  airlines_air_carriers: 'Airlines', hotels_motels_and_resorts: 'Hotels', taxicabs_limousines: 'Taxis and rideshare', computer_software_stores: 'Software',
  digital_goods_media: 'Digital goods', advertising_services: 'Advertising', telecommunication_services: 'Telecom', miscellaneous_general_merchandise: 'General merchandise',
  book_stores: 'Books', car_rental_agencies: 'Car rental', drug_stores_and_pharmacies: 'Pharmacies', electronics_stores: 'Electronics', travel_agencies_tour_operators: 'Travel agencies',
  bakeries: 'Bakeries', professional_services: 'Professional services', computer_network_services: 'Network services', bus_lines: 'Buses', postal_services_government_only: 'Postal services',
};
const CardStatus = ({ s }: { s: string }) => <Badge kind={s === 'active' ? 'success' : s === 'canceled' ? 'danger' : 'neutral'}>{s}</Badge>;
const AuthStatus = ({ a }: { a: any }) => (!a.approved ? <Badge kind="danger">Declined</Badge> : <Badge kind={a.status === 'pending' ? 'info' : a.status === 'closed' ? 'success' : 'neutral'}>{a.status}</Badge>);
const REASON_LABEL: Record<string, string> = {
  card_active: 'Within controls', webhook_approved: 'Approved by your webhook', webhook_declined: 'Declined by your webhook', webhook_timeout: 'Webhook timed out', webhook_error: 'Webhook error',
  insufficient_funds: 'Insufficient Issuing balance', spending_controls: 'Spending controls', card_inactive: 'Card inactive', card_canceled: 'Card canceled', cardholder_inactive: 'Cardholder inactive',
};

function IssuingBalance({ onChange }: { onChange?: () => void }) {
  const toast = useToast();
  const bal = useLoad(() => api('GET', '/v1/balance'), []);
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('500.00');
  const [err, setErr] = useState<any>(null);
  const available = bal.data?.issuing?.available?.find((b: any) => b.currency === 'usd')?.amount ?? 0;
  return (
    <>
      <div className="card card-body row" style={{ justifyContent: 'space-between' }}>
        <div><div className="stat-label">Issuing balance</div><div className="stat-value">{money(available, 'usd')}</div></div>
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>Top up</button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Top up the Issuing balance" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try { await api('POST', '/v1/topups', { amount: toMinor(amt, 'usd'), currency: 'usd', destination_balance: 'issuing', description: 'Issuing top-up' }); setOpen(false); bal.reload(); onChange?.(); toast('Balance topped up'); } catch (e) { setErr(e); }
      }}>Add funds</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Amount (USD)" hint="In test mode the money arrives immediately from a simulated bank account."><input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
        </div>
      </Modal>
    </>
  );
}

export function IssuingCards() {
  const { navigate } = useRouter();
  const cards = useLoad(() => api('GET', '/v1/issuing/cards', { limit: 100 }), []);
  const holders = useLoad(() => api('GET', '/v1/issuing/cardholders', { limit: 100 }), []);
  const [tab, setTab] = useState<'cards' | 'cardholders'>('cards');
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Issuing" sub="Virtual and physical cards with spending controls, funded from your Issuing balance." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create card</button>} />
      <div style={{ marginBottom: 16 }}><IssuingBalance /></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'cards', label: 'Cards' }, { id: 'cardholders', label: 'Cardholders' }]} />
      {tab === 'cards' ? (
        <Card pad={false}>
          {!cards.data ? <Skeleton /> : !cards.data.data.length ? <Empty>No cards yet.</Empty> : (
            <table className="table"><thead><tr><th>Card</th><th>Cardholder</th><th>Type</th><th>Status</th><th>Limits</th><th>Created</th></tr></thead>
              <tbody>{cards.data.data.map((c: any) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/issuing/cards/${c.id}`)}><td className="mono">•••• {c.last4}</td><td>{c.cardholder.name}</td><td className="soft">{c.type}</td><td><CardStatus s={c.status} /></td>
                  <td className="soft">{c.spending_controls.spending_limits.map((l: any) => `${money(l.amount, c.currency)} ${l.interval.replace('_', ' ')}`).join(', ') || '—'}</td><td className="soft">{date(c.created)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      ) : (
        <Card pad={false}>
          {!holders.data ? <Skeleton /> : !holders.data.data.length ? <Empty>No cardholders yet.</Empty> : (
            <table className="table"><thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Status</th><th>Billing address</th></tr></thead>
              <tbody>{holders.data.data.map((h: any) => (
                <tr key={h.id}><td><strong>{h.name}</strong><div className="mono muted" style={{ fontSize: 12 }}>{h.id}</div></td><td>{h.email ?? '—'}</td><td className="soft">{h.type}</td><td><CardStatus s={h.status} /></td><td className="soft">{[h.billing.address.line1, h.billing.address.city, h.billing.address.country].join(', ')}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      )}
      {open && <CreateCardModal holders={holders.data?.data ?? []} onClose={() => setOpen(false)} onDone={(c) => navigate(`/issuing/cards/${c.id}`)} />}
    </>
  );
}

function CreateCardModal({ holders, onClose, onDone }: { holders: any[]; onClose: () => void; onDone: (c: any) => void }) {
  const [holder, setHolder] = useState(holders[0]?.id ?? '__new');
  const [h, setH] = useState({ name: 'Jenny Rosen', email: 'jenny@example.com', line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postal_code: '94103', country: 'US' });
  const [f, setF] = useState({ type: 'virtual', active: true, limit: '500', interval: 'monthly', blocked: [] as string[] });
  const [err, setErr] = useState<any>(null);
  async function create() {
    setErr(null);
    try {
      let ch = holder;
      if (ch === '__new') ch = (await api('POST', '/v1/issuing/cardholders', { name: h.name, email: h.email, type: 'individual', billing: { address: { line1: h.line1, city: h.city, state: h.state, postal_code: h.postal_code, country: h.country } } })).id;
      const card = await api('POST', '/v1/issuing/cards', {
        cardholder: ch, currency: 'usd', type: f.type, status: f.active ? 'active' : 'inactive',
        ...(f.type === 'physical' ? { shipping: { name: h.name, address: { line1: h.line1, city: h.city, state: h.state, postal_code: h.postal_code, country: h.country } } } : {}),
        spending_controls: { ...(f.limit ? { spending_limits: [{ amount: toMinor(f.limit, 'usd'), interval: f.interval }] } : {}), ...(f.blocked.length ? { blocked_categories: f.blocked } : {}) },
      });
      onDone(card);
    } catch (e) { setErr(e); }
  }
  return (
    <Modal open onClose={onClose} title="Create a card" footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={create}>Create card</button></>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Cardholder"><select className="input" value={holder} onChange={(e) => setHolder(e.target.value)}>{holders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}<option value="__new">+ New cardholder</option></select></Field>
        {holder === '__new' && <>
          <div className="form-row"><Field label="Name on card"><input className="input" maxLength={24} value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /></Field><Field label="Email"><input className="input" type="email" value={h.email} onChange={(e) => setH({ ...h, email: e.target.value })} /></Field></div>
          <Field label="Billing address"><input className="input" value={h.line1} onChange={(e) => setH({ ...h, line1: e.target.value })} /></Field>
          <div className="form-row"><Field label="City"><input className="input" value={h.city} onChange={(e) => setH({ ...h, city: e.target.value })} /></Field><Field label="State"><input className="input" value={h.state} onChange={(e) => setH({ ...h, state: e.target.value.toUpperCase() })} /></Field></div>
          <div className="form-row"><Field label="Postal code"><input className="input" value={h.postal_code} onChange={(e) => setH({ ...h, postal_code: e.target.value })} /></Field><Field label="Country"><input className="input" maxLength={2} value={h.country} onChange={(e) => setH({ ...h, country: e.target.value.toUpperCase() })} /></Field></div>
        </>}
        <div className="form-row">
          <Field label="Card type"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="virtual">Virtual</option><option value="physical">Physical (shipped)</option></select></Field>
          <Field label="Spending limit (USD)"><input className="input" placeholder="No limit" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></Field>
          <Field label="Per"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}>{['per_authorization', 'daily', 'weekly', 'monthly', 'yearly', 'all_time'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}</select></Field>
        </div>
        <Field label="Block categories (optional)">
          <select className="input" multiple size={4} value={f.blocked} onChange={(e) => setF({ ...f, blocked: [...e.target.selectedOptions].map((o) => o.value) })}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </Field>
        <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activate now</label>
      </div>
    </Modal>
  );
}

export function IssuingCardDetail({ id }: { id: string }) {
  const toast = useToast();
  const card = useLoad(() => api('GET', `/v1/issuing/cards/${id}`), [id]);
  const auths = useLoad(() => api('GET', '/v1/issuing/authorizations', { card: id, limit: 50 }), [id]);
  const txns = useLoad(() => api('GET', '/v1/issuing/transactions', { card: id, limit: 50 }), [id]);
  const [revealed, setRevealed] = useState<any>(null);
  const [buy, setBuy] = useState({ amount: '24.00', category: 'eating_places_restaurants', name: 'Blue Bottle Coffee' });
  const [err, setErr] = useState<any>(null);
  const [bkey, setBkey] = useState(0);
  const [disputing, setDisputing] = useState<any>(null);
  const reloadAll = () => { card.reload(); auths.reload(); txns.reload(); setBkey((k) => k + 1); };
  useEffect(() => setRevealed(null), [id]);
  if (!card.data) return card.error ? <ErrorNote error={card.error} /> : <Card><Skeleton /></Card>;
  const c = card.data;
  const act = async (fn: () => Promise<any>, msg: string) => { setErr(null); try { const r = await fn(); toast(msg); reloadAll(); return r; } catch (e) { setErr(e); } };
  const num = revealed?.number?.replace(/(\d{4})(?=\d)/g, '$1 ') ?? `•••• •••• •••• ${c.last4}`;
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/issuing">Issuing</Link> / <span className="mono">{id}</span></div>
      <PageHead title={`${c.cardholder.name} · •••• ${c.last4}`} sub={<span className="row"><CardStatus s={c.status} /><span className="soft">{c.type} card</span></span>} actions={c.status !== 'canceled' && <>
        <button className="btn btn-secondary" onClick={() => act(() => api('POST', `/v1/issuing/cards/${id}`, { status: c.status === 'active' ? 'inactive' : 'active' }), c.status === 'active' ? 'Card frozen' : 'Card activated')}>{c.status === 'active' ? 'Freeze' : 'Activate'}</button>
        <button className="btn btn-danger" onClick={() => confirm('Cancel this card permanently?') && act(() => api('POST', `/v1/issuing/cards/${id}`, { status: 'canceled', cancellation_reason: 'lost' }), 'Card canceled')}>Cancel card</button>
      </>} />
      <ErrorNote error={err} />
      <div className="grid grid-2" style={{ marginTop: 8, alignItems: 'start' }}>
        <div className="stack">
          <div className={`issued-card ${c.status !== 'active' ? 'issued-card-off' : ''}`} aria-label="Card details">
            <div className="row" style={{ justifyContent: 'space-between' }}><strong>Tessera</strong><span>{c.type === 'virtual' ? 'Virtual' : 'Physical'}</span></div>
            <div className="issued-number mono">{num}</div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{c.cardholder.name}</span>
              <span className="mono">{String(c.exp_month).padStart(2, '0')}/{String(c.exp_year).slice(-2)}{revealed && <> · CVC {revealed.cvc}</>}</span>
              <span style={{ fontStyle: 'italic', fontWeight: 700 }}>VISA</span>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ alignSelf: 'flex-start', justifySelf: 'start', width: 'auto' }} onClick={async () => revealed ? setRevealed(null) : setRevealed(await api('GET', `/v1/issuing/cards/${id}`, { expand: ['number', 'cvc'] }))}>{revealed ? 'Hide details' : 'Show card details'}</button>
          <IssuingBalance key={bkey} onChange={reloadAll} />
          <Card title="Simulate a purchase">
            <div className="form-grid">
              <div className="form-row">
                <Field label="Amount (USD)"><input className="input" value={buy.amount} onChange={(e) => setBuy({ ...buy, amount: e.target.value })} /></Field>
                <Field label="Merchant"><input className="input" value={buy.name} onChange={(e) => setBuy({ ...buy, name: e.target.value })} /></Field>
              </div>
              <Field label="Merchant category"><select className="input" value={buy.category} onChange={(e) => setBuy({ ...buy, category: e.target.value })}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <button className="btn btn-primary" onClick={async () => {
                const a = await act(() => api('POST', '/v1/test_helpers/issuing/authorizations', { card: id, amount: toMinor(buy.amount, 'usd'), merchant_data: { category: buy.category, name: buy.name } }), 'Authorization received');
                if (a && !a.approved) toast(`Declined: ${REASON_LABEL[a.request_history[0].reason] ?? a.request_history[0].reason}`, 'error');
              }}>Authorize</button>
            </div>
          </Card>
          <SpendingControls card={c} onSaved={reloadAll} />
        </div>
        <div className="stack">
          <Card title="Authorizations" pad={false}>
            {!auths.data ? <Skeleton /> : !auths.data.data.length ? <Empty>No authorizations yet. Simulate a purchase to see how controls apply.</Empty> : (
              <table className="table"><thead><tr><th>Merchant</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                <tbody>{auths.data.data.map((a: any) => (
                  <tr key={a.id}><td>{a.merchant_data.name}<div className="muted" style={{ fontSize: 12 }}>{CATEGORY_LABEL[a.merchant_data.category] ?? a.merchant_data.category} · {REASON_LABEL[a.request_history.at(-1)?.reason] ?? a.request_history.at(-1)?.reason}</div></td>
                    <td className="num amount">{money(a.approved ? a.amount || a.request_history[0].amount : a.request_history[0].amount, a.currency)}</td><td><AuthStatus a={a} /></td>
                    <td className="num">{a.status === 'pending' && a.approved && <><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/issuing/authorizations/${a.id}/capture`), 'Captured')}>Capture</button><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/issuing/authorizations/${a.id}/reverse`), 'Reversed')}>Reverse</button></>}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card title="Transactions" pad={false}>
            {!txns.data ? <Skeleton /> : !txns.data.data.length ? <Empty>No transactions yet. Captured authorizations become transactions.</Empty> : (
              <table className="table"><thead><tr><th>Merchant</th><th>Type</th><th className="num">Amount</th><th /></tr></thead>
                <tbody>{txns.data.data.map((t: any) => (
                  <tr key={t.id}><td>{t.merchant_data.name}</td><td className="soft">{t.type}</td><td className="num amount">{money(t.amount, t.currency)}</td>
                    <td className="num">{t.type === 'capture' && <><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/issuing/transactions/${t.id}/refund`), 'Refunded')}>Refund</button>{!t.dispute ? <button className="btn btn-ghost btn-sm" onClick={() => setDisputing(t)}>Dispute</button> : <span className="muted" style={{ fontSize: 12 }}> disputed</span>}</>}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card title="Card object"><Json value={c} /></Card>
          {disputing && <DisputeTransactionModal txn={disputing} onClose={() => setDisputing(null)} onDone={() => { setDisputing(null); toast('Dispute created'); reloadAll(); }} />}
        </div>
      </div>
    </>
  );
}

function SpendingControls({ card, onSaved }: { card: any; onSaved: () => void }) {
  const toast = useToast();
  const sc = card.spending_controls;
  const [limits, setLimits] = useState<{ amount: string; interval: string }[]>(sc.spending_limits.map((l: any) => ({ amount: (l.amount / 100).toFixed(2), interval: l.interval })));
  const [blocked, setBlocked] = useState<string[]>(sc.blocked_categories ?? []);
  const [err, setErr] = useState<any>(null);
  return (
    <Card title="Spending controls">
      <div className="form-grid">
        <ErrorNote error={err} />
        {limits.map((l, i) => (
          <div key={i} className="limit-row">
            <Field label="Limit (USD)"><input className="input" value={l.amount} onChange={(e) => setLimits(limits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></Field>
            <Field label="Per"><select className="input" value={l.interval} onChange={(e) => setLimits(limits.map((x, j) => (j === i ? { ...x, interval: e.target.value } : x)))}>{['per_authorization', 'daily', 'weekly', 'monthly', 'yearly', 'all_time'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}</select></Field>
            <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'end' }} onClick={() => setLimits(limits.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', justifySelf: 'start', width: 'auto' }} onClick={() => setLimits([...limits, { amount: '100.00', interval: 'per_authorization' }])}>+ Add limit</button>
        <Field label="Blocked categories"><select className="input" multiple size={5} value={blocked} onChange={(e) => setBlocked([...e.target.selectedOptions].map((o) => o.value))}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start', justifySelf: 'start', width: 'auto' }} disabled={card.status === 'canceled'} onClick={async () => {
          setErr(null);
          try {
            await api('POST', `/v1/issuing/cards/${card.id}`, { spending_controls: { spending_limits: limits.length ? limits.map((l) => ({ amount: toMinor(l.amount, 'usd'), interval: l.interval })) : '', blocked_categories: blocked.length ? blocked : '' } });
            toast('Controls saved'); onSaved();
          } catch (e) { setErr(e); }
        }}>Save controls</button>
      </div>
    </Card>
  );
}

export function IssuingAuthorizations() {
  const [tab, setTab] = useState<'authorizations' | 'transactions' | 'disputes'>('authorizations');
  const auths = useLoad(() => api('GET', '/v1/issuing/authorizations', { limit: 100 }), []);
  const txns = useLoad(() => api('GET', '/v1/issuing/transactions', { limit: 100 }), []);
  const { navigate } = useRouter();
  return (
    <>
      <PageHead title="Card activity" sub="Authorizations (purchase attempts and their decisions) and the transactions they become." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'authorizations', label: 'Authorizations' }, { id: 'transactions', label: 'Transactions' }, { id: 'disputes', label: 'Disputes' }]} />
      {tab === 'disputes' ? <IssuingDisputesTable /> : tab === 'authorizations' ? (
        <Card pad={false}>{!auths.data ? <Skeleton /> : !auths.data.data.length ? <Empty>No authorizations yet.</Empty> : (
          <table className="table"><thead><tr><th>Merchant</th><th>Card</th><th className="num">Amount</th><th>Status</th><th>Decision</th><th>Created</th></tr></thead>
            <tbody>{auths.data.data.map((a: any) => (
              <tr key={a.id} className="clickable" onClick={() => navigate(`/issuing/cards/${a.card.id}`)}><td>{a.merchant_data.name}</td><td className="mono">•••• {a.card.last4}</td><td className="num amount">{money(a.request_history[0]?.amount ?? a.amount, a.currency)}</td><td><AuthStatus a={a} /></td><td className="soft">{REASON_LABEL[a.request_history.at(-1)?.reason] ?? '—'}</td><td className="soft">{date(a.created)}</td></tr>
            ))}</tbody>
          </table>
        )}</Card>
      ) : (
        <Card pad={false}>{!txns.data ? <Skeleton /> : !txns.data.data.length ? <Empty>No transactions yet.</Empty> : (
          <table className="table"><thead><tr><th>Merchant</th><th>Type</th><th className="num">Amount</th><th>Created</th></tr></thead>
            <tbody>{txns.data.data.map((t: any) => (
              <tr key={t.id} className="clickable" onClick={() => navigate(`/issuing/cards/${t.card}`)}><td>{t.merchant_data.name}</td><td className="soft">{t.type}</td><td className="num amount">{money(t.amount, t.currency)}</td><td className="soft">{date(t.created)}</td></tr>
            ))}</tbody>
          </table>
        )}</Card>
      )}
    </>
  );
}
