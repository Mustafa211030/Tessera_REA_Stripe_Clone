import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { setConfig } from '../src/config.ts';
import { createAccount } from '../src/domain/accounts.ts';
import { resetLimits } from '../src/platform/ratelimit.ts';

export type Env = { app: FastifyInstance; base: string; sk: string; pk: string; close: () => Promise<void> };

export async function start(): Promise<Env> {
  setConfig({ rateLimitPerSecond: 1000, settlementDelaySeconds: 0, webhookRetrySchedule: [1, 1] });
  resetLimits();
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as any;
  const acct = await createAccount(`t${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`, 'password123', 'Test Shop');
  return { app, base: `http://127.0.0.1:${addr.port}`, sk: acct.secretKey, pk: acct.publishableKey, close: () => app.close() };
}

export function form(obj: Record<string, any>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? parts.push(form(x, `${key}[${i}]`)) : parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(x)}`)));
    else if (v && typeof v === 'object') parts.push(form(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

export async function api(env: Env, method: string, path: string, body?: Record<string, any>, headers: Record<string, string> = {}, key = env.sk) {
  if (method === 'GET' && body) {
    path += (path.includes('?') ? '&' : '?') + form(body);
    body = undefined;
  }
  const res = await fetch(env.base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: body ? form(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}
