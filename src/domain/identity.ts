import { config } from '../config.ts';
import { one, query } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { bool, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/**
 * Identity verification sessions (simulated, test mode only).
 *
 * A session sends the person to a hosted page (`url`) where they enter their details and
 * "present" a document. Nothing is uploaded or checked: the page offers test outcomes, the
 * way test mode does, and the result arrives a few seconds later — `verified`, or back to
 * `requires_input` with a `last_error` they can retry from. Each attempt produces an
 * `identity.verification_report`. Verified details are returned only when you expand
 * `verified_outputs`, and `redact` erases them.
 */

const DOC_TYPES = ['driving_license', 'id_card', 'passport'] as const;

/** Test outcomes the hosted page offers, with the error each one produces. */
export const OUTCOMES: Record<string, { label: string; error?: { code: string; reason: string }; for: ('document' | 'id_number' | 'selfie')[] }> = {
  verified: { label: 'Verification succeeds', for: ['document', 'id_number'] },
  document_unverified_other: { label: 'Document can’t be verified', error: { code: 'document_unverified_other', reason: 'The document could not be verified.' }, for: ['document'] },
  document_expired: { label: 'Document is expired', error: { code: 'document_expired', reason: 'The document is expired.' }, for: ['document'] },
  document_type_not_supported: { label: 'Document type not accepted', error: { code: 'document_type_not_supported', reason: 'This type of document is not accepted.' }, for: ['document'] },
  selfie_face_mismatch: { label: 'Selfie doesn’t match the document', error: { code: 'selfie_face_mismatch', reason: 'The selfie does not match the photo on the document.' }, for: ['selfie'] },
  id_number_mismatch: { label: 'ID number doesn’t match', error: { code: 'id_number_mismatch', reason: 'The ID number does not match the name and date of birth provided.' }, for: ['id_number'] },
  under_supported_age: { label: 'Person is under 18', error: { code: 'under_supported_age', reason: 'The person is under the minimum supported age.' }, for: ['document', 'id_number'] },
};

function parseOptions(type: string, p: Params, existing?: any) {
  if (type === 'id_number') return { id_number: {} };
  const d = p.options?.document ?? {};
  const prev = existing?.document ?? {};
  const allowed = Array.isArray(d.allowed_types) ? d.allowed_types.map(String) : prev.allowed_types ?? [...DOC_TYPES];
  for (const t of allowed) if (!(DOC_TYPES as readonly string[]).includes(t)) throw invalid(`'${t}' is not a supported document type.`, 'options[document][allowed_types]');
  if (!allowed.length) throw invalid('Allow at least one document type.', 'options[document][allowed_types]');
  const flag = (k: string) => (d[k] !== undefined ? bool(d, k)! : prev[k] ?? false);
  return { document: { allowed_types: allowed, require_id_number: flag('require_id_number'), require_live_capture: flag('require_live_capture'), require_matching_selfie: flag('require_matching_selfie') } };
}

export async function createVerificationSession(ctx: Ctx, p: Params) {
  const type = oneOf(p, 'type', ['document', 'id_number'] as const);
  if (!type) throw missing('type');
  const id = newId('vs');
  const token = `test_${base62(32)}`;
  let relatedCustomer: string | null = null;
  if (p.related_customer) relatedCustomer = (await getObject<any>(ctx.accountId, 'customer', String(p.related_customer), 'customer', 'related_customer')).id;
  const s = {
    id,
    object: 'identity.verification_session',
    client_reference_id: str(p, 'client_reference_id', { max: 500 }) ?? null,
    client_secret: `${id}_secret_${base62(24)}`,
    created: nowSeconds(),
    last_error: null as any,
    last_verification_report: null as string | null,
    livemode: false,
    metadata: metadata(p),
    options: parseOptions(type, p),
    provided_details: { email: str(p.provided_details ?? {}, 'email') ?? null, phone: str(p.provided_details ?? {}, 'phone') ?? null },
    redaction: null as any,
    related_customer: relatedCustomer,
    related_person: null,
    status: 'requires_input',
    type,
    url: `${ctx.baseUrl}/verify/${token}`,
    verified_outputs: null as any,
    _token: token,
    _return_url: str(p, 'return_url', { max: 2048 }) ?? null,
    _verified_outputs: null as any,
    _submission: null as any,
    _resolve_at: null as number | null,
  };
  if (s._return_url && !/^https?:\/\//.test(s._return_url)) throw invalid('return_url must be an http(s) URL.', 'return_url');
  await insertObject(ctx.accountId, s);
  await emit(ctx, 'identity.verification_session.created', s);
  return s;
}

export async function updateVerificationSession(ctx: Ctx, id: string, p: Params) {
  const s = await getObject<any>(ctx.accountId, 'identity.verification_session', id, 'verification session');
  if (s.status !== 'requires_input') throw invalid(`A ${s.status} verification session can't be updated.`, 'session', 'verification_session_unexpected_state');
  if (p.type !== undefined) s.type = oneOf(p, 'type', ['document', 'id_number'] as const);
  if (p.type !== undefined || p.options !== undefined) s.options = parseOptions(s.type, p, p.type !== undefined ? undefined : s.options);
  s.metadata = metadata(p, s.metadata);
  await saveObject(ctx.accountId, s);
  return s;
}

export async function cancelVerificationSession(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'identity.verification_session', id, 'verification session');
  if (s.status !== 'requires_input') throw invalid(`Only sessions that require input can be canceled; this one is ${s.status}.`, 'session', 'verification_session_unexpected_state');
  s.status = 'canceled';
  await saveObject(ctx.accountId, s);
  await emit(ctx, 'identity.verification_session.canceled', s);
  return s;
}

export async function redactVerificationSession(ctx: Ctx, id: string) {
  const s = await getObject<any>(ctx.accountId, 'identity.verification_session', id, 'verification session');
  if (s.status === 'processing') throw invalid("A session can't be redacted while it is processing.", 'session', 'verification_session_unexpected_state');
  if (s.redaction?.status === 'redacted') return s;
  s.redaction = { status: 'redacted' };
  s._verified_outputs = s._verified_outputs ? Object.fromEntries(Object.keys(s._verified_outputs).map((k) => [k, null])) : null;
  s._submission = null;
  s.provided_details = { email: null, phone: null };
  s.metadata = {};
  await saveObject(ctx.accountId, s);
  const reports = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'identity.verification_report' AND data->>'verification_session' = $2", [ctx.accountId, s.id]);
  for (const { data: r } of reports) {
    for (const k of ['document', 'id_number']) if (r[k]) r[k] = { ...Object.fromEntries(Object.keys(r[k]).map((x) => [x, null])), status: r[k].status, error: r[k].error };
    if (r.selfie) r.selfie = { status: r.selfie.status, error: r.selfie.error, document: null, selfie: null };
    await saveObject(ctx.accountId, r);
  }
  await emit(ctx, 'identity.verification_session.redacted', s);
  return s;
}

/** API view: `verified_outputs` only when expanded. */
export function present(s: any, expand?: string[] | string) {
  const paths = Array.isArray(expand) ? expand : expand ? [expand] : [];
  return { ...s, verified_outputs: paths.includes('verified_outputs') || paths.includes('data.verified_outputs') ? s._verified_outputs : null };
}

// ---------------- hosted page ----------------

export async function findByToken(token: string) {
  const row = await one<{ data: any; account_id: string }>("SELECT data, account_id FROM objects WHERE type = 'identity.verification_session' AND data->>'_token' = $1", [token]);
  if (!row) throw new ApiError(404, 'invalid_request_error', 'This verification link is not valid.', { code: 'resource_missing' });
  return row;
}

export async function hostedView(accountId: string, s: any) {
  const acct = await one<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [accountId]);
  const needs: ('document' | 'id_number' | 'selfie')[] = s.type === 'id_number' ? ['id_number'] : ['document', ...(s.options.document.require_matching_selfie ? ['selfie' as const] : [])];
  return {
    id: s.id,
    type: s.type,
    status: s.status,
    merchant_name: acct?.data?.business_profile?.name ?? acct?.data?.settings?.dashboard?.display_name ?? 'This business',
    allowed_types: s.type === 'document' ? s.options.document.allowed_types : [],
    require_id_number: s.type === 'id_number' || !!s.options.document?.require_id_number,
    require_selfie: !!s.options.document?.require_matching_selfie,
    last_error: s.last_error,
    return_url: s._return_url,
    email: s.provided_details?.email ?? null,
    outcomes: Object.entries(OUTCOMES).filter(([, o]) => o.for.some((f) => needs.includes(f))).map(([k, o]) => ({ id: k, label: o.label })),
  };
}

/** The person submitted the form: start processing (the result arrives a few seconds later). */
export async function submitVerification(accountId: string, token: string, b: any) {
  const { data: s } = await findByToken(token);
  const ctx = accountCtx(accountId);
  if (s.status !== 'requires_input') throw invalid(s.status === 'verified' ? 'You are already verified.' : `This verification is ${s.status}.`, 'session', 'verification_session_unexpected_state');
  const first = String(b?.first_name ?? '').trim();
  const last = String(b?.last_name ?? '').trim();
  if (!first || !last) throw invalid('Enter your first and last name.', 'first_name');
  const dob = b?.dob ?? {};
  const [dd, mm, yy] = [Number(dob.day), Number(dob.month), Number(dob.year)];
  if (!dd || !mm || !yy || yy < 1900 || yy > new Date().getUTCFullYear()) throw invalid('Enter a valid date of birth.', 'dob');
  const docType = s.type === 'document' ? String(b?.document_type ?? '') : null;
  if (s.type === 'document' && !s.options.document.allowed_types.includes(docType)) throw invalid('Choose one of the accepted document types.', 'document_type');
  const needsId = s.type === 'id_number' || s.options.document?.require_id_number;
  const idNumber = needsId ? String(b?.id_number ?? '').replace(/\s/g, '') : null;
  if (needsId && !/^[0-9A-Za-z-]{4,20}$/.test(idNumber!)) throw invalid('Enter your ID number (for example, a US SSN).', 'id_number');
  const outcome = String(b?.outcome ?? 'verified');
  if (!OUTCOMES[outcome]) throw invalid('Choose a test outcome.', 'outcome');
  s._submission = {
    first_name: first, last_name: last, dob: { day: dd, month: mm, year: yy }, document_type: docType, id_number: idNumber, outcome,
    address: b?.address?.line1 ? { city: b.address.city ?? null, country: b.address.country ?? 'US', line1: b.address.line1, line2: null, postal_code: b.address.postal_code ?? null, state: b.address.state ?? null } : null,
    issuing_country: String(b?.issuing_country ?? 'US').toUpperCase().slice(0, 2),
  };
  s.status = 'processing';
  s.last_error = null;
  s._resolve_at = nowSeconds() + config.identityProcessingSeconds;
  await saveObject(accountId, s);
  await emit(ctx, 'identity.verification_session.processing', s);
  return s;
}

/** Worker: finish processing submitted sessions whose (simulated) checks are done. */
export async function processVerifications(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'identity.verification_session' AND data->>'status' = 'processing' ORDER BY seq LIMIT 100");
  let n = 0;
  for (const { account_id, data: s } of rows) {
    if (!s._resolve_at || s._resolve_at > now) continue;
    await finishVerification(accountCtx(account_id), s, now);
    n++;
  }
  return n;
}

export async function finishVerification(ctx: Ctx, s: any, now = nowSeconds()) {
  const sub = s._submission;
  const outcome = OUTCOMES[sub.outcome]!;
  const err = outcome.error ?? null;
  const failed = (part: 'document' | 'id_number' | 'selfie') => (err && outcome.for.includes(part) ? { code: err.code, reason: err.reason } : null);
  const ageErr = sub.outcome === 'under_supported_age' ? { code: err!.code, reason: err!.reason } : null;
  const expYear = sub.outcome === 'document_expired' ? new Date(now * 1000).getUTCFullYear() - 1 : new Date(now * 1000).getUTCFullYear() + 6;
  const report: any = {
    id: newId('vr'),
    object: 'identity.verification_report',
    client_reference_id: s.client_reference_id,
    created: now,
    livemode: false,
    options: s.options,
    type: s.type,
    verification_session: s.id,
  };
  if (s.type === 'document') {
    const docErr = sub.outcome === 'under_supported_age' ? ageErr : failed('document');
    report.document = {
      address: sub.address, dob: sub.dob, error: docErr, expiration_date: { day: 1, month: 6, year: expYear }, files: [], first_name: sub.first_name,
      issued_date: { day: 1, month: 6, year: expYear - 10 }, issuing_country: sub.issuing_country, last_name: sub.last_name,
      number: sub.document_type === 'passport' ? '000000000' : 'TEST1234', status: docErr ? 'unverified' : 'verified', type: sub.document_type,
    };
    if (s.options.document.require_matching_selfie) {
      const selfieErr = failed('selfie');
      report.selfie = { document: null, error: selfieErr, selfie: null, status: selfieErr || docErr ? 'unverified' : 'verified' };
    }
  }
  if (sub.id_number) {
    const idErr = s.type === 'id_number' && sub.outcome === 'under_supported_age' ? ageErr : failed('id_number');
    report.id_number = { dob: sub.dob, error: idErr, first_name: sub.first_name, id_number_type: 'us_ssn', last_name: sub.last_name, status: idErr ? 'unverified' : 'verified' };
  }
  await insertObject(ctx.accountId, report);
  s.last_verification_report = report.id;
  s._resolve_at = null;
  if (err) {
    s.status = 'requires_input';
    s.last_error = err;
    await saveObject(ctx.accountId, s);
    await emit(ctx, 'identity.verification_session.requires_input', s);
  } else {
    s.status = 'verified';
    s.last_error = null;
    s._verified_outputs = {
      address: sub.address, dob: sub.dob, email: s.provided_details?.email ?? null, first_name: sub.first_name,
      id_number: sub.id_number, id_number_type: sub.id_number ? 'us_ssn' : null, last_name: sub.last_name, phone: s.provided_details?.phone ?? null, sex: null,
    };
    await saveObject(ctx.accountId, s);
    await emit(ctx, 'identity.verification_session.verified', s);
  }
  return s;
}
void findObject;
