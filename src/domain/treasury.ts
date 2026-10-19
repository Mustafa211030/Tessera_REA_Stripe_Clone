import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { query } from '../db/index.ts';
import { ApiError, invalid, missing } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { int, metadata, oneOf, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { accountCtx } from './connect/accounts.ts';
import { emit } from './events.ts';
import { balances, post } from './ledger.ts';
import { ACH_TEST_OUTCOMES, buildBankAccount, resolvePaymentMethod } from './paymentMethods.ts';
import { findObject, getObject, insertObject, saveObject } from './store.ts';

/**
 * Treasury: financial accounts that hold money and move it in and out.
 *
 * A financial account has an ABA address (routing + account number) and three balances:
 * `cash` (spendable), `inbound_pending` (pulled in, not yet settled) and `outbound_pending`
 * (sent, not yet posted). Money moves through flows:
 *
 *   InboundTransfer   pull from your bank account (ACH)       inbound_pending → cash
 *   OutboundTransfer  push to your own bank account           cash → outbound_pending → posted
 *   OutboundPayment   pay a third party (ACH / wire / another financial account)
 *   ReceivedCredit    money someone sent to the ABA address   → cash
 *   ReceivedDebit     someone pulled from the ABA address     cash →
 *
 * Every flow has a Transaction whose TransactionEntries record each balance impact. Flows
 * settle on their own a few seconds later (test-mode ACH); test helpers can succeed, fail,
 * post or return them on demand. Test bank account numbers decide failures (see
 * ACH_TEST_OUTCOMES). Each balance is a ledger account, so the books always balance.
 */

type Impact = { cash?: number; inbound_pending?: number; outbound_pending?: number };
const LEDGER = { cash: 'fa_cash', inbound_pending: 'fa_inbound', outbound_pending: 'fa_outbound' } as const;
const FEATURES = ['card_issuing', 'deposit_insurance', 'financial_addresses.aba', 'inbound_transfers.ach', 'intra_stripe_flows', 'outbound_payments.ach', 'outbound_payments.us_domestic_wire', 'outbound_transfers.ach', 'outbound_transfers.us_domestic_wire'];

// ---------------- financial accounts ----------------

function requestedFeatures(f: any): string[] {
  if (!f || typeof f !== 'object') return [...FEATURES];
  const out: string[] = [];
  for (const name of FEATURES) {
    const [a, b] = name.split('.');
    const v = b ? f[a!]?.[b!]?.requested : f[a!]?.requested;
    if (v === true || v === 'true') out.push(name);
  }
  return out;
}

export async function createFinancialAccount(ctx: Ctx, p: Params) {
  const curs = Array.isArray(p.supported_currencies) ? p.supported_currencies.map(String) : ['usd'];
  if (curs.some((c) => c !== 'usd')) throw invalid('Financial accounts support usd only.', 'supported_currencies');
  const id = newId('fa');
  const features = requestedFeatures(p.features);
  const acct = await one(ctx.accountId);
  const accountNumber = '0' + BigInt('0x' + createHash('sha256').update(id).digest('hex').slice(0, 12)).toString().slice(0, 11).padStart(11, '7');
  const fa = {
    id,
    object: 'treasury.financial_account',
    active_features: features,
    balance: { cash: { usd: 0 }, inbound_pending: { usd: 0 }, outbound_pending: { usd: 0 } },
    country: 'US',
    created: nowSeconds(),
    financial_addresses: features.includes('financial_addresses.aba')
      ? [{ aba: { account_holder_name: acct, account_number: null as string | null, account_number_last4: accountNumber.slice(-4), bank_name: 'Tessera Test Bank', routing_number: '110000000' }, supported_networks: ['ach', 'us_domestic_wire'], type: 'aba' }]
      : [],
    is_default: !(await query("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'treasury.financial_account' LIMIT 1", [ctx.accountId])).length,
    livemode: false,
    metadata: metadata(p),
    nickname: str(p, 'nickname', { max: 100 }) ?? null,
    pending_features: [],
    platform_restrictions: { inbound_flows: oneOf(p.platform_restrictions ?? {}, 'inbound_flows', ['restricted', 'unrestricted'] as const) ?? null, outbound_flows: oneOf(p.platform_restrictions ?? {}, 'outbound_flows', ['restricted', 'unrestricted'] as const) ?? null },
    restricted_features: [],
    status: 'open',
    status_details: { closed: null as any },
    supported_currencies: ['usd'],
    _account_number: accountNumber,
  };
  await insertObject(ctx.accountId, fa);
  await emit(ctx, 'treasury.financial_account.created', await present(ctx.accountId, fa));
  return fa;
}

async function one(accountId: string) {
  const rows = await query<{ data: any }>('SELECT data FROM accounts WHERE id = $1', [accountId]);
  const a = rows[0]?.data;
  return a?.business_profile?.name ?? a?.settings?.dashboard?.display_name ?? 'Account holder';
}

/** API view: live balances; the full account number only when expanded. */
export async function present(accountId: string, fa: any, expand?: any) {
  const paths: string[] = Array.isArray(expand) ? expand : expand ? [expand] : [];
  const b = await balances(accountId);
  const bal = (k: keyof typeof LEDGER) => ({ usd: -(b[`${LEDGER[k]}:${fa.id}`]?.usd ?? 0) });
  const showNumber = paths.some((x) => x.includes('financial_addresses.aba.account_number'));
  return {
    ...fa,
    balance: { cash: bal('cash'), inbound_pending: bal('inbound_pending'), outbound_pending: bal('outbound_pending') },
    financial_addresses: fa.financial_addresses.map((a: any) => ({ ...a, aba: { ...a.aba, account_number: showNumber ? fa._account_number : null } })),
  };
}

export async function updateFinancialAccount(ctx: Ctx, id: string, p: Params) {
  const fa = await getFa(ctx, id);
  if (p.nickname !== undefined) fa.nickname = p.nickname || null;
  if (p.features) fa.active_features = requestedFeatures({ ...Object.fromEntries(FEATURES.map((f) => f.split('.')).map(([a, b]) => [a, b ? { [b]: { requested: fa.active_features.includes(`${a}.${b}`) } } : { requested: fa.active_features.includes(a!) }])), ...p.features });
  fa.metadata = metadata(p, fa.metadata);
  await saveObject(ctx.accountId, fa);
  await emit(ctx, 'treasury.financial_account.features_status_updated', await present(ctx.accountId, fa));
  return fa;
}

export async function closeFinancialAccount(ctx: Ctx, id: string) {
  const fa = await getFa(ctx, id);
  const v = await present(ctx.accountId, fa);
  if (v.balance.cash.usd || v.balance.inbound_pending.usd || v.balance.outbound_pending.usd) throw invalid('Move all funds out of the financial account before closing it.', 'financial_account', 'financial_account_not_empty');
  fa.status = 'closed';
  fa.status_details = { closed: { reasons: ['closed_by_platform'] } };
  fa.active_features = [];
  await saveObject(ctx.accountId, fa);
  return fa;
}

async function getFa(ctx: Ctx, id: string, param = 'financial_account') {
  const fa = await getObject<any>(ctx.accountId, 'treasury.financial_account', id, 'treasury.financial_account', param);
  return fa;
}

function requireOpen(fa: any, feature: string, param = 'financial_account') {
  if (fa.status !== 'open') throw invalid('This financial account is closed.', param, 'financial_account_closed');
  if (!fa.active_features.includes(feature)) throw invalid(`The financial account does not have the ${feature} feature active.`, param, 'financial_account_capability_not_enabled');
}

async function cashOf(accountId: string, faId: string) {
  const b = await balances(accountId);
  return -(b[`fa_cash:${faId}`]?.usd ?? 0);
}

// ---------------- transactions and entries ----------------

async function openTransaction(ctx: Ctx, fa: any, flowType: string, flow: string, amount: number, description: string) {
  const t = {
    id: newId('trxn'), object: 'treasury.transaction', amount, balance_impact: { cash: 0, inbound_pending: 0, outbound_pending: 0 }, created: nowSeconds(), currency: 'usd',
    description, entries: { object: 'list', data: [] as string[], has_more: false, url: '' }, financial_account: fa.id, flow, flow_details: null, flow_type: flowType, livemode: false,
    status: 'open', status_transitions: { posted_at: null as number | null, void_at: null as number | null },
  };
  t.entries.url = `/v1/treasury/transaction_entries?transaction=${t.id}`;
  await insertObject(ctx.accountId, t);
  return t;
}

/** Applies a balance impact to a financial account and records an entry; `counter` balances the ledger. */
async function impact(ctx: Ctx, faId: string, trxnId: string, entryType: string, imp: Impact, counter: { account: string; amount: number }[] | null) {
  // counter === null: the ledger movement was posted by the caller (one group spanning two financial accounts).
  const entries = Object.entries(imp).filter(([, v]) => v).map(([k, v]) => ({ account: `${LEDGER[k as keyof Impact]}:${faId}`, amount: -(v as number) }));
  if (counter) await post(ctx.accountId, 'usd', [...entries, ...counter], trxnId, `Treasury ${entryType} on ${faId}`);
  const t = await getObject<any>(ctx.accountId, 'treasury.transaction', trxnId);
  for (const [k, v] of Object.entries(imp)) t.balance_impact[k] += v ?? 0;
  const e = {
    id: newId('trxne'), object: 'treasury.transaction_entry', balance_impact: { cash: imp.cash ?? 0, inbound_pending: imp.inbound_pending ?? 0, outbound_pending: imp.outbound_pending ?? 0 },
    created: nowSeconds(), currency: 'usd', effective_at: nowSeconds(), financial_account: faId, flow: t.flow, flow_details: null, flow_type: t.flow_type, livemode: false, transaction: trxnId, type: entryType,
  };
  await insertObject(ctx.accountId, e);
  t.entries.data.push(e.id);
  await saveObject(ctx.accountId, t);
}

async function closeTransaction(ctx: Ctx, trxnId: string, how: 'posted' | 'void') {
  const t = await getObject<any>(ctx.accountId, 'treasury.transaction', trxnId);
  t.status = how;
  t.status_transitions[how === 'posted' ? 'posted_at' : 'void_at'] = nowSeconds();
  t.amount = t.balance_impact.cash;
  await saveObject(ctx.accountId, t);
}

const pmDetails = (pm: any) => ({ billing_details: pm.billing_details, type: 'us_bank_account', us_bank_account: { account_holder_type: pm.us_bank_account.account_holder_type, account_type: pm.us_bank_account.account_type, bank_name: pm.us_bank_account.bank_name, fingerprint: pm.us_bank_account.fingerprint, last4: pm.us_bank_account.last4, network: 'ach', routing_number: pm.us_bank_account.routing_number } });

async function bankPm(ctx: Ctx, id: string, param: string) {
  const pm = await resolvePaymentMethod(ctx, id, param);
  if (pm.type !== 'us_bank_account') throw invalid('This flow needs a us_bank_account payment method.', param, 'payment_method_unsupported_type');
  return pm;
}

// ---------------- inbound transfers ----------------

export async function createInboundTransfer(ctx: Ctx, p: Params) {
  const fa = await getFa(ctx, str(p, 'financial_account', { required: true })!);
  requireOpen(fa, 'inbound_transfers.ach');
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  if ((str(p, 'currency') ?? 'usd') !== 'usd') throw invalid('Only usd is supported.', 'currency');
  const pm = await bankPm(ctx, str(p, 'origin_payment_method', { required: true })!, 'origin_payment_method');
  const id = newId('ibt');
  const t = await openTransaction(ctx, fa, 'inbound_transfer', id, amount, str(p, 'description') ?? 'InboundTransfer');
  const ibt = {
    id, object: 'treasury.inbound_transfer', amount, cancelable: true, created: nowSeconds(), currency: 'usd', description: str(p, 'description') ?? null,
    failure_details: null as any, financial_account: fa.id, hosted_regulatory_receipt_url: `${ctx.baseUrl}/treasury/receipts/${id}`, linked_flows: { received_debit: null },
    livemode: false, metadata: metadata(p), origin_payment_method: pm.id, origin_payment_method_details: pmDetails(pm), returned: false,
    statement_descriptor: str(p, 'statement_descriptor', { max: 10 }) ?? 'transfer', status: 'processing',
    status_transitions: { canceled_at: null as number | null, failed_at: null as number | null, succeeded_at: null as number | null }, transaction: t.id,
    _settle_at: nowSeconds() + config.treasurySettleSeconds,
  };
  await impact(ctx, fa.id, t.id, 'inbound_transfer', { inbound_pending: amount }, [{ account: 'ach_receivable', amount }]);
  await insertObject(ctx.accountId, ibt);
  await emit(ctx, 'treasury.inbound_transfer.created', ibt);
  return ibt;
}

export async function finishInboundTransfer(ctx: Ctx, id: string, outcome: 'succeed' | 'fail' | 'cancel', failureCode?: string) {
  const ibt = await getObject<any>(ctx.accountId, 'treasury.inbound_transfer', id, 'treasury.inbound_transfer');
  if (ibt.status !== 'processing') throw invalid(`This InboundTransfer is ${ibt.status}.`, 'inbound_transfer', 'treasury_inbound_transfer_unexpected_state');
  const now = nowSeconds();
  if (outcome === 'succeed') {
    await impact(ctx, ibt.financial_account, ibt.transaction, 'inbound_transfer', { inbound_pending: -ibt.amount, cash: ibt.amount }, []);
    await post(ctx.accountId, 'usd', [{ account: 'cash', amount: ibt.amount }, { account: 'ach_receivable', amount: -ibt.amount }], ibt.id, `ACH settlement ${ibt.id}`);
    ibt.status = 'succeeded';
    ibt.status_transitions.succeeded_at = now;
    await closeTransaction(ctx, ibt.transaction, 'posted');
  } else {
    await impact(ctx, ibt.financial_account, ibt.transaction, outcome === 'cancel' ? 'inbound_transfer_cancellation' : 'inbound_transfer_return', { inbound_pending: -ibt.amount }, [{ account: 'ach_receivable', amount: -ibt.amount }]);
    ibt.status = outcome === 'cancel' ? 'canceled' : 'failed';
    ibt.status_transitions[outcome === 'cancel' ? 'canceled_at' : 'failed_at'] = now;
    if (outcome === 'fail') ibt.failure_details = { code: failureCode ?? 'account_closed' };
    await closeTransaction(ctx, ibt.transaction, 'void');
  }
  ibt.cancelable = false;
  await saveObject(ctx.accountId, ibt);
  await emit(ctx, `treasury.inbound_transfer.${ibt.status}`, ibt);
  return ibt;
}

/** Test helper: an InboundTransfer that already succeeded is returned (the bank reverses the debit). */
export async function returnInboundTransfer(ctx: Ctx, id: string) {
  const ibt = await getObject<any>(ctx.accountId, 'treasury.inbound_transfer', id, 'treasury.inbound_transfer');
  if (ibt.status !== 'succeeded' || ibt.returned) throw invalid('Only a succeeded InboundTransfer can be returned, once.', 'inbound_transfer');
  const t = await openTransaction(ctx, { id: ibt.financial_account }, 'received_debit', ibt.id, -ibt.amount, `Return of ${ibt.id}`);
  await impact(ctx, ibt.financial_account, t.id, 'received_debit', { cash: -ibt.amount }, [{ account: 'cash', amount: -ibt.amount }]);
  await closeTransaction(ctx, t.id, 'posted');
  ibt.returned = true;
  await saveObject(ctx.accountId, ibt);
  await emit(ctx, 'treasury.inbound_transfer.updated', ibt);
  return ibt;
}

// ---------------- outbound payments and transfers ----------------

async function outbound(ctx: Ctx, p: Params, kind: 'payment' | 'transfer') {
  const fa = await getFa(ctx, str(p, 'financial_account', { required: true })!);
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  if ((str(p, 'currency') ?? 'usd') !== 'usd') throw invalid('Only usd is supported.', 'currency');
  let dest: any = null;
  let destFa: any = null;
  let network = 'ach';
  if (kind === 'payment' && p.destination_payment_method_data?.type === 'financial_account') {
    destFa = await getFa(ctx, String(p.destination_payment_method_data.financial_account), 'destination_payment_method_data[financial_account]');
    if (destFa.id === fa.id) throw invalid('The destination must be a different financial account.', 'destination_payment_method_data[financial_account]');
    requireOpen(fa, 'intra_stripe_flows');
    network = 'stripe';
  } else if (p.destination_payment_method) {
    dest = await bankPm(ctx, String(p.destination_payment_method), 'destination_payment_method');
  } else if (p.destination_payment_method_data?.type === 'us_bank_account') {
    dest = await buildBankAccount(ctx, p.destination_payment_method_data);
  } else throw missing('destination_payment_method');
  if (network !== 'stripe') {
    network = p.destination_payment_method_options?.us_bank_account?.network === 'us_domestic_wire' ? 'us_domestic_wire' : 'ach';
    requireOpen(fa, `outbound_${kind}s.${network}`);
  }
  if ((await cashOf(ctx.accountId, fa.id)) < amount) throw new ApiError(400, 'invalid_request_error', 'The financial account does not have enough cash for this payment.', { code: 'insufficient_funds', param: 'amount' });
  const id = newId(kind === 'payment' ? 'obp' : 'obt');
  const t = await openTransaction(ctx, fa, `outbound_${kind}`, id, -amount, str(p, 'description') ?? (kind === 'payment' ? 'OutboundPayment' : 'OutboundTransfer'));
  await impact(ctx, fa.id, t.id, `outbound_${kind}`, { cash: -amount, outbound_pending: amount }, []);
  const now = nowSeconds();
  const obj: any = {
    id, object: `treasury.outbound_${kind}`, amount, cancelable: network !== 'stripe', created: now, currency: 'usd', description: str(p, 'description') ?? null,
    expected_arrival_date: now + (network === 'ach' ? 2 * 86400 : 0), financial_account: fa.id, hosted_regulatory_receipt_url: `${ctx.baseUrl}/treasury/receipts/${id}`,
    livemode: false, metadata: metadata(p), returned_details: null, statement_descriptor: str(p, 'statement_descriptor', { max: 10 }) ?? (kind === 'payment' ? 'payment' : 'transfer'),
    status: 'processing', status_transitions: { canceled_at: null, failed_at: null, posted_at: null, returned_at: null } as Record<string, number | null>,
    tracking_details: null, transaction: t.id,
    _settle_at: network === 'stripe' ? now : now + config.treasurySettleSeconds, _network: network, _dest_fa: destFa?.id ?? null, _dest_account: dest?._account_number ?? null,
  };
  if (kind === 'payment') {
    obj.customer = str(p, 'customer') ?? null;
    obj.end_user_details = { ip_address: p.end_user_details?.ip_address ?? null, present: String(p.end_user_details?.present ?? 'false') === 'true' };
    obj.destination_payment_method = dest?.id ?? null;
  } else obj.destination_payment_method = dest.id;
  obj.destination_payment_method_details = destFa
    ? { billing_details: { address: null, email: null, name: null }, financial_account: { id: destFa.id, network: 'stripe' }, type: 'financial_account' }
    : { ...pmDetails(dest), us_bank_account: { ...pmDetails(dest).us_bank_account, network } };
  await insertObject(ctx.accountId, obj);
  await emit(ctx, `treasury.outbound_${kind}.created`, obj);
  if (network === 'stripe') return settleOutbound(ctx, obj.object, id, 'post');
  return obj;
}
export const createOutboundPayment = (ctx: Ctx, p: Params) => outbound(ctx, p, 'payment');
export const createOutboundTransfer = (ctx: Ctx, p: Params) => outbound(ctx, p, 'transfer');

/** Posts, fails, cancels or returns an outbound flow. */
export async function settleOutbound(ctx: Ctx, type: string, id: string, action: 'post' | 'fail' | 'cancel' | 'return', code?: string) {
  const o = await getObject<any>(ctx.accountId, type, id, type);
  const kind = type.endsWith('payment') ? 'payment' : 'transfer';
  const now = nowSeconds();
  if (action === 'return') {
    if (o.status !== 'posted') throw invalid(`Only posted ${kind}s can be returned; this one is ${o.status}.`, 'id', 'treasury_unexpected_state');
    const t = await openTransaction(ctx, { id: o.financial_account }, `outbound_${kind}`, o.id, o.amount, `Return of ${o.id}`);
    await impact(ctx, o.financial_account, t.id, `outbound_${kind}_return`, { cash: o.amount }, [{ account: 'cash', amount: o.amount }]);
    await closeTransaction(ctx, t.id, 'posted');
    o.status = 'returned';
    o.status_transitions.returned_at = now;
    o.returned_details = { code: code ?? 'declined', transaction: t.id };
  } else {
    if (o.status !== 'processing') throw invalid(`This ${kind} is ${o.status}.`, 'id', 'treasury_unexpected_state');
    if (action === 'post') {
      if (o._dest_fa) {
        // Between two financial accounts: one ledger group moves the money from one to the other.
        await post(ctx.accountId, 'usd', [{ account: `fa_outbound:${o.financial_account}`, amount: o.amount }, { account: `fa_cash:${o._dest_fa}`, amount: -o.amount }], o.id, `Intra-account ${o.id}`);
        await impact(ctx, o.financial_account, o.transaction, `outbound_${kind}`, { outbound_pending: -o.amount }, null);
        await receivedCredit(ctx, { financial_account: o._dest_fa, amount: o.amount, network: 'stripe', description: o.description ?? `From ${o.financial_account}`, source_fa: o.financial_account, internalCounter: true });
      } else {
        await impact(ctx, o.financial_account, o.transaction, `outbound_${kind}`, { outbound_pending: -o.amount }, [{ account: 'cash', amount: -o.amount }]);
      }
      o.status = 'posted';
      o.status_transitions.posted_at = now;
      await closeTransaction(ctx, o.transaction, 'posted');
    } else {
      await impact(ctx, o.financial_account, o.transaction, `outbound_${kind}_${action === 'cancel' ? 'cancellation' : 'return'}`, { outbound_pending: -o.amount, cash: o.amount }, []);
      o.status = action === 'cancel' ? 'canceled' : 'failed';
      o.status_transitions[action === 'cancel' ? 'canceled_at' : 'failed_at'] = now;
      await closeTransaction(ctx, o.transaction, 'void');
    }
  }
  o.cancelable = false;
  await saveObject(ctx.accountId, o);
  await emit(ctx, `${type.replace('treasury.', 'treasury.')}.${o.status}`, o);
  return o;
}

export async function cancelOutbound(ctx: Ctx, type: string, id: string) {
  const o = await getObject<any>(ctx.accountId, type, id, type);
  if (!o.cancelable || o.status !== 'processing') throw invalid('This flow can no longer be canceled.', 'id', 'treasury_unexpected_state');
  return settleOutbound(ctx, type, id, 'cancel');
}

// ---------------- received credits and debits ----------------

export async function receivedCredit(ctx: Ctx, p: { financial_account: string; amount: number; network: string; description?: string; source_fa?: string; sender?: any; internalCounter?: boolean }) {
  const fa = await getFa(ctx, p.financial_account);
  const id = newId('rc');
  const t = await openTransaction(ctx, fa, 'received_credit', id, p.amount, p.description ?? 'ReceivedCredit');
  // Credits from another financial account are funded by that account's outbound_pending (already debited there).
  await impact(ctx, fa.id, t.id, 'received_credit', { cash: p.amount }, p.internalCounter ? null : [{ account: 'cash', amount: p.amount }]);
  await closeTransaction(ctx, t.id, 'posted');
  const rc = {
    id, object: 'treasury.received_credit', amount: p.amount, created: nowSeconds(), currency: 'usd', description: p.description ?? 'ReceivedCredit', failure_code: null,
    financial_account: fa.id, hosted_regulatory_receipt_url: `${ctx.baseUrl}/treasury/receipts/${id}`,
    initiating_payment_method_details: p.source_fa
      ? { balance: null, billing_details: { address: null, email: null, name: null }, financial_account: { id: p.source_fa, network: 'stripe' }, type: 'financial_account' }
      : { balance: null, billing_details: { address: null, email: null, name: p.sender?.name ?? 'Jenny Rosen' }, type: 'us_bank_account', us_bank_account: { bank_name: 'TEST BANK', last4: p.sender?.last4 ?? '6789', routing_number: '110000000' } },
    linked_flows: { credit_reversal: null, issuing_authorization: null, issuing_transaction: null, source_flow: null, source_flow_type: null },
    livemode: false, network: p.network, reversal_details: { deadline: null, restricted_reason: null }, status: 'succeeded', transaction: t.id,
  };
  await insertObject(ctx.accountId, rc);
  await emit(ctx, 'treasury.received_credit.created', rc);
  await emit(ctx, 'treasury.received_credit.succeeded', rc);
  return rc;
}

export async function testReceivedCredit(ctx: Ctx, p: Params) {
  const fa = await getFa(ctx, str(p, 'financial_account', { required: true })!);
  requireOpen(fa, 'financial_addresses.aba');
  const network = oneOf(p, 'network', ['ach', 'us_domestic_wire'] as const) ?? (() => { throw missing('network'); })();
  return receivedCredit(ctx, { financial_account: fa.id, amount: int(p, 'amount', { required: true, min: 1 })!, network, description: str(p, 'description') ?? undefined, sender: { name: p.initiating_payment_method_details?.us_bank_account?.account_holder_name } });
}

export async function testReceivedDebit(ctx: Ctx, p: Params) {
  const fa = await getFa(ctx, str(p, 'financial_account', { required: true })!);
  const amount = int(p, 'amount', { required: true, min: 1 })!;
  const network = oneOf(p, 'network', ['ach'] as const) ?? 'ach';
  const id = newId('rd');
  const enough = (await cashOf(ctx.accountId, fa.id)) >= amount;
  let transaction: string | null = null;
  if (enough) {
    const t = await openTransaction(ctx, fa, 'received_debit', id, -amount, str(p, 'description') ?? 'ReceivedDebit');
    await impact(ctx, fa.id, t.id, 'received_debit', { cash: -amount }, [{ account: 'cash', amount: -amount }]);
    await closeTransaction(ctx, t.id, 'posted');
    transaction = t.id;
  }
  const rd = {
    id, object: 'treasury.received_debit', amount, created: nowSeconds(), currency: 'usd', description: str(p, 'description') ?? 'ReceivedDebit', failure_code: enough ? null : 'insufficient_funds',
    financial_account: fa.id, hosted_regulatory_receipt_url: `${ctx.baseUrl}/treasury/receipts/${id}`,
    initiating_payment_method_details: { balance: null, billing_details: { address: null, email: null, name: 'Jenny Rosen' }, type: 'us_bank_account', us_bank_account: { bank_name: 'TEST BANK', last4: '6789', routing_number: '110000000' } },
    linked_flows: { debit_reversal: null, inbound_transfer: null, issuing_authorization: null, issuing_transaction: null, payout: null }, livemode: false, network,
    reversal_details: { deadline: null, restricted_reason: null }, status: enough ? 'succeeded' : 'failed', transaction,
  };
  await insertObject(ctx.accountId, rd);
  await emit(ctx, 'treasury.received_debit.created', rd);
  return rd;
}

// ---------------- worker ----------------

/** Settles processing flows whose (simulated) ACH window has passed; test bank accounts decide failures. */
export async function processTreasury(now = nowSeconds()) {
  const rows = await query<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type IN ('treasury.inbound_transfer','treasury.outbound_payment','treasury.outbound_transfer') AND data->>'status' = 'processing' ORDER BY seq LIMIT 200");
  let n = 0;
  for (const { account_id, data: o } of rows) {
    if (!o._settle_at || o._settle_at > now) continue;
    const ctx = accountCtx(account_id);
    if (o.object === 'treasury.inbound_transfer') {
      const pm = await findObject<any>(account_id, 'payment_method', o.origin_payment_method);
      const failure = pm ? ACH_TEST_OUTCOMES[pm._account_number] : undefined;
      await finishInboundTransfer(ctx, o.id, failure ? 'fail' : 'succeed', failure?.code);
    } else {
      const failure = o._dest_account ? ACH_TEST_OUTCOMES[o._dest_account] : undefined;
      await settleOutbound(ctx, o.object, o.id, failure ? 'fail' : 'post');
    }
    n++;
  }
  return n;
}
