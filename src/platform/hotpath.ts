import { query } from '../db/index.ts';
import { nowSeconds } from '../lib/ids.ts';

/**
 * Hot-path helpers for the request pipeline. Each request used to take the database lock three
 * extra times (key lookup, last-used stamp, request log); under load those waits dominated.
 *
 *  - API keys are cached for a few seconds and dropped whenever keys change.
 *  - "last used" is stamped at most once a minute per key.
 *  - Request logs are buffered and written in one multi-row insert (write coalescing); readers
 *    flush first, so the Logs page never misses a request.
 */
const keys = new Map<string, { key: any; at: number }>();
const KEY_TTL = 5000;

export async function lookupKey(token: string) {
  const now = Date.now();
  const c = keys.get(token);
  let key = c && now - c.at < KEY_TTL ? c.key : undefined;
  if (key === undefined) {
    key = (await query<any>('SELECT * FROM api_keys WHERE token = $1', [token]))[0] ?? null;
    keys.set(token, { key, at: now });
  }
  if (!key || (key.expires && Number(key.expires) <= nowSeconds())) return null;
  if (!key.last_used || Number(key.last_used) < nowSeconds() - 60) {
    key.last_used = nowSeconds();
    await query('UPDATE api_keys SET last_used = $1 WHERE id = $2', [key.last_used, key.id]);
  }
  return key;
}
export const invalidateKeys = () => keys.clear();

type LogRow = unknown[];
let buffer: LogRow[] = [];
let timer: NodeJS.Timeout | null = null;
const COLS = 12;

export function logRequest(row: LogRow) {
  buffer.push(row);
  if (buffer.length >= 200) void flushLogs();
  else if (!timer) { timer = setTimeout(() => void flushLogs(), 250); timer.unref(); }
}

export async function flushLogs() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  const values = rows.map((_, i) => `(${Array.from({ length: COLS }, (_, j) => `$${i * COLS + j + 1}`).join(',')})`).join(',');
  await query(`INSERT INTO request_logs (id, account_id, method, path, status, duration_ms, idempotency_key, api_version, source, created, request_body, response_body) VALUES ${values}`, rows.flat()).catch(() => {});
}
