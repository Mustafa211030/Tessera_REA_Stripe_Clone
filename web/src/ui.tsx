import { useEffect, useRef, useState, type ReactNode } from 'react';
import { loadTessera, money } from './lib.tsx';

export function Badge({ kind = 'neutral', children }: { kind?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'test'; children: ReactNode }) {
  return <span className={`badge ${kind === 'neutral' ? '' : `badge-${kind}`}`}>{children}</span>;
}

export function StatusBadge({ obj }: { obj: any }) {
  if (obj.object === 'charge') {
    if (obj.status === 'failed') return <Badge kind={obj.outcome?.type === 'blocked' ? 'danger' : 'danger'}>{obj.outcome?.type === 'blocked' ? 'Blocked' : 'Failed'}</Badge>;
    if (obj.refunded) return <Badge>Refunded</Badge>;
    if (obj.amount_refunded > 0 && obj.captured) return <Badge kind="info">Partially refunded</Badge>;
    if (!obj.captured) return <Badge kind="warning">Uncaptured</Badge>;
    return <Badge kind="success">Succeeded</Badge>;
  }
  const s: string = obj.status;
  const map: Record<string, [string, any]> = {
    succeeded: ['Succeeded', 'success'], requires_capture: ['Uncaptured', 'warning'], requires_payment_method: [obj.last_payment_error ? 'Failed' : 'Incomplete', obj.last_payment_error ? 'danger' : 'neutral'],
    requires_confirmation: ['Incomplete', 'neutral'], requires_action: ['Needs authentication', 'info'], canceled: ['Canceled', 'neutral'], processing: ['Processing', 'info'],
    open: ['Open', 'info'], complete: ['Complete', 'success'], expired: ['Expired', 'neutral'], enabled: ['Enabled', 'success'], disabled: ['Disabled', 'neutral'],
    pending: ['Pending', 'warning'], available: ['Available', 'success'], failed: ['Failed', 'danger'],
    in_transit: ['In transit', 'info'], paid: ['Paid', 'success'],
  };
  const [label, kind] = map[s] ?? [s, 'neutral'];
  return <Badge kind={kind}>{label}</Badge>;
}

export function Money({ amount, currency }: { amount: number; currency: string }) {
  return <span className="amount">{money(amount, currency)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{currency.toUpperCase()}</span></span>;
}

export function Card({ title, actions, children, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && <div className="card-head"><h3>{title}</h3><div className="row">{actions}</div></div>}
      {pad ? <div className="card-body">{children}</div> : children}
    </section>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  useEffect(() => { document.title = `${title} · Tessera`; }, [title]);
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      <div className="row">{actions}</div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="modal-title">
      <div className="modal-head"><h2 id="modal-title">{title}</h2></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Json({ value }: { value: unknown }) {
  const html = JSON.stringify(value, null, 2)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b/g, (m, s, colon, n) => {
      if (s) return colon ? `<span class="json-key">${s}</span>${colon}` : `<span class="json-str">${s}</span>`;
      return `<span class="json-num">${n ?? m}</span>`;
    });
  return <pre className="code" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div className="card-body stack" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>;
}

export function ErrorNote({ error }: { error?: any }) {
  if (!error) return null;
  return <div className="alert alert-error" role="alert">{error.message ?? String(error)}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} className="tab" onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

/** The card element (iframe), mounted through the client SDK. */
export function CardInput({ pk, account, onReady, label = 'Card information', locale }: { pk: string; account?: string; onReady: (api: { element: any; tessera: any }) => void; label?: string; locale?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ error?: string; focus?: boolean }>({});
  useEffect(() => {
    let card: any;
    loadTessera().then((Tessera) => {
      const tessera = Tessera(pk, account ? { stripeAccount: account } : undefined);
      card = tessera.elements(locale ? { locale } : undefined).create('card');
      card.mount(ref.current);
      card.on('change', (e: any) => setState((s) => ({ ...s, error: e.error?.message })));
      onReady({ element: card, tessera });
    });
    return () => card?.unmount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pk, account, locale]);
  return (
    <div className="field">
      <span>{label}</span>
      <div ref={ref} style={{ minHeight: 46 }} />
      {state.error && <small style={{ color: 'var(--color-danger-text)' }} role="alert">{state.error}</small>}
    </div>
  );
}

export const TEST_CARDS: [string, string][] = [
  ['4242 4242 4242 4242', 'Succeeds'],
  ['4000 0027 6000 3184', 'Always requires 3-D Secure'],
  ['4000 0000 0000 0002', 'Generic decline'],
  ['4000 0000 0000 9995', 'Insufficient funds'],
  ['4000 0000 0000 0127', 'Incorrect CVC'],
  ['4100 0000 0000 0019', 'Blocked by fraud rules'],
  ['4000 0000 0000 9235', 'Elevated risk'],
  ['4000 0000 0000 0077', 'Funds available immediately'],
  ['4000 0025 0000 3155', 'Authenticate once, then saved for off-session'],
  ['4000 0000 0000 0341', 'Saves fine, but charges decline'],
  ['4000 0000 0000 0259', 'Payment is disputed (fraudulent)'],
  ['4000 0000 0000 2685', 'Disputed: product not received'],
  ['4000 0000 0000 1976', 'Inquiry from the issuer'],
  ['4000 0000 0000 5423', 'Early fraud warning'],
  ['4000 0007 6000 0002', 'Brazilian card (country rules)'],
];

export function TestCards({ label = 'Test card numbers' }: { label?: string }) {
  return (
    <details>
      <summary className="soft" style={{ cursor: 'pointer' }}>{label}</summary>
      <table className="table test-cards" style={{ marginTop: 8 }}>
        <tbody>{TEST_CARDS.map(([n, d]) => <tr key={n}><td>{n}</td><td className="soft" style={{ fontFamily: 'inherit' }}>{d}</td></tr>)}</tbody>
      </table>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Use any future expiry date and any 3-digit CVC.</p>
    </details>
  );
}

export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    leaf: 'M5 19c0-8 6-14 15-14 0 9-6 15-14 15-.4 0-.7 0-1-.1M5 19l7-7',
    coins: 'M8 8a5 3 0 1 0 0-.01M3 8v4c0 1.7 2.2 3 5 3M3 12v4c0 1.7 2.2 3 5 3M13 13a5 3 0 1 0 0-.01M13 13v4c0 1.7 2.2 3 5 3s5-1.3 5-3v-4',
    database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    card: 'M3 6h18v12H3zM3 10h18',
    users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
    wallet: 'M3 7h18v12H3zM16 13h2M3 7l12-4v4',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
    shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
    flag: 'M5 21V4h11l-2 4 2 4H5',
    key: 'M15 7a4 4 0 1 1-3.9 4.9L3 20v-3l2-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7z',
    hook: 'M12 3v8a4 4 0 1 1-4 4M18 8l-6 3',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    terminal: 'M4 17l6-6-6-6M12 19h8',
    book: 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM18 20H7a3 3 0 0 1-3-3',
    code: 'M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16',
    box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
    repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
    receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
    tag: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    quote: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
    network: 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 23a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 23a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 5v6M12 11l-7 8M12 11l7 8',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    bank: 'M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18M12 3l9 5H3z',
    calendar: 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4',
    'terminal-reader': 'M7 2h10v20H7zM9 5h6v5H9zM9 13h2M13 13h2M9 16h2M13 16h2M9 19h6',
    truck: 'M2 6h12v10H2zM14 10h4l3 3v3h-7M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    id: 'M3 5h18v14H3zM8.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 16a3 3 0 0 1 6 0M14 9h4M14 13h4',
    gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6M12 18h.01',
    percent: 'M19 5 5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    check: 'M20 6 9 17l-5-5',
  };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.list} />
    </svg>
  );
}
