import { invalid, missing, ApiError, CommitThenFail } from '../lib/errors.ts';
import { base62, newId, nowSeconds } from '../lib/ids.ts';
import { arr, int, metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { emit } from './events.ts';
import { buildCardPresent, TEST_PAYMENT_METHODS } from './paymentMethods.ts';
import { getObject, insertObject, saveObject } from './store.ts';

/**
 * Terminal: in-person payments on (simulated) card readers.
 *
 * Locations group readers. A reader is registered with a registration code — in test mode
 * `simulated-wpe` or `simulated-s700` give a simulated reader. Your server hands the reader an
 * action (process a PaymentIntent, show a cart, or refund a payment); it stays `in_progress`
 * until a card is "presented" with the test helper (or the dashboard's virtual reader). The
 * card's test number decides the outcome, exactly like online test cards.
 */

const DEVICES: Record<string, { type: string; sw: string; prefix: string }> = {
  'simulated-wpe': { type: 'simulated_wisepos_e', sw: '2.27.2.0', prefix: 'WSC513' },
  'simulated-s700': { type: 'simulated_stripe_s700', sw: '2.27.2.0', prefix: 'STRM26' },
};

function address(a: any, param: string) {
  if (!a || typeof a !== 'object') throw missing(param);
  const f = (k: string) => (a[k] === undefined || a[k] === '' ? null : String(a[k]));
  if (!a.country) throw missing(`${param}[country]`);
  return { city: f('city'), country: String(a.country).toUpperCase(), line1: f('line1'), line2: f('line2'), postal_code: f('postal_code'), state: f('state') };
}

// ---------------- locations ----------------
export async function createLocation(ctx: Ctx, p: Params) {
  const loc = {
    id: newId('tml'),
    object: 'terminal.location',
    address: address(p.address, 'address'),
    configuration_overrides: str(p, 'configuration_overrides') ?? null,
    created: nowSeconds(),
    display_name: str(p, 'display_name', { required: true, max: 1000 })!,
    livemode: false,
    metadata: metadata(p),
  };
  await insertObject(ctx.accountId, loc);
  return loc;
}

export async function updateLocation(ctx: Ctx, id: string, p: Params) {
  const loc = await getObject<any>(ctx.accountId, 'terminal.location', id, 'terminal location');
  if (loc.deleted) throw invalid(`No such location: '${id}'`, 'id', 'resource_missing');
  if (p.display_name !== undefined) loc.display_name = str(p, 'display_name', { required: true });
  if (p.address !== undefined) loc.address = address(p.address, 'address');
  loc.metadata = metadata(p, loc.metadata);
  return saveObject(ctx.accountId, loc);
}

export async function deleteLocation(ctx: Ctx, id: string) {
  const loc = await getObject<any>(ctx.accountId, 'terminal.location', id, 'terminal location');
  loc.deleted = true;
  await saveObject(ctx.accountId, loc);
  return { id, object: 'terminal.location', deleted: true };
}

// ---------------- readers ----------------
export async function registerReader(ctx: Ctx, p: Params) {
  const code = str(p, 'registration_code', { required: true })!;
  const dev = DEVICES[code];
  if (!dev) throw invalid(`The registration code '${code}' is invalid. In test mode, use 'simulated-wpe' or 'simulated-s700' to register a simulated reader.`, 'registration_code', 'terminal_reader_registration_code_invalid');
  const locationId = str(p, 'location', { required: true })!;
  const loc = await getObject<any>(ctx.accountId, 'terminal.location', locationId, 'terminal location', 'location');
  if (loc.deleted) throw invalid(`No such location: '${locationId}'`, 'location', 'resource_missing');
  const reader = {
    id: newId('tmr'),
    object: 'terminal.reader',
    action: null as any,
    created: nowSeconds(),
    device_sw_version: dev.sw,
    device_type: dev.type,
    ip_address: `192.168.1.${10 + Math.floor(Math.random() * 200)}`,
    label: str(p, 'label', { max: 5000 }) ?? `Reader ${base62(4).toUpperCase()}`,
    last_seen_at: Date.now(),
    livemode: false,
    location: loc.id,
    metadata: metadata(p),
    serial_number: `${dev.prefix}${base62(10).toUpperCase()}`,
    status: 'online',
  };
  await insertObject(ctx.accountId, reader);
  return reader;
}

export async function updateReader(ctx: Ctx, id: string, p: Params) {
  const r = await liveReader(ctx, id);
  if (p.label !== undefined) r.label = str(p, 'label', { required: true });
  r.metadata = metadata(p, r.metadata);
  return saveObject(ctx.accountId, r);
}

export async function deleteReader(ctx: Ctx, id: string) {
  const r = await liveReader(ctx, id);
  r.deleted = true;
  await saveObject(ctx.accountId, r);
  return { id, object: 'terminal.reader', deleted: true };
}

async function liveReader(ctx: Ctx, id: string) {
  const r = await getObject<any>(ctx.accountId, 'terminal.reader', id, 'terminal reader');
  if (r.deleted) throw new ApiError(404, 'invalid_request_error', `No such terminal.reader: '${id}'`, { code: 'resource_missing', param: 'id' });
  return r;
}

function assertIdle(r: any) {
  if (r.action?.status === 'in_progress') throw new ApiError(409, 'invalid_request_error', 'Reader is currently busy processing another request. Cancel the current action or wait for it to finish.', { code: 'terminal_reader_busy' });
}

const action = (type: string, body: any, status = 'in_progress') => ({ failure_code: null, failure_message: null, [type]: body, status, type });

export async function processPaymentIntent(ctx: Ctx, id: string, p: Params) {
  const r = await liveReader(ctx, id);
  assertIdle(r);
  const piId = str(p, 'payment_intent', { required: true })!;
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', piId, 'payment_intent', 'payment_intent');
  if (!(pi.payment_method_types ?? []).includes('card_present')) throw invalid('This PaymentIntent does not accept in-person payments. Create it with payment_method_types[]=card_present.', 'payment_intent', 'payment_intent_invalid_parameter');
  if (!['requires_payment_method', 'requires_confirmation'].includes(pi.status)) throw invalid(`This PaymentIntent's status is ${pi.status}; it can't be processed on a reader.`, 'payment_intent', 'payment_intent_unexpected_state');
  const cfg = p.process_config ?? {};
  r.action = action('process_payment_intent', {
    payment_intent: pi.id,
    process_config: { enable_customer_cancellation: cfg.enable_customer_cancellation === 'true', skip_tipping: cfg.skip_tipping === 'true', tipping: cfg.tipping?.amount_eligible ? { amount_eligible: int(cfg.tipping, 'amount_eligible', { min: 0 }) } : null },
  });
  await saveObject(ctx.accountId, r);
  return r;
}

export async function setReaderDisplay(ctx: Ctx, id: string, p: Params) {
  const r = await liveReader(ctx, id);
  assertIdle(r);
  if ((p.type ?? 'cart') !== 'cart') throw invalid("Only type='cart' displays are supported.", 'type');
  const cart = p.cart ?? {};
  const items = (arr(cart, 'line_items') ?? []).map((li: any, i: number) => ({ amount: int(li, 'amount', { required: true })!, description: str(li, 'description', { required: true }) ?? `Item ${i + 1}`, quantity: int(li, 'quantity', { min: 1 }) ?? 1 }));
  const cur = str(cart, 'currency', { required: true })!.toLowerCase();
  const total = int(cart, 'total', { required: true, min: 0 })!;
  r.action = action('set_reader_display', { cart: { currency: cur, line_items: items, tax: int(cart, 'tax', { min: 0 }) ?? null, total }, type: 'cart' }, 'succeeded');
  await saveObject(ctx.accountId, r);
  await emit(ctx, 'terminal.reader.action_succeeded', r);
  return r;
}

export async function refundPayment(ctx: Ctx, id: string, p: Params) {
  const r = await liveReader(ctx, id);
  assertIdle(r);
  const piId = str(p, 'payment_intent');
  const chargeId = str(p, 'charge');
  if (!piId && !chargeId) throw missing('payment_intent');
  const pi = piId ? await getObject<any>(ctx.accountId, 'payment_intent', piId, 'payment_intent', 'payment_intent') : null;
  r.action = action('refund_payment', { amount: int(p, 'amount', { min: 1 }) ?? null, charge: chargeId ?? pi?.latest_charge ?? null, metadata: metadata(p), payment_intent: pi?.id ?? null, reason: str(p, 'reason') ?? null, refund: null, refund_application_fee: p.refund_application_fee === 'true', reverse_transfer: p.reverse_transfer === 'true' });
  await saveObject(ctx.accountId, r);
  return r;
}

export async function cancelAction(ctx: Ctx, id: string) {
  const r = await liveReader(ctx, id);
  if (r.action?.status !== 'in_progress') throw invalid('This reader has no action in progress to cancel.', 'reader', 'terminal_reader_unexpected_state');
  r.action.status = 'failed';
  r.action.failure_code = 'canceled';
  r.action.failure_message = 'The action was canceled.';
  await saveObject(ctx.accountId, r);
  await emit(ctx, 'terminal.reader.action_failed', r);
  return r;
}

/** Test helper: a customer taps/inserts a card on the reader, completing its in-progress action. */
export async function presentPaymentMethod(ctx: Ctx, id: string, p: Params) {
  const r = await liveReader(ctx, id);
  if (r.action?.status !== 'in_progress') throw invalid('The reader is not waiting for a card. Start an action (e.g. process_payment_intent) first.', 'reader', 'terminal_reader_unexpected_state');
  const type = str(p, 'type') ?? 'card_present';
  if (type !== 'card_present') throw invalid("Only type='card_present' is supported.", 'type');
  const number = String(p.card_present?.number ?? TEST_PAYMENT_METHODS.pm_card_visa).replace(/\s/g, '');
  const readMethod = p.card_present?.read_method ?? (r.device_type === 'simulated_stripe_s700' ? 'contactless_emv' : 'contact_emv');
  const finish = async (ok: boolean, code?: string, message?: string) => {
    r.action.status = ok ? 'succeeded' : 'failed';
    r.action.failure_code = ok ? null : code ?? 'card_declined';
    r.action.failure_message = ok ? null : message ?? 'The card was declined.';
    await saveObject(ctx.accountId, r);
    await emit(ctx, ok ? 'terminal.reader.action_succeeded' : 'terminal.reader.action_failed', r);
    return r;
  };
  let pm: any;
  try {
    pm = await buildCardPresent(ctx, number, { read_method: readMethod, cardholder_name: p.card_present?.cardholder_name ?? null });
  } catch (e: any) {
    return finish(false, e.code ?? 'card_declined', e.message);
  }
  if (r.action.type === 'refund_payment') {
    const { createRefund } = await import('./refunds.ts');
    const a = r.action.refund_payment;
    try {
      const re = await createRefund(ctx, { ...(a.payment_intent ? { payment_intent: a.payment_intent } : { charge: a.charge }), ...(a.amount ? { amount: a.amount } : {}), ...(a.reason ? { reason: a.reason } : {}), metadata: a.metadata, refund_application_fee: String(a.refund_application_fee), reverse_transfer: String(a.reverse_transfer) });
      a.refund = re.id;
      return finish(true);
    } catch (e: any) {
      return finish(false, e.code ?? 'refund_failed', e.message);
    }
  }
  // process_payment_intent: add any tip, then confirm the PaymentIntent with the card read.
  const piId = r.action.process_payment_intent.payment_intent;
  const pi = await getObject<any>(ctx.accountId, 'payment_intent', piId);
  const tip = int(p, 'amount_tip', { min: 0 }) ?? 0;
  if (tip && !r.action.process_payment_intent.process_config?.skip_tipping) {
    pi.amount += tip;
    pi.amount_details = { ...(pi.amount_details ?? {}), tip: { amount: tip } };
    await saveObject(ctx.accountId, pi);
  }
  const { confirmPaymentIntent } = await import('./paymentIntents.ts');
  const res = await confirmPaymentIntent(ctx, pi.id, { payment_method: pm.id });
  if (res instanceof CommitThenFail) return finish(false, res.error.code ?? 'card_declined', res.error.message);
  return finish(true);
}

export function connectionToken(p: Params) {
  return { object: 'terminal.connection_token', location: str(p, 'location') ?? null, secret: `pst_test_${base62(48)}` };
}
