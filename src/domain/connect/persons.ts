import { ApiError, invalid } from '../../lib/errors.ts';
import { metadata, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { emit } from '../events.ts';
import { announce, applyPersonFields, checkPersonDocuments, computeRequirements, connectedAccount, connectedCtx, newPerson, saveAccount } from './accounts.ts';

/**
 * Persons API: the people behind a company account (representative, owners, directors,
 * executives). Persons are stored on the account document so requirements can be computed
 * synchronously; they are served as standalone `person` objects.
 *
 *   POST   /v1/accounts/:id/persons         create
 *   GET    /v1/accounts/:id/persons         list (relationship[owner]=true, ...)
 *   GET    /v1/accounts/:id/persons/:pid    retrieve
 *   POST   /v1/accounts/:id/persons/:pid    update
 *   DELETE /v1/accounts/:id/persons/:pid    delete
 */

const ROLES = ['representative', 'owner', 'director', 'executive'] as const;

async function load(ctx: Ctx, accountId: string) {
  const acct = await connectedAccount(ctx, accountId, 'account');
  if (acct.business_type === 'individual') {
    throw new ApiError(400, 'invalid_request_error', 'Persons can only be added to accounts whose business_type is company, non_profit or government_entity. For individuals, update account[individual] instead.', { code: 'account_invalid' });
  }
  acct._persons ??= [];
  return acct;
}

function find(acct: any, personId: string) {
  const p = (acct._persons as any[]).find((x) => x.id === personId);
  if (!p) throw new ApiError(404, 'invalid_request_error', `No such person: '${personId}'`, { param: 'person', code: 'resource_missing' });
  return p;
}

function guardOwnership(acct: any) {
  const total = (acct._persons as any[]).reduce((s, x) => s + (x.relationship.percent_ownership ?? 0), 0);
  if (total > 100) throw invalid(`The owners' percent_ownership adds up to ${total}%, which is more than 100%.`, 'relationship[percent_ownership]');
}

async function commit(ctx: Ctx, before: any, acct: any) {
  guardOwnership(acct);
  computeRequirements(acct);
  await saveAccount(acct);
  await announce(ctx, before, acct);
}

export async function createPerson(ctx: Ctx, accountId: string, p: Params) {
  const acct = await load(ctx, accountId);
  const before = structuredClone(acct);
  await checkPersonDocuments(ctx, p, 'person', acct.id);
  const person = newPerson(acct);
  applyPersonFields(person, p, 'person');
  person.metadata = metadata(p);
  if (person.relationship.representative) for (const x of acct._persons) x.relationship.representative = false;
  acct._persons.unshift(person);
  await commit(ctx, before, acct);
  await emit(connectedCtx(ctx, acct.id), 'person.created', person);
  return person;
}

export async function getPerson(ctx: Ctx, accountId: string, personId: string) {
  return find(await load(ctx, accountId), personId);
}

export async function updatePerson(ctx: Ctx, accountId: string, personId: string, p: Params) {
  const acct = await load(ctx, accountId);
  const before = structuredClone(acct);
  const person = find(acct, personId);
  const prev = structuredClone(person);
  await checkPersonDocuments(ctx, p, 'person', acct.id);
  applyPersonFields(person, p, 'person');
  person.metadata = metadata(p, person.metadata);
  if (person.relationship.representative && !prev.relationship.representative) {
    for (const x of acct._persons) if (x !== person) x.relationship.representative = false;
  }
  await commit(ctx, before, acct);
  await emit(connectedCtx(ctx, acct.id), 'person.updated', person, { relationship: prev.relationship, verification: prev.verification });
  return person;
}

export async function deletePerson(ctx: Ctx, accountId: string, personId: string) {
  const acct = await load(ctx, accountId);
  const before = structuredClone(acct);
  const person = find(acct, personId);
  if (person.relationship.representative && acct.charges_enabled) {
    throw new ApiError(400, 'invalid_request_error', 'You cannot delete the representative of an active account. Designate another person as the representative first.', { code: 'person_is_representative' });
  }
  acct._persons = acct._persons.filter((x: any) => x.id !== person.id);
  await commit(ctx, before, acct);
  await emit(connectedCtx(ctx, acct.id), 'person.deleted', { ...person, deleted: true });
  return { id: person.id, object: 'person', deleted: true };
}

export async function listPersons(ctx: Ctx, accountId: string, p: Params) {
  const acct = await load(ctx, accountId);
  let data: any[] = acct._persons;
  const rel = p.relationship && typeof p.relationship === 'object' ? p.relationship : {};
  for (const r of ROLES) {
    if (rel[r] === undefined) continue;
    const want = rel[r] === true || rel[r] === 'true';
    data = data.filter((x) => !!x.relationship[r] === want);
  }
  const limit = p.limit === undefined ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('This value must be between 1 and 100.', 'limit');
  let start = 0;
  if (p.starting_after) start = data.findIndex((x) => x.id === p.starting_after) + 1;
  let end = start + limit;
  if (p.ending_before) {
    end = data.findIndex((x) => x.id === p.ending_before);
    start = Math.max(0, end - limit);
  }
  return { object: 'list', data: data.slice(start, end), has_more: end < data.length, url: `/v1/accounts/${acct.id}/persons` };
}
