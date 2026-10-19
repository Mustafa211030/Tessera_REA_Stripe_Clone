import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { one, query, transaction } from '../db/index.ts';
import { getAccount, sessionUser } from '../domain/accounts.ts';
import { audit, can, isRole, ROLES, type Role } from '../domain/team.ts';

/** Dashboard changes to these resources are recorded in the security history. */
const AUDITED = new Set(['webhook_endpoints', 'payouts', 'transfers', 'refunds', 'accounts', 'account', 'capital', 'treasury', 'issuing', 'topups', 'application_fees', 'radar']);
import { stripInternal } from '../domain/paymentIntents.ts';
import { expand } from '../domain/store.ts';
import { ApiError, CommitThenFail } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Ctx } from './context.ts';
import { acquire, type TrafficClass } from './ratelimit.ts';
import { record } from './metrics.ts';
import { logRequest, lookupKey } from './hotpath.ts';
import { waitForGate } from '../domain/shards.ts';
import { transformForVersion, validateVersion } from './versioning.ts';

export type RouteOpts = {
  /** Resource name for restricted-key permissions, e.g. 'payment_intents'. */
  resource: string;
  /** Critical routes (creating/confirming payments) are shed last under load. */
  critical?: boolean;
  /** Allows publishable keys; return true when the request is permitted for them. */
  publishable?: (req: FastifyRequest, params: any) => Promise<boolean> | boolean;
  /** Skip the generic expand/version pipeline (custom shapes). */
  raw?: boolean;
};

type Handler = (ctx: Ctx, params: any, req: FastifyRequest) => Promise<any>;

const REDACT = /("?(?:number|cvc)"?\s*:\s*)"([^"]*)"/g;

function redact(body: any) {
  if (!body || typeof body !== 'object') return body;
  const s = JSON.stringify(body).replace(REDACT, (_m, k, v) => `${k}"${k.includes('cvc') ? '***' : '************' + String(v).slice(-4)}"`);
  return JSON.parse(s);
}

function baseUrl(req: FastifyRequest) {
  return `${req.protocol}://${req.headers.host ?? `${config.host}:${config.port}`}`;
}

async function authenticate(req: FastifyRequest, opts: RouteOpts, params: any): Promise<Omit<Ctx, 'apiVersion' | 'requestId' | 'baseUrl'>> {
  const h = req.headers.authorization;
  let token: string | undefined;
  if (h?.startsWith('Bearer ')) token = h.slice(7).trim();
  else if (h?.startsWith('Basic ')) token = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':')[0];

  if (!token) {
    // Dashboard session: cookie + CSRF header (double-submit), same origin only.
    const sid = /(?:^|;\s*)tsr_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = await sessionUser(sid);
    if (user) {
      if (req.method !== 'GET' && req.headers['x-tessera-csrf'] !== user.csrf) {
        throw new ApiError(403, 'permission_error', 'Missing or invalid CSRF token for dashboard request.');
      }
      if (!can(user.role, opts.resource, req.method)) {
        const label = ROLES[(isRole(user.role) ? user.role : 'view_only') as Role].label;
        throw new ApiError(403, 'permission_error', `Your role (${label}) can't make changes to ${opts.resource.replace(/_/g, ' ')}. Ask an owner or administrator.`, { code: 'role_not_permitted' });
      }
      return { accountId: user.account_id, livemode: false, keyType: 'dashboard', keyId: `dash_${user.user_id}`, userEmail: user.email } as any;
    }
    throw new ApiError(401, 'authentication_error', 'You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. \'Authorization: Bearer YOUR_SECRET_KEY\').', { headers: { 'WWW-Authenticate': 'Basic realm="Tessera"' } });
  }
  if (/^(sk|pk|rk)_live_/.test(token)) throw new ApiError(401, 'authentication_error', 'Live mode keys do not exist on this local test-mode platform.');
  const key = await lookupKey(token);
  if (!key) throw new ApiError(401, 'authentication_error', `Invalid API Key provided: ${token.slice(0, 8)}${'*'.repeat(Math.max(0, token.length - 12))}${token.slice(-4)}`, { code: 'api_key_invalid' });
  if (key.type === 'publishable') {
    if (!opts.publishable || !(await opts.publishable(req, params))) {
      throw new ApiError(401, 'invalid_request_error', 'This API call cannot be made with a publishable API key. Please use a secret API key.', { code: 'secret_key_required' });
    }
  }
  if (key.type === 'restricted') {
    const level = key.permissions?.[opts.resource] ?? 'none';
    const needWrite = req.method !== 'GET';
    if (level === 'none' || (needWrite && level !== 'write')) {
      throw new ApiError(403, 'permission_error', `The provided key '${token.slice(0, 12)}...' does not have the required permissions for this endpoint. Having the '${needWrite ? 'write' : 'read'}' permission on '${opts.resource}' would allow this request to continue.`);
    }
  }
  return { accountId: key.account_id, livemode: false, keyType: key.type, keyId: key.id, permissions: key.permissions ?? undefined };
}

/**
 * Connect: a platform's key acts on one of its connected accounts when the request carries
 * `Stripe-Account: acct_...`. Every object, event and balance then belongs to that account.
 */
async function actAs<T extends { accountId: string; platformAccountId?: string }>(req: FastifyRequest, auth: T): Promise<T> {
  const target = req.headers['stripe-account'];
  if (!target || target === auth.accountId) return auth;
  const row = await one<{ platform: string | null }>('SELECT platform FROM accounts WHERE id = $1', [String(target)]);
  if (!row || row.platform !== auth.accountId) {
    throw new ApiError(403, 'permission_error', `The provided key does not have access to account '${target}' (or that account does not exist). Application access may have been revoked.`, { code: 'account_invalid' });
  }
  return { ...auth, accountId: String(target), platformAccountId: auth.accountId };
}

function sendError(reply: FastifyReply, err: ApiError, requestId: string) {
  for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
  if (err.status === 409 || err.status >= 500 || err.code === 'lock_timeout') reply.header('Stripe-Should-Retry', 'true');
  const body = err.toJSON() as any;
  body.error.request_log_url = `/logs/${requestId}`;
  return reply.code(err.status).send(body);
}

function hashParams(p: any) {
  return createHash('sha256').update(JSON.stringify(p ?? {}, Object.keys(flatten(p ?? {})).sort())).digest('hex');
}
function flatten(o: any, pre = '', out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    out[k] = 1;
    if (v && typeof v === 'object') flatten(v, `${pre}${k}.`, out);
  }
  return out;
}

export function apiRoute(app: FastifyInstance, method: 'GET' | 'POST' | 'DELETE', url: string, opts: RouteOpts, handler: Handler) {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const started = Date.now();
      const requestId = `req_${newId('', 14).slice(1)}`;
      reply.header('Request-Id', requestId);
      const params = { ...(req.query as any), ...((req.body as any) ?? {}), ...(req.params as any) };
      let accountId: string | null = null;
      let status = 200;
      let responseBody: any;
      let idemKey: string | undefined;
      let version = config.latestApiVersion;
      let release: () => void = () => {};
      try {
        let auth: Awaited<ReturnType<typeof authenticate>> = await authenticate(req, opts, params);
        accountId = auth.accountId; // request logs belong to the caller (the platform)
        // Priority class for load shedding: critical payment calls > other writes > reads > dashboard reads.
        const cls: TrafficClass = opts.critical ? 'critical' : method === 'GET' ? (auth.keyType === 'dashboard' ? 'low' : 'get') : 'post';
        release = acquire(auth.keyId ?? auth.accountId, auth.accountId, cls);
        auth = await actAs(req, auth);
        // An account whose data is switching shards waits here (a second or two at most).
        await waitForGate(auth.accountId);
        const account = await getAccount(auth.accountId);
        const hv = req.headers['stripe-version'] ?? req.headers['tessera-version'];
        version = hv ? validateVersion(String(hv)) : (account?._api_version ?? config.latestApiVersion);
        reply.header('Stripe-Version', version);
        if (auth.platformAccountId) reply.header('Stripe-Account', auth.accountId);
        idemKey = method === 'POST' ? (req.headers['idempotency-key'] as string | undefined) : undefined;
        if (idemKey && idemKey.length > 255) throw new ApiError(400, 'invalid_request_error', 'Idempotency keys can be at most 255 characters.', { code: 'idempotency_key_too_long' });
        const ctx: Ctx = { ...auth, apiVersion: version, requestId, idempotencyKey: idemKey, baseUrl: baseUrl(req) };

        // ---- idempotency ----
        const reqHash = hashParams({ ...params, __path: url });
        if (idemKey) {
          const existing = await one<any>('SELECT * FROM idempotency_keys WHERE account_id = $1 AND key = $2', [ctx.accountId, idemKey]);
          if (existing) {
            if (existing.request_hash !== reqHash) {
              throw new ApiError(400, 'idempotency_error', `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idemKey}' if you meant to execute a different request.`);
            }
            if (existing.status === 'in_progress') {
              throw new ApiError(409, 'idempotency_error', 'There is currently another in-progress request using this Idempotent Key (that probably means you submitted twice, and the other request is still going through): ' + idemKey + '. Please try again later.', { code: 'idempotency_key_in_use' });
            }
            reply.header('Idempotent-Replayed', 'true');
            status = existing.response_code;
            responseBody = JSON.parse(existing.response_body);
            return reply.code(status).send(responseBody);
          }
          await query('INSERT INTO idempotency_keys (account_id, key, request_hash, method, path, status, created) VALUES ($1,$2,$3,$4,$5,$6,$7)', [ctx.accountId, idemKey, reqHash, method, req.url, 'in_progress', nowSeconds()]);
        }

        const saveIdem = async (code: number, body: any) => {
          if (idemKey) await query("UPDATE idempotency_keys SET status = 'complete', response_code = $3, response_body = $4 WHERE account_id = $1 AND key = $2", [ctx.accountId, idemKey, code, JSON.stringify(body)]);
        };

        try {
          let result = await transaction(() => handler(ctx, params, req));
          if (result instanceof CommitThenFail) throw result.error;
          if (!opts.raw) {
            const exp = Array.isArray(params.expand) ? params.expand : params.expand ? Object.values(params.expand) : undefined;
            result = await expand(ctx.accountId, structuredClone(result), exp as string[] | undefined);
            result = await transformForVersion(stripInternal(result), version);
          }
          status = 200;
          if (auth.keyType === 'dashboard' && method !== 'GET' && AUDITED.has(opts.resource)) {
            await audit(auth.platformAccountId ?? auth.accountId, { id: auth.keyId?.slice(5), email: (auth as any).userEmail }, 'dashboard.change', `${method} ${req.url.split('?')[0]}`, { resource: opts.resource, ...(auth.platformAccountId ? { connected_account: auth.accountId } : {}) }, req.ip).catch(() => {});
          }
          responseBody = Buffer.isBuffer(result) ? { object: 'binary', size: result.length } : result;
          if (!Buffer.isBuffer(result)) await saveIdem(200, result);
          return reply.code(200).send(result);
        } catch (e) {
          if (idemKey) {
            const err = e instanceof ApiError ? e : new ApiError(500, 'api_error', 'An unknown error occurred');
            // Errors raised before execution started are not saved, so the client may retry.
            if (err.status === 402 || err.status >= 500) await saveIdem(err.status, { ...err.toJSON(), error: { ...(err.toJSON() as any).error, request_log_url: `/logs/${requestId}` } });
            else await query('DELETE FROM idempotency_keys WHERE account_id = $1 AND key = $2', [ctx.accountId, idemKey]);
          }
          throw e;
        }
      } catch (e: any) {
        const err = e instanceof ApiError ? e : new ApiError(500, 'api_error', 'An unknown error occurred. The request may or may not have been processed; retry with the same Idempotency-Key.');
        if (!(e instanceof ApiError)) { req.log.error(e); if (process.env.TESSERA_DEBUG) console.error(e); }
        status = err.status;
        responseBody = err.toJSON();
        return sendError(reply, err, requestId);
      } finally {
        release();
        const ms = Date.now() - started;
        reply.header('Tessera-Server-Duration-Micros', String(ms * 1000));
        record(status, ms, status === 429);
        if (accountId) {
          logRequest([requestId, accountId, method, req.url.split('?')[0], status, ms, idemKey ?? null, version, req.headers.authorization ? 'api' : 'dashboard', nowSeconds(), JSON.stringify(redact(params)), JSON.stringify(responseBody ?? null)]);
        }
      }
    },
  });
}
