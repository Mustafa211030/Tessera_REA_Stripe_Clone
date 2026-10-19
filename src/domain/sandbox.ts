import { one, query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { nowSeconds } from '../lib/ids.ts';
import { checkPassword, createKey, getAccount } from './accounts.ts';
import { stripInternal } from './paymentIntents.ts';
import { audit } from './team.ts';
import { invalidateCache } from './store.ts';

/**
 * Sandbox data tools: export everything as JSON, or reset the account to empty.
 *
 * Reset deletes the account's API objects, events, ledger, logs, webhook deliveries, files,
 * connected accounts (and all of their data). It keeps the team, the security history and
 * the account settings; API keys and webhook endpoints are kept unless asked otherwise.
 */

async function accountIds(accountId: string) {
  const connected = await query<{ id: string }>('SELECT id FROM accounts WHERE platform = $1', [accountId]);
  return [accountId, ...connected.map((r) => r.id)];
}

export async function exportData(accountId: string, actor: { user_id: string; email: string }) {
  const ids = await accountIds(accountId);
  const account = await getAccount(accountId);
  const objects = await query<{ account_id: string; type: string; data: any }>('SELECT account_id, type, data FROM objects WHERE account_id = ANY($1) ORDER BY seq', [ids]);
  const byType: Record<string, any[]> = {};
  for (const o of objects) {
    if (o.type === 'tessera.email') continue;
    const key = o.account_id === accountId ? o.type : `${o.account_id}/${o.type}`;
    (byType[key] ??= []).push(stripInternal(o.data));
  }
  const ledger = await query('SELECT account_id, group_id, ledger_account, amount::text AS amount, currency, source, description, created FROM ledger_entries WHERE account_id = ANY($1) ORDER BY seq', [ids]);
  const connected = await query<{ data: any }>('SELECT data FROM accounts WHERE platform = $1', [accountId]);
  await audit(accountId, { id: actor.user_id, email: actor.email }, 'sandbox.exported', null, { objects: objects.length });
  return {
    object: 'tessera.export', exported_at: nowSeconds(), format_version: 1,
    account: stripInternal(account), connected_accounts: connected.map((r) => stripInternal(r.data)),
    counts: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
    objects: byType, ledger_entries: ledger,
  };
}

export async function resetData(accountId: string, actor: { user_id: string; email: string }, p: { password?: string; confirm?: string; keep_api_keys?: boolean; keep_webhook_endpoints?: boolean }) {
  const u = await one<any>('SELECT * FROM users WHERE id = $1', [actor.user_id]);
  if (!u || !checkPassword(String(p.password ?? ''), u.password_hash)) throw new ApiError(401, 'authentication_error', 'Incorrect password.', { code: 'incorrect_password' });
  const account = await getAccount(accountId);
  const name = account?.settings?.dashboard?.display_name ?? '';
  if (String(p.confirm ?? '').trim() !== name) throw invalid(`Type the account name (${name}) to confirm.`, 'confirm', 'confirmation_mismatch');
  const ids = await accountIds(accountId);
  const connected = ids.slice(1);
  const before = (await one<{ n: number }>('SELECT count(*)::int AS n FROM objects WHERE account_id = ANY($1)', [ids]))?.n ?? 0;
  const keepHooks = p.keep_webhook_endpoints !== false;
  await query(`DELETE FROM objects WHERE account_id = ANY($1)${keepHooks ? " AND NOT (account_id = $2 AND type = 'webhook_endpoint')" : ''}`, keepHooks ? [ids, accountId] : [ids]);
  await query('DELETE FROM ledger_entries WHERE account_id = ANY($1)', [ids]);
  await query('DELETE FROM idempotency_keys WHERE account_id = ANY($1)', [ids]);
  await query('DELETE FROM request_logs WHERE account_id = ANY($1)', [ids]);
  await query('DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE account_id = ANY($1))', [ids]);
  await query('DELETE FROM webhook_deliveries WHERE account_id = ANY($1)', [ids]);
  await query('DELETE FROM file_blobs WHERE account_id = ANY($1)', [ids]);
  if (connected.length) {
    await query('DELETE FROM api_keys WHERE account_id = ANY($1)', [connected]);
    await query('DELETE FROM accounts WHERE id = ANY($1)', [connected]);
  }
  let keys: { secret: string; publishable: string } | null = null;
  if (p.keep_api_keys === false) {
    await query('DELETE FROM api_keys WHERE account_id = $1', [accountId]);
    const sk = await createKey(accountId, 'secret', 'Standard secret key');
    const pk = await createKey(accountId, 'publishable', 'Standard publishable key');
    keys = { secret: sk.token, publishable: pk.token };
  }
  // Billing state kept on the account document (invoice numbering, payout timers) restarts too.
  if (account) {
    delete account._next_auto_payout;
    await query('UPDATE accounts SET data = $1 WHERE id = $2', [JSON.stringify(account), accountId]);
  }
  invalidateCache();
  (await import('../platform/hotpath.ts')).invalidateKeys();
  await audit(accountId, { id: actor.user_id, email: actor.email }, 'sandbox.reset', null, { objects_deleted: before, connected_accounts_deleted: connected.length, api_keys_rolled: !!keys, webhook_endpoints_kept: keepHooks });
  return { ok: true, objects_deleted: before, connected_accounts_deleted: connected.length, new_keys: keys };
}
