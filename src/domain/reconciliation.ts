import { query } from '../db/index.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Ctx } from '../platform/context.ts';
import { insertObject, listObjects } from './store.ts';
import type { Params } from '../lib/params.ts';

/**
 * Ledger data-quality checks (after Stripe's published Ledger design): the ledger is the source
 * of truth, so it is checked against itself and against the API objects that caused each entry.
 *
 *  balanced      every ledger group sums to zero (across all owners of the group)
 *  clearing      each clearing account holds exactly what is still in flight:
 *                processor_receivable = captured charges the network has not settled yet,
 *                refund_payable = refunds not yet settled, payouts_in_transit = open payouts
 *  completeness  every captured charge, refund and payout has its ledger entries and a
 *                balance transaction
 *  balances      the available and pending balances equal the sum of the account's balance
 *                transactions in those states
 *  timeliness    no balance transaction is still pending long after its available_on date
 *
 * A run is stored as a `tessera.reconciliation_run`; failures list example ids to investigate.
 */
type Check = { name: string; description: string; checked: number; failures: number; examples: string[]; detail?: string };

const sumBy = (rows: { currency: string; total: string | number }[]) => Object.fromEntries(rows.map((r) => [r.currency, Number(r.total)]));
const sameMoney = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => (a[k] ?? 0) !== (b[k] ?? 0)).map((k) => `${k}: ledger ${a[k] ?? 0} vs objects ${b[k] ?? 0}`);
};

export async function runReconciliation(ctx: Ctx) {
  const t0 = Date.now();
  const acct = ctx.accountId;
  const checks: Check[] = [];

  // balanced
  const groups = await query<{ group_id: string }>('SELECT DISTINCT group_id FROM ledger_entries WHERE account_id = $1', [acct]);
  const bad = await query<{ group_id: string }>(
    'SELECT group_id FROM ledger_entries WHERE group_id IN (SELECT group_id FROM ledger_entries WHERE account_id = $1) GROUP BY group_id, currency HAVING SUM(amount) <> 0', [acct],
  );
  checks.push({ name: 'balanced', description: 'Every ledger group sums to zero', checked: groups.length, failures: bad.length, examples: bad.slice(0, 5).map((r) => r.group_id) });

  // clearing accounts
  const ledger = async (acc: string) => sumBy(await query('SELECT currency, SUM(amount)::text AS total FROM ledger_entries WHERE account_id = $1 AND ledger_account = $2 GROUP BY currency', [acct, acc]));
  const unsettled = sumBy(await query("SELECT data->>'currency' AS currency, SUM((data->>'amount')::bigint)::text AS total FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'type' = 'charge' AND (data->>'_network_settled')::boolean = false GROUP BY 1", [acct]));
  const refundsOpen = sumBy(await query("SELECT data->>'currency' AS currency, SUM((data->>'amount')::bigint)::text AS total FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'type' = 'refund' AND (data->>'_network_settled')::boolean = false GROUP BY 1", [acct]));
  const payoutsOpen = sumBy(await query("SELECT data->>'currency' AS currency, (-SUM((data->>'amount')::bigint))::text AS total FROM objects WHERE account_id = $1 AND type = 'payout' AND data->>'status' IN ('pending', 'in_transit') GROUP BY 1", [acct]));
  const clearingIssues = [
    ...sameMoney(await ledger('processor_receivable'), unsettled).map((x) => `processor_receivable ${x}`),
    ...sameMoney(await ledger('refund_payable'), refundsOpen).map((x) => `refund_payable ${x}`),
    ...sameMoney(await ledger('payouts_in_transit'), payoutsOpen).map((x) => `payouts_in_transit ${x}`),
  ];
  checks.push({ name: 'clearing', description: 'Clearing accounts hold exactly the money still in flight', checked: 3, failures: clearingIssues.length, examples: clearingIssues.slice(0, 5) });

  // completeness
  const charges = await query<{ id: string; bt: string | null }>("SELECT id, data->>'balance_transaction' AS bt FROM objects WHERE account_id = $1 AND type = 'charge' AND (data->>'captured')::boolean = true", [acct]);
  const refunds = await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'refund' AND data->>'status' = 'succeeded'", [acct]);
  const payouts = await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'payout'", [acct]);
  const sources = new Set((await query<{ source: string }>('SELECT DISTINCT source FROM ledger_entries WHERE account_id = $1', [acct])).map((r) => r.source));
  const missing = [
    ...charges.filter((c) => !c.bt || !sources.has(c.id)).map((c) => c.id),
    ...refunds.filter((r) => !sources.has(r.id)).map((r) => r.id),
    ...payouts.filter((p) => !sources.has(p.id)).map((p) => p.id),
  ];
  checks.push({ name: 'completeness', description: 'Every captured charge, refund and payout has ledger entries', checked: charges.length + refunds.length + payouts.length, failures: missing.length, examples: missing.slice(0, 5) });

  // balances vs balance transactions
  const btAvail = sumBy(await query("SELECT data->>'currency' AS currency, SUM((data->>'net')::bigint)::text AS total FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'status' = 'available' AND coalesce(data->>'balance_type', 'payments') = 'payments' GROUP BY 1", [acct]));
  const btIssuing = sumBy(await query("SELECT data->>'currency' AS currency, SUM((data->>'net')::bigint)::text AS total FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'balance_type' = 'issuing' GROUP BY 1", [acct]));
  const issuingLedger = async () => sumBy(await query("SELECT currency, SUM(amount)::text AS total FROM ledger_entries WHERE account_id = $1 AND ledger_account IN ('issuing_available', 'issuing_reserved') GROUP BY currency", [acct]));
  const btPending = sumBy(await query("SELECT data->>'currency' AS currency, SUM((data->>'net')::bigint)::text AS total FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'status' = 'pending' AND coalesce(data->>'balance_type', 'payments') = 'payments' GROUP BY 1", [acct]));
  const neg = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, -v]));
  const balIssues = [
    ...sameMoney(neg(await ledger('merchant_available')), btAvail).map((x) => `available ${x}`),
    ...sameMoney(neg(await ledger('merchant_pending')), btPending).map((x) => `pending ${x}`),
    ...sameMoney(neg(await issuingLedger()), btIssuing).map((x) => `issuing ${x}`),
  ];
  checks.push({ name: 'balances', description: 'Payments and Issuing balances equal their balance transactions', checked: 3, failures: balIssues.length, examples: balIssues.slice(0, 5) });

  // timeliness
  const late = await query<{ id: string }>("SELECT id FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'status' = 'pending' AND (data->>'available_on')::bigint < $2", [acct, nowSeconds() - 3600]);
  const pendingCount = (await query<{ n: number }>("SELECT count(*)::int AS n FROM objects WHERE account_id = $1 AND type = 'balance_transaction' AND data->>'status' = 'pending'", [acct]))[0]?.n ?? 0;
  checks.push({ name: 'timeliness', description: 'No funds stay pending more than an hour past their available date', checked: pendingCount, failures: late.length, examples: late.slice(0, 5).map((r) => r.id) });

  const failures = checks.reduce((s, c) => s + c.failures, 0);
  const run = {
    id: newId('recon', 20), object: 'tessera.reconciliation_run', created: nowSeconds(), livemode: false,
    status: failures ? 'discrepancies_found' : 'passed', checks, failures, duration_ms: Date.now() - t0,
  };
  await insertObject(acct, run as any);
  return run;
}

export async function listRuns(ctx: Ctx, p: Params) {
  return listObjects(ctx.accountId, 'tessera.reconciliation_run', '/v1/tessera/reconciliation_runs', p);
}

/** Worker: each account with ledger activity is reconciled every RECONCILE_SECONDS. */
export async function scheduledReconciliation(every: number, now = nowSeconds()) {
  const { accountCtx } = await import('./connect/accounts.ts');
  const accts = await query<{ account_id: string }>('SELECT DISTINCT account_id FROM ledger_entries');
  let n = 0;
  for (const { account_id } of accts) {
    const last = await query<{ created: string }>("SELECT max(created)::text AS created FROM objects WHERE account_id = $1 AND type = 'tessera.reconciliation_run'", [account_id]);
    if (last[0]?.created && Number(last[0].created) > now - every) continue;
    await runReconciliation(accountCtx(account_id));
    n++;
  }
  return n;
}
