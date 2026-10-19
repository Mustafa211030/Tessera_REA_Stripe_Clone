import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { setConfig } from '../src/config.ts';
import { nowSeconds } from '../src/lib/ids.ts';
import { payoutsTick, runWorkersOnce } from '../src/workers/index.ts';
import { api, start, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await start();
  setConfig({ payoutInTransitSeconds: 0, payoutArrivalSeconds: 0, instantPayoutSeconds: 0 });
});
after(async () => { await env.close(); });

const as = (acct: string) => ({ 'Stripe-Account': acct });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa3c1e5a00000000049454e44ae426082', 'hex');

async function upload(purpose: string, bytes: Buffer, filename: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append('purpose', purpose);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([bytes]), filename);
  const res = await fetch(`${env.base}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${env.sk}`, ...headers }, body: fd });
  return { status: res.status, body: (await res.json()) as any };
}

describe('files', () => {
  it('uploads, serves the bytes back, validates type and purpose, and shares via expiring links', async () => {
    const f = await upload('dispute_evidence', PNG, 'receipt.png', { 'file_link_data[create]': 'true' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.match(f.body.id, /^file_/);
    assert.equal(f.body.type, 'png');
    assert.equal(f.body.size, PNG.length);
    assert.equal(f.body.filename, 'receipt.png');
    assert.equal(f.body.links.data.length, 1);

    const raw = await fetch(`${env.base}/v1/files/${f.body.id}/contents`, { headers: { authorization: `Bearer ${env.sk}` } });
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), PNG);
    const anon = await fetch(`${env.base}/v1/files/${f.body.id}/contents`);
    assert.equal(anon.status, 401);

    const pub = await fetch(f.body.links.data[0].url);
    assert.equal(pub.status, 200);
    assert.deepEqual(Buffer.from(await pub.arrayBuffer()), PNG);
    const exp = await api(env, 'POST', `/v1/file_links/${f.body.links.data[0].id}`, { expires_at: 'now' });
    assert.equal(exp.body.expired, true);
    assert.equal((await fetch(f.body.links.data[0].url)).status, 410);
    const listed = await api(env, 'GET', '/v1/file_links', { file: f.body.id, expired: 'true' });
    assert.equal(listed.body.data.length, 1);

    const wrongType = await upload('identity_document', Buffer.from('hello'), 'notes.txt');
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error.code, 'file_invalid_type');
    const badPurpose = await upload('selfies', PNG, 'x.png');
    assert.equal(badPurpose.status, 400);
    const missingFile = await api(env, 'POST', '/v1/files', { purpose: 'dispute_evidence' });
    assert.equal(missingFile.status, 400);

    const id = await upload('identity_document', PNG, 'passport.png');
    const link = await api(env, 'POST', '/v1/file_links', { file: id.body.id });
    assert.equal(link.status, 400);
    assert.equal(link.body.error.code, 'file_link_not_allowed');
    const byPurpose = await api(env, 'GET', '/v1/files', { purpose: 'identity_document' });
    assert.deepEqual(byPurpose.body.data.map((x: any) => x.id), [id.body.id]);
  });

  it('attaches uploaded files as dispute evidence', async () => {
    const pi = await api(env, 'POST', '/v1/payment_intents', { amount: 4000, currency: 'usd', payment_method: 'pm_card_createDispute', confirm: 'true' });
    const dp = (await api(env, 'GET', '/v1/disputes', { payment_intent: pi.body.id })).body.data[0];
    const receipt = await upload('dispute_evidence', PNG, 'receipt.png');
    const idDoc = await upload('identity_document', PNG, 'id.png');
    const wrong = await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { receipt: idDoc.body.id }, submit: 'false' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'file_purpose_invalid');
    const missing = await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { receipt: 'file_nope' }, submit: 'false' });
    assert.equal(missing.status, 400);
    const ok = await api(env, 'POST', `/v1/disputes/${dp.id}`, { evidence: { receipt: receipt.body.id, uncategorized_text: 'winning_evidence' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.evidence.receipt, receipt.body.id);
    const exp = await api(env, 'GET', `/v1/disputes/${dp.id}`, { 'expand[]': 'evidence.receipt' });
    assert.equal(exp.body.evidence.receipt.filename, 'receipt.png');
  });
});

const COMPANY = {
  type: 'custom',
  country: 'US',
  business_type: 'company',
  capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
  business_profile: { mcc: '5734', url: 'https://rosen.example.com' },
  company: { name: 'Rosen Ceramics LLC', tax_id: '000000000', phone: '+15555550100', address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105' } },
  tos_acceptance: { date: 1700000000, ip: '127.0.0.1' },
  external_account: 'btok_us_verified',
  settings: { payouts: { schedule: { interval: 'manual' } } },
};
const REP = {
  first_name: 'Jenny', last_name: 'Rosen', email: 'jenny@example.com', phone: '+15555550100',
  dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
  address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105' },
  relationship: { representative: 'true', executive: 'true', owner: 'true', percent_ownership: '60', title: 'CEO' },
};

describe('persons', () => {
  it('company accounts need a representative and owners before they are enabled', async () => {
    const a = (await api(env, 'POST', '/v1/accounts', COMPANY)).body;
    assert.equal(a.charges_enabled, false);
    assert.ok(a.requirements.currently_due.includes('representative.first_name'));
    assert.ok(a.requirements.currently_due.includes('company.owners_provided'));

    const rep = await api(env, 'POST', `/v1/accounts/${a.id}/persons`, { ...REP, dob: { day: 1, month: 1, year: 1902 } });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    assert.match(rep.body.id, /^person_/);
    assert.equal(rep.body.verification.status, 'unverified');
    assert.equal(rep.body.ssn_last_4_provided, true);
    assert.equal(rep.body.ssn_last_4, undefined);
    let acct = (await api(env, 'GET', `/v1/accounts/${a.id}`)).body;
    assert.ok(acct.requirements.currently_due.includes(`${rep.body.id}.verification.document`));
    assert.ok(!acct.requirements.currently_due.some((k: string) => k.startsWith('representative.')));

    // An uploaded identity document (purpose identity_document) verifies the representative.
    const doc = await upload('identity_document', PNG, 'passport.png', {}, as(a.id));
    assert.equal(doc.status, 200, JSON.stringify(doc.body));
    const failDoc = await upload('identity_document', PNG, 'passport-fail.png', {}, as(a.id));
    const bad = await api(env, 'POST', `/v1/accounts/${a.id}/persons/${rep.body.id}`, { verification: { document: { front: failDoc.body.id } } });
    assert.equal(bad.status, 200, JSON.stringify(bad.body));
    assert.equal(bad.body.verification.status, 'unverified');
    assert.equal(bad.body.verification.document.details_code, 'document_failed_greyscale');
    const wrongPurpose = await upload('dispute_evidence', PNG, 'r.png', {}, as(a.id));
    const rejected = await api(env, 'POST', `/v1/accounts/${a.id}/persons/${rep.body.id}`, { verification: { document: { front: wrongPurpose.body.id } } });
    assert.equal(rejected.status, 400);
    const good = await api(env, 'POST', `/v1/accounts/${a.id}/persons/${rep.body.id}`, { verification: { document: { front: doc.body.id } } });
    assert.equal(good.body.verification.status, 'verified');

    const owner = await api(env, 'POST', `/v1/accounts/${a.id}/persons`, { first_name: 'Sam', relationship: { owner: 'true', percent_ownership: '40' } });
    assert.equal(owner.status, 200);
    const tooMuch = await api(env, 'POST', `/v1/accounts/${a.id}/persons`, { first_name: 'Max', last_name: 'Extra', relationship: { owner: 'true', percent_ownership: '10' } });
    assert.equal(tooMuch.status, 400);
    acct = (await api(env, 'GET', `/v1/accounts/${a.id}`)).body;
    assert.ok(acct.requirements.currently_due.includes(`${owner.body.id}.last_name`));
    await api(env, 'POST', `/v1/accounts/${a.id}/persons/${owner.body.id}`, { last_name: 'Lee' });
    acct = (await api(env, 'POST', `/v1/accounts/${a.id}`, { company: { owners_provided: 'true' } })).body;
    assert.deepEqual(acct.requirements.currently_due, []);
    assert.equal(acct.charges_enabled, true);
    assert.equal(acct.company.owners_provided, true);

    const owners = await api(env, 'GET', `/v1/accounts/${a.id}/persons`, { relationship: { owner: 'true' } });
    assert.equal(owners.body.data.length, 2);
    const reps = await api(env, 'GET', `/v1/accounts/${a.id}/people`, { relationship: { representative: 'true' } });
    assert.deepEqual(reps.body.data.map((x: any) => x.id), [rep.body.id]);
    const delRep = await api(env, 'DELETE', `/v1/accounts/${a.id}/persons/${rep.body.id}`);
    assert.equal(delRep.status, 400);
    const del = await api(env, 'DELETE', `/v1/accounts/${a.id}/persons/${owner.body.id}`);
    assert.deepEqual(del.body, { id: owner.body.id, object: 'person', deleted: true });

    const ind = (await api(env, 'POST', '/v1/accounts', { type: 'custom', country: 'US', business_type: 'individual', capabilities: { transfers: { requested: 'true' } } })).body;
    const nope = await api(env, 'POST', `/v1/accounts/${ind.id}/persons`, { first_name: 'X' });
    assert.equal(nope.status, 400);
  });
});

describe('instant payouts', () => {
  it('pays out to a debit card in seconds for a 1.5% fee', async () => {
    const a = (await api(env, 'POST', '/v1/accounts', { ...COMPANY, business_type: 'individual', company: undefined, individual: { ...REP, relationship: undefined } })).body;
    assert.equal(a.payouts_enabled, true, JSON.stringify(a.requirements));
    const pm = await api(env, 'POST', '/v1/payment_methods', { type: 'card', card: { number: '4000000000000077', exp_month: 12, exp_year: 2034, cvc: '123' } }, as(a.id));
    await api(env, 'POST', '/v1/payment_intents', { amount: 50000, currency: 'usd', payment_method: pm.body.id, confirm: 'true' }, as(a.id));

    const toBank = await api(env, 'POST', '/v1/payouts', { amount: 1000, currency: 'usd', method: 'instant' }, as(a.id));
    assert.equal(toBank.status, 400);
    assert.equal(toBank.body.error.code, 'instant_payouts_unsupported');
    const credit = await api(env, 'POST', `/v1/accounts/${a.id}/external_accounts`, { external_account: 'tok_visa' });
    assert.equal(credit.status, 400);
    const card = await api(env, 'POST', `/v1/accounts/${a.id}/external_accounts`, { external_account: 'tok_visa_debit' });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    assert.equal(card.body.object, 'card');
    assert.deepEqual(card.body.available_payout_methods, ['standard', 'instant']);

    const bal = (await api(env, 'GET', '/v1/balance', undefined, as(a.id))).body;
    const avail = bal.available[0].amount;
    assert.equal(bal.instant_available[0].amount, avail);

    const po = await api(env, 'POST', '/v1/payouts', { amount: 20000, currency: 'usd', method: 'instant' }, as(a.id));
    assert.equal(po.status, 200, JSON.stringify(po.body));
    assert.equal(po.body.method, 'instant');
    assert.equal(po.body.destination, card.body.id);
    assert.equal(po.body.type, 'card');
    const txn = (await api(env, 'GET', `/v1/balance_transactions/${po.body.balance_transaction}`, undefined, as(a.id))).body;
    assert.equal(txn.fee, 300);
    assert.equal(txn.net, -20300);
    const after1 = (await api(env, 'GET', '/v1/balance', undefined, as(a.id))).body.available[0].amount;
    assert.equal(after1, avail - 20300);
    await payoutsTick(nowSeconds() + 1);
    assert.equal((await api(env, 'GET', `/v1/payouts/${po.body.id}`, undefined, as(a.id))).body.status, 'paid');

    const small = await api(env, 'POST', '/v1/payouts', { amount: 1000, currency: 'usd', method: 'instant' }, as(a.id));
    assert.equal((await api(env, 'GET', `/v1/balance_transactions/${small.body.balance_transaction}`, undefined, as(a.id))).body.fee, 50, 'minimum fee');

    const failing = await api(env, 'POST', `/v1/accounts/${a.id}/external_accounts`, { external_account: 'tok_visa_debit_us_transferFail' });
    const before2 = (await api(env, 'GET', '/v1/balance', undefined, as(a.id))).body.available[0].amount;
    const f = await api(env, 'POST', '/v1/payouts', { amount: 5000, currency: 'usd', method: 'instant', destination: failing.body.id }, as(a.id));
    await payoutsTick(nowSeconds() + 1);
    const failed = (await api(env, 'GET', `/v1/payouts/${f.body.id}`, undefined, as(a.id))).body;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure_code, 'could_not_process');
    assert.equal((await api(env, 'GET', '/v1/balance', undefined, as(a.id))).body.available[0].amount, before2, 'amount and fee returned');
  });
});

describe('sigma', () => {
  it('runs read-only SQL over the account\'s own data', async () => {
    const cus = await api(env, 'POST', '/v1/customers', { email: 'sql@example.com' });
    for (const amount of [1000, 2500]) await api(env, 'POST', '/v1/payment_intents', { amount, currency: 'usd', customer: cus.body.id, payment_method: 'pm_card_visa', confirm: 'true' });
    const r = await api(env, 'POST', '/v1/tessera/sigma/query', { sql: `SELECT customer_id, count(*) AS n, sum(amount) AS total, max(created) AS last FROM charges WHERE customer_id = '${cus.body.id}' GROUP BY 1` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.columns, ['customer_id', 'n', 'total', 'last']);
    assert.equal(r.body.rows[0][1], 2);
    assert.equal(Number(r.body.rows[0][2]), 3500);
    assert.match(r.body.rows[0][3], /^\d{4}-\d{2}-\d{2}T/);

    const json = await api(env, 'POST', '/v1/tessera/sigma/query', { sql: "SELECT payment_method_details->'card'->>'brand' AS brand FROM charges LIMIT 1" });
    assert.equal(json.body.rows[0][0], 'visa');
    const bad = await api(env, 'POST', '/v1/tessera/sigma/query', { sql: 'SELECT nope FROM charges' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'sql_error');
    const multi = await api(env, 'POST', '/v1/tessera/sigma/query', { sql: 'SELECT 1; DROP TABLE charges' });
    assert.equal(multi.status, 400);
    const other = await api(env, 'POST', '/v1/tessera/sigma/query', { sql: 'SELECT count(*) FROM objects' });
    assert.equal(other.status, 400, 'only the snapshot tables exist');
    const big = await api(env, 'POST', '/v1/tessera/sigma/query', { sql: 'SELECT g FROM generate_series(1, 5000) g' });
    assert.equal(big.body.row_count, 1000);
    assert.equal(big.body.truncated, true);
    const schema = await api(env, 'GET', '/v1/tessera/sigma/schema');
    const charges = schema.body.data.find((t: any) => t.table === 'charges');
    assert.ok(charges.columns.some((c: any) => c.name === 'customer_id' && c.type === 'text'));
    assert.ok(charges.columns.some((c: any) => c.name === 'created' && c.type === 'timestamptz'));
  });
});

describe('webhook endpoint api versions', () => {
  it('renders events in the endpoint\'s pinned version', async () => {
    const bad = await api(env, 'POST', '/v1/webhook_endpoints', { url: 'http://127.0.0.1:9/x', enabled_events: ['*'], api_version: 'yesterday' });
    assert.equal(bad.status, 400);
    const got: Record<string, any> = {};
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { got[req.url!] = JSON.parse(body); res.end('ok'); });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const old = await api(env, 'POST', '/v1/webhook_endpoints', { url: `http://127.0.0.1:${port}/old`, enabled_events: ['payment_intent.created'], api_version: '2025-09-30' });
    assert.equal(old.body.api_version, '2025-09-30');
    await api(env, 'POST', '/v1/webhook_endpoints', { url: `http://127.0.0.1:${port}/new`, enabled_events: ['payment_intent.created'] });
    await api(env, 'POST', '/v1/payment_intents', { amount: 700, currency: 'usd' });
    await runWorkersOnce();
    srv.close();
    assert.equal(got['/old'].api_version, '2025-09-30');
    assert.equal('allowed_payment_method_types' in got['/old'].data.object, false);
    assert.ok('allowed_payment_method_types' in got['/new'].data.object);
  });
});
