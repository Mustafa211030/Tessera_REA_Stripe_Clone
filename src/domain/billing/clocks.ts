import { AsyncLocalStorage } from 'node:async_hooks';
import { one } from '../../db/index.ts';
import { invalid } from '../../lib/errors.ts';
import { newId, nowSeconds } from '../../lib/ids.ts';
import { int, str, type Params } from '../../lib/params.ts';
import type { Ctx } from '../../platform/context.ts';
import { emit } from '../events.ts';
import { getObject, insertObject, saveObject } from '../store.ts';

/**
 * Test clocks: a frozen point in time that customers (and therefore their subscriptions
 * and invoices) can be attached to. Advancing the clock runs the billing engine as if
 * that much time had passed, the standard way to test renewals without waiting a month.
 */
export async function createClock(ctx: Ctx, p: Params) {
  const frozen = int(p, 'frozen_time', { required: true })!;
  const clock = {
    id: newId('clock'),
    object: 'test_helpers.test_clock',
    created: nowSeconds(),
    deletes_after: nowSeconds() + 30 * 86400,
    frozen_time: frozen,
    livemode: false,
    name: str(p, 'name') ?? null,
    status: 'ready',
    status_details: {},
  };
  return insertObject(ctx.accountId, clock);
}

/** While the billing engine replays an event, "now" is that event's time, not the wall clock. */
const virtualNow = new AsyncLocalStorage<number>();
export const atTime = <T>(t: number, fn: () => Promise<T>) => virtualNow.run(t, fn);

export async function clockTime(accountId: string, clockId: string | null | undefined): Promise<number> {
  const v = virtualNow.getStore();
  if (v !== undefined) return v;
  if (!clockId) return nowSeconds();
  const row = await one<{ data: any }>("SELECT data FROM objects WHERE id = $1 AND account_id = $2 AND type = 'test_helpers.test_clock'", [clockId, accountId]);
  return row?.data.frozen_time ?? nowSeconds();
}

export async function setClockTime(ctx: Ctx, id: string, p: Params) {
  const clock = await getObject<any>(ctx.accountId, 'test_helpers.test_clock', id, 'test clock');
  const to = int(p, 'frozen_time', { required: true })!;
  if (to <= clock.frozen_time) throw invalid('frozen_time must be later than the current frozen time.', 'frozen_time');
  if (to - clock.frozen_time > 2 * 366 * 86400) throw invalid('You can advance a test clock by at most two years at a time.', 'frozen_time');
  clock.frozen_time = to;
  clock.status = 'ready';
  await saveObject(ctx.accountId, clock);
  await emit(ctx, 'test_helpers.test_clock.ready', clock);
  return clock;
}
