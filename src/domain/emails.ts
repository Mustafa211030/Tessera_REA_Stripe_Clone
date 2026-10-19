import { one, query } from '../db/index.ts';
import { invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import type { Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { getAccount } from './accounts.ts';
import { insertObject, listObjects } from './store.ts';

/**
 * Simulated email. Nothing leaves the machine: messages land in the account's inbox
 * (Developers → Emails), rendered exactly as a customer would see them.
 *
 * Sent automatically (each kind can be turned off in Settings → Emails):
 *   receipt          a payment succeeded and the charge has an email address
 *   refund           a charge was refunded
 *   invoice          a send_invoice invoice was finalized, or POST /v1/invoices/:id/send
 *   payment_failed   an invoice payment failed: a link to update the payment method
 *   trial_ending     three days before a trial ends
 *   team_invite      someone was invited to the team
 *   verification_code  a returning customer signs in to one-click checkout
 */

export const KINDS = {
  receipt: 'Successful payments',
  refund: 'Refunds',
  invoice: 'Invoices',
  payment_failed: 'Failed payments (update payment method)',
  trial_ending: 'Trial ending reminders',
  team_invite: 'Team invitations',
  verification_code: 'One-click checkout sign-in codes',
} as const;
export type Kind = keyof typeof KINDS;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (amount: number, cur: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(['jpy', 'krw'].includes(cur) ? amount : amount / 100);

type Message = {
  to: string; kind: Kind; subject: string; heading: string; paragraphs: string[];
  rows?: [string, string][]; total?: [string, string]; button?: { label: string; url: string }; links?: { label: string; url: string }[];
  related?: { type: string; id: string } | null;
};

function render(merchant: string, m: Message) {
  const rows = (m.rows ?? []).map(([l, v]) => `<tr><td style="padding:6px 0;color:#55554f">${esc(l)}</td><td style="padding:6px 0;text-align:right">${esc(v)}</td></tr>`).join('');
  const total = m.total ? `<tr><td style="padding:10px 0;border-top:1px solid #e6e4df;font-weight:600">${esc(m.total[0])}</td><td style="padding:10px 0;border-top:1px solid #e6e4df;text-align:right;font-weight:600">${esc(m.total[1])}</td></tr>` : '';
  const button = m.button ? `<p style="margin:24px 0"><a href="${esc(m.button.url)}" style="background:#0f6b56;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${esc(m.button.label)}</a></p>` : '';
  const links = (m.links ?? []).map((l) => `<a href="${esc(l.url)}" style="color:#0f6b56">${esc(l.label)}</a>`).join(' · ');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1b">
<div style="max-width:520px;margin:0 auto;padding:32px 16px">
<div style="font-weight:600;margin-bottom:16px">${esc(merchant)}</div>
<div style="background:#fff;border:1px solid #e6e4df;border-radius:10px;padding:28px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(m.heading)}</h1>
${m.paragraphs.map((p) => `<p style="margin:0 0 10px;line-height:1.5">${esc(p)}</p>`).join('')}
${rows || total ? `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:14px">${rows}${total}</table>` : ''}
${button}${links ? `<p style="font-size:13px;margin:12px 0 0">${links}</p>` : ''}
</div>
<p style="font-size:12px;color:#86857f;margin-top:16px">Sent by Tessera in test mode. This message was not delivered to a real inbox.</p>
</div></body></html>`;
  const text = [m.heading, '', ...m.paragraphs, '', ...(m.rows ?? []).map(([l, v]) => `${l}: ${v}`), ...(m.total ? [`${m.total[0]}: ${m.total[1]}`] : []), ...(m.button ? ['', `${m.button.label}: ${m.button.url}`] : []), ...(m.links ?? []).map((l) => `${l.label}: ${l.url}`)].join('\n');
  return { html, text };
}

export async function emailSettings(accountId: string): Promise<Record<Kind, boolean>> {
  const a = await getAccount(accountId);
  const s = a?._email_settings ?? {};
  return Object.fromEntries(Object.keys(KINDS).map((k) => [k, s[k] !== false])) as Record<Kind, boolean>;
}

export async function updateEmailSettings(accountId: string, p: Record<string, unknown>) {
  const a = await getAccount(accountId);
  const cur = a._email_settings ?? {};
  for (const k of Object.keys(KINDS)) if (p[k] !== undefined) cur[k] = p[k] === true || p[k] === 'true';
  a._email_settings = cur;
  await query('UPDATE accounts SET data = $1 WHERE id = $2', [JSON.stringify(a), accountId]);
  return emailSettings(accountId);
}

export async function sendEmail(accountId: string, m: Message) {
  if (!(await emailSettings(accountId))[m.kind]) return null;
  const a = await getAccount(accountId);
  const merchant = a?.settings?.dashboard?.display_name ?? a?.business_profile?.name ?? 'Tessera merchant';
  const { html, text } = render(merchant, m);
  const email = {
    id: newId('em'), object: 'tessera.email', created: nowSeconds(), livemode: false, kind: m.kind,
    from: `${merchant} <${m.kind === 'team_invite' ? 'team' : 'receipts'}@tessera.local>`, to: m.to, subject: m.subject, html, text,
    related: m.related ?? null, status: 'delivered',
  };
  await insertObject(accountId, email as any);
  return email;
}

export async function listEmails(ctx: Ctx, p: Params) {
  const filters: { field: string; value: string }[] = [];
  if (p.kind) filters.push({ field: 'kind', value: String(p.kind) });
  if (p.to) filters.push({ field: 'to', value: String(p.to).toLowerCase() });
  const l = await listObjects(ctx.accountId, 'tessera.email', '/v1/tessera/emails', p, filters);
  return { ...l, data: l.data.map((e: any) => ({ ...e, html: undefined, text: undefined, preview: String(e.text ?? '').split('\n').filter(Boolean).slice(1, 2).join(' ').slice(0, 140) })) };
}

// ---------------------------------------------------------------- automatic emails

const name = async (accountId: string) => {
  const a = await getAccount(accountId);
  return a?.settings?.dashboard?.display_name ?? a?.business_profile?.name ?? 'Tessera merchant';
};

async function customerEmail(accountId: string, id: string | null | undefined) {
  if (!id) return null;
  const c = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2 AND type = 'customer'", [accountId, id]);
  return c?.data.email ?? null;
}

async function invoiceEmail(ctx: Ctx, inv: any) {
  const to = inv.customer_email ?? (await customerEmail(ctx.accountId, inv.customer));
  if (!to || !inv.hosted_invoice_url) return;
  const merchant = await name(ctx.accountId);
  const due = inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' }) : null;
  await sendEmail(ctx.accountId, {
    to, kind: 'invoice', related: { type: 'invoice', id: inv.id },
    subject: `Invoice ${inv.number} from ${merchant}`, heading: `${fmt(inv.amount_remaining ?? inv.amount_due, inv.currency)}${due ? ` due ${due}` : ''}`,
    paragraphs: [`${merchant} sent you invoice ${inv.number}.`, ...(inv.amounts_due?.length ? [`You can pay in ${inv.amounts_due.length} installments.`] : [])],
    rows: inv.lines.data.slice(0, 8).map((l: any) => [l.description ?? 'Item', fmt(l.amount, inv.currency)]),
    total: ['Amount due', fmt(inv.amount_remaining ?? inv.amount_due, inv.currency)],
    button: { label: 'Pay this invoice', url: inv.hosted_invoice_url },
    links: inv.invoice_pdf ? [{ label: 'Download PDF', url: inv.invoice_pdf }] : [],
  });
}

/** Called for every event (see events.ts). Must never throw. */
export async function afterEvent(ctx: Ctx, type: string, o: any) {
  try {
    if (type === 'charge.succeeded') {
      const to = o.receipt_email ?? o.billing_details?.email ?? (await customerEmail(ctx.accountId, o.customer));
      if (!to) return;
      const merchant = await name(ctx.accountId);
      const card = o.payment_method_details?.card;
      await sendEmail(ctx.accountId, {
        to, kind: 'receipt', related: { type: 'charge', id: o.id },
        subject: `Your receipt from ${merchant}`, heading: `Receipt from ${merchant}`,
        paragraphs: [`Thanks for your payment${o.description ? ` for ${o.description}` : ''}.`],
        rows: [['Amount paid', fmt(o.amount, o.currency)], ['Date', new Date(o.created * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })], ...(card ? [['Payment method', `${card.brand} •••• ${card.last4}`] as [string, string]] : [])],
        button: o.receipt_url ? { label: 'View receipt', url: o.receipt_url } : undefined,
      });
    } else if (type === 'charge.refunded') {
      const to = o.receipt_email ?? o.billing_details?.email ?? (await customerEmail(ctx.accountId, o.customer));
      if (!to) return;
      const merchant = await name(ctx.accountId);
      await sendEmail(ctx.accountId, {
        to, kind: 'refund', related: { type: 'charge', id: o.id },
        subject: `Refund from ${merchant}`, heading: `${fmt(o.amount_refunded, o.currency)} refunded`,
        paragraphs: [`${merchant} refunded your payment. Refunds take 5 to 10 business days to appear on your statement.`],
        button: o.receipt_url ? { label: 'View receipt', url: o.receipt_url } : undefined,
      });
    } else if (type === 'invoice.finalized' && o.collection_method === 'send_invoice') {
      await invoiceEmail(ctx, o);
    } else if (type === 'invoice.sent') {
      // Sending a draft finalizes it, which already emailed the invoice moments ago.
      const recent = await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'tessera.email' AND data->'related'->>'id' = $2 AND created >= $3", [ctx.accountId, o.id, nowSeconds() - 5]);
      if (!recent) await invoiceEmail(ctx, o);
    } else if (type === 'invoice.payment_failed') {
      const to = o.customer_email ?? (await customerEmail(ctx.accountId, o.customer));
      if (!to) return;
      const merchant = await name(ctx.accountId);
      let url = o.hosted_invoice_url;
      // Subscriptions: send the customer to the portal to update their card.
      if (o.subscription) {
        const cfg = await one("SELECT 1 FROM objects WHERE account_id = $1 AND type = 'billing_portal.configuration'", [ctx.accountId]);
        if (cfg) {
          const { createPortalSession } = await import('./billing/portal.ts');
          const ps: any = await createPortalSession(ctx, { customer: o.customer, return_url: o.hosted_invoice_url ?? ctx.baseUrl });
          url = ps.url;
        }
      }
      await sendEmail(ctx.accountId, {
        to, kind: 'payment_failed', related: { type: 'invoice', id: o.id },
        subject: `Action needed: your payment to ${merchant} failed`, heading: 'Your payment didn\'t go through',
        paragraphs: [`We couldn't charge ${fmt(o.amount_remaining ?? o.amount_due, o.currency)} for invoice ${o.number}.`, o.next_payment_attempt ? `We'll try again on ${new Date(o.next_payment_attempt * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' })}. Update your payment method before then to avoid an interruption.` : 'Update your payment method to keep your subscription active.'],
        button: url ? { label: 'Update payment method', url } : undefined,
      });
    } else if (type === 'customer.subscription.trial_will_end') {
      const to = await customerEmail(ctx.accountId, o.customer);
      if (!to) return;
      const merchant = await name(ctx.accountId);
      await sendEmail(ctx.accountId, {
        to, kind: 'trial_ending', related: { type: 'subscription', id: o.id },
        subject: `Your ${merchant} trial ends soon`, heading: 'Your free trial is ending',
        paragraphs: [`Your trial ends on ${new Date(o.trial_end * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' })}. After that, your default payment method will be charged automatically.`],
      });
    }
  } catch (e) {
    // Emails are best-effort and must not undo the change that triggered them.
    if (process.env.TESSERA_DEBUG) console.error('[email]', e);
  }
}

export async function getEmail(ctx: Ctx, id: string) {
  const row = await one<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND id = $2 AND type = 'tessera.email'", [ctx.accountId, id]);
  if (!row) throw invalid(`No such email: '${id}'`, 'id', 'resource_missing');
  return row.data;
}
