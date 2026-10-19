import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import qs from 'qs';
import { closeDb, openDb } from './db/index.ts';
import { registerBilling } from './routes/billing.ts';
import { registerConnect } from './routes/connect.ts';
import { registerExtended } from './routes/extended.ts';
import { registerCommerce } from './routes/commerce.ts';
import { registerGrowth } from './routes/growth.ts';
import { registerFinance } from './routes/finance.ts';
import { registerOperations } from './routes/operations.ts';
import { registerTreasury } from './routes/treasury.ts';
import { upgradeAccounts } from './domain/connect/accounts.ts';
import { registerV1 } from './routes/v1.ts';
import { registerWeb } from './routes/web.ts';
import { registerData } from './routes/data.ts';
import { registerServices } from './routes/services.ts';
import { registerTaxSearch } from './routes/taxSearch.ts';
import { registerTeam } from './routes/team.ts';
import { registerMethods } from './routes/methods.ts';
import { registerSystem } from './routes/system.ts';
import { registerBillingExtras } from './routes/billingExtras.ts';
import { parseMultipart } from './lib/multipart.ts';
import { closeVault, openVault } from './vault/vault.ts';

export async function buildApp(opts: { dataDir?: string; logger?: boolean } = {}): Promise<FastifyInstance> {
  await openDb(opts.dataDir ? join(opts.dataDir, 'pg') : undefined);
  await openVault(opts.dataDir ? join(opts.dataDir, 'vault') : undefined);
  await upgradeAccounts();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: false });

  // The public API speaks form encoding with bracket notation: card[number]=..., expand[]=...
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, qs.parse(body as string, { depth: 6, arrayLimit: 200, parameterLimit: 2000 }));
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  // File uploads: multipart/form-data with text fields (bracket notation) and one file part.
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 17 * 1024 * 1024 }, (req, body, done) => {
    try {
      done(null, parseMultipart(body as Buffer, String(req.headers['content-type'])));
    } catch (e) {
      (e as any).statusCode = 400;
      done(e as Error, undefined);
    }
  });
  // Query strings use the same bracket notation.
  app.addHook('onRequest', async (req) => {
    const i = req.url.indexOf('?');
    if (i >= 0) (req as any).query = qs.parse(req.url.slice(i + 1), { depth: 6, arrayLimit: 200 });
  });

  // Security headers on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (/^\/v1\/quotes\/[^/?]+\/pdf/.test(req.url) && reply.statusCode === 200) {
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `inline; filename="${req.url.split('/')[3]}.pdf"`);
    }
    const tf = (req as any).tesseraFile as { type: string; filename: string } | undefined;
    if (tf && reply.statusCode === 200) {
      reply.header('Content-Type', tf.type);
      reply.header('Content-Disposition', `${/^(image|application\/pdf)/.test(tf.type) ? 'inline' : 'attachment'}; filename="${tf.filename.replace(/["\\\r\n]/g, '_')}"`);
    }
    if (req.url.startsWith('/v1/')) {
      reply.header('Cache-Control', 'no-cache, no-store');
      reply.header('Content-Security-Policy', "base-uri 'none'; default-src 'none'; form-action 'none'; frame-ancestors 'none'");
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Expose-Headers', 'Request-Id, Stripe-Should-Retry, Idempotent-Replayed, Stripe-Version, Stripe-Account');
    } else if (!req.url.startsWith('/elements/')) {
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    }
  });
  app.options('/v1/*', async (_req, reply) =>
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, DELETE')
      .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Stripe-Version, Stripe-Account')
      .header('Access-Control-Max-Age', '300')
      .code(204)
      .send(),
  );

  registerV1(app);
  registerBilling(app);
  registerConnect(app);
  registerExtended(app);
  registerCommerce(app);
  registerGrowth(app);
  registerFinance(app);
  registerOperations(app);
  registerTreasury(app);
  registerData(app);
  registerServices(app);
  registerTaxSearch(app);
  registerTeam(app);
  registerMethods(app);
  registerSystem(app);
  registerBillingExtras(app);
  registerWeb(app);

  // Client SDK + isolated card element (served as plain static files).
  const root = process.cwd();
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/', decorateReply: true, index: false, wildcard: false });
  const dist = join(root, 'web', 'dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/app-assets/', decorateReply: false });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/v1/')) {
      return reply.code(404).send({ error: { type: 'invalid_request_error', message: `Unrecognized request URL (${req.method}: ${req.url.split('?')[0]}).` } });
    }
    if (req.method === 'GET' && existsSync(join(dist, 'index.html'))) {
      return reply.type('text/html').sendFile('index.html', dist);
    }
    return reply.code(404).type('text/plain').send('Not found. Run `npm run build` to build the dashboard.');
  });

  app.addHook('onClose', async () => {
    await (await import('./platform/hotpath.ts')).flushLogs();
    await closeDb();
    await closeVault();
  });
  return app;
}
