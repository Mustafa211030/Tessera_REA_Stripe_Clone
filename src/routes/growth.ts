import type { FastifyInstance } from 'fastify';
import * as meters from '../domain/billing/meters.ts';
import * as promos from '../domain/billing/promotions.ts';
import * as schedules from '../domain/billing/schedules.ts';
import * as links from '../domain/paymentLinks.ts';
import { findObject, getObject, listObjects, type ListFilter } from '../domain/store.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

/** Older promotion codes stored an embedded coupon; present every code in the current `promotion` shape. */
async function withCoupon(_accountId: string, promo: any) {
  if (promo.promotion) return promo;
  const { coupon, ...rest } = promo;
  return { ...rest, promotion: { coupon: coupon?.id ?? coupon, type: 'coupon' } };
}

/** Usage-based billing, promotion codes, payment links and subscription schedules. */
export function registerGrowth(app: FastifyInstance) {
  // ---------- Billing meters ----------
  apiRoute(app, 'POST', '/v1/billing/meters', { resource: 'billing' }, (ctx, p) => meters.createMeter(ctx, p));
  apiRoute(app, 'GET', '/v1/billing/meters', { resource: 'billing' }, (ctx, p) => listObjects(ctx.accountId, 'billing.meter', '/v1/billing/meters', p, filters(p, ['status'])));
  apiRoute(app, 'GET', '/v1/billing/meters/:id', { resource: 'billing' }, (ctx, p) => getObject(ctx.accountId, 'billing.meter', p.id, 'billing meter'));
  apiRoute(app, 'POST', '/v1/billing/meters/:id', { resource: 'billing' }, (ctx, p) => meters.updateMeter(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/billing/meters/:id/deactivate', { resource: 'billing' }, (ctx, p) => meters.setMeterStatus(ctx, p.id, false));
  apiRoute(app, 'POST', '/v1/billing/meters/:id/reactivate', { resource: 'billing' }, (ctx, p) => meters.setMeterStatus(ctx, p.id, true));
  apiRoute(app, 'GET', '/v1/billing/meters/:id/event_summaries', { resource: 'billing' }, (ctx, p) => meters.eventSummaries(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/billing/meter_events', { resource: 'billing' }, (ctx, p) => meters.recordMeterEvent(ctx, p));
  apiRoute(app, 'POST', '/v1/billing/meter_event_adjustments', { resource: 'billing' }, (ctx, p) => meters.adjustMeterEvent(ctx, p));

  // ---------- Promotion codes ----------
  apiRoute(app, 'POST', '/v1/promotion_codes', { resource: 'promotion_codes' }, async (ctx, p) => withCoupon(ctx.accountId, await promos.createPromotionCode(ctx, p)));
  apiRoute(app, 'GET', '/v1/promotion_codes', { resource: 'promotion_codes' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'promotion_code', '/v1/promotion_codes', p, filters(p, ['customer']));
    if (p.active !== undefined) l.data = l.data.filter((x: any) => String(x.active) === String(p.active));
    if (p.code) l.data = l.data.filter((x: any) => x.code.toUpperCase() === String(p.code).toUpperCase());
    if (p.coupon) l.data = l.data.filter((x: any) => promos.couponOf(x) === p.coupon);
    l.data = await Promise.all(l.data.map((x) => withCoupon(ctx.accountId, x)));
    return l;
  });
  apiRoute(app, 'GET', '/v1/promotion_codes/:id', { resource: 'promotion_codes' }, async (ctx, p) => withCoupon(ctx.accountId, await getObject(ctx.accountId, 'promotion_code', p.id, 'promotion code')));
  apiRoute(app, 'POST', '/v1/promotion_codes/:id', { resource: 'promotion_codes' }, async (ctx, p) => withCoupon(ctx.accountId, await promos.updatePromotionCode(ctx, p.id, p)));

  // ---------- Payment links ----------
  apiRoute(app, 'POST', '/v1/payment_links', { resource: 'payment_links' }, (ctx, p) => links.createPaymentLink(ctx, p));
  apiRoute(app, 'GET', '/v1/payment_links', { resource: 'payment_links' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'payment_link', '/v1/payment_links', p);
    if (p.active !== undefined) l.data = l.data.filter((x: any) => String(x.active) === String(p.active));
    return l;
  });
  apiRoute(app, 'GET', '/v1/payment_links/:id', { resource: 'payment_links' }, (ctx, p) => getObject(ctx.accountId, 'payment_link', p.id, 'payment link'));
  apiRoute(app, 'POST', '/v1/payment_links/:id', { resource: 'payment_links' }, (ctx, p) => links.updatePaymentLink(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/payment_links/:id/line_items', { resource: 'payment_links' }, (ctx, p) => links.linkLineItems(ctx, p.id));

  // ---------- Subscription schedules ----------
  apiRoute(app, 'POST', '/v1/subscription_schedules', { resource: 'subscription_schedules', critical: true }, (ctx, p) => schedules.createSchedule(ctx, p));
  apiRoute(app, 'GET', '/v1/subscription_schedules', { resource: 'subscription_schedules' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'subscription_schedule', '/v1/subscription_schedules', p, filters(p, ['customer']));
    if (p.scheduled !== undefined) l.data = l.data.filter((x: any) => (x.status === 'not_started') === (String(p.scheduled) === 'true'));
    return l;
  });
  apiRoute(app, 'GET', '/v1/subscription_schedules/:id', { resource: 'subscription_schedules' }, (ctx, p) => getObject(ctx.accountId, 'subscription_schedule', p.id, 'subscription schedule'));
  apiRoute(app, 'POST', '/v1/subscription_schedules/:id', { resource: 'subscription_schedules', critical: true }, (ctx, p) => schedules.updateSchedule(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/subscription_schedules/:id/cancel', { resource: 'subscription_schedules', critical: true }, (ctx, p) => schedules.cancelSchedule(ctx, p.id, p));
  apiRoute(app, 'POST', '/v1/subscription_schedules/:id/release', { resource: 'subscription_schedules' }, (ctx, p) => schedules.releaseSchedule(ctx, p.id));
}
