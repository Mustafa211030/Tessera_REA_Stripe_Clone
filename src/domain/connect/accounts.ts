import { createHmac } from 'node:crypto';
import { config } from '../../config.ts';
import { one, query } from '../../db/index.ts';
import { ApiError, invalid, missing } from '../../lib/errors.ts';
import { base62, newId, nowSeconds } from '../../lib/ids.ts';
import { bool, int, metadata, oneOf, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { diff, emit } from '../events.ts';
import { insertObject, saveObject, getObject } from '../store.ts';
import { assertFile } from '../files.ts';

/**
 * Connect accounts.
 *
 * A connected account is a full Tessera account (own objects, ledger and balance) whose
 * `platform` column points at the account that created it. The platform acts on it with
 * its own key plus `Stripe-Account: acct_...`.
 *
 * Account types follow the public model:
 *   standard  Tessera collects requirements, connected account pays fees    (controller.stripe_dashboard.type = full)
 *   express   Tessera collects requirements, platform pays fees, light dashboard (express)
 *   custom    the platform collects requirements through the API             (none)
 *
 * Requirements are recomputed after every change; `charges_enabled` and `payouts_enabled`
 * follow from them, and changes emit `account.updated` / `capability.updated`.
 */

export const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'usd', CA: 'cad', GB: 'gbp', AU: 'aud', IE: 'eur', DE: 'eur', FR: 'eur', NL: 'eur', ES: 'eur', IT: 'eur', JP: 'jpy', SG: 'sgd', IN: 'inr',
};
const CAPABILITIES = ['card_payments', 'transfers'] as const;
const BUSINESS_TYPES = ['individual', 'company', 'non_profit', 'government_entity'] as const;
const DAY = 86400;

export const applicationId = (platformId: string) => `ca_${platformId.slice(5)}`;

/** Context for acting on a connected account on behalf of its platform. */
export const connectedCtx = (ctx: Ctx, accountId: string): Ctx => ({ ...ctx, accountId, platformAccountId: ctx.platformAccountId ?? ctx.accountId });

export const accountCtx = (accountId: string, baseUrl = `http://localhost:${config.port}`): Ctx => ({
  accountId, livemode: false, apiVersion: config.latestApiVersion, keyType: 'secret', requestId: `req_worker_${Date.now()}`, baseUrl,
});

const noAccess = (id: string) =>
  new ApiError(403, 'permission_error', `The provided key does not have access to account '${id}' (or that account does not exist). Application access may have been revoked.`, { code: 'account_invalid' });

export async function loadAccount(id: string): Promise<any | undefined> {
  const row = await one<{ data: any; platform: string | null }>('SELECT data, platform FROM accounts WHERE id = $1', [id]);
  return row?.data;
}

export async function saveAccount(acct: any) {
  await query('UPDATE accounts SET data = $1 WHERE id = $2', [JSON.stringify(acct), acct.id]);
  return acct;
}

/** The caller's own account, or one of its connected accounts. */
export async function accessibleAccount(ctx: Ctx, id: string) {
  if (id === ctx.accountId) return loadAccount(id);
  const a = await loadAccount(id);
  if (!a || a._platform !== ctx.accountId || a._deleted) throw noAccess(id);
  return a;
}

/** A connected account of the caller (not the caller itself). */
export async function connectedAccount(ctx: Ctx, id: string, param = 'account') {
  if (ctx.platformAccountId) throw new ApiError(400, 'invalid_request_error', 'Connected accounts cannot manage other accounts. Make this request without the Stripe-Account header.');
  const a = await loadAccount(id);
  if (!a || a._platform !== ctx.accountId || a._deleted) {
    if (param === 'account' || param === 'id') throw noAccess(id);
    throw new ApiError(400, 'invalid_request_error', `No such ${param.replace(/.*\[|\]/g, '')}: '${id}'`, { param, code: 'resource_missing' });
  }
  return a;
}

// ---------------------------------------------------------------- creation

function controllerFor(type: string) {
  const dash = type === 'custom' ? 'none' : type === 'express' ? 'express' : 'full';
  return {
    fees: { payer: type === 'standard' ? 'account' : 'application' },
    is_controller: true,
    losses: { payments: type === 'standard' ? 'stripe' : 'application' },
    requirement_collection: type === 'custom' ? 'application' : 'stripe',
    stripe_dashboard: { type: dash },
    type: 'application',
  };
}

function typeFromController(c: any): 'standard' | 'express' | 'custom' {
  const dash = c?.stripe_dashboard?.type;
  if (dash === 'none' || c?.requirement_collection === 'application') return 'custom';
  if (dash === 'express') return 'express';
  return 'standard';
}

export async function createConnectedAccount(ctx: Ctx, p: Params) {
  if (ctx.platformAccountId) throw new ApiError(400, 'invalid_request_error', 'Connected accounts cannot create their own connected accounts.');
  const platform = await loadAccount(ctx.accountId);
  if (platform?._platform) throw new ApiError(400, 'invalid_request_error', 'Connected accounts cannot create their own connected accounts.');
  let type = oneOf(p, 'type', ['standard', 'express', 'custom'] as const);
  if (type && p.controller) throw invalid('You cannot specify both `type` and `controller`. Use `controller` to describe the account.', 'controller');
  if (!type) type = p.controller ? typeFromController(p.controller) : 'standard';
  const country = (str(p, 'country') ?? 'US').toUpperCase();
  if (!COUNTRY_CURRENCY[country]) throw invalid(`Country '${country}' is not supported. Supported: ${Object.keys(COUNTRY_CURRENCY).join(', ')}.`, 'country');

  const requested = parseCapabilities(p);
  if (!requested.length) {
    if (type !== 'standard') throw invalid(`You must request at least one capability for an account with type=${type}, for example capabilities[transfers][requested]=true.`, 'capabilities');
    requested.push('card_payments', 'transfers');
  }
  if (requested.includes('card_payments') && !requested.includes('transfers') && country === 'US') {
    throw invalid('To request the card_payments capability you must also request the transfers capability.', 'capabilities');
  }

  const id = newId('acct', 16);
  const created = nowSeconds();
  const acct: any = {
    id,
    object: 'account',
    business_profile: { mcc: null, name: null, product_description: null, support_email: null, support_phone: null, support_url: null, url: null },
    business_type: null,
    capabilities: {},
    charges_enabled: false,
    controller: controllerFor(type),
    country,
    created,
    default_currency: COUNTRY_CURRENCY[country],
    details_submitted: false,
    email: null,
    external_accounts: { object: 'list', data: [] as any[], has_more: false, total_count: 0, url: `/v1/accounts/${id}/external_accounts` },
    future_requirements: emptyRequirements(),
    metadata: {},
    payouts_enabled: false,
    requirements: emptyRequirements(),
    settings: {
      dashboard: { display_name: null, timezone: 'Etc/UTC' },
      payments: { statement_descriptor: null },
      payouts: { debit_negative_balances: true, schedule: { delay_days: 2, interval: 'daily' }, statement_descriptor: null },
    },
    tos_acceptance: { date: null, ip: null, user_agent: null },
    type,
    _platform: ctx.accountId,
    _capabilities: Object.fromEntries(requested.map((c) => [c, { requested: true, requested_at: created }])),
    _api_version: config.latestApiVersion,
  };
  await applyUpdate(ctx, acct, p, { creating: true });
  computeRequirements(acct);
  await query('INSERT INTO accounts (id, created, data, platform) VALUES ($1,$2,$3,$4)', [id, created, JSON.stringify(acct), ctx.accountId]);
  await query('SELECT tessera_shard($1)', [id]); // placed on a shard in the same transaction
  await emit(connectedCtx(ctx, id), 'account.updated', acct);
  return acct;
}

function parseCapabilities(p: Params): string[] {
  const c = p.capabilities;
  if (c === undefined || c === '') return [];
  if (typeof c !== 'object') throw invalid('Invalid capabilities', 'capabilities');
  const out: string[] = [];
  for (const [name, v] of Object.entries<any>(c)) {
    if (!CAPABILITIES.includes(name as any)) throw invalid(`Unknown capability: ${name}. Supported: ${CAPABILITIES.join(', ')}.`, `capabilities[${name}]`);
    if (v?.requested === 'true' || v?.requested === true) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- updates

const IDENTITY_KEYS = ['business_type', 'individual', 'company', 'tos_acceptance'];

/** Fields any platform may change, even after Tessera-hosted onboarding. */
export async function updateConnectedAccount(ctx: Ctx, id: string, p: Params, opts: { hosted?: boolean } = {}) {
  const acct = opts.hosted ? await loadAccount(id) : id === ctx.accountId ? await loadAccount(id) : await connectedAccount(ctx, id, 'account');
  if (!acct._platform) return updateOwnAccount(ctx, acct, p);
  const before = structuredClone(acct);
  const ownedByTessera = acct.controller.requirement_collection === 'stripe';
  if (!opts.hosted && ownedByTessera && acct.details_submitted && IDENTITY_KEYS.some((k) => p[k] !== undefined)) {
    throw new ApiError(400, 'invalid_request_error', `This account's requirements are collected by Tessera, so you can't change \`${IDENTITY_KEYS.find((k) => p[k] !== undefined)}\` through the API once onboarding is complete. Send the user through an Account Link instead.`, { code: 'account_update_not_allowed' });
  }
  await applyUpdate(ctx, acct, p, { creating: false });
  if (opts.hosted) acct.details_submitted = true;
  computeRequirements(acct);
  await saveAccount(acct);
  await announce(ctx, before, acct);
  return acct;
}

async function updateOwnAccount(ctx: Ctx, acct: any, p: Params) {
  if (p.settings?.payouts?.schedule) applySchedule(acct, p.settings.payouts.schedule);
  if (p.business_profile && typeof p.business_profile === 'object') {
    for (const k of ['name', 'url', 'support_email', 'support_phone', 'product_description']) if (p.business_profile[k] !== undefined) acct.business_profile[k] = p.business_profile[k] || null;
  }
  acct.metadata = metadata(p, acct.metadata ?? {});
  await saveAccount(acct);
  await emit(ctx, 'account.updated', acct);
  return acct;
}

/** Emit account.updated and capability.updated for what changed. */
export async function announce(ctx: Ctx, before: any, after: any) {
  const prev = diff(stripPriv(before), stripPriv(after));
  const c = connectedCtx(ctx, after.id);
  if (Object.keys(prev).length) await emit(c, 'account.updated', after, prev);
  for (const cap of Object.keys(after.capabilities)) {
    if (before.capabilities?.[cap] !== after.capabilities[cap]) await emit(c, 'capability.updated', capabilityObject(after, cap) as any, { status: before.capabilities?.[cap] ?? 'inactive' });
  }
}

const stripPriv = (o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

const setIf = (target: any, src: any, keys: string[]) => {
  for (const k of keys) if (src?.[k] !== undefined) target[k] = src[k] === '' ? null : String(src[k]);
};

async function applyUpdate(ctx: Ctx, acct: any, p: Params, { creating }: { creating: boolean }) {
  if (p.email !== undefined) acct.email = str(p, 'email') ?? null;
  if (p.business_type !== undefined) acct.business_type = oneOf(p, 'business_type', BUSINESS_TYPES) ?? null;
  if (p.default_currency !== undefined) acct.default_currency = String(p.default_currency).toLowerCase();
  if (p.business_profile && typeof p.business_profile === 'object') {
    setIf(acct.business_profile, p.business_profile, ['mcc', 'name', 'product_description', 'support_email', 'support_phone', 'support_url', 'url']);
    if (acct.business_profile.mcc && !/^\d{4}$/.test(acct.business_profile.mcc)) throw invalid('business_profile[mcc] must be a 4-digit merchant category code.', 'business_profile[mcc]');
  }
  if (p.individual && typeof p.individual === 'object') {
    await checkPersonDocuments(ctx, p.individual, 'individual', acct.id);
    applyIndividual(acct, p.individual);
  }
  if (p.company && typeof p.company === 'object') applyCompany(acct, p.company);
  // Hosted onboarding sends the company representative with the rest of the form.
  if (p._representative && typeof p._representative === 'object') {
    await checkPersonDocuments(ctx, p._representative, 'representative', acct.id);
    const persons: any[] = (acct._persons ??= []);
    let rep = persons.find((x) => x.relationship.representative);
    if (!rep) persons.unshift((rep = newPerson(acct, { representative: true })));
    applyPersonFields(rep, p._representative, 'representative');
  }
  if (p.tos_acceptance && typeof p.tos_acceptance === 'object') {
    const t = p.tos_acceptance;
    if (t.date !== undefined) acct.tos_acceptance.date = int(t, 'date');
    if (t.ip !== undefined) acct.tos_acceptance.ip = String(t.ip);
    if (t.user_agent !== undefined) acct.tos_acceptance.user_agent = String(t.user_agent);
  }
  const caps = parseCapabilities(p);
  for (const c of caps) acct._capabilities[c] ??= { requested: true, requested_at: nowSeconds() };
  if (p.capabilities && typeof p.capabilities === 'object') {
    for (const [name, v] of Object.entries<any>(p.capabilities)) if (v?.requested === 'false' || v?.requested === false) delete acct._capabilities[name];
  }
  if (p.settings?.payouts?.schedule) applySchedule(acct, p.settings.payouts.schedule);
  if (p.settings?.payouts?.statement_descriptor !== undefined) acct.settings.payouts.statement_descriptor = String(p.settings.payouts.statement_descriptor).slice(0, 22) || null;
  if (p.settings?.payments?.statement_descriptor !== undefined) acct.settings.payments.statement_descriptor = String(p.settings.payments.statement_descriptor).slice(0, 22).toUpperCase() || null;
  if (p.external_account !== undefined && p.external_account !== '') await addExternalAccount(ctx, acct, p.external_account, { save: false });
  acct.metadata = metadata(p, acct.metadata);
  if (acct.business_profile.name) acct.settings.dashboard.display_name = acct.business_profile.name;
  else if (acct.individual?.first_name) acct.settings.dashboard.display_name = `${acct.individual.first_name} ${acct.individual.last_name ?? ''}`.trim();
  else if (acct.company?.name) acct.settings.dashboard.display_name = acct.company.name;
  void creating;
}

function applySchedule(acct: any, s: any) {
  const sched = acct.settings.payouts.schedule;
  if (s.interval !== undefined) {
    if (!['manual', 'daily', 'weekly', 'monthly'].includes(s.interval)) throw invalid('Invalid interval: must be one of manual, daily, weekly, monthly', 'settings[payouts][schedule][interval]');
    sched.interval = s.interval;
    delete sched.weekly_anchor;
    delete sched.monthly_anchor;
    if (s.interval === 'weekly') sched.weekly_anchor = s.weekly_anchor ?? 'monday';
    if (s.interval === 'monthly') sched.monthly_anchor = Number(s.monthly_anchor ?? 1);
    acct._next_auto_payout = null;
  }
  if (s.delay_days !== undefined) {
    const d = s.delay_days === 'minimum' ? 2 : Number(s.delay_days);
    if (!Number.isInteger(d) || d < 2 || d > 30) throw invalid('delay_days must be between 2 and 30, or "minimum".', 'settings[payouts][schedule][delay_days]');
    sched.delay_days = d;
  }
}

export function newPerson(acct: any, relationship: Partial<Record<string, any>> = {}) {
  return {
    id: newId('person', 16),
    object: 'person',
    account: acct.id,
    address: { city: null, country: acct.country, line1: null, line2: null, postal_code: null, state: null },
    created: nowSeconds(),
    dob: { day: null, month: null, year: null },
    email: null,
    first_name: null,
    id_number_provided: false,
    last_name: null,
    metadata: {},
    phone: null,
    relationship: { director: false, executive: false, owner: false, percent_ownership: null, representative: false, title: null, ...relationship },
    ssn_last_4_provided: false,
    verification: { additional_document: null, details: null, details_code: null, document: { back: null, details: null, details_code: null, front: null }, status: 'unverified' },
  } as any;
}

const TEST_DOCS: Record<string, 'success' | 'failure'> = { file_identity_document_success: 'success', file_identity_document_failure: 'failure' };

/** Shared by account[individual] and the Persons API. `param` prefixes error params. */
export function applyPersonFields(ind: any, src: any, param: string) {
  setIf(ind, src, ['first_name', 'last_name', 'email', 'phone']);
  if (src.address && typeof src.address === 'object') setIf(ind.address, src.address, ['line1', 'line2', 'city', 'state', 'postal_code', 'country']);
  if (src.dob && typeof src.dob === 'object') {
    for (const k of ['day', 'month', 'year'] as const) if (src.dob[k] !== undefined) ind.dob[k] = src.dob[k] === '' ? null : Number(src.dob[k]);
    const { day, month, year } = ind.dob;
    if (day && month && year && (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > new Date().getFullYear() - 13)) {
      throw invalid('Invalid date of birth: the person must be at least 13 years old.', `${param}[dob]`);
    }
  }
  if (src.ssn_last_4 !== undefined) {
    if (!/^\d{4}$/.test(String(src.ssn_last_4))) throw invalid('ssn_last_4 must be 4 digits.', `${param}[ssn_last_4]`);
    ind.ssn_last_4_provided = true;
    ind._ssn_last_4 = String(src.ssn_last_4);
  }
  if (src.id_number !== undefined) {
    if (!/^\d{9}$/.test(String(src.id_number))) throw invalid('id_number must be 9 digits.', `${param}[id_number]`);
    ind.id_number_provided = true;
    ind.ssn_last_4_provided = true;
    ind._id_number = String(src.id_number);
  }
  if (src.relationship && typeof src.relationship === 'object') {
    const r = src.relationship;
    for (const k of ['representative', 'owner', 'director', 'executive']) if (r[k] !== undefined) ind.relationship[k] = r[k] === true || r[k] === 'true';
    if (r.title !== undefined) ind.relationship.title = r.title === '' ? null : String(r.title).slice(0, 100);
    if (r.percent_ownership !== undefined) {
      const pct = r.percent_ownership === '' ? null : Number(r.percent_ownership);
      if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) throw invalid('percent_ownership must be between 0 and 100.', `${param}[relationship][percent_ownership]`);
      ind.relationship.percent_ownership = pct;
    }
  }
  const doc = src.verification?.document;
  if (doc && typeof doc === 'object') {
    for (const side of ['front', 'back'] as const) {
      if (doc[side] === undefined) continue;
      ind.verification.document[side] = doc[side] === '' ? null : String(doc[side]);
    }
    if (doc.front !== undefined) ind._doc_outcome = TEST_DOCS[String(doc.front)] ?? doc._outcome ?? null;
  }
  verifyIndividual(ind);
}

/**
 * Document uploads given as real file ids (purpose identity_document) are checked before the
 * synchronous update runs. A file whose name contains "fail" simulates a rejected document.
 */
export async function checkPersonDocuments(ctx: Ctx, src: any, param: string, accountId = ctx.accountId) {
  // Files may be uploaded to the connected account (Stripe-Account header) or to the platform.
  if (accountId !== ctx.accountId) ctx = connectedCtx(ctx, accountId);
  const doc = src?.verification?.document;
  if (!doc || typeof doc !== 'object') return;
  for (const side of ['front', 'back'] as const) {
    const id = doc[side];
    if (!id || TEST_DOCS[id]) continue;
    const f = await assertFile(ctx, String(id), ['identity_document', 'additional_verification'], `${param}[verification][document][${side}]`);
    if (side === 'front') doc._outcome = /fail/i.test(f.filename ?? '') ? 'failure' : 'success';
  }
}

function applyIndividual(acct: any, src: any) {
  const ind = (acct.individual ??= newPerson(acct, { representative: true }));
  applyPersonFields(ind, src, 'individual');
}

/**
 * Simulated identity verification, using the same test values as the public docs:
 *   dob 1901-01-01            verified
 *   dob 1902-01-01            keyed identity fails; needs a document
 *   document file_identity_document_success / _failure
 *   id_number 111111111       identity mismatch
 */
export function verifyIndividual(ind: any) {
  const v = ind.verification;
  const { day, month, year } = ind.dob;
  const keyed = ind.first_name && ind.last_name && day && month && year && ind.ssn_last_4_provided;
  v.details = null;
  v.details_code = null;
  v.document.details = null;
  v.document.details_code = null;
  if (!keyed) { v.status = 'unverified'; return; }
  const failsKeyed = (year === 1902 && month === 1 && day === 1) || ind._id_number === '111111111';
  if (!failsKeyed) { v.status = 'verified'; return; }
  if (ind._doc_outcome === 'success') { v.status = 'verified'; return; }
  v.status = 'unverified';
  if (ind._doc_outcome === 'failure') {
    v.document.details = 'The document might have been altered so it could not be verified.';
    v.document.details_code = 'document_failed_greyscale';
  } else {
    v.details = 'Provided identity information could not be verified';
    v.details_code = 'failed_keyed_identity';
  }
}

function applyCompany(acct: any, src: any) {
  const c = (acct.company ??= {
    address: { city: null, country: acct.country, line1: null, line2: null, postal_code: null, state: null },
    directors_provided: false, executives_provided: false, name: null, owners_provided: false, phone: null, tax_id_provided: false,
    verification: { document: { back: null, details: null, details_code: null, front: null } },
  });
  setIf(c, src, ['name', 'phone']);
  for (const k of ['owners_provided', 'directors_provided', 'executives_provided']) if (src[k] !== undefined) c[k] = src[k] === true || src[k] === 'true';
  if (src.address && typeof src.address === 'object') setIf(c.address, src.address, ['line1', 'line2', 'city', 'state', 'postal_code', 'country']);
  if (src.tax_id !== undefined) {
    if (!/^\d{9}$/.test(String(src.tax_id))) throw invalid('tax_id must be 9 digits.', 'company[tax_id]');
    c.tax_id_provided = true;
    c._tax_id = String(src.tax_id);
  }
}

// ---------------------------------------------------------------- requirements

function emptyRequirements() {
  return { alternatives: [], current_deadline: null, currently_due: [] as string[], disabled_reason: null as string | null, errors: [] as any[], eventually_due: [] as string[], past_due: [] as string[], pending_verification: [] as string[] };
}

export function computeRequirements(a: any) {
  const due: string[] = [];
  const errors: any[] = [];
  const need = (ok: unknown, key: string) => { if (!ok) due.push(key); };
  need(a.business_type, 'business_type');
  need(a.business_profile.mcc, 'business_profile.mcc');
  need(a.business_profile.url || a.business_profile.product_description, 'business_profile.url');
  if (a.business_type === 'individual') {
    const i = a.individual ?? { dob: {}, address: {} };
    need(i.first_name, 'individual.first_name');
    need(i.last_name, 'individual.last_name');
    need(i.email, 'individual.email');
    need(i.phone, 'individual.phone');
    need(i.dob?.day, 'individual.dob.day');
    need(i.dob?.month, 'individual.dob.month');
    need(i.dob?.year, 'individual.dob.year');
    need(i.address?.line1, 'individual.address.line1');
    need(i.address?.city, 'individual.address.city');
    need(i.address?.postal_code, 'individual.address.postal_code');
    if (a.country === 'US') {
      need(i.address?.state, 'individual.address.state');
      need(i.ssn_last_4_provided, 'individual.ssn_last_4');
    }
    if (i.verification && i.verification.status !== 'verified' && i.first_name && i.dob?.year && i.ssn_last_4_provided) {
      due.push('individual.verification.document');
      errors.push({
        code: i.verification.document?.details_code ? 'verification_document_failed_greyscale' : 'verification_failed_keyed_identity',
        reason: i.verification.document?.details ?? 'The identity information you entered cannot be verified. Please correct any errors or upload a document that matches the identity fields (e.g., name and date of birth) that you entered.',
        requirement: 'individual.verification.document',
      });
    }
  } else if (a.business_type) {
    const c = a.company ?? { address: {} };
    need(c.name, 'company.name');
    need(c.tax_id_provided, 'company.tax_id');
    need(c.phone, 'company.phone');
    need(c.address?.line1, 'company.address.line1');
    need(c.address?.city, 'company.address.city');
    need(c.address?.postal_code, 'company.address.postal_code');
    if (a.country === 'US') need(c.address?.state, 'company.address.state');
    personRequirements(a, need, due, errors);
  }
  need(a.tos_acceptance.date, 'tos_acceptance.date');
  need(a.tos_acceptance.ip, 'tos_acceptance.ip');
  need(a.external_accounts.data.length, 'external_account');

  const rejected = a._rejected as string | undefined;
  a.requirements = {
    ...emptyRequirements(),
    currently_due: due,
    eventually_due: due,
    past_due: due,
    errors,
    disabled_reason: rejected ? `rejected.${rejected}` : due.length ? 'requirements.past_due' : null,
  };
  const ready = !rejected && due.length === 0;
  a.capabilities = Object.fromEntries(Object.keys(a._capabilities).map((c) => [c, ready ? 'active' : 'inactive']));
  a.charges_enabled = ready && a.capabilities.card_payments === 'active';
  a.payouts_enabled = ready;
  if (ready) a.details_submitted = true;
  return a;
}

/**
 * Companies need a representative (an executive who can act for the business) with full
 * identity details, and the owners must be listed (or confirmed via company[owners_provided]).
 * Keys follow the documented shape: `representative.*` until one exists, then `person_xxx.*`.
 */
function personRequirements(a: any, need: (ok: unknown, key: string) => void, due: string[], errors: any[]) {
  const persons: any[] = a._persons ?? [];
  const rep = persons.find((x) => x.relationship.representative);
  const fields = ['first_name', 'last_name', 'email', 'phone', 'dob.day', 'dob.month', 'dob.year', 'address.line1', 'address.city', 'address.postal_code', 'relationship.title'];
  if (a.country === 'US') fields.push('address.state', 'ssn_last_4');
  const get = (o: any, path: string) => path === 'ssn_last_4' ? o.ssn_last_4_provided : path.split('.').reduce((x, k) => x?.[k], o);
  if (!rep) for (const f of fields) need(false, `representative.${f}`);
  else {
    for (const f of fields) need(get(rep, f), `${rep.id}.${f}`);
    if (rep.verification.status !== 'verified' && rep.first_name && rep.dob?.year && rep.ssn_last_4_provided) {
      due.push(`${rep.id}.verification.document`);
      errors.push({
        code: rep.verification.document?.details_code ? 'verification_document_failed_greyscale' : 'verification_failed_keyed_identity',
        reason: rep.verification.document?.details ?? 'The representative\'s identity information could not be verified. Correct the details or upload an identity document.',
        requirement: `${rep.id}.verification.document`,
      });
    }
  }
  const owners = persons.filter((x) => x.relationship.owner);
  for (const o of owners) if (o !== rep) { need(o.first_name, `${o.id}.first_name`); need(o.last_name, `${o.id}.last_name`); }
  need(a.company?.owners_provided, 'company.owners_provided');
}

export function capabilityObject(a: any, name: string) {
  const req = a._capabilities[name];
  return {
    id: name,
    object: 'capability',
    account: a.id,
    future_requirements: emptyRequirements(),
    requested: !!req,
    requested_at: req?.requested_at ?? null,
    requirements: a.capabilities[name] === 'active' ? emptyRequirements() : a.requirements,
    status: req ? a.capabilities[name] ?? 'inactive' : 'unrequested',
  };
}

export async function updateCapability(ctx: Ctx, id: string, cap: string, p: Params) {
  if (!CAPABILITIES.includes(cap as any)) throw invalid(`No such capability: ${cap}`, 'capability');
  const requested = bool(p, 'requested');
  if (requested === undefined) return capabilityObject(await connectedAccount(ctx, id), cap);
  const a = await updateConnectedAccount(ctx, id, { capabilities: { [cap]: { requested: String(requested) } } });
  return capabilityObject(a, cap);
}

// ---------------------------------------------------------------- external accounts

/** Test bank account numbers (routing 110000000) and the payout outcome each one simulates. */
export const TEST_BANK_ACCOUNTS: Record<string, { failure?: string; message?: string }> = {
  '000123456789': {},
  '000111111116': { failure: 'no_account', message: 'The bank account details on file are probably incorrect. No bank account could be located with those details.' },
  '000111111113': { failure: 'account_closed', message: 'The bank account has been closed.' },
  '000222222227': { failure: 'insufficient_funds', message: 'Your Tessera balance is insufficient to cover the payout.' },
  '000333333335': { failure: 'debit_not_authorized', message: 'Debit transactions are not approved on the bank account.' },
  '000444444440': { failure: 'invalid_currency', message: 'The bank was unable to process this payout because of its currency.' },
};
const TEST_BANK_TOKENS: Record<string, string> = {
  btok_us_verified: '000123456789',
  btok_us_verified_noAccount: '000111111116',
  btok_us_verified_accountClosed: '000111111113',
  btok_us_verified_insufficientFunds: '000222222227',
  btok_us_verified_debitNotAuthorized: '000333333335',
  btok_us_verified_invalidCurrency: '000444444440',
};

function bankDetails(src: any, param: string) {
  const country = String(src.country ?? 'US').toUpperCase();
  const currency = String(src.currency ?? COUNTRY_CURRENCY[country] ?? 'usd').toLowerCase();
  const number = String(src.account_number ?? '').replace(/\s/g, '');
  if (!number) throw missing(`${param}[account_number]`);
  if (!/^\d{4,17}$/.test(number)) throw invalid('The account number must contain only digits, and be between 4 and 17 digits long.', `${param}[account_number]`, 'account_number_invalid');
  const routing = src.routing_number === undefined ? null : String(src.routing_number);
  if (country === 'US' && !/^\d{9}$/.test(routing ?? '')) throw invalid('Routing number must have 9 digits.', `${param}[routing_number]`, 'routing_number_invalid');
  return { country, currency, number, routing, holder: src.account_holder_name ?? null, holderType: src.account_holder_type ?? null };
}

/** POST /v1/tokens with bank_account (client-side tokenization of bank details). */
export async function createBankToken(ctx: Ctx, p: Params) {
  if (!p.bank_account || typeof p.bank_account !== 'object') throw invalid('This endpoint supports bank_account tokens. Card data is tokenized with /v1/payment_methods.', 'bank_account');
  const b = bankDetails(p.bank_account, 'bank_account');
  const tok = {
    id: newId('btok', 24),
    object: 'token',
    bank_account: bankObject('', b, false),
    client_ip: null,
    created: nowSeconds(),
    livemode: false,
    type: 'bank_account',
    used: false,
    _details: b,
  };
  delete (tok.bank_account as any).account;
  await insertObject(ctx.platformAccountId ?? ctx.accountId, tok);
  return tok;
}

function bankObject(accountId: string, b: ReturnType<typeof bankDetails>, isDefault: boolean) {
  return {
    id: newId('ba', 24),
    object: 'bank_account',
    account: accountId,
    account_holder_name: b.holder,
    account_holder_type: b.holderType,
    account_type: null,
    available_payout_methods: ['standard'],
    bank_name: 'TESSERA TEST BANK',
    country: b.country,
    currency: b.currency,
    default_for_currency: isDefault,
    fingerprint: createHmac('sha256', 'tessera-bank').update(`${b.routing}:${b.number}`).digest('base64url').slice(0, 16),
    last4: b.number.slice(-4),
    metadata: {},
    routing_number: b.routing,
    status: 'new',
    _account_number: b.number,
  };
}

/**
 * Debit cards as external accounts (Instant Payouts). Test tokens and numbers:
 *   tok_visa_debit / 4000056655665556, tok_mastercard_debit / 5200828282828210   instant + standard
 *   tok_visa_debit_us_transferFail      payouts to this card fail (could_not_process)
 *   tok_visa_debit_us_instantPayoutUnsupported   standard payouts only
 */
const DEBIT_CARDS: Record<string, { brand: string; last4: string; instant: boolean; fail?: boolean }> = {
  tok_visa_debit: { brand: 'Visa', last4: '5556', instant: true },
  tok_mastercard_debit: { brand: 'MasterCard', last4: '8210', instant: true },
  tok_visa_debit_us_transferFail: { brand: 'Visa', last4: '0077', instant: true, fail: true },
  tok_visa_debit_us_instantPayoutUnsupported: { brand: 'Visa', last4: '0085', instant: false },
};
const DEBIT_NUMBERS: Record<string, string> = { '4000056655665556': 'tok_visa_debit', '5200828282828210': 'tok_mastercard_debit' };
type CardInput = { kind: 'card'; token: string; currency: string; exp_month: number; exp_year: number; name: string | null };

function cardObject(accountId: string, c: CardInput, isDefault: boolean) {
  const d = DEBIT_CARDS[c.token]!;
  return {
    id: newId('card', 24),
    object: 'card',
    account: accountId,
    address_city: null, address_country: null, address_line1: null, address_line2: null, address_state: null, address_zip: null,
    available_payout_methods: d.instant ? ['standard', 'instant'] : ['standard'],
    brand: d.brand,
    country: 'US',
    currency: c.currency,
    cvc_check: 'pass',
    default_for_currency: isDefault,
    exp_month: c.exp_month,
    exp_year: c.exp_year,
    fingerprint: createHmac('sha256', 'tessera-card').update(c.token).digest('base64url').slice(0, 16),
    funding: 'debit',
    last4: d.last4,
    metadata: {},
    name: c.name,
    status: 'new',
    _payout_fails: !!d.fail,
  };
}

async function resolveBankInput(ctx: Ctx, input: any, param = 'external_account'): Promise<ReturnType<typeof bankDetails> | CardInput> {
  if (typeof input === 'string') {
    if (TEST_BANK_TOKENS[input]) return bankDetails({ country: 'US', currency: 'usd', routing_number: '110000000', account_number: TEST_BANK_TOKENS[input] }, param);
    if (DEBIT_CARDS[input]) return { kind: 'card', token: input, currency: 'usd', exp_month: 12, exp_year: new Date().getFullYear() + 3, name: null };
    if (/^tok_/.test(input)) throw invalid('This card is not a debit card. Only debit cards can receive payouts; use tok_visa_debit or tok_mastercard_debit.', param, 'invalid_card_type');
    if (input.startsWith('btok_')) {
      const owner = ctx.platformAccountId ?? ctx.accountId;
      const row = await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND account_id = $2 AND type = 'token'", [input, owner]);
      if (!row) throw invalid(`No such token: '${input}'`, param, 'resource_missing');
      if (row.data.used) throw invalid(`You cannot use a Tessera token more than once: ${input}.`, param, 'token_already_used');
      row.data.used = true;
      await saveObject(owner, row.data);
      return row.data._details;
    }
    throw invalid(`Invalid external_account: pass a bank account token (btok_...), a debit card token (tok_visa_debit) or bank details.`, param);
  }
  if (typeof input !== 'object') throw invalid('Invalid external_account', param);
  if (input.object === 'card') {
    const num = String(input.number ?? '').replace(/\s/g, '');
    const token = DEBIT_NUMBERS[num];
    if (!token) throw invalid('Only debit cards can receive payouts. Test debit numbers: 4000056655665556 (Visa), 5200828282828210 (Mastercard).', `${param}[number]`, 'invalid_card_type');
    const exp_month = Number(input.exp_month), exp_year = Number(input.exp_year);
    if (!(exp_month >= 1 && exp_month <= 12) || !(exp_year >= new Date().getFullYear())) throw invalid('Your card\'s expiration date is invalid.', `${param}[exp_month]`, 'invalid_expiry_month');
    return { kind: 'card', token, currency: String(input.currency ?? 'usd').toLowerCase(), exp_month, exp_year, name: input.name ? String(input.name) : null };
  }
  if (input.object && input.object !== 'bank_account') throw invalid('external_account[object] must be bank_account or card.', `${param}[object]`);
  return bankDetails(input, param);
}

export async function addExternalAccount(ctx: Ctx, acct: any, input: any, opts: { save?: boolean; makeDefault?: boolean } = {}) {
  const b = await resolveBankInput(ctx, input);
  acct.external_accounts ??= { object: 'list', data: [], has_more: false, total_count: 0, url: `/v1/accounts/${acct.id}/external_accounts` };
  const list = acct.external_accounts.data as any[];
  if (list.length >= 10) throw invalid('This account already has the maximum number of external accounts.', 'external_account');
  const hasDefault = list.some((x) => x.currency === b.currency && x.default_for_currency);
  const ba: any = 'kind' in b ? cardObject(acct.id, b, !hasDefault || !!opts.makeDefault) : bankObject(acct.id, b, !hasDefault || !!opts.makeDefault);
  if (ba.default_for_currency) for (const x of list) if (x.currency === ba.currency) x.default_for_currency = false;
  list.unshift(ba);
  acct.external_accounts.total_count = list.length;
  if (opts.save !== false) {
    const before = structuredClone(acct);
    before.external_accounts.data = list.slice(1);
    if (acct._platform) computeRequirements(acct);
    await saveAccount(acct);
    const c = acct._platform ? connectedCtx(ctx, acct.id) : ctx;
    await emit(c, 'account.external_account.created', ba as any);
    if (acct._platform) await announce(ctx, before, acct);
  }
  return ba;
}

export async function updateExternalAccount(ctx: Ctx, acct: any, extId: string, p: Params) {
  const ba = getExternal(acct, extId);
  if (bool(p, 'default_for_currency')) {
    for (const x of acct.external_accounts.data) if (x.currency === ba.currency) x.default_for_currency = x.id === ba.id;
  }
  if (ba.object === 'card') {
    if (p.exp_month !== undefined) ba.exp_month = Number(p.exp_month);
    if (p.exp_year !== undefined) ba.exp_year = Number(p.exp_year);
    if (p.name !== undefined) ba.name = p.name || null;
  }
  if (ba.object === 'bank_account' && p.account_holder_name !== undefined) ba.account_holder_name = p.account_holder_name || null;
  if (ba.object === 'bank_account' && p.account_holder_type !== undefined) ba.account_holder_type = oneOf(p, 'account_holder_type', ['individual', 'company'] as const) ?? null;
  ba.metadata = metadata(p, ba.metadata);
  await saveAccount(acct);
  await emit(acct._platform ? connectedCtx(ctx, acct.id) : ctx, 'account.external_account.updated', ba);
  return ba;
}

export async function deleteExternalAccount(ctx: Ctx, acct: any, extId: string) {
  const ba = getExternal(acct, extId);
  const others = acct.external_accounts.data.filter((x: any) => x.id !== ba.id);
  if (ba.default_for_currency && others.some((x: any) => x.currency === ba.currency)) {
    throw invalid('You cannot delete the default external account for this currency. Make another external account the default using the default_for_currency param, and then delete this one.', 'id');
  }
  if (ba.default_for_currency && ba.currency === acct.default_currency && acct._platform) {
    throw invalid('You cannot delete the default external account for your default currency. Add another external account for this currency first.', 'id');
  }
  acct.external_accounts.data = others;
  acct.external_accounts.total_count = others.length;
  const before = structuredClone(acct);
  if (acct._platform) computeRequirements(acct);
  await saveAccount(acct);
  const c = acct._platform ? connectedCtx(ctx, acct.id) : ctx;
  await emit(c, 'account.external_account.deleted', { ...ba, deleted: true });
  if (acct._platform) await announce(ctx, before, acct);
  return { id: ba.id, object: ba.object, deleted: true };
}

export function getExternal(acct: any, extId: string) {
  const ba = acct.external_accounts.data.find((x: any) => x.id === extId);
  if (!ba) throw new ApiError(404, 'invalid_request_error', `No such external account: '${extId}'`, { param: 'id', code: 'resource_missing' });
  return ba;
}

export function defaultExternal(acct: any, currency: string) {
  return acct.external_accounts?.data.find((x: any) => x.currency === currency && x.default_for_currency);
}

// ---------------------------------------------------------------- lifecycle

export async function rejectAccount(ctx: Ctx, id: string, p: Params) {
  const acct = await connectedAccount(ctx, id);
  const reason = oneOf(p, 'reason', ['fraud', 'terms_of_service', 'other'] as const);
  if (!reason) throw missing('reason');
  const before = structuredClone(acct);
  acct._rejected = reason;
  computeRequirements(acct);
  await saveAccount(acct);
  await announce(ctx, before, acct);
  return acct;
}

/** Test-mode accounts can be deleted at any time. */
export async function deleteAccount(ctx: Ctx, id: string) {
  const acct = await connectedAccount(ctx, id);
  acct._deleted = true;
  await saveAccount(acct);
  return { id, object: 'account', deleted: true };
}

export async function listConnectedAccounts(ctx: Ctx, p: Params) {
  if (ctx.platformAccountId) throw new ApiError(400, 'invalid_request_error', 'Connected accounts cannot list accounts.');
  const limit = p.limit === undefined ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('This value must be between 1 and 100.', 'limit');
  const args: unknown[] = [ctx.accountId];
  let where = "platform = $1 AND coalesce(data->>'_deleted', 'false') <> 'true'";
  let order = 'DESC';
  const cursor = p.starting_after ?? p.ending_before;
  if (cursor) {
    const c = await one<{ created: number }>('SELECT created FROM accounts WHERE id = $1 AND platform = $2', [cursor, ctx.accountId]);
    if (!c) throw invalid(`No such account: '${cursor}'`, p.starting_after ? 'starting_after' : 'ending_before');
    args.push(c.created, cursor);
    where += p.starting_after ? ' AND (created, id) < ($2, $3)' : ' AND (created, id) > ($2, $3)';
    if (p.ending_before) order = 'ASC';
  }
  args.push(limit + 1);
  const rows = await query<{ data: any }>(`SELECT data FROM accounts WHERE ${where} ORDER BY created ${order}, id ${order} LIMIT $${args.length}`, args);
  let data = rows.slice(0, limit).map((r) => r.data);
  if (order === 'ASC') data = data.reverse();
  return { object: 'list', data, has_more: rows.length > limit, url: '/v1/accounts' };
}

// ---------------------------------------------------------------- hosted flows

export async function createAccountLink(ctx: Ctx, p: Params) {
  const acctId = str(p, 'account', { required: true })!;
  const acct = await connectedAccount(ctx, acctId);
  const type = oneOf(p, 'type', ['account_onboarding', 'account_update'] as const);
  if (!type) throw missing('type');
  if (type === 'account_update' && acct.controller.requirement_collection !== 'application') {
    throw invalid('account_update links can only be created for accounts where the platform collects requirements (custom accounts).', 'type');
  }
  const refresh = str(p, 'refresh_url', { required: true })!;
  const ret = str(p, 'return_url', { required: true })!;
  for (const [k, v] of [['refresh_url', refresh], ['return_url', ret]] as const) if (!/^https?:\/\//.test(v)) throw invalid(`Not a valid URL`, k, 'url_invalid');
  const now = nowSeconds();
  const token = base62(32);
  const link = {
    id: newId('acctlink', 16),
    object: 'account_link',
    created: now,
    expires_at: now + 300,
    livemode: false,
    url: `${ctx.baseUrl}/connect/onboarding/${token}`,
    _token: token,
    _account: acct.id,
    _type: type,
    _collect: p.collect === 'eventually_due' || p.collection_options?.fields === 'eventually_due' ? 'eventually_due' : 'currently_due',
    _refresh_url: refresh,
    _return_url: ret,
    _used: false,
  };
  await insertObject(ctx.accountId, link);
  return link;
}

export async function findLink(token: string) {
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'account_link' AND data->>'_token' = $1", [token]);
  return row;
}

export async function createLoginLink(ctx: Ctx, id: string) {
  const acct = await connectedAccount(ctx, id);
  if (acct.type !== 'express') throw invalid('Login links can only be created for Express accounts.', 'account');
  if (!acct.details_submitted) throw invalid('Cannot create a login link for an account that has not completed onboarding.', 'account');
  const now = nowSeconds();
  const token = base62(32);
  const link = { id: newId('lnk', 16), object: 'login_link', created: now, livemode: false, url: `${ctx.baseUrl}/connect/express/${token}`, _token: token, _account: id, _expires: now + 3600 };
  await insertObject(ctx.accountId, link);
  return link;
}

export async function findLoginLink(token: string) {
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'login_link' AND data->>'_token' = $1", [token]);
  if (!row || row.data._expires < nowSeconds()) return undefined;
  return row;
}

// ---------------------------------------------------------------- top-level accounts

/** Fields every top-level (platform) account needs for payouts; also upgrades older databases. */
export function ensurePlatformFields(acct: any) {
  let changed = false;
  if (!acct.external_accounts) {
    acct.external_accounts = { object: 'list', data: [], has_more: false, total_count: 0, url: `/v1/accounts/${acct.id}/external_accounts` };
    const ba = bankObject(acct.id, bankDetails({ country: acct.country ?? 'US', currency: acct.default_currency ?? 'usd', routing_number: '110000000', account_number: '000123456789', account_holder_name: acct.business_profile?.name ?? null, account_holder_type: 'company' }, 'external_account'), true);
    acct.external_accounts.data.push(ba);
    acct.external_accounts.total_count = 1;
    changed = true;
  }
  acct.settings ??= {};
  if (!acct.settings.payouts) {
    acct.settings.payouts = { debit_negative_balances: true, schedule: { delay_days: 2, interval: 'manual' }, statement_descriptor: null };
    changed = true;
  }
  if (!acct.capabilities) {
    acct.capabilities = { card_payments: 'active', transfers: 'active' };
    acct.details_submitted = true;
    acct.requirements = emptyRequirements();
    changed = true;
  }
  return changed;
}

export async function upgradeAccounts() {
  const rows = await query<{ data: any }>('SELECT data FROM accounts WHERE platform IS NULL');
  for (const { data } of rows) if (ensurePlatformFields(data)) await saveAccount(data);
}

export const SCHEDULE_SECONDS: Record<string, number> = { daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY };
void getObject;
