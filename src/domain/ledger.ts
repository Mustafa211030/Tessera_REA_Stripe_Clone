import { query } from '../db/index.ts';
import { newId, nowSeconds } from '../lib/ids.ts';

/**
 * Double-entry ledger (cf. Stripe's Ledger: immutable, every movement balanced, health
 * measured by whether clearing accounts drain to zero).
 *
 * Sign convention: debit = positive, credit = negative. Each posted group sums to zero.
 *
 * Accounts:
 *  processor_receivable  (clearing)  money the card network owes us for captured charges
 *  refund_payable        (clearing)  refunds we owe the network
 *  cash                              settled funds at the bank
 *  merchant_pending      (liability) merchant funds not yet available
 *  merchant_available    (liability) merchant funds available for payout
 *  fee_revenue           (income)    processing fees
 *  payouts_in_transit    (clearing)  payouts sent to the merchant bank
 *
 * Connect movements (transfers, application fees, reversals) post one group whose entries
 * belong to two accounts, e.g. platform merchant_pending +X / connected merchant_pending -X.
 */
export const CLEARING_ACCOUNTS = ['processor_receivable', 'refund_payable', 'payouts_in_transit', 'ach_receivable'] as const;

/** `owner` books the entry on another Tessera account (Connect transfers and fees): one group, two balance sheets. */
export type Entry = { account: string; amount: number; owner?: string };

export class LedgerImbalanceError extends Error {}

export async function post(accountId: string, currency: string, entries: Entry[], source: string, description: string): Promise<string> {
  const sum = entries.reduce((s, e) => s + e.amount, 0);
  if (sum !== 0) throw new LedgerImbalanceError(`Ledger group for ${source} does not balance (${sum})`);
  const groupId = newId('lg', 16);
  const created = nowSeconds();
  for (const e of entries) {
    if (e.amount === 0) continue;
    await query(
      'INSERT INTO ledger_entries (account_id, group_id, ledger_account, amount, currency, source, description, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [e.owner ?? accountId, groupId, e.account, e.amount, currency, source, description, created],
    );
  }
  return groupId;
}

export async function balances(accountId: string): Promise<Record<string, Record<string, number>>> {
  const rows = await query<{ ledger_account: string; currency: string; total: string }>(
    'SELECT ledger_account, currency, SUM(amount)::text AS total FROM ledger_entries WHERE account_id = $1 GROUP BY 1, 2',
    [accountId],
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.ledger_account] ??= {})[r.currency] = Number(r.total);
  return out;
}

/** Ledger health: totals by account, open clearing balances, and whether every group balances. */
export async function health(accountId: string) {
  const b = await balances(accountId);
  const unbalanced = await query<{ group_id: string; total: string }>(
    // A group may span a platform and its connected accounts, so it is summed across all owners.
    'SELECT group_id, SUM(amount)::text AS total FROM ledger_entries WHERE group_id IN (SELECT group_id FROM ledger_entries WHERE account_id = $1) GROUP BY group_id HAVING SUM(amount) <> 0',
    [accountId],
  );
  const groups = await query<{ n: number }>('SELECT count(DISTINCT group_id)::int AS n FROM ledger_entries WHERE account_id = $1', [accountId]);
  const clearing = CLEARING_ACCOUNTS.map((a) => ({ account: a, balances: b[a] ?? {} }));
  const openClearing = clearing.filter((c) => Object.values(c.balances).some((v) => v !== 0));
  return {
    accounts: b,
    groups: groups[0]?.n ?? 0,
    unbalanced_groups: unbalanced.length,
    clearing,
    clearing_zeroed: openClearing.length === 0,
  };
}

export async function entriesFor(accountId: string, source: string) {
  return query('SELECT group_id, account_id, ledger_account, amount::int AS amount, currency, description, created FROM ledger_entries WHERE group_id IN (SELECT group_id FROM ledger_entries WHERE account_id = $1 AND source = $2) ORDER BY seq', [accountId, source]);
}
