import type { FastifyInstance } from 'fastify';
import * as persons from '../domain/connect/persons.ts';
import * as files from '../domain/files.ts';
import * as sigma from '../domain/sigma.ts';
import { listObjects } from '../domain/store.ts';
import { apiRoute } from '../platform/http.ts';

/** Files and file links, the Persons API, and SQL over your data. */
export function registerData(app: FastifyInstance) {
  // ---------- Files ----------
  apiRoute(app, 'POST', '/v1/files', { resource: 'files' }, (ctx, p) => files.createFile(ctx, p));
  apiRoute(app, 'GET', '/v1/files', { resource: 'files' }, (ctx, p) =>
    listObjects(ctx.accountId, 'file', '/v1/files', p, p.purpose ? [{ field: 'purpose', value: String(p.purpose) }] : []));
  apiRoute(app, 'GET', '/v1/files/:id', { resource: 'files' }, (ctx, p) => files.getFile(ctx, p.id));
  apiRoute(app, 'GET', '/v1/files/:id/contents', { resource: 'files', raw: true }, (ctx, p, req) => files.fileContents(ctx, p.id, req));

  apiRoute(app, 'POST', '/v1/file_links', { resource: 'file_links' }, (ctx, p) => files.createFileLink(ctx, p));
  apiRoute(app, 'GET', '/v1/file_links', { resource: 'file_links' }, (ctx, p) => files.listFileLinks(ctx, p));
  apiRoute(app, 'GET', '/v1/file_links/:id', { resource: 'file_links' }, (ctx, p) => files.getFileLink(ctx, p.id));
  apiRoute(app, 'POST', '/v1/file_links/:id', { resource: 'file_links' }, (ctx, p) => files.updateFileLink(ctx, p.id, p));

  // Public download URL of a file link (no API key; expires with the link).
  app.get('/links/:token', async (req, reply) => {
    const r = await files.resolveLink((req.params as any).token);
    if (!r) return reply.code(404).type('text/plain').send('This link does not exist.');
    if (r.expired) return reply.code(410).type('text/plain').send('This link has expired.');
    const name = String(r.file.filename ?? r.file.id).replace(/["\\\r\n]/g, '_');
    return reply
      .header('Content-Type', files.mimeFor(r.file.type))
      .header('Content-Disposition', `inline; filename="${name}"`)
      .header('Cache-Control', 'private, no-store')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .send(r.bytes);
  });

  // ---------- Persons (Connect) ----------
  for (const seg of ['persons', 'people']) {
    apiRoute(app, 'POST', `/v1/accounts/:id/${seg}`, { resource: 'accounts' }, (ctx, p) => persons.createPerson(ctx, p.id, p));
    apiRoute(app, 'GET', `/v1/accounts/:id/${seg}`, { resource: 'accounts' }, (ctx, p) => persons.listPersons(ctx, p.id, p));
    apiRoute(app, 'GET', `/v1/accounts/:id/${seg}/:pid`, { resource: 'accounts' }, (ctx, p) => persons.getPerson(ctx, p.id, p.pid));
    apiRoute(app, 'POST', `/v1/accounts/:id/${seg}/:pid`, { resource: 'accounts' }, (ctx, p) => persons.updatePerson(ctx, p.id, p.pid, p));
    apiRoute(app, 'DELETE', `/v1/accounts/:id/${seg}/:pid`, { resource: 'accounts' }, (ctx, p) => persons.deletePerson(ctx, p.id, p.pid));
  }

  // ---------- SQL (Sigma-style) ----------
  apiRoute(app, 'POST', '/v1/tessera/sigma/query', { resource: 'reporting', raw: true }, (ctx, p) => sigma.runQuery(ctx, p.sql));
  apiRoute(app, 'GET', '/v1/tessera/sigma/schema', { resource: 'reporting', raw: true }, (ctx) => sigma.sigmaSchema(ctx));
  apiRoute(app, 'GET', '/v1/tessera/sigma/templates', { resource: 'reporting', raw: true }, async () => ({ object: 'list', data: sigma.TEMPLATES }));
}
