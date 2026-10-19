import { query } from '../db/index.ts';
import { invalid } from '../lib/errors.ts';
import type { Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';

/**
 * Search query language for /v1/{resource}/search:
 *
 *   email:"jenny@example.com"            exact match (case-insensitive for text)
 *   name~"jen"                           substring (at least 3 characters)
 *   amount>1000  created>=1700000000     numeric comparison (>, <, >=, <=)
 *   metadata["order_id"]:"6735"          metadata
 *   -status:"canceled"                   negation
 *   currency:"usd" AND amount>500        AND or OR (not both in one query)
 *   customer:null                        field is empty
 *
 * Results are newest first; `page` continues from a previous result's next_page.
 */

type Kind = 'string' | 'number' | 'boolean' | 'token';
const F = (path: string, kind: Kind = 'string') => ({ path, kind });

export const FIELDS: Record<string, Record<string, { path: string; kind: Kind }>> = {
  charge: {
    amount: F('amount', 'number'), 'billing_details.address.postal_code': F('billing_details.address.postal_code'), 'billing_details.email': F('billing_details.email'), 'billing_details.name': F('billing_details.name'),
    created: F('created', 'number'), currency: F('currency', 'token'), customer: F('customer', 'token'), disputed: F('disputed', 'boolean'),
    'payment_method_details.card.brand': F('payment_method_details.card.brand', 'token'), 'payment_method_details.card.exp_month': F('payment_method_details.card.exp_month', 'number'),
    'payment_method_details.card.exp_year': F('payment_method_details.card.exp_year', 'number'), 'payment_method_details.card.fingerprint': F('payment_method_details.card.fingerprint', 'token'),
    'payment_method_details.card.last4': F('payment_method_details.card.last4', 'token'), payment_intent: F('payment_intent', 'token'), refunded: F('refunded', 'boolean'), status: F('status', 'token'),
  },
  customer: { created: F('created', 'number'), email: F('email'), name: F('name'), phone: F('phone') },
  invoice: {
    created: F('created', 'number'), currency: F('currency', 'token'), customer: F('customer', 'token'), number: F('number', 'token'), receipt_number: F('receipt_number', 'token'),
    status: F('status', 'token'), subscription: F('subscription', 'token'), total: F('total', 'number'), amount_due: F('amount_due', 'number'), due_date: F('due_date', 'number'),
  },
  payment_intent: { amount: F('amount', 'number'), created: F('created', 'number'), currency: F('currency', 'token'), customer: F('customer', 'token'), status: F('status', 'token'), description: F('description') },
  price: { active: F('active', 'boolean'), created: F('created', 'number'), currency: F('currency', 'token'), lookup_key: F('lookup_key', 'token'), product: F('product', 'token'), type: F('type', 'token'), unit_amount: F('unit_amount', 'number') },
  product: { active: F('active', 'boolean'), created: F('created', 'number'), description: F('description'), name: F('name'), shippable: F('shippable', 'boolean'), url: F('url') },
  subscription: { canceled_at: F('canceled_at', 'number'), created: F('created', 'number'), customer: F('customer', 'token'), status: F('status', 'token'), current_period_end: F('current_period_end', 'number') },
};

type Clause = { negate: boolean; field: string; meta?: string; op: ':' | '~' | '>' | '<' | '>=' | '<='; value: string | number | boolean | null };
type Parsed = { clauses: Clause[]; join: 'and' | 'or' };

export function parseSearch(type: string, q: string): Parsed {
  const fields = FIELDS[type]!;
  const src = q.trim();
  if (!src) throw invalid('Missing required param: query.', 'query', 'parameter_missing');
  if (src.length > 10_000) throw invalid('Search queries can be at most 10,000 characters.', 'query');
  const re = /\s*(?:(AND|OR)\b|(-)?(metadata\[\s*"([^"]+)"\s*\]|metadata\[\s*'([^']+)'\s*\]|[a-z_][a-z0-9_.]*)\s*(>=|<=|:|~|>|<)\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|[^\s"']+))/iy;
  const clauses: Clause[] = [];
  const joins = new Set<string>();
  let i = 0;
  let expectClause = true;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw invalid(`Couldn't parse the query near "${src.slice(i, i + 25).trim()}". Clauses look like field:"value", field~"text" or field>123.`, 'query', 'search_query_invalid');
    i = re.lastIndex;
    if (m[1]) {
      if (expectClause) throw invalid(`Unexpected ${m[1].toUpperCase()} in the query.`, 'query', 'search_query_invalid');
      joins.add(m[1].toLowerCase());
      expectClause = true;
      continue;
    }
    if (!expectClause) joins.add('and'); // juxtaposed clauses mean AND
    expectClause = false;
    const meta = m[4] ?? m[5];
    const field = meta ? 'metadata' : m[3]!.toLowerCase();
    if (!meta && !fields[field]) {
      throw invalid(`Field '${field}' is not supported for ${type} search. Supported: ${[...Object.keys(fields), 'metadata["key"]'].join(', ')}.`, 'query', 'search_query_invalid');
    }
    const op = m[6] as Clause['op'];
    const quoted = m[8] ?? m[9];
    const rawValue = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : m[7]!;
    const kind = meta ? 'string' : fields[field]!.kind;
    let value: Clause['value'];
    if (quoted === undefined && rawValue.toLowerCase() === 'null') {
      if (op !== ':') throw invalid('null can only be used with ":".', 'query', 'search_query_invalid');
      value = null;
    } else if (kind === 'number') {
      if (!/^-?\d+$/.test(rawValue)) throw invalid(`'${field}' takes a whole number, like ${field}>1000.`, 'query', 'search_query_invalid');
      value = Number(rawValue);
    } else if (kind === 'boolean') {
      if (!/^(true|false)$/i.test(rawValue)) throw invalid(`'${field}' takes true or false.`, 'query', 'search_query_invalid');
      value = rawValue.toLowerCase() === 'true';
    } else {
      if (quoted === undefined && kind === 'string') throw invalid(`Put text values in double quotes, like ${field}:"${rawValue}".`, 'query', 'search_query_invalid');
      value = rawValue;
    }
    if (['>', '<', '>=', '<='].includes(op) && kind !== 'number') throw invalid(`'${field}' can't be compared with ${op}; use ":" or "~".`, 'query', 'search_query_invalid');
    if (op === '~') {
      if (kind === 'number' || kind === 'boolean') throw invalid(`'${field}' doesn't support substring search (~).`, 'query', 'search_query_invalid');
      if (String(value).length < 3) throw invalid('Substring searches (~) need at least 3 characters.', 'query', 'search_query_invalid');
    }
    clauses.push({ negate: !!m[2], field, meta, op, value });
  }
  if (expectClause) throw invalid('The query ends with AND or OR.', 'query', 'search_query_invalid');
  if (joins.size > 1) throw invalid("A query can't mix AND and OR.", 'query', 'search_query_invalid');
  return { clauses, join: joins.has('or') ? 'or' : 'and' };
}

const get = (o: any, path: string) => path.split('.').reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);

function matches(obj: any, c: Clause, type: string): boolean {
  const raw = c.meta !== undefined ? obj.metadata?.[c.meta] : get(obj, FIELDS[type]![c.field]!.path);
  let hit: boolean;
  if (c.value === null) hit = raw === null || raw === undefined || raw === '';
  else if (raw === null || raw === undefined) hit = false;
  else if (typeof c.value === 'number') {
    const v = Number(raw);
    hit = c.op === ':' ? v === c.value : c.op === '>' ? v > c.value : c.op === '<' ? v < c.value : c.op === '>=' ? v >= c.value : v <= c.value;
  } else if (typeof c.value === 'boolean') hit = !!raw === c.value;
  else {
    const a = String(typeof raw === 'object' ? raw.id ?? '' : raw).toLowerCase();
    const b = c.value.toLowerCase();
    hit = c.op === '~' ? a.includes(b) : a === b;
  }
  return c.negate ? !hit : hit;
}

export async function search(ctx: Ctx, type: string, url: string, p: Params) {
  const parsed = parseSearch(type, String(p.query ?? ''));
  const limit = p.limit === undefined ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('This value must be between 1 and 100.', 'limit');
  let offset = 0;
  if (p.page) {
    const decoded = Buffer.from(String(p.page), 'base64url').toString('utf8');
    const m = /^offset:(\d+)$/.exec(decoded);
    if (!m) throw invalid('Invalid page token.', 'page');
    offset = Number(m[1]);
  }
  const rows = await query<{ data: any }>('SELECT data FROM objects WHERE account_id = $1 AND type = $2 ORDER BY created DESC, seq DESC', [ctx.accountId, type]);
  const all = rows.map((r) => r.data).filter((o) => !o.deleted);
  const hits = all.filter((o) => (parsed.join === 'and' ? parsed.clauses.every((c) => matches(o, c, type)) : parsed.clauses.some((c) => matches(o, c, type))));
  const data = hits.slice(offset, offset + limit);
  const more = offset + limit < hits.length;
  // total_count is returned when requested with expand[]=total_count (handled here, not as an expansion).
  const exp = Array.isArray(p.expand) ? p.expand : p.expand ? Object.values(p.expand) : [];
  const wantTotal = exp.includes('total_count');
  if (wantTotal) p.expand = exp.filter((x: string) => x !== 'total_count');
  return {
    object: 'search_result', data, has_more: more, next_page: more ? Buffer.from(`offset:${offset + limit}`).toString('base64url') : null, url,
    ...(wantTotal ? { total_count: hits.length } : {}),
  };
}
