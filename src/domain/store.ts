import { one, query } from '../db/index.ts';
import { invalid, notFound } from '../lib/errors.ts';
import { nowSeconds } from '../lib/ids.ts';
import type { Params } from '../lib/params.ts';

/** Generic document store helpers for API objects. */
export type ApiObject = { id: string; object: string; created: number; livemode: boolean; [k: string]: any };

/**
 * Shard routing (the directory is the source of truth; this process caches what it has read).
 * A new account is placed by tessera_shard() on its first write; a shard move drops the entry.
 */
const shardCache = new Map<string, number>();
export const forgetShard = (accountId: string) => shardCache.delete(accountId);
export async function shardFor(accountId: string) {
  const hit = shardCache.get(accountId);
  if (hit !== undefined) return hit;
  const row = await one<{ shard: number }>('SELECT shard FROM shard_directory WHERE account_id = $1', [accountId]);
  if (row) { shardCache.set(accountId, row.shard); return row.shard; }
  return (await one<{ s: number }>('SELECT tessera_shard($1) AS s', [accountId]))!.s;
}

/** Short-lived read cache for hot lookups (webhook endpoints), dropped whenever they change. */
const readCache = new Map<string, { at: number; value: unknown }>();
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const c = readCache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.value as T;
  const value = await load();
  readCache.set(key, { at: Date.now(), value });
  return value;
}
export const invalidateCache = (prefix = '') => { for (const k of readCache.keys()) if (k.startsWith(prefix)) readCache.delete(k); };
const touched = (type: string) => { if (type === 'webhook_endpoint') invalidateCache('webhooks:'); };

export async function insertObject<T extends ApiObject>(accountId: string, obj: T): Promise<T> {
  touched(obj.object);
  await query('INSERT INTO objects (id, account_id, type, created, data, shard) VALUES ($1,$2,$3,$4,$5,$6)', [
    obj.id,
    accountId,
    obj.object,
    obj.created ?? nowSeconds(),
    JSON.stringify(obj),
    await shardFor(accountId),
  ]);
  return obj;
}

export async function saveObject<T extends ApiObject>(accountId: string, obj: T): Promise<T> {
  touched(obj.object);
  await query('UPDATE objects SET data = $1 WHERE shard = $4 AND id = $2 AND account_id = $3', [JSON.stringify(obj), obj.id, accountId, await shardFor(accountId)]);
  return obj;
}

export async function findObject<T = ApiObject>(accountId: string, type: string, id: string): Promise<T | undefined> {
  // Routed to the account's shard (the partition is pruned, like a proxy picking one shard).
  const row = await one<{ data: T }>('SELECT data FROM objects WHERE shard = $4 AND id = $1 AND account_id = $2 AND type = $3', [id, accountId, type, await shardFor(accountId)]);
  return row?.data;
}

export async function getObject<T = ApiObject>(accountId: string, type: string, id: string, label = type, param = 'id'): Promise<T> {
  const o = await findObject<T>(accountId, type, id);
  if (!o) throw notFound(label, id, param);
  return o;
}

/** Find any object by id regardless of type (used by expand). */
export async function findAny(accountId: string, id: string): Promise<ApiObject | undefined> {
  const row = await one<{ data: ApiObject }>('SELECT data FROM objects WHERE shard = $3 AND id = $1 AND account_id = $2', [id, accountId, await shardFor(accountId)]);
  return row?.data;
}

export type ListFilter = { field: string; value: string | number | boolean };

/**
 * Cursor pagination with Stripe semantics: newest first, limit 1..100,
 * starting_after / ending_before cursors, has_more flag, created[gt|gte|lt|lte].
 */
export async function listObjects(
  accountId: string,
  type: string,
  url: string,
  p: Params,
  filters: ListFilter[] = [],
): Promise<{ object: 'list'; data: ApiObject[]; has_more: boolean; url: string }> {
  const limit = p.limit === undefined ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('This value must be between 1 and 100.', 'limit');
  const where: string[] = ['account_id = $1', 'type = $2', 'shard = $3'];
  const args: unknown[] = [accountId, type, await shardFor(accountId)];
  for (const f of filters) {
    args.push(String(f.value));
    where.push(`data->>'${f.field.replace(/[^a-z_.]/g, '')}' = $${args.length}`);
  }
  if (p.created !== undefined) {
    const c = p.created;
    const ops: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
    if (typeof c === 'object') {
      for (const [k, v] of Object.entries(c)) {
        if (!ops[k]) throw invalid(`Invalid created filter: ${k}`, 'created');
        args.push(Number(v));
        where.push(`created ${ops[k]} $${args.length}`);
      }
    } else {
      args.push(Number(c));
      where.push(`created = $${args.length}`);
    }
  }
  let order = 'DESC';
  const cursorId = p.starting_after ?? p.ending_before;
  if (cursorId) {
    const cur = await one<{ seq: number }>('SELECT seq FROM objects WHERE id = $1 AND account_id = $2', [cursorId, accountId]);
    if (!cur) throw notFound('object', String(cursorId), p.starting_after ? 'starting_after' : 'ending_before');
    args.push(cur.seq);
    if (p.starting_after) where.push(`seq < $${args.length}`);
    else {
      where.push(`seq > $${args.length}`);
      order = 'ASC';
    }
  }
  args.push(limit + 1);
  const rows = await query<{ data: ApiObject }>(
    `SELECT data FROM objects WHERE ${where.join(' AND ')} ORDER BY seq ${order} LIMIT $${args.length}`,
    args,
  );
  const has_more = rows.length > limit;
  let data = rows.slice(0, limit).map((r) => r.data);
  if (order === 'ASC') data = data.reverse();
  return { object: 'list', data, has_more, url };
}

/** Stripe-style `expand[]` support, including dotted paths and `data.` prefixes for lists. */
export async function expand(accountId: string, obj: any, paths: string[] | undefined): Promise<any> {
  if (!paths?.length || !obj) return obj;
  for (const path of paths) {
    if (obj.object === 'list' && path.startsWith('data.')) {
      const rest = path.slice(5);
      obj.data = await Promise.all(obj.data.map((d: any) => expand(accountId, d, [rest])));
      continue;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) obj[i] = await expand(accountId, obj[i], [path]);
      continue;
    }
    const [head, ...tail] = path.split('.');
    if (!head || !(head in obj)) throw invalid(`This property cannot be expanded (${path}).`, 'expand');
    const v = obj[head];
    if (typeof v === 'string') {
      const found = await findAny(accountId, v);
      if (found) obj[head] = found;
    }
    if (Array.isArray(obj[head]) && tail.length) {
      obj[head] = await Promise.all(obj[head].map((x: any) => expand(accountId, x, [tail.join('.')])));
      continue;
    }
    if (tail.length && obj[head] && typeof obj[head] === 'object') {
      obj[head] = await expand(accountId, obj[head], [tail.join('.')]);
    }
  }
  return obj;
}
