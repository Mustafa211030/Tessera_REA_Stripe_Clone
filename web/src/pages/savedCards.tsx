import { useState } from 'react';
import { api, ApiErr, dash, money, toMinor, useLoad, useToast } from '../lib.tsx';
import { Badge, Card, CardInput, ErrorNote, Field, Modal, TestCards } from '../ui.tsx';

/**
 * Saved cards on a customer: add one with a SetupIntent (card element + confirmCardSetup,
 * 3-D Secure when the card needs it), make one the default, remove one, and charge a saved
 * card off-session the way a merchant's server would.
 */
export function SavedCards({ customer, defaultPm, onChange }: { customer: string; defaultPm: string | null; onChange: () => void }) {
  const toast = useToast();
  const pms = useLoad(() => api('GET', `/v1/customers/${customer}/payment_methods`, { limit: 100 }), [customer]);
  const [adding, setAdding] = useState(false);
  const [charging, setCharging] = useState<any>(null);
  const reload = () => { pms.reload(); onChange(); };
  const setDefault = async (pm: string) => { await api('POST', `/v1/customers/${customer}`, { invoice_settings: { default_payment_method: pm } }); toast('Default card updated'); reload(); };
  const remove = async (pm: string) => {
    try { await api('POST', `/v1/payment_methods/${pm}/detach`); toast('Card removed'); reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <Card title="Saved cards" actions={<button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>+ Add card</button>}>
      {!pms.data?.data.length ? <span className="muted">No saved cards. Add one with a SetupIntent to charge it later without the customer.</span> : (
        <div className="stack" style={{ gap: 4 }}>
          {pms.data.data.map((pm: any) => (
            <div key={pm.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
              <div className="row">
                <strong style={{ textTransform: 'capitalize' }}>{pm.card.brand}</strong> •••• {pm.card.last4}
                <span className="muted" style={{ fontSize: 12 }}>{String(pm.card.exp_month).padStart(2, '0')}/{String(pm.card.exp_year).slice(-2)}</span>
                {pm.id === defaultPm && <Badge>Default</Badge>}
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setCharging(pm)}>Charge</button>
                {pm.id !== defaultPm && <button className="btn btn-ghost btn-sm" onClick={() => setDefault(pm.id)}>Make default</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => remove(pm.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <AddCardModal open={adding} customer={customer} onClose={() => setAdding(false)} onDone={reload} />
      <ChargeSavedModal pm={charging} customer={customer} onClose={() => setCharging(null)} onDone={onChange} />
    </Card>
  );
}

function AddCardModal({ open, customer, onClose, onDone }: { open: boolean; customer: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const keys = useLoad(() => dash('GET', '/keys'), [open]);
  const pk = keys.data?.data.find((k: any) => k.type === 'publishable')?.token;
  const [sdk, setSdk] = useState<{ element: any; tessera: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  async function save() {
    if (!sdk) return;
    setBusy(true); setError(null);
    try {
      const si = await api('POST', '/v1/setup_intents', { customer, usage: 'off_session' }, { 'Idempotency-Key': crypto.randomUUID() });
      const r = await sdk.tessera.confirmCardSetup(si.client_secret, { payment_method: { card: sdk.element }, return_url: location.href });
      if (r.error) setError(r.error);
      else { toast('Card saved for off-session use'); sdk.element.clear(); onDone(); onClose(); }
    } catch (e) { setError(e instanceof ApiErr ? e : { message: String(e) }); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Save a card"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !sdk} onClick={save}>{busy ? 'Saving…' : 'Save card'}</button></>}>
      <div className="form-grid">
        <ErrorNote error={error} />
        <p className="soft">Runs a SetupIntent: a zero-amount check, plus 3-D Secure if the card asks for it. The card can then be charged off-session.</p>
        {open && pk && <CardInput pk={pk} onReady={setSdk} />}
        <TestCards />
      </div>
    </Modal>
  );
}

function ChargeSavedModal({ pm, customer, onClose, onDone }: { pm: any; customer: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('19.00');
  const [offSession, setOffSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  async function charge() {
    setBusy(true); setError(null);
    try {
      const pi = await api('POST', '/v1/payment_intents', { amount: toMinor(amount), currency: 'usd', customer, payment_method: pm.id, confirm: 'true', off_session: offSession ? 'true' : undefined, return_url: offSession ? undefined : location.href, description: 'Saved card charge' }, { 'Idempotency-Key': crypto.randomUUID() });
      if (pi.status === 'requires_action') { location.assign(pi.next_action.redirect_to_url.url); return; }
      toast(`Payment ${pi.status}`); onDone(); onClose();
    } catch (e) { setError(e instanceof ApiErr ? e.body?.error ?? e : { message: String(e) }); } finally { setBusy(false); }
  }
  return (
    <Modal open={!!pm} onClose={onClose} title={pm ? `Charge ${pm.card.brand} •••• ${pm.card.last4}` : 'Charge'}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={charge}>Charge {money(toMinor(amount || '0'))}</button></>}>
      <div className="form-grid">
        {error && <div className="alert alert-error" role="alert">{error.message}{error.code === 'authentication_required' && <div style={{ marginTop: 6 }}>The bank wants the customer to authenticate. Bring them back on-session (untick off-session) or send them an invoice to pay.</div>}</div>}
        <Field label="Amount (USD)"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <label className="row"><input type="checkbox" checked={offSession} onChange={(e) => setOffSession(e.target.checked)} /> Customer is not present (off_session)</label>
      </div>
    </Modal>
  );
}
