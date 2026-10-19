import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------------- API client (dashboard session: cookie + CSRF header) ----------------
let csrf = '';
export const setCsrf = (t: string) => (csrf = t);

export class ApiErr extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error?.message ?? `HTTP ${status}`);
  }
}

function encode(obj: any, prefix = '', out = new URLSearchParams()) {
  if (obj === undefined || obj === null) return out;
  if (Array.isArray(obj)) obj.forEach((v, i) => (typeof v === 'object' ? encode(v, `${prefix}[${i}]`, out) : out.append(`${prefix}[]`, String(v))));
  else if (typeof obj === 'object') for (const [k, v] of Object.entries(obj)) encode(v, prefix ? `${prefix}[${k}]` : k, out);
  else out.append(prefix, String(obj));
  return out;
}

export async function api<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: any, headers: Record<string, string> = {}): Promise<T> {
  const qs = method === 'GET' && params ? '?' + encode(params).toString() : '';
  const res = await fetch(path + qs, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-tessera-csrf': csrf, ...headers },
    body: method === 'GET' ? undefined : encode(params ?? {}).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(res.status, body);
  return body as T;
}

/** POST /v1/files as multipart/form-data (dashboard session). */
export async function uploadFile<T = any>(purpose: string, file: File, headers: Record<string, string> = {}, extra: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  fd.append('purpose', purpose);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', file, file.name);
  const res = await fetch('/v1/files', { method: 'POST', credentials: 'same-origin', headers: { 'x-tessera-csrf': csrf, ...headers }, body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(res.status, body);
  return body as T;
}

export async function dash<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: any): Promise<T> {
  const res = await fetch('/dashboard-api' + path, {
    method,
    credentials: 'same-origin',
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), 'x-tessera-csrf': csrf },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(res.status, json);
  return json as T;
}

export async function hosted<T = any>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
  const res = await fetch('/hosted-api' + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(res.status, json);
  return json as T;
}

// ---------------- router ----------------
const RouterCtx = createContext<{ path: string; navigate: (to: string) => void }>({ path: '/', navigate: () => {} });

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((to: string) => {
    history.pushState(null, '', to);
    setPath(to);
    scrollTo(0, 0);
  }, []);
  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>;
}
export const useRouter = () => useContext(RouterCtx);

export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string; [k: string]: any }) {
  const { navigate } = useRouter();
  return (
    <a href={to} className={className} {...rest} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = path.split('?')[0]!.split('/').filter(Boolean);
  const q = pattern.split('/').filter(Boolean);
  if (p.length !== q.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < q.length; i++) {
    if (q[i]!.startsWith(':')) out[q[i]!.slice(1)] = decodeURIComponent(p[i]!);
    else if (q[i] !== p[i]) return null;
  }
  return out;
}

// ---------------- data hook ----------------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, set] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true }));
    fn().then((data) => live && set({ data, loading: false }), (error) => live && set({ error, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

// ---------------- toasts ----------------
type Toast = { id: number; text: string; kind: 'info' | 'error' };
const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'toast-error' : ''}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------- formatting ----------------
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp']);
export function money(amount: number, currency = 'usd', locale = 'en-US') {
  const major = ZERO_DECIMAL.has(currency) ? amount : amount / 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(major);
}
export const isZeroDecimal = (c: string) => ZERO_DECIMAL.has(c);
export const toMinor = (major: string, currency = 'usd') => Math.round(Number(major) * (ZERO_DECIMAL.has(currency) ? 1 : 100));
export const date = (s: number) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dateLong = (s: number) => new Date(s * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });

export function copy(text: string, toast?: (t: string) => void) {
  navigator.clipboard?.writeText(text).then(() => toast?.('Copied to clipboard'));
}

/** Loads /v3/tessera.js once (the same client SDK merchants would use). */
let sdkPromise: Promise<any> | null = null;
export function loadTessera(): Promise<any> {
  if ((window as any).Tessera) return Promise.resolve((window as any).Tessera);
  sdkPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/v3/tessera.js';
    s.onload = () => resolve((window as any).Tessera);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return sdkPromise;
}

// ---------------- prices (all pricing models) ----------------
/** Amount for `qty` units of a price: per-unit, package (transform_quantity) or tiered. */
export function priceAmount(price: any, qty: number): number {
  if (!price) return 0;
  if (price.billing_scheme === 'tiered' && price.tiers) {
    const tiers = price.tiers;
    if (price.tiers_mode === 'volume') {
      const t = tiers.find((x: any) => x.up_to === null || qty <= x.up_to) ?? tiers[tiers.length - 1];
      return qty > 0 ? (t.unit_amount ?? 0) * qty + (t.flat_amount ?? 0) : 0;
    }
    let total = 0;
    let prev = 0;
    for (const t of tiers) {
      if (qty <= prev) break;
      total += (t.unit_amount ?? 0) * (Math.min(qty, t.up_to ?? Infinity) - prev) + (t.flat_amount ?? 0);
      prev = t.up_to ?? Infinity;
    }
    return total;
  }
  let q = qty;
  if (price.transform_quantity) q = (price.transform_quantity.round === 'down' ? Math.floor : Math.ceil)(q / price.transform_quantity.divide_by);
  return (price.unit_amount ?? 0) * q;
}
export const isMetered = (price: any) => price?.recurring?.usage_type === 'metered';
const per = (price: any) => (price?.recurring ? (price.recurring.interval_count === 1 ? ` / ${price.recurring.interval}` : ` every ${price.recurring.interval_count} ${price.recurring.interval}s`) : '');
/** Short description of a price, e.g. "$10.00 / month", "$0.02 per unit / month (metered)", "Graduated tiers / month". */
export function priceText(price: any): string {
  if (!price) return '';
  const usage = isMetered(price) ? ' · usage' : '';
  if (price.billing_scheme === 'tiered') return `${price.tiers_mode === 'volume' ? 'Volume' : 'Graduated'} tiers from ${money(price.tiers?.[0]?.unit_amount ?? 0, price.currency)}${per(price)}${usage}`;
  if (price.transform_quantity) return `${money(price.unit_amount, price.currency)} per ${price.transform_quantity.divide_by} units${per(price)}${usage}`;
  return `${money(price.unit_amount, price.currency)}${isMetered(price) ? ' per unit' : ''}${per(price) || ' one-time'}${usage}`;
}
