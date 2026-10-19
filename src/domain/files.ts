import { randomBytes } from 'node:crypto';
import { one, query } from '../db/index.ts';
import { ApiError, invalid } from '../lib/errors.ts';
import { newId, nowSeconds } from '../lib/ids.ts';
import { bool, int, metadata, str, type Params } from '../lib/params.ts';
import type { Ctx } from '../platform/context.ts';
import { findObject, getObject, insertObject, listObjects, saveObject } from './store.ts';

/**
 * File uploads (POST /v1/files, multipart/form-data) and file links.
 *
 * Bytes live in the `file_blobs` table; the `file` object carries metadata only. Financial
 * report files created by the reporting worker keep their CSV in `_content` and are served
 * through the same endpoints. The contents endpoint needs a secret key; a file link gives a
 * public URL (/links/<token>) that works until it expires.
 */

/** Multipart file part as parsed by the app's content-type parser (bytes are non-enumerable). */
export type UploadedPart = { filename: string; content_type: string; size: number; data?: Buffer };

type Rule = { types: string[] | null; max: number; linkable: boolean };
const MB = 1024 * 1024;
const DOC = ['pdf', 'jpg', 'png'];
export const PURPOSES: Record<string, Rule> = {
  account_requirement: { types: DOC, max: 16 * MB, linkable: false },
  additional_verification: { types: DOC, max: 10 * MB, linkable: false },
  business_icon: { types: ['png', 'jpg', 'gif'], max: 512 * 1024, linkable: true },
  business_logo: { types: ['png', 'jpg', 'gif'], max: 512 * 1024, linkable: true },
  customer_signature: { types: ['png', 'jpg'], max: 4 * MB, linkable: true },
  dispute_evidence: { types: DOC, max: 5 * MB, linkable: true },
  identity_document: { types: DOC, max: 10 * MB, linkable: false },
  issuing_regulatory_reporting: { types: null, max: 16 * MB, linkable: false },
  pci_document: { types: ['pdf'], max: 16 * MB, linkable: false },
  tax_document_user_upload: { types: ['pdf', 'jpg', 'png', 'csv'], max: 16 * MB, linkable: false },
  terminal_reader_splashscreen: { types: ['png', 'jpg', 'gif'], max: 4 * MB, linkable: true },
};

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8', json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip',
};

/** File type from magic bytes, falling back to the filename extension. */
export function sniffType(buf: Buffer, filename: string): string {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length > 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(filename)?.[1] ?? '').toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  if (buf.subarray(0, 2).toString('latin1') === 'PK') return ext === 'docx' || ext === 'xlsx' ? ext : 'zip';
  return ext && MIME[ext] ? ext : 'txt';
}

export const mimeFor = (type: string) => MIME[type] ?? 'application/octet-stream';

function linksList(fileId: string, data: any[] = []) {
  return { object: 'list', data, has_more: false, url: `/v1/file_links?file=${fileId}` };
}

export async function createFile(ctx: Ctx, p: Params) {
  const purpose = str(p, 'purpose', { required: true })!;
  const rule = PURPOSES[purpose];
  if (!rule) throw invalid(`Invalid purpose: must be one of ${Object.keys(PURPOSES).join(', ')}`, 'purpose');
  const part = p.file as UploadedPart | undefined;
  if (!part || typeof part !== 'object' || !part.data) {
    throw invalid('Missing required param: file. Send the file as multipart/form-data with a `file` part.', 'file', 'parameter_missing');
  }
  const buf = part.data;
  if (!buf.length) throw invalid('The file is empty.', 'file');
  if (buf.length > rule.max) throw invalid(`Files with purpose ${purpose} can be at most ${rule.max >= MB ? `${rule.max / MB}MB` : `${rule.max / 1024}KB`}. This file is ${(buf.length / MB).toFixed(2)}MB.`, 'file', 'file_too_large');
  const type = sniffType(buf, part.filename);
  if (rule.types && !rule.types.includes(type)) {
    throw invalid(`Files with purpose ${purpose} must be one of these types: ${rule.types.join(', ')}. This file looks like ${type}.`, 'file', 'file_invalid_type');
  }
  const now = nowSeconds();
  const id = newId('file');
  const file: any = {
    id, object: 'file', created: now, expires_at: null, filename: part.filename || 'upload', links: linksList(id), livemode: false,
    purpose, size: buf.length, title: null, type, url: `${ctx.baseUrl}/v1/files/${id}/contents`,
  };
  await query('INSERT INTO file_blobs (id, account_id, data) VALUES ($1,$2,$3)', [id, ctx.accountId, buf]);
  await insertObject(ctx.accountId, file);
  const fl = p.file_link_data;
  if (fl && typeof fl === 'object' && (fl.create === 'true' || fl.create === true)) {
    const link = await createFileLink(ctx, { file: id, expires_at: fl.expires_at, metadata: fl.metadata });
    file.links = linksList(id, [link]);
  }
  return file;
}

export async function getFile(ctx: Ctx, id: string) {
  const f = await getObject<any>(ctx.accountId, 'file', id, 'file');
  const links = await query<{ data: any }>("SELECT data FROM objects WHERE account_id = $1 AND type = 'file_link' AND data->>'file' = $2 ORDER BY seq DESC LIMIT 10", [ctx.accountId, id]);
  f.links = linksList(id, links.map((r) => presentLink(r.data)));
  return f;
}

/** Raw bytes for a file (uploaded blob, or a generated report's CSV). */
export async function fileBytes(accountId: string, f: any): Promise<Buffer> {
  if (typeof f._content === 'string') return Buffer.from(f._content, 'utf8');
  const row = await one<{ data: Uint8Array }>('SELECT data FROM file_blobs WHERE id = $1 AND account_id = $2', [f.id, accountId]);
  return row ? Buffer.from(row.data) : Buffer.alloc(0);
}

export async function fileContents(ctx: Ctx, id: string, req?: any) {
  const f = await getObject<any>(ctx.accountId, 'file', id, 'file');
  if (req) req.tesseraFile = { type: mimeFor(f.type), filename: f.filename ?? `${f.id}.${f.type}` };
  return fileBytes(ctx.accountId, f);
}

/**
 * Validates a file id passed in another API (dispute evidence, identity documents).
 * Files on the platform account may be used for its connected accounts.
 */
export async function assertFile(ctx: Ctx, id: string, purposes: string[], param: string) {
  if (typeof id !== 'string' || !id.startsWith('file_')) throw invalid(`Invalid file id: '${id}'. Upload the file with POST /v1/files first.`, param);
  const f = (await findObject<any>(ctx.accountId, 'file', id)) ?? (ctx.platformAccountId ? await findObject<any>(ctx.platformAccountId, 'file', id) : undefined);
  if (!f) throw invalid(`No such file upload: '${id}'`, param, 'resource_missing');
  if (!purposes.includes(f.purpose)) throw invalid(`The file ${id} was uploaded with purpose ${f.purpose}; this field needs a file with purpose ${purposes.join(' or ')}.`, param, 'file_purpose_invalid');
  return f;
}

// ---------------------------------------------------------------- file links

function presentLink(l: any) {
  const now = nowSeconds();
  return { ...l, expired: l.expires_at !== null && l.expires_at <= now };
}

function parseExpiry(v: any, param: string) {
  if (v === undefined || v === '' || v === null) return null;
  if (v === 'now') return nowSeconds();
  const t = int({ v }, 'v');
  if (!t || t <= nowSeconds()) throw invalid('expires_at must be in the future.', param);
  return t;
}

export async function createFileLink(ctx: Ctx, p: Params) {
  const fileId = str(p, 'file', { required: true })!;
  const f = await getObject<any>(ctx.accountId, 'file', fileId, 'file', 'file');
  const rule = PURPOSES[f.purpose];
  if (f.purpose !== 'finance_report_run' && (!rule || !rule.linkable)) {
    throw invalid(`Links can't be created for files with purpose ${f.purpose}, because they may contain sensitive data.`, 'file', 'file_link_not_allowed');
  }
  const now = nowSeconds();
  const token = randomBytes(18).toString('base64url');
  const link = {
    id: newId('link'), object: 'file_link', created: now, expired: false, expires_at: parseExpiry(p.expires_at, 'expires_at'), file: f.id,
    livemode: false, metadata: metadata(p), url: `${ctx.baseUrl}/links/${token}`, _token: token,
  };
  await insertObject(ctx.accountId, link);
  return presentLink(link);
}

export async function getFileLink(ctx: Ctx, id: string) {
  return presentLink(await getObject<any>(ctx.accountId, 'file_link', id, 'file_link'));
}

export async function updateFileLink(ctx: Ctx, id: string, p: Params) {
  const l = await getObject<any>(ctx.accountId, 'file_link', id, 'file_link');
  if (presentLink(l).expired) throw new ApiError(400, 'invalid_request_error', 'This file link has expired and can no longer be updated.');
  if (p.expires_at !== undefined) l.expires_at = parseExpiry(p.expires_at, 'expires_at');
  l.metadata = metadata(p, l.metadata);
  await saveObject(ctx.accountId, l);
  return presentLink(l);
}

export async function listFileLinks(ctx: Ctx, p: Params) {
  const filters = p.file ? [{ field: 'file', value: String(p.file) }] : [];
  const list = await listObjects(ctx.accountId, 'file_link', '/v1/file_links', p, filters);
  let data = list.data.map(presentLink);
  const expired = bool(p, 'expired');
  if (expired !== undefined) data = data.filter((l) => l.expired === expired);
  return { ...list, data };
}

/** Public download through a file link (no API key). */
export async function resolveLink(token: string) {
  const row = await one<{ account_id: string; data: any }>("SELECT account_id, data FROM objects WHERE type = 'file_link' AND data->>'_token' = $1", [token]);
  if (!row) return null;
  const l = presentLink(row.data);
  if (l.expired) return { expired: true as const };
  const f = await findObject<any>(row.account_id, 'file', l.file);
  if (!f) return null;
  return { expired: false as const, file: f, bytes: await fileBytes(row.account_id, f) };
}
