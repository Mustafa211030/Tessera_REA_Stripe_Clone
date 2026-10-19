/**
 * Load test for a running Tessera server.
 *
 *   npm run loadtest -- [--base http://localhost:4242] [--key sk_test_…] [--seconds 20] [--concurrency 32]
 *
 * Without --key it signs in as the demo user (demo@tessera.local / tessera-demo) and uses the
 * account's secret key. Traffic mix, like a busy checkout:
 *   45%  create + confirm a PaymentIntent with pm_card_visa      (critical)
 *   20%  create a customer                                         (write)
 *   35%  list or retrieve payment intents                          (read)
 * Prints throughput, latency percentiles, status codes and which limiter tier answered 429s,
 * then the server's own view from GET /v1/tessera/system. Start the server with
 * RATE_LIMIT_PER_SECOND raised (e.g. 100000) to measure capacity rather than the per-key limit.
 */
const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1]! : def; };
const base = arg('base', 'http://localhost:4242');
const seconds = Number(arg('seconds', '20'));
const concurrency = Number(arg('concurrency', '32'));
let key = arg('key', '');

async function demoKey() {
  const login = await fetch(`${base}/dashboard-api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@tessera.local', password: 'tessera-demo' }) });
  if (!login.ok) throw new Error(`Demo sign-in failed (${login.status}). Pass --key sk_test_…`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const keys = await (await fetch(`${base}/dashboard-api/keys`, { headers: { cookie } })).json() as any;
  const sk = keys.data.find((k: any) => k.type === 'secret' && !k.expires && String(k.token ?? '').startsWith('sk_test_'));
  if (!sk) throw new Error('No secret key found. Pass --key sk_test_…');
  return sk.token as string;
}

type Result = { kind: string; status: number; ms: number; reason: string | null };
const results: Result[] = [];
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function call(kind: string, method: string, path: string, body?: Record<string, string>) {
  const t = performance.now();
  try {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: body ? form(body) : undefined });
    const j = await r.json().catch(() => null) as any;
    results.push({ kind, status: r.status, ms: performance.now() - t, reason: r.headers.get('stripe-rate-limited-reason') });
    return j;
  } catch {
    results.push({ kind, status: 0, ms: performance.now() - t, reason: 'network' });
    return null;
  }
}

const recent: string[] = [];
async function worker(until: number) {
  while (Date.now() < until) {
    const x = Math.random();
    if (x < 0.45) {
      const pi = await call('payment', 'POST', '/v1/payment_intents', { amount: String(500 + Math.floor(Math.random() * 9500)), currency: 'usd', payment_method: 'pm_card_visa', confirm: 'true', description: 'Load test' });
      if (pi?.id) { recent.push(pi.id); if (recent.length > 200) recent.shift(); }
    } else if (x < 0.65) {
      await call('customer', 'POST', '/v1/customers', { email: `load${Math.floor(Math.random() * 1e9)}@example.com` });
    } else if (x < 0.85 || !recent.length) {
      await call('list', 'GET', '/v1/payment_intents?limit=10');
    } else {
      await call('retrieve', 'GET', `/v1/payment_intents/${recent[Math.floor(Math.random() * recent.length)]}`);
    }
  }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0; };

if (!key) key = await demoKey();
console.log(`Load test: ${concurrency} concurrent clients for ${seconds}s against ${base}`);
const t0 = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker(t0 + seconds * 1000)));
const elapsed = (Date.now() - t0) / 1000;
const ok = results.filter((r) => r.status >= 200 && r.status < 300);
const byKind = (k: string) => results.filter((r) => r.kind === k);
console.log(`\nRequests: ${results.length} in ${elapsed.toFixed(1)}s = ${(results.length / elapsed).toFixed(0)} req/s (${(ok.length / elapsed).toFixed(0)} successful/s)`);
console.log(`Payments confirmed: ${byKind('payment').filter((r) => r.status === 200).length} = ${(byKind('payment').filter((r) => r.status === 200).length / elapsed).toFixed(0)}/s`);
console.log(`Latency (successful, ms): p50 ${pct(ok.map((r) => r.ms), 50).toFixed(1)} · p95 ${pct(ok.map((r) => r.ms), 95).toFixed(1)} · p99 ${pct(ok.map((r) => r.ms), 99).toFixed(1)}`);
for (const k of ['payment', 'customer', 'list', 'retrieve']) {
  const xs = byKind(k), good = xs.filter((r) => r.status < 300);
  console.log(`  ${k.padEnd(9)} ${String(xs.length).padStart(6)} requests · p50 ${pct(good.map((r) => r.ms), 50).toFixed(1)} ms · p99 ${pct(good.map((r) => r.ms), 99).toFixed(1)} ms`);
}
const codes: Record<string, number> = {};
for (const r of results) codes[r.status] = (codes[r.status] ?? 0) + 1;
console.log(`Status codes: ${JSON.stringify(codes)}`);
const reasons: Record<string, number> = {};
for (const r of results) if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
if (Object.keys(reasons).length) console.log(`429 by limiter tier: ${JSON.stringify(reasons)}`);
const sys = await (await fetch(`${base}/v1/tessera/system?window=60`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
console.log(`Server view: peak ${sys.traffic?.peak_requests_per_second} req/s, p99 ${sys.traffic?.latency_ms?.p99} ms, event-loop delay ${sys.load_shedding?.event_loop_delay_ms} ms, shed so far ${sys.load_shedding?.counters?.fleet_shed + sys.load_shedding?.counters?.worker_shed}`);
