import { useState } from 'react';
import { api, money, useLoad } from '../lib.tsx';
import { Card, ErrorNote, PageHead, Skeleton } from '../ui.tsx';
import { CreatePaymentModal, PaymentsTable } from './payments.tsx';

function VolumeChart({ charges }: { charges: any[] }) {
  const days = 14;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() - (days - 1 - i));
    return { day: d, total: 0 };
  });
  for (const c of charges) {
    if (c.status !== 'succeeded' || !c.captured || c.currency !== 'usd') continue;
    const d = new Date(c.created * 1000);
    d.setHours(0, 0, 0, 0);
    const b = buckets.find((x) => x.day.getTime() === d.getTime());
    if (b) b.total += c.amount_captured - (c.amount_refunded - (c.amount - c.amount_captured));
  }
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const W = 640, H = 160, bw = W / days;
  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Net volume in USD over the last 14 days" style={{ width: '100%', height: 'auto' }}>
      {buckets.map((b, i) => {
        const h = Math.max(b.total ? 3 : 1, (b.total / max) * (H - 10));
        return (
          <g key={i}>
            <rect x={i * bw + 4} y={H - h} width={bw - 8} height={h} rx="3" fill={b.total ? 'var(--color-brand)' : 'var(--color-border)'}>
              <title>{`${b.day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${money(b.total, 'usd')}`}</title>
            </rect>
            {(i === 0 || i === days - 1 || i === Math.floor(days / 2)) && (
              <text x={i * bw + bw / 2} y={H + 16} textAnchor="middle" fontSize="11" fill="var(--color-text-quiet)">{b.day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function Home() {
  const [open, setOpen] = useState(false);
  const charges = useLoad(() => api('GET', '/v1/charges', { limit: 100 }), []);
  const balance = useLoad(() => api('GET', '/v1/balance'), []);
  const list: any[] = charges.data?.data ?? [];
  const ok = list.filter((c) => c.status === 'succeeded' && c.captured && c.currency === 'usd');
  const gross = ok.reduce((s, c) => s + c.amount_captured, 0);
  const refunded = ok.reduce((s, c) => s + c.amount_refunded - (c.amount - c.amount_captured), 0);
  const failed = list.filter((c) => c.status === 'failed').length;
  const usdAvail = balance.data?.available.find((b: any) => b.currency === 'usd')?.amount ?? 0;
  const usdPending = balance.data?.pending.find((b: any) => b.currency === 'usd')?.amount ?? 0;
  const reload = () => { charges.reload(); balance.reload(); };

  return (
    <>
      <PageHead title="Today" sub="Test-mode activity for your account." actions={<button className="btn btn-primary" onClick={() => setOpen(true)}>+ Create payment</button>} />
      <ErrorNote error={charges.error ?? balance.error} />
      <div className="grid grid-4">
        <Card><div className="stat-label">Gross volume (USD)</div><div className="stat-value">{money(gross, 'usd')}</div></Card>
        <Card><div className="stat-label">Successful payments</div><div className="stat-value">{ok.length}</div></Card>
        <Card><div className="stat-label">Available balance</div><div className="stat-value">{money(usdAvail, 'usd')}</div><div className="muted" style={{ fontSize: 12 }}>{money(usdPending, 'usd')} pending</div></Card>
        <Card><div className="stat-label">Refunded · Failed</div><div className="stat-value">{money(refunded, 'usd')}</div><div className="muted" style={{ fontSize: 12 }}>{failed} failed or blocked attempts</div></Card>
      </div>
      <div style={{ marginTop: 16 }}><Card title="Net volume, last 14 days">{charges.loading && !charges.data ? <Skeleton rows={3} /> : <VolumeChart charges={list} />}</Card></div>
      <div style={{ marginTop: 16 }}><Card title="Recent payments" pad={false}>{charges.loading && !charges.data ? <Skeleton /> : <PaymentsTable charges={list.slice(0, 8)} />}</Card></div>
      <CreatePaymentModal open={open} onClose={() => setOpen(false)} onDone={reload} />
    </>
  );
}
