import { api, date, money, useLoad } from '../lib.tsx';
import { Card, Empty, ErrorNote, Money, PageHead, Skeleton, StatusBadge } from '../ui.tsx';

export function Balances() {
  const bal = useLoad(() => api('GET', '/v1/balance'), []);
  const txns = useLoad(() => api('GET', '/v1/balance_transactions', { limit: 100 }), []);
  return (
    <>
      <PageHead title="Balances" sub="Derived from the double-entry ledger. Charges settle in their own currency when you have a bank account for it; otherwise they are converted to your default currency (1% conversion fee)." actions={<button className="btn btn-secondary" onClick={() => { bal.reload(); txns.reload(); }}>Refresh</button>} />
      <ErrorNote error={bal.error ?? txns.error} />
      <div className="grid grid-2">
        <Card title="Available">{bal.data ? bal.data.available.map((b: any) => <div key={b.currency} className="stat-value">{money(b.amount, b.currency)}</div>) : <Skeleton rows={1} />}</Card>
        <Card title="Pending">{bal.data ? bal.data.pending.map((b: any) => <div key={b.currency} className="stat-value">{money(b.amount, b.currency)}</div>) : <Skeleton rows={1} />}</Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title="Balance transactions" pad={false}>
          {!txns.data ? <Skeleton /> : !txns.data.data.length ? <Empty>No balance activity yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Type</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th><th>Status</th><th>FX rate</th><th>Available on</th><th>Source</th></tr></thead>
              <tbody>{txns.data.data.map((t: any) => (
                <tr key={t.id}><td>{t.type}</td><td className="num"><Money amount={t.amount} currency={t.currency} /></td><td className="num soft">{money(-t.fee, t.currency)}</td><td className="num">{money(t.net, t.currency)}</td><td><StatusBadge obj={t} /></td><td className="soft">{t.exchange_rate ?? '—'}</td><td className="soft">{date(t.available_on)}</td><td className="mono soft">{t.source}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
