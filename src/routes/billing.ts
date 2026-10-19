import type { FastifyInstance } from 'fastify';
import * as catalog from '../domain/billing/catalog.ts';
import { clockTime, createClock, setClockTime } from '../domain/billing/clocks.ts';
import * as invoices from '../domain/billing/invoices.ts';
import { setAmountsDue } from '../domain/billing/installments.ts';
import * as subs from '../domain/billing/subscriptions.ts';
import { emit } from '../domain/events.ts';
import { getObject, listObjects, saveObject, type ListFilter } from '../domain/store.ts';
import { invalid, missing } from '../lib/errors.ts';
import { CommitThenFail } from '../lib/errors.ts';
import { apiRoute } from '../platform/http.ts';

const filters = (p: any, fields: string[]): ListFilter[] =>
  fields.filter((f) => p[f] !== undefined && p[f] !== '').map((f) => ({ field: f, value: p[f] }));

const notDeleted = (l: any) => ((l.data = l.data.filter((x: any) => !x.deleted)), l);

export function registerBilling(app: FastifyInstance) {
  // ---------- Products ----------
  apiRoute(app, 'POST', '/v1/products', { resource: 'products' }, (ctx, p) => catalog.createProduct(ctx, p));
  apiRoute(app, 'GET', '/v1/products', { resource: 'products' }, async (ctx, p) => notDeleted(await listObjects(ctx.accountId, 'product', '/v1/products', p, filters(p, ['active']))));
  apiRoute(app, 'GET', '/v1/products/:id', { resource: 'products' }, (ctx, p) => getObject(ctx.accountId, 'product', p.id, 'product'));
  apiRoute(app, 'POST', '/v1/products/:id', { resource: 'products' }, (ctx, p) => catalog.updateProduct(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/products/:id', { resource: 'products' }, async (ctx, p) => {
    const prod = await getObject<any>(ctx.accountId, 'product', p.id, 'product');
    const prices = await listObjects(ctx.accountId, 'price', '', { limit: 1 }, [{ field: 'product', value: p.id }]);
    if (prices.data.length) throw invalid('This product cannot be deleted because it has one or more user-created prices. Archive it instead (active=false).', 'product');
    prod.deleted = true;
    await saveObject(ctx.accountId, prod);
    await emit(ctx, 'product.deleted', prod);
    return { id: prod.id, object: 'product', deleted: true };
  });

  // ---------- Prices ----------
  apiRoute(app, 'POST', '/v1/prices', { resource: 'prices' }, (ctx, p) => catalog.createPrice(ctx, p));
  apiRoute(app, 'GET', '/v1/prices', { resource: 'prices' }, async (ctx, p) => {
    const l = await listObjects(ctx.accountId, 'price', '/v1/prices', p, filters(p, ['product', 'active', 'type', 'currency']));
    const keys = Array.isArray(p.lookup_keys) ? p.lookup_keys : p.lookup_keys ? Object.values(p.lookup_keys) : null;
    if (keys) l.data = l.data.filter((x: any) => keys.includes(x.lookup_key));
    return l;
  });
  apiRoute(app, 'GET', '/v1/prices/:id', { resource: 'prices' }, (ctx, p) => getObject(ctx.accountId, 'price', p.id, 'price'));
  apiRoute(app, 'POST', '/v1/prices/:id', { resource: 'prices' }, (ctx, p) => catalog.updatePrice(ctx, p.id, p));

  // ---------- Coupons ----------
  apiRoute(app, 'POST', '/v1/coupons', { resource: 'coupons' }, (ctx, p) => catalog.createCoupon(ctx, p));
  apiRoute(app, 'GET', '/v1/coupons', { resource: 'coupons' }, async (ctx, p) => notDeleted(await listObjects(ctx.accountId, 'coupon', '/v1/coupons', p)));
  apiRoute(app, 'GET', '/v1/coupons/:id', { resource: 'coupons' }, (ctx, p) => getObject(ctx.accountId, 'coupon', p.id, 'coupon'));
  apiRoute(app, 'DELETE', '/v1/coupons/:id', { resource: 'coupons' }, async (ctx, p) => {
    const c = await getObject<any>(ctx.accountId, 'coupon', p.id, 'coupon');
    c.deleted = true;
    c.valid = false;
    await saveObject(ctx.accountId, c);
    await emit(ctx, 'coupon.deleted', c);
    return { id: c.id, object: 'coupon', deleted: true };
  });

  // ---------- Subscriptions ----------
  apiRoute(app, 'POST', '/v1/subscriptions', { resource: 'subscriptions', critical: true }, (ctx, p) => subs.createSubscription(ctx, p));
  apiRoute(app, 'GET', '/v1/subscriptions', { resource: 'subscriptions' }, async (ctx, p) => {
    const status = p.status;
    const q = { ...p };
    delete q.status;
    const l = await listObjects(ctx.accountId, 'subscription', '/v1/subscriptions', { ...q, limit: 100 }, filters(p, ['customer', 'price', 'test_clock']));
    l.data = l.data.filter((s: any) => (status === 'all' ? true : status ? s.status === status : s.status !== 'canceled' && s.status !== 'incomplete_expired'));
    l.data = l.data.slice(0, Number(p.limit ?? 10));
    return l;
  });
  apiRoute(app, 'GET', '/v1/subscriptions/:id', { resource: 'subscriptions' }, (ctx, p) => getObject(ctx.accountId, 'subscription', p.id, 'subscription'));
  apiRoute(app, 'POST', '/v1/subscriptions/:id', { resource: 'subscriptions' }, (ctx, p) => subs.updateSubscription(ctx, p.id, p));
  apiRoute(app, 'DELETE', '/v1/subscriptions/:id', { resource: 'subscriptions' }, (ctx, p) => subs.cancelSubscription(ctx, p.id, p));
  apiRoute(app, 'GET', '/v1/subscription_items', { resource: 'subscriptions' }, async (ctx, p) => {
    if (!p.subscription) throw missing('subscription');
    const s = await getObject<any>(ctx.accountId, 'subscription', p.subscription, 'subscription', 'subscription');
    return { object: 'list', data: s.items.data, has_more: false, url: '/v1/subscription_items' };
  });

  // ---------- Invoices ----------
  apiRoute(app, 'POST', '/v1/invoices', { resource: 'invoices' }, (ctx, p) => invoices.createInvoice(ctx, p));
  apiRoute(app, 'GET', '/v1/invoices', { resource: 'invoices' }, async (ctx, p) => notDeleted(await listObjects(ctx.accountId, 'invoice', '/v1/invoices', p, filters(p, ['customer', 'subscription', 'status', 'collection_method']))));
  const upcoming = async (ctx: any, p: any) => {
    if (!p.subscription) throw missing('subscription');
    return subs.previewUpcoming(ctx, String(p.subscription));
  };
  apiRoute(app, 'GET', '/v1/invoices/upcoming', { resource: 'invoices' }, upcoming);
  apiRoute(app, 'POST', '/v1/invoices/create_preview', { resource: 'invoices' }, upcoming);
  apiRoute(app, 'GET', '/v1/invoices/:id', { resource: 'invoices' }, (ctx, p) => getObject(ctx.accountId, 'invoice', p.id, 'invoice'));
  apiRoute(app, 'GET', '/v1/invoices/:id/lines', { resource: 'invoices' }, async (ctx, p) => (await getObject<any>(ctx.accountId, 'invoice', p.id, 'invoice')).lines);
  apiRoute(app, 'POST', '/v1/invoices/:id', { resource: 'invoices' }, async (ctx, p) => {
    const inv = await getObject<any>(ctx.accountId, 'invoice', p.id, 'invoice');
    if (inv.status !== 'draft' && (p.description !== undefined || p.days_until_due !== undefined)) throw invalid('Only draft invoices can be edited (except metadata).', 'invoice');
    if (p.description !== undefined) inv.description = p.description || null;
    setAmountsDue(inv, p);
    if (p.auto_advance !== undefined) inv.auto_advance = p.auto_advance === 'true' || p.auto_advance === true;
    if (p.metadata && typeof p.metadata === 'object') for (const [k, v] of Object.entries(p.metadata)) v === '' ? delete inv.metadata[k] : (inv.metadata[k] = String(v));
    await saveObject(ctx.accountId, inv);
    await emit(ctx, 'invoice.updated', inv);
    return inv;
  });
  apiRoute(app, 'DELETE', '/v1/invoices/:id', { resource: 'invoices' }, async (ctx, p) => invoices.deleteDraft(ctx, await getObject(ctx.accountId, 'invoice', p.id, 'invoice')));
  apiRoute(app, 'POST', '/v1/invoices/:id/finalize', { resource: 'invoices' }, async (ctx, p) => invoices.finalizeInvoice(ctx, await getObject(ctx.accountId, 'invoice', p.id, 'invoice')));
  apiRoute(app, 'POST', '/v1/invoices/:id/pay', { resource: 'invoices', critical: true }, async (ctx, p) => {
    const r = await invoices.payInvoice(ctx, await getObject(ctx.accountId, 'invoice', p.id, 'invoice'), { payment_method: p.payment_method, paid_out_of_band: p.paid_out_of_band === 'true', throwOnFailure: true });
    return r;
  });
  // Tessera extension: pay the next installment of a payment plan.
  apiRoute(app, 'POST', '/v1/tessera/invoices/:id/pay_installment', { resource: 'invoices', critical: true }, async (ctx, p) => {
    const { payInstallment } = await import('../domain/billing/installments.ts');
    const r = await payInstallment(ctx, await getObject(ctx.accountId, 'invoice', p.id, 'invoice'), { payment_method: p.payment_method });
    if (r instanceof CommitThenFail) return r;
    return getObject(ctx.accountId, 'invoice', p.id, 'invoice');
  });
  apiRoute(app, 'POST', '/v1/invoices/:id/void', { resource: 'invoices' }, async (ctx, p) => invoices.voidInvoice(ctx, await getObject(ctx.accountId, 'invoice', p.id, 'invoice')));
  apiRoute(app, 'POST', '/v1/invoices/:id/mark_uncollectible', { resource: 'invoices' }, async (ctx, p) => invoices.markUncollectible(ctx, await getObject(ctx.accountId, 'invoice', p.id, 'invoice')));
  apiRoute(app, 'POST', '/v1/invoices/:id/send', { resource: 'invoices' }, async (ctx, p) => {
    const inv = await getObject<any>(ctx.accountId, 'invoice', p.id, 'invoice');
    if (inv.status === 'draft') await invoices.finalizeInvoice(ctx, inv);
    await emit(ctx, 'invoice.sent', inv);
    return inv;
  });

  // ---------- Invoice items ----------
  apiRoute(app, 'POST', '/v1/invoiceitems', { resource: 'invoices' }, (ctx, p) => invoices.createInvoiceItem(ctx, p));
  apiRoute(app, 'GET', '/v1/invoiceitems', { resource: 'invoices' }, async (ctx, p) => {
    const l = notDeleted(await listObjects(ctx.accountId, 'invoiceitem', '/v1/invoiceitems', p, filters(p, ['customer', 'invoice'])));
    if (p.pending === 'true') l.data = l.data.filter((i: any) => !i.invoice);
    return l;
  });
  apiRoute(app, 'GET', '/v1/invoiceitems/:id', { resource: 'invoices' }, (ctx, p) => getObject(ctx.accountId, 'invoiceitem', p.id, 'invoiceitem'));
  apiRoute(app, 'DELETE', '/v1/invoiceitems/:id', { resource: 'invoices' }, async (ctx, p) => {
    const it = await getObject<any>(ctx.accountId, 'invoiceitem', p.id, 'invoiceitem');
    if (it.invoice) throw invalid('Invoice items that are already on an invoice cannot be deleted.', 'id');
    it.deleted = true;
    await saveObject(ctx.accountId, it);
    return { id: it.id, object: 'invoiceitem', deleted: true };
  });

  // ---------- Test clocks ----------
  apiRoute(app, 'POST', '/v1/test_helpers/test_clocks', { resource: 'test_clocks' }, (ctx, p) => createClock(ctx, p));
  apiRoute(app, 'GET', '/v1/test_helpers/test_clocks', { resource: 'test_clocks' }, async (ctx, p) => notDeleted(await listObjects(ctx.accountId, 'test_helpers.test_clock', '/v1/test_helpers/test_clocks', p)));
  apiRoute(app, 'GET', '/v1/test_helpers/test_clocks/:id', { resource: 'test_clocks' }, (ctx, p) => getObject(ctx.accountId, 'test_helpers.test_clock', p.id, 'test clock'));
  apiRoute(app, 'POST', '/v1/test_helpers/test_clocks/:id/advance', { resource: 'test_clocks' }, async (ctx, p) => {
    const clock = await setClockTime(ctx, p.id, p);
    await subs.runBilling(ctx, clock.id, clock.frozen_time);
    return getObject(ctx.accountId, 'test_helpers.test_clock', p.id);
  });
  apiRoute(app, 'DELETE', '/v1/test_helpers/test_clocks/:id', { resource: 'test_clocks' }, async (ctx, p) => {
    const c = await getObject<any>(ctx.accountId, 'test_helpers.test_clock', p.id, 'test clock');
    c.deleted = true;
    await saveObject(ctx.accountId, c);
    return { id: c.id, object: 'test_helpers.test_clock', deleted: true };
  });
  void clockTime;
}
