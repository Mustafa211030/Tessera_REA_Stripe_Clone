import { one, query } from '../db/index.ts';
import { invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { insertObject, saveObject, getObject } from './store.ts';

/**
 * Fraud rules engine in the style of Radar rules:
 *   block if :risk_level: = 'highest'
 *   review if :amount_in_usd: > 1000 and :card_country: != 'US'
 *   block if :card_fingerprint: in @blocked_cards
 *   review if ::order_type:: = 'gift'                 (PaymentIntent metadata)
 *   block if ::customer:tier:: = 'banned'             (customer metadata)
 *   review if :email: like '%@example.org'            (% matches any run of characters)
 * Evaluation order: allow rules, then block, then review (first match wins in each group).
 */
export type RiskAttrs = Record<string, string | number | boolean | null>;

// ---------- expression parser ----------
type Tok = { t: 'attr' | 'num' | 'str' | 'list' | 'op' | 'kw' | 'lp' | 'rp'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:::([A-Za-z0-9_.\-]+)(?::([A-Za-z0-9_.\-]+))?::|:([a-z_0-9]+):|(-?\d+(?:\.\d+)?)|'([^']*)'|@([a-zA-Z_0-9]+)|(>=|<=|!=|=|>|<)|\b(and|or|not|in|like|IN|AND|OR|NOT|LIKE)\b|(\()|(\)))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw invalid(`Could not parse rule near: "${src.slice(i, i + 20)}"`, 'predicate');
    i = re.lastIndex;
    if (m[1] && m[2]) {
      if (m[1] !== 'customer' && m[1] !== 'payment_intent') throw invalid(`Unknown metadata scope "${m[1]}": use ::key:: for payment metadata or ::customer:key:: for customer metadata.`, 'predicate');
      out.push({ t: 'attr', v: m[1] === 'customer' ? `customer_metadata:${m[2]}` : `metadata:${m[2]}` });
    } else if (m[1]) out.push({ t: 'attr', v: `metadata:${m[1]}` });
    else if (m[3]) out.push({ t: 'attr', v: m[3] });
    else if (m[4]) out.push({ t: 'num', v: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'str', v: m[5] });
    else if (m[6]) out.push({ t: 'list', v: m[6] });
    else if (m[7]) out.push({ t: 'op', v: m[7] });
    else if (m[8]) out.push({ t: 'kw', v: m[8].toLowerCase() });
    else if (m[9]) out.push({ t: 'lp', v: '(' });
    else if (m[10]) out.push({ t: 'rp', v: ')' });
  }
  return out;
}

type Node =
  | { k: 'and' | 'or'; a: Node; b: Node }
  | { k: 'not'; a: Node }
  | { k: 'cmp'; attr: string; op: string; value: string | number }
  | { k: 'in'; attr: string; list: string; negate: boolean };

const label = (attr: string) => attr.startsWith('metadata:') ? `::${attr.slice(9)}::` : attr.startsWith('customer_metadata:') ? `::customer:${attr.slice(18)}::` : `:${attr}:`;

export function parsePredicate(src: string): Node {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  function expr(): Node {
    let a = term();
    while (peek()?.t === 'kw' && peek()!.v === 'or') { next(); a = { k: 'or', a, b: term() }; }
    return a;
  }
  function term(): Node {
    let a = factor();
    while (peek()?.t === 'kw' && peek()!.v === 'and') { next(); a = { k: 'and', a, b: factor() }; }
    return a;
  }
  function factor(): Node {
    const t = next();
    if (!t) throw invalid('Rule predicate ended unexpectedly.', 'predicate');
    if (t.t === 'kw' && t.v === 'not') return { k: 'not', a: factor() };
    if (t.t === 'lp') { const n = expr(); if (next()?.t !== 'rp') throw invalid('Missing closing parenthesis.', 'predicate'); return n; }
    if (t.t !== 'attr') throw invalid(`Expected an attribute like :risk_score: or ::metadata_key::, got "${t.v}".`, 'predicate');
    let negate = false;
    if (peek()?.t === 'kw' && peek()!.v === 'not') { next(); negate = true; }
    const op = next();
    if (op?.t === 'kw' && op.v === 'in') {
      const l = next();
      if (l?.t !== 'list') throw invalid('Expected a list like @blocked_cards after "in".', 'predicate');
      return { k: 'in', attr: t.v, list: l.v, negate };
    }
    if (op?.t === 'kw' && op.v === 'like') {
      const v = next();
      if (v?.t !== 'str') throw invalid('Expected a quoted pattern after "like", for example \'%@example.com\'.', 'predicate');
      return { k: 'cmp', attr: t.v, op: negate ? 'not like' : 'like', value: v.v };
    }
    if (op?.t !== 'op') throw invalid(`Expected a comparison after ${label(t.v)}.`, 'predicate');
    const v = next();
    if (!v || (v.t !== 'num' && v.t !== 'str')) throw invalid('Expected a number or a quoted string.', 'predicate');
    return { k: 'cmp', attr: t.v, op: op.v, value: v.t === 'num' ? Number(v.v) : v.v };
  }
  const n = expr();
  if (i < toks.length) throw invalid(`Unexpected "${toks[i]!.v}" in rule.`, 'predicate');
  return n;
}

function evaluate(n: Node, attrs: RiskAttrs, lists: Record<string, Set<string>>): boolean {
  switch (n.k) {
    case 'and': return evaluate(n.a, attrs, lists) && evaluate(n.b, attrs, lists);
    case 'or': return evaluate(n.a, attrs, lists) || evaluate(n.b, attrs, lists);
    case 'not': return !evaluate(n.a, attrs, lists);
    case 'in': {
      const v = attrs[n.attr];
      const hit = v !== null && v !== undefined && (lists[n.list]?.has(String(v).toLowerCase()) ?? false);
      return n.negate ? !hit : hit;
    }
    case 'cmp': {
      const v = attrs[n.attr];
      if (n.op === 'like' || n.op === 'not like') {
        const re = new RegExp(`^${String(n.value).toLowerCase().split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        const hit = v !== undefined && v !== null && re.test(String(v).toLowerCase());
        return n.op === 'like' ? hit : !hit;
      }
      // Missing metadata compares like an empty string, so `::key:: != 'x'` matches when unset.
      if ((v === undefined || v === null) && n.attr.includes('metadata:') && typeof n.value === 'string') return n.op === '=' ? n.value === '' : n.op === '!=' ? n.value !== '' : false;
      if (v === undefined || v === null) return false;
      const a = typeof n.value === 'number' ? Number(v) : String(v).toLowerCase();
      const b = typeof n.value === 'number' ? n.value : n.value.toLowerCase();
      switch (n.op) {
        case '=': return a === b;
        case '!=': return a !== b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '<': return a < b;
        case '<=': return a <= b;
      }
      return false;
    }
  }
}

// ---------- risk scoring ----------
const USD_RATE: Record<string, number> = { usd: 1, eur: 1.08, gbp: 1.27, cad: 0.73, aud: 0.66, jpy: 0.0067, inr: 0.012, pkr: 0.0036 };
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'pyg', 'ugx', 'xaf', 'xof']);

export function amountInUsd(amount: number, currency: string) {
  const major = ZERO_DECIMAL.has(currency) ? amount : amount / 100;
  return Math.round(major * (USD_RATE[currency] ?? 1) * 100) / 100;
}

export async function buildAttributes(ctx: Ctx, pi: any, pmIn: any): Promise<RiskAttrs> {
  // In-person (card_present) payment methods carry the same card details under card_present.
  const pm = pmIn.card ? pmIn : { ...pmIn, card: { ...pmIn.card_present, checks: { cvc_check: null } } };
  const since = nowSeconds() - 3600;
  const attempts = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM objects WHERE account_id = $1 AND type = 'charge' AND created >= $2 AND data->'payment_method_details'->'card'->>'fingerprint' = $3",
    [ctx.accountId, since, pm.card.fingerprint],
  );
  const declines = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM objects WHERE account_id = $1 AND type = 'charge' AND created >= $2 AND data->>'status' = 'failed' AND data->'payment_method_details'->'card'->>'fingerprint' = $3",
    [ctx.accountId, nowSeconds() - 86400, pm.card.fingerprint],
  );
  const email: string | null = pm.billing_details?.email ?? pi.receipt_email ?? null;
  const meta: RiskAttrs = {};
  for (const [k, v] of Object.entries<any>(pi.metadata ?? {})) meta[`metadata:${k}`] = String(v);
  if (pi.customer) {
    const cus = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2 AND type = 'customer'", [ctx.accountId, pi.customer]);
    for (const [k, v] of Object.entries<any>(cus?.data.metadata ?? {})) meta[`customer_metadata:${k}`] = String(v);
  }
  return {
    ...meta,
    amount_in_usd: amountInUsd(pi.amount, pi.currency),
    currency: pi.currency,
    card_brand: pm.card.brand,
    card_country: pm.card.country,
    card_funding: pm.card.funding,
    card_fingerprint: pm.card.fingerprint,
    cvc_check: pm.card.checks.cvc_check,
    customer: pi.customer ?? null,
    email,
    email_domain: email ? email.split('@')[1] ?? null : null,
    attempts_per_card_1h: attempts?.n ?? 0,
    declines_per_card_1d: declines?.n ?? 0,
    is_3d_secure: pi._three_ds_status === 'succeeded',
  };
}

export function score(attrs: RiskAttrs, pm: any): number {
  let s = 8 + (pm._risk_hint ?? 0);
  if (attrs.cvc_check === 'fail') s += 25;
  if (Number(attrs.attempts_per_card_1h) >= 4) s += 20;
  if (Number(attrs.declines_per_card_1d) >= 3) s += 25;
  if (Number(attrs.amount_in_usd) > 5000) s += 12;
  if (attrs.card_funding === 'prepaid') s += 8;
  if (attrs.is_3d_secure) s -= 10;
  return Math.max(0, Math.min(99, s));
}

export const riskLevel = (s: number) => (s >= 75 ? 'highest' : s >= 65 ? 'elevated' : 'normal');

export type RadarDecision = { action: 'allow' | 'block' | 'review'; rule: { id: string; predicate: string } | null; risk_score: number; risk_level: string; attributes: RiskAttrs };

const DEFAULT_RULES = [{ id: 'rule_default_block_highest', action: 'block', predicate: ":risk_level: = 'highest'" }];

export async function decide(ctx: Ctx, pi: any, pm: any): Promise<RadarDecision> {
  const attrs = await buildAttributes(ctx, pi, pm);
  const risk_score = score(attrs, pm);
  const risk_level = riskLevel(risk_score);
  attrs.risk_score = risk_score;
  attrs.risk_level = risk_level;

  const custom = (await query<{ data: any }>(
    "SELECT data FROM objects WHERE account_id = $1 AND type = 'radar.rule' ORDER BY seq",
    [ctx.accountId],
  )).map((r) => r.data).filter((r) => r.enabled);
  const lists: Record<string, Set<string>> = {};
  for (const { data } of await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'radar.value_list'", [ctx.accountId])) {
    lists[data.alias] = new Set((data.list_items ?? []).map((x: string) => x.toLowerCase()));
  }
  const rules = [...custom, ...DEFAULT_RULES];
  for (const action of ['allow', 'block', 'review'] as const) {
    for (const r of rules.filter((x) => x.action === action)) {
      if (evaluate(parsePredicate(r.predicate), attrs, lists)) {
        return { action, rule: { id: r.id, predicate: r.predicate }, risk_score, risk_level, attributes: attrs };
      }
    }
  }
  return { action: 'allow', rule: null, risk_score, risk_level, attributes: attrs };
}

// ---------- rule & list management ----------
export async function createRule(ctx: Ctx, p: Params) {
  const action = str(p, 'action', { required: true })!;
  if (!['allow', 'block', 'review'].includes(action)) throw invalid('action must be allow, block or review', 'action');
  const predicate = str(p, 'predicate', { required: true })!;
  parsePredicate(predicate);
  const rule = { id: newId('rule', 16), object: 'radar.rule', action, predicate, enabled: p.enabled !== 'false', description: str(p, 'description') ?? null, created: nowSeconds(), livemode: false };
  return insertObject(ctx.accountId, rule);
}

export async function updateRule(ctx: Ctx, id: string, p: Params) {
  const r = await getObject<any>(ctx.accountId, 'radar.rule', id, 'rule');
  if (p.predicate !== undefined) { parsePredicate(String(p.predicate)); r.predicate = String(p.predicate); }
  if (p.enabled !== undefined) r.enabled = p.enabled === true || p.enabled === 'true';
  if (p.action !== undefined) r.action = String(p.action);
  return saveObject(ctx.accountId, r);
}

export async function createValueList(ctx: Ctx, p: Params) {
  const alias = str(p, 'alias', { required: true })!;
  if (!/^[a-zA-Z_0-9]+$/.test(alias)) throw invalid('alias may contain only letters, digits and underscores', 'alias');
  const items = Array.isArray(p.list_items) ? p.list_items.map(String) : p.list_items ? Object.values(p.list_items).map(String) : [];
  const vl = { id: newId('rsl', 16), object: 'radar.value_list', alias, name: str(p, 'name') ?? alias, item_type: str(p, 'item_type') ?? 'string', list_items: items, created: nowSeconds(), livemode: false };
  return insertObject(ctx.accountId, vl);
}

export async function testRule(ctx: Ctx, p: Params) {
  const predicate = str(p, 'predicate', { required: true })!;
  const node = parsePredicate(predicate);
  const charges = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'charge' ORDER BY seq DESC LIMIT 200", [ctx.accountId]);
  let matched = 0;
  const sample: string[] = [];
  for (const { data: ch } of charges) {
    const attrs = ch._risk_attributes as RiskAttrs | undefined;
    if (attrs && evaluate(node, attrs, {})) { matched++; if (sample.length < 10) sample.push(ch.id); }
  }
  return { object: 'radar.rule_test', predicate, charges_evaluated: charges.length, matched, sample };
}
