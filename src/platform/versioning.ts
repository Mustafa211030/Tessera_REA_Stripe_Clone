import { config } from '../config.ts';
import { query } from '../db/index.ts';
import { invalid } from '../lib/errors.ts';

/**
 * Date-based API versioning with "version change modules", following the published design:
 * responses are always built in the latest shape, then walked backwards through each
 * change newer than the requested version.
 */
type Change = {
  version: string; // the change took effect at this version
  description: string;
  resources: string[];
  /** Transform an object from `version` shape to the shape just before it. */
  down: (obj: any) => Promise<any> | any;
};

async function chargesFor(piId: string) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE type = 'charge' AND data->>'payment_intent' = $1 ORDER BY seq DESC", [piId]);
  return rows.map((r) => r.data);
}

async function refundsFor(chId: string) {
  const rows = await query<{ data: any }>("SELECT data FROM objects WHERE type = 'refund' AND data->>'charge' = $1 ORDER BY seq DESC", [chId]);
  return rows.map((r) => r.data);
}

export const CHANGES: Change[] = [
  {
    version: '2026-09-30',
    description: 'PaymentIntent gains `allowed_payment_method_types` and `excluded_payment_method_types` (inputs that replace `payment_method_types`).',
    resources: ['payment_intent'],
    down: (o) => {
      delete o.allowed_payment_method_types;
      delete o.excluded_payment_method_types;
      return o;
    },
  },
  {
    version: '2025-03-31',
    description: 'Checkout Session moves `shipping_details` into `collected_information.shipping_details`.',
    resources: ['checkout.session'],
    down: (o) => {
      o.shipping_details = o.collected_information?.shipping_details ?? null;
      delete o.collected_information;
      return o;
    },
  },
  {
    version: '2025-09-30',
    description: 'PromotionCode replaces the embedded `coupon` with `promotion` ({type: "coupon", coupon}).',
    resources: ['promotion_code'],
    down: async (o) => {
      const id = o.promotion?.coupon && typeof o.promotion.coupon === 'object' ? o.promotion.coupon.id : o.promotion?.coupon;
      const row = id ? await query<{ data: any }>("SELECT data FROM objects WHERE type = 'coupon' AND id = $1 LIMIT 1", [id]) : [];
      o.coupon = row[0]?.data ?? (typeof o.promotion?.coupon === 'object' ? o.promotion.coupon : id);
      delete o.promotion;
      return o;
    },
  },
  {
    version: '2026-10-01',
    description: 'PaymentIntent gains `amount_details`; older versions omit it.',
    resources: ['payment_intent'],
    down: (o) => {
      delete o.amount_details;
      return o;
    },
  },
  {
    version: '2022-11-15',
    description: 'PaymentIntent no longer embeds `charges`; Charge no longer embeds `refunds`. Use latest_charge / list endpoints instead.',
    resources: ['payment_intent', 'charge'],
    down: async (o) => {
      if (o.object === 'payment_intent') {
        const data = await chargesFor(o.id);
        o.charges = { object: 'list', data, has_more: false, total_count: data.length, url: `/v1/charges?payment_intent=${o.id}` };
      } else if (o.object === 'charge') {
        const data = await refundsFor(o.id);
        o.refunds = { object: 'list', data, has_more: false, total_count: data.length, url: `/v1/charges/${o.id}/refunds` };
      }
      return o;
    },
  },
];

export const SUPPORTED_VERSIONS = ['2020-08-27', '2022-08-01', '2022-11-15', '2024-06-20', '2025-09-30', config.latestApiVersion];

export function validateVersion(v: string): string {
  const base = v.split('.')[0]!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) throw invalid(`Invalid Stripe-Version header: '${v}'.`, 'Stripe-Version');
  if (base > config.latestApiVersion) return config.latestApiVersion;
  return base;
}

/** Recursively apply version change modules to an object graph (including lists and expansions). */
export async function transformForVersion(obj: any, version: string): Promise<any> {
  if (!obj || typeof obj !== 'object' || version >= config.latestApiVersion) return obj;
  if (Array.isArray(obj)) return Promise.all(obj.map((o) => transformForVersion(o, version)));
  for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') obj[k] = await transformForVersion(v, version);
  for (const change of CHANGES) {
    if (change.version > version && obj.object && change.resources.includes(obj.object)) obj = await change.down(obj);
  }
  return obj;
}
