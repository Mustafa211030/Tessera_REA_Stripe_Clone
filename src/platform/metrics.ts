/**
 * Request metrics kept in memory: one bucket per second for the last two minutes
 * (count, errors, shed requests, a sample of latencies). Enough for the System health page
 * and the load test; nothing is persisted.
 */
type Bucket = { sec: number; count: number; errors: number; shed: number; lat: number[] };
const WINDOW = 120;
const buckets: Bucket[] = [];
let total = 0;

function bucket(sec: number) {
  let b = buckets.at(-1);
  if (!b || b.sec !== sec) {
    b = { sec, count: 0, errors: 0, shed: 0, lat: [] };
    buckets.push(b);
    while (buckets.length && buckets[0]!.sec <= sec - WINDOW) buckets.shift();
  }
  return b;
}

export function record(status: number, ms: number, shed: boolean) {
  const b = bucket(Math.floor(Date.now() / 1000));
  b.count++;
  total++;
  if (status >= 500) b.errors++;
  if (shed) b.shed++;
  // Reservoir of up to 500 latencies per second keeps percentiles honest under load.
  if (b.lat.length < 500) b.lat.push(ms);
  else b.lat[Math.floor(Math.random() * b.count) % 500] = ms;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export function snapshot(seconds = 60) {
  const now = Math.floor(Date.now() / 1000);
  const series = [];
  const lat: number[] = [];
  let count = 0, errors = 0, shed = 0;
  for (let s = now - seconds + 1; s <= now; s++) {
    const b = buckets.find((x) => x.sec === s);
    series.push({ t: s, requests: b?.count ?? 0, shed: b?.shed ?? 0, errors: b?.errors ?? 0 });
    if (b && s < now) { count += b.count; errors += b.errors; shed += b.shed; lat.push(...b.lat); }
  }
  const done = seconds - 1;
  return {
    window_seconds: seconds, requests_total: total, requests_per_second: Math.round((count / done) * 10) / 10,
    peak_requests_per_second: Math.max(0, ...series.slice(0, -1).map((x) => x.requests)),
    latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) }, errors, shed, series,
  };
}
