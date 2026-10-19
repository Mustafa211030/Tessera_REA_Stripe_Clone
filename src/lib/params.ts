import { invalid, missing } from './errors.ts';

/** Helpers that read form-encoded params (everything arrives as strings) with Stripe-like validation errors. */
export type Params = Record<string, any>;

export function str(p: Params, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw missing(key);
    return undefined;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw invalid(`Invalid string: ${key}`, key);
  const s = String(v);
  if (opts.max && s.length > opts.max) throw invalid(`${key} must be at most ${opts.max} characters.`, key);
  return s;
}

export function int(p: Params, key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw missing(key);
    return undefined;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw invalid(`Invalid integer: ${v}`, key);
  if (opts.min !== undefined && n < opts.min) throw invalid(`This value must be greater than or equal to ${opts.min}.`, key);
  if (opts.max !== undefined && n > opts.max) throw invalid(`This value must be less than or equal to ${opts.max}.`, key);
  return n;
}

export function bool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === '') return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw invalid(`Invalid boolean: ${v}`, key);
}

export function oneOf<T extends string>(p: Params, key: string, values: readonly T[], def?: T): T | undefined {
  const v = str(p, key);
  if (v === undefined) return def;
  if (!values.includes(v as T)) throw invalid(`Invalid ${key}: must be one of ${values.join(', ')}`, key);
  return v as T;
}

export function currency(p: Params, key = 'currency', required = true): string | undefined {
  const c = str(p, key, { required });
  if (c === undefined) return undefined;
  if (!/^[a-zA-Z]{3}$/.test(c)) throw invalid(`Invalid currency: ${c}`, key);
  return c.toLowerCase();
}

/** metadata[key]=value, max 50 keys, empty string unsets a key (Stripe semantics). */
export function metadata(p: Params, existing: Record<string, string> = {}): Record<string, string> {
  const m = p.metadata;
  if (m === undefined) return existing;
  if (m === '') return {};
  if (typeof m !== 'object') throw invalid('Invalid metadata', 'metadata');
  const out = { ...existing };
  for (const [k, v] of Object.entries(m)) {
    if (k.length > 40) throw invalid('Metadata keys must be at most 40 characters.', `metadata[${k}]`);
    if (v === '' || v === null) delete out[k];
    else out[k] = String(v).slice(0, 500);
  }
  if (Object.keys(out).length > 50) throw invalid('Metadata can have at most 50 keys.', 'metadata');
  return out;
}

export function arr(p: Params, key: string): any[] | undefined {
  const v = p[key];
  if (v === undefined || v === '') return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [v];
}
