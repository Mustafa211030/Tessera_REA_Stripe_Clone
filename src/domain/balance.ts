import { one, query } from '../db/index.ts';
import { nowSeconds } from '../lib/ids.ts';
import { balances, post } from './ledger.ts';
import { saveObject } from './store.ts';

/** Balance object derived purely from the ledger (no separate counters to drift). */
export async function getBalance(accountId: string) {
  const b = await balances(accountId);
  const currencies = new Set([...Object.keys(b.merchant_available ?? {}), ...Object.keys(b.merchant_pending ?? {})]);
  if (!currencies.size) currencies.add('usd');
  const bucket = (acct: string) => [...currencies].map((c) => ({ amount: -(b[acct]?.[c] ?? 0), currency: c, source_types: { card: -(b[acct]?.[c] ?? 0) } }));
  const issuingCurs = new Set([...Object.keys(b.issuing_available ?? {}), ...Object.keys(b.issuing_reserved ?? {})]);
  // Instant Payouts: shown when the account has a debit card that supports them.
  const acct = await one<{ cards: any }>("SELECT data->'external_accounts'->'data' AS cards FROM accounts WHERE id = $1", [accountId]);
  const instantCurs = new Set<string>((acct?.cards ?? []).filter((x: any) => x.available_payout_methods?.includes('instant')).map((x: any) => x.currency));
  const instant = [...instantCurs].map((c) => ({ amount: Math.max(0, -(b.merchant_available?.[c] ?? 0)), currency: c, net_available: [], source_types: { card: Math.max(0, -(b.merchant_available?.[c] ?? 0)) } }));
  return {
    ...(instant.length ? { instant_available: instant } : {}),
    object: 'balance', available: bucket('merchant_available'), connect_reserved: [], livemode: false, pending: bucket('merchant_pending'),
    // Issuing balance: what cards can spend (held authorizations are already deducted).
    ...(issuingCurs.size ? { issuing: { available: [...issuingCurs].map((c) => ({ amount: -(b.issuing_available?.[c] ?? 0), currency: c })) } } : {}),
  };
}

/**
 * Settlement worker step:
 *  1. Pending charge funds whose available_on has passed move to available.
 *  2. The simulated network settles: processor_receivable and refund_payable clear to cash.
 */
export async function settleDue(): Promise<number> {
  const now = nowSeconds();
  const due = await query<{ account_id: string; data: any }>(
    "SELECT account_id, data FROM objects WHERE type = 'balance_transaction' AND ((data->>'status' = 'pending' AND (data->>'available_on')::bigint <= $1) OR ((data->>'_network_settled')::boolean = false AND (data->>'available_on')::bigint <= $1)) ORDER BY seq LIMIT 200",
    [now],
  );
  let n = 0;
  for (const { account_id, data: txn } of due) {
    if (txn.status === 'pending') {
      await post(account_id, txn.currency, [
        { account: 'merchant_pending', amount: txn.net },
        { account: 'merchant_available', amount: -txn.net },
      ], txn.id, `Funds available for ${txn.source}`);
      txn.status = 'available';
    }
    if (!txn._network_settled) {
      if (txn.type === 'charge') {
        await post(account_id, txn.currency, [{ account: 'cash', amount: txn.amount }, { account: 'processor_receivable', amount: -txn.amount }], txn.id, `Network settlement ${txn.source}`);
      } else if (txn.type === 'refund') {
        await post(account_id, txn.currency, [{ account: 'refund_payable', amount: -txn.amount }, { account: 'cash', amount: txn.amount }], txn.id, `Network refund settlement ${txn.source}`);
      }
      txn._network_settled = true;
    }
    if (txn.status === 'available' && !txn._capital_checked && (txn.type === 'charge' || txn.type === 'payment')) {
      txn._capital_checked = true;
      const { withhold } = await import('./capital.ts');
      await withhold(account_id, txn);
    }
    await saveObject(account_id, txn);
    n++;
  }
  return n;
}
