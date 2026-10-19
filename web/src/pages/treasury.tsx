import { useState } from 'react';
import { api, date, Link, money, toMinor, useLoad, useRouter, useToast } from '../lib.tsx';
import { Badge, Card, Empty, ErrorNote, Field, Json, Modal, PageHead, Skeleton, Tabs } from '../ui.tsx';

// ======================= Treasury =======================

const ACH_ACCOUNTS: [string, string][] = [
  ['000123456789', 'Succeeds'], ['000222222227', 'Fails: insufficient funds'], ['000111111113', 'Fails: account closed'], ['000111111116', 'Fails: no account'],
];
const FLOW_LABEL: Record<string, string> = { inbound_transfer: 'Inbound transfer', outbound_payment: 'Outbound payment', outbound_transfer: 'Outbound transfer', received_credit: 'Received credit', received_debit: 'Received debit' };
const FlowStatus = ({ s }: { s: string }) => <Badge kind={['succeeded', 'posted'].includes(s) ? 'success' : s === 'processing' ? 'info' : ['failed', 'returned'].includes(s) ? 'danger' : 'neutral'}>{s}</Badge>;

export function FinancialAccounts() {
  const { navigate } = useRouter();
  const list = useLoad(() => api('GET', '/v1/treasury/financial_accounts', { limit: 100 }), []);
  const [open, setOpen] = useState(false);
  const [nick, setNick] = useState('Operating account');
  const [err, setErr] = useState<any>(null);
  return (
    <>
      <PageHead title="Financial accounts" sub="Hold money in accounts with their own routing and account numbers, and move it in and out by ACH, wire, or between accounts." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Open account</button>} />
      <Card pad={false}>
        {!list.data ? <Skeleton /> : !list.data.data.length ? <Empty>No financial accounts yet.</Empty> : (
          <table className="table"><thead><tr><th>Account</th><th>Routing / account</th><th className="num">Cash</th><th className="num">Inbound</th><th className="num">Outbound</th><th>Status</th></tr></thead>
            <tbody>{list.data.data.map((f: any) => (
              <tr key={f.id} className="clickable" onClick={() => navigate(`/treasury/${f.id}`)}>
                <td><strong>{f.nickname ?? 'Financial account'}</strong><div className="mono muted" style={{ fontSize: 12 }}>{f.id}</div></td>
                <td className="mono soft">{f.financial_addresses[0] ? `${f.financial_addresses[0].aba.routing_number} / ••••${f.financial_addresses[0].aba.account_number_last4}` : '—'}</td>
                <td className="num amount">{money(f.balance.cash.usd, 'usd')}</td><td className="num soft">{money(f.balance.inbound_pending.usd, 'usd')}</td><td className="num soft">{money(f.balance.outbound_pending.usd, 'usd')}</td>
                <td>{f.status === 'open' ? <Badge kind="success">Open</Badge> : <Badge>Closed</Badge>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Open a financial account" footer={<button className="btn btn-primary" onClick={async () => {
        setErr(null);
        try { const f = await api('POST', '/v1/treasury/financial_accounts', { supported_currencies: ['usd'], nickname: nick }); navigate(`/treasury/${f.id}`); } catch (e) { setErr(e); }
      }}>Open account</button>}>
        <div className="form-grid">
          <ErrorNote error={err} />
          <Field label="Nickname"><input className="input" value={nick} onChange={(e) => setNick(e.target.value)} /></Field>
          <p className="soft" style={{ margin: 0 }}>The account gets a US routing and account number, and can pull money in by ACH, pay others by ACH or wire, and send money to your other financial accounts.</p>
        </div>
      </Modal>
    </>
  );
}

export function FinancialAccountDetail({ id }: { id: string }) {
  const toast = useToast();
  const fa = useLoad(() => api('GET', `/v1/treasury/financial_accounts/${id}`, { expand: ['financial_addresses.aba.account_number'] }), [id]);
  const others = useLoad(() => api('GET', '/v1/treasury/financial_accounts', { limit: 100 }), []);
  const txns = useLoad(() => api('GET', '/v1/treasury/transactions', { financial_account: id, limit: 50 }), [id]);
  const [modal, setModal] = useState<null | 'in' | 'out' | 'credit'>(null);
  const [err, setErr] = useState<any>(null);
  const [showNumber, setShowNumber] = useState(false);
  const reload = () => { fa.reload(); txns.reload(); };
  if (!fa.data) return fa.error ? <ErrorNote error={fa.error} /> : <Card><Skeleton /></Card>;
  const f = fa.data;
  const aba = f.financial_addresses[0]?.aba;
  const flowPath = (t: any) => `/v1/treasury/${t.flow_type}s/${t.flow}`;
  const act = async (fn: () => Promise<any>, msg: string) => { setErr(null); try { await fn(); toast(msg); reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <div className="soft" style={{ marginBottom: 6 }}><Link to="/treasury">Financial accounts</Link> / <span className="mono">{id}</span></div>
      <PageHead title={f.nickname ?? 'Financial account'} sub={f.status === 'open' ? <Badge kind="success">Open</Badge> : <Badge>Closed</Badge>} actions={f.status === 'open' && <>
        <button className="btn btn-secondary" onClick={() => setModal('credit')}>Simulate incoming transfer</button>
        <button className="btn btn-secondary" onClick={() => setModal('in')}>Add funds</button>
        <button className="btn btn-primary" onClick={() => setModal('out')}>Send money</button>
      </>} />
      <ErrorNote error={err} />
      <div className="grid grid-4" style={{ margin: '8px 0 16px' }}>
        <div className="card card-body"><div className="stat-label">Cash</div><div className="stat-value">{money(f.balance.cash.usd, 'usd')}</div></div>
        <div className="card card-body"><div className="stat-label">Inbound pending</div><div className="stat-value">{money(f.balance.inbound_pending.usd, 'usd')}</div></div>
        <div className="card card-body"><div className="stat-label">Outbound pending</div><div className="stat-value">{money(f.balance.outbound_pending.usd, 'usd')}</div></div>
        <div className="card card-body"><div className="stat-label">Account details</div>
          {aba ? <div className="mono" style={{ fontSize: 13, marginTop: 6 }}>Routing {aba.routing_number}<br />Account {showNumber ? aba.account_number : `•••• ${aba.account_number_last4}`} <button className="btn btn-ghost btn-sm" onClick={() => setShowNumber(!showNumber)}>{showNumber ? 'Hide' : 'Show'}</button></div> : <span className="muted">No ABA address</span>}
        </div>
      </div>
      <div className="grid grid-3-1">
        <div className="stack">
          <Card title="Transactions" pad={false}>
            {!txns.data ? <Skeleton /> : !txns.data.data.length ? <Empty>No money has moved yet. Add funds or simulate an incoming transfer.</Empty> : (
              <table className="table"><thead><tr><th>Description</th><th>Type</th><th className="num">Amount</th><th>Status</th><th>Created</th><th /></tr></thead>
                <tbody>{txns.data.data.map((t: any) => (
                  <tr key={t.id}><td>{t.description}</td><td className="soft">{FLOW_LABEL[t.flow_type] ?? t.flow_type}</td>
                    <td className="num amount">{money(t.status !== 'open' ? t.amount : t.flow_type === 'inbound_transfer' ? t.balance_impact.inbound_pending : -t.balance_impact.outbound_pending, 'usd')}</td>
                    <td><Badge kind={t.status === 'posted' ? 'success' : t.status === 'open' ? 'info' : 'neutral'}>{t.status === 'open' ? 'processing' : t.status}</Badge></td><td className="soft">{date(t.created)}</td>
                    <td className="num">{t.status === 'open' && (t.flow_type === 'inbound_transfer'
                      ? <><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/treasury/inbound_transfers/${t.flow}/succeed`), 'Transfer succeeded')}>Succeed</button><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/treasury/inbound_transfers/${t.flow}/fail`), 'Transfer failed')}>Fail</button></>
                      : t.flow_type.startsWith('outbound') ? <><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `/v1/test_helpers/treasury/${t.flow_type}s/${t.flow}/post`), 'Posted')}>Post</button><button className="btn btn-ghost btn-sm" onClick={() => act(() => api('POST', `${flowPath(t)}/cancel`), 'Canceled')}>Cancel</button></> : null)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card title="Financial account object"><Json value={f} /></Card>
        </div>
        <Card title="Features">
          <ul className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>{f.active_features.map((x: string) => <li key={x} className="soft">{x.replace(/[._]/g, ' ')}</li>)}</ul>
        </Card>
      </div>
      {modal === 'in' && <AddFundsModal fa={f} onClose={() => setModal(null)} onDone={() => { setModal(null); toast('Inbound transfer started'); reload(); }} />}
      {modal === 'out' && <SendMoneyModal fa={f} others={(others.data?.data ?? []).filter((x: any) => x.id !== id && x.status === 'open')} onClose={() => setModal(null)} onDone={() => { setModal(null); toast('Payment sent'); reload(); }} />}
      {modal === 'credit' && <IncomingModal fa={f} onClose={() => setModal(null)} onDone={() => { setModal(null); toast('Money received'); reload(); }} />}
    </>
  );
}

async function bankPm(account: string, name: string) {
  return api('POST', '/v1/payment_methods', { type: 'us_bank_account', us_bank_account: { routing_number: '110000000', account_number: account, account_holder_type: 'company' }, billing_details: { name } });
}

function AddFundsModal({ fa, onClose, onDone }: { fa: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ amount: '1000.00', account: ACH_ACCOUNTS[0]![0] });
  const [err, setErr] = useState<any>(null);
  return (
    <Modal open onClose={onClose} title="Add funds by ACH" footer={<button className="btn btn-primary" onClick={async () => {
      setErr(null);
      try { const pm = await bankPm(f.account, 'Your bank account'); await api('POST', '/v1/treasury/inbound_transfers', { financial_account: fa.id, amount: toMinor(f.amount, 'usd'), currency: 'usd', origin_payment_method: pm.id, description: 'Funds from bank account' }); onDone(); } catch (e) { setErr(e); }
    }}>Start transfer</button>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="Amount (USD)"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="From test bank account" hint="ACH pulls take a few seconds in test mode; the account number decides the result."><select className="input" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>{ACH_ACCOUNTS.map(([n, l]) => <option key={n} value={n}>{n} · {l}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

function SendMoneyModal({ fa, others, onClose, onDone }: { fa: any; others: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ to: 'bank', amount: '250.00', name: 'Acme Supplies', account: '000123456789', network: 'ach', dest: others[0]?.id ?? '', description: 'Supplier payment' });
  const [err, setErr] = useState<any>(null);
  return (
    <Modal open onClose={onClose} title="Send money" footer={<button className="btn btn-primary" onClick={async () => {
      setErr(null);
      try {
        if (f.to === 'fa') await api('POST', '/v1/treasury/outbound_payments', { financial_account: fa.id, amount: toMinor(f.amount, 'usd'), currency: 'usd', destination_payment_method_data: { type: 'financial_account', financial_account: f.dest }, description: f.description });
        else {
          const pm = await bankPm(f.account, f.name);
          await api('POST', '/v1/treasury/outbound_payments', { financial_account: fa.id, amount: toMinor(f.amount, 'usd'), currency: 'usd', destination_payment_method: pm.id, destination_payment_method_options: { us_bank_account: { network: f.network } }, description: f.description });
        }
        onDone();
      } catch (e) { setErr(e); }
    }}>Send {f.amount ? money(toMinor(f.amount, 'usd'), 'usd') : ''}</button>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <Field label="To"><select className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="bank">Someone's bank account</option>{others.length > 0 && <option value="fa">Another of your financial accounts</option>}</select></Field>
        {f.to === 'bank' ? <>
          <div className="form-row">
            <Field label="Recipient name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Network"><select className="input" value={f.network} onChange={(e) => setF({ ...f, network: e.target.value })}><option value="ach">ACH (1–2 business days)</option><option value="us_domestic_wire">Wire (same day)</option></select></Field>
          </div>
          <Field label="Account number (routing 110000000)"><input className="input mono" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} /></Field>
        </> : <Field label="Financial account"><select className="input" value={f.dest} onChange={(e) => setF({ ...f, dest: e.target.value })}>{others.map((o) => <option key={o.id} value={o.id}>{o.nickname ?? o.id}</option>)}</select></Field>}
        <div className="form-row">
          <Field label="Amount (USD)"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <p className="soft" style={{ margin: 0 }}>Available: {money(fa.balance.cash.usd, 'usd')}</p>
      </div>
    </Modal>
  );
}

function IncomingModal({ fa, onClose, onDone }: { fa: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ amount: '500.00', network: 'ach', description: 'Customer remittance' });
  const [err, setErr] = useState<any>(null);
  return (
    <Modal open onClose={onClose} title="Simulate an incoming transfer" footer={<button className="btn btn-primary" onClick={async () => {
      setErr(null);
      try { await api('POST', '/v1/test_helpers/treasury/received_credits', { financial_account: fa.id, amount: toMinor(f.amount, 'usd'), currency: 'usd', network: f.network, description: f.description }); onDone(); } catch (e) { setErr(e); }
    }}>Receive</button>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <p className="soft" style={{ margin: 0 }}>Someone sends money to this account's routing and account number.</p>
        <div className="form-row">
          <Field label="Amount (USD)"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Network"><select className="input" value={f.network} onChange={(e) => setF({ ...f, network: e.target.value })}><option value="ach">ACH</option><option value="us_domestic_wire">Wire</option></select></Field>
        </div>
        <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// ======================= Issuing disputes =======================

const DISPUTE_REASONS: [string, string][] = [['not_received', 'Not received'], ['fraudulent', 'Fraudulent'], ['duplicate', 'Duplicate charge'], ['merchandise_not_as_described', 'Not as described'], ['canceled', 'Canceled'], ['other', 'Other']];
export const IssuingDisputeStatus = ({ s }: { s: string }) => <Badge kind={s === 'won' ? 'success' : s === 'lost' ? 'danger' : s === 'submitted' ? 'info' : 'neutral'}>{s}</Badge>;

export function DisputeTransactionModal({ txn, onClose, onDone }: { txn: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ reason: 'not_received', explanation: 'The order never arrived.', amount: (-txn.amount / 100).toFixed(2), submit: true });
  const [err, setErr] = useState<any>(null);
  return (
    <Modal open onClose={onClose} title={`Dispute ${money(-txn.amount, txn.currency)} at ${txn.merchant_data.name}`} footer={<button className="btn btn-primary" onClick={async () => {
      setErr(null);
      try {
        const d = await api('POST', '/v1/issuing/disputes', { transaction: txn.id, amount: toMinor(f.amount, txn.currency), evidence: { reason: f.reason, [f.reason]: { explanation: f.explanation } } });
        if (f.submit) await api('POST', `/v1/issuing/disputes/${d.id}/submit`);
        onDone();
      } catch (e) { setErr(e); }
    }}>{f.submit ? 'Submit dispute' : 'Save draft'}</button>}>
      <div className="form-grid">
        <ErrorNote error={err} />
        <div className="form-row">
          <Field label="Reason"><select className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{DISPUTE_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Amount"><input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        <Field label="Explanation" hint="Test mode: an explanation containing losing_evidence loses; anything else wins a few seconds after submitting."><textarea className="input" rows={3} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></Field>
        <label className="row"><input type="checkbox" checked={f.submit} onChange={(e) => setF({ ...f, submit: e.target.checked })} /> Submit now</label>
      </div>
    </Modal>
  );
}

export function IssuingDisputesTable() {
  const toast = useToast();
  const list = useLoad(() => api('GET', '/v1/issuing/disputes', { limit: 100 }), []);
  if (!list.data) return <Card><Skeleton /></Card>;
  if (!list.data.data.length) return <Card><Empty>No disputes. Dispute a purchase from a card's transactions.</Empty></Card>;
  return (
    <Card pad={false}>
      <table className="table"><thead><tr><th>Transaction</th><th>Reason</th><th className="num">Amount</th><th>Status</th><th>Created</th><th /></tr></thead>
        <tbody>{list.data.data.map((d: any) => (
          <tr key={d.id}><td className="mono soft">{d.transaction}</td><td>{DISPUTE_REASONS.find(([k]) => k === d.evidence.reason)?.[1] ?? d.evidence.reason}</td><td className="num amount">{money(d.amount, d.currency)}</td><td><IssuingDisputeStatus s={d.status} /></td><td className="soft">{date(d.created)}</td>
            <td className="num">{d.status === 'unsubmitted' && <button className="btn btn-ghost btn-sm" onClick={async () => { try { await api('POST', `/v1/issuing/disputes/${d.id}/submit`); toast('Dispute submitted'); list.reload(); } catch (e: any) { toast(e.message, 'error'); } }}>Submit</button>}</td></tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

// ======================= Customer cash balance =======================

export function CashBalanceCard({ customer }: { customer: any }) {
  const toast = useToast();
  const bal = useLoad(() => api('GET', `/v1/customers/${customer.id}/cash_balance`), [customer.id]);
  const txns = useLoad(() => api('GET', `/v1/customers/${customer.id}/cash_balance_transactions`, { limit: 5 }), [customer.id, bal.data?.available?.usd]);
  const [instr, setInstr] = useState<any>(null);
  const [fund, setFund] = useState(false);
  const [amt, setAmt] = useState('100.00');
  const [tab, setTab] = useState<'balance' | 'activity'>('balance');
  const label: Record<string, string> = { funded: 'Bank transfer received', applied_to_payment: 'Applied to payment', unapplied_from_payment: 'Returned from payment', refunded_from_payment: 'Refund' };
  return (
    <Card title="Cash balance" actions={<button className="btn btn-ghost btn-sm" onClick={async () => setInstr(instr ? null : await api('POST', `/v1/customers/${customer.id}/funding_instructions`, { currency: 'usd', funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } }))}>{instr ? 'Hide' : 'Bank details'}</button>}>
      <div className="stack" style={{ gap: 10 }}>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'balance', label: 'Balance' }, { id: 'activity', label: 'Activity' }]} />
        {tab === 'balance' ? <>
          <div className="stat-value" style={{ fontSize: 22 }}>{money(bal.data?.available?.usd ?? 0, 'usd')}</div>
          {instr && <div className="mono soft" style={{ fontSize: 13 }}>Routing {instr.bank_transfer.financial_addresses[0].aba.routing_number}<br />Account {instr.bank_transfer.financial_addresses[0].aba.account_number}</div>}
          {fund ? (
            <div className="row"><input className="input" aria-label="Amount to send" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ maxWidth: 120 }} /><button className="btn btn-primary btn-sm" onClick={async () => { await api('POST', `/v1/test_helpers/customers/${customer.id}/fund_cash_balance`, { amount: toMinor(amt, 'usd'), currency: 'usd' }); setFund(false); toast('Bank transfer received'); bal.reload(); }}>Send</button></div>
          ) : <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', justifySelf: 'start', width: 'auto' }} onClick={() => setFund(true)}>Simulate bank transfer</button>}
        </> : (
          !txns.data?.data.length ? <span className="muted">No activity.</span> : <table className="table table-compact"><tbody>{txns.data.data.map((t: any) => <tr key={t.id}><td>{label[t.type] ?? t.type}</td><td className="num">{t.net_amount > 0 ? '+' : ''}{money(t.net_amount, t.currency)}</td></tr>)}</tbody></table>
        )}
      </div>
    </Card>
  );
}
