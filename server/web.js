'use strict';
/*
 * Extranet web service — serves the compiled UI (app/dist) on :3000.
 *
 *   /            home.html   the guest start page (data comes from /api/directory)
 *   /admin       admin.html  the console (blocked on the public link)
 *   /analytics   analytics.html (blocked on the public link)
 *   /app/*       the Vite bundle's assets
 *   /favicon.ico, /robots.txt
 *
 * Internal service: binds 127.0.0.1 only — the reverse proxy is the only
 * way in from the outside. The proxy tags each request with x-client-kind
 * (local | lan | tunnel); a missing tag means the owner hit this service
 * directly on this computer.
 */

const fs = require('fs');
const path = require('path');
const Fastify = require('fastify');
const lib = require('./lib');

const { PUBLIC_DIR, sendRawHtml } = lib;

const APP_TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function appPage(name) {
  try { return fs.readFileSync(path.join(PUBLIC_DIR, name)); }
  catch {
    return Buffer.from(lib.pageHTML('UI not built', `<h1>UI not built</h1>
<p>The interface is missing. Run <code>npx extranet --build</code> (or <code>npm run build --prefix app</code>) once, then restart.</p>`));
  }
}

function sendPage(reply, name) {
  return reply.code(200)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex')
    .send(appPage(name));
}

function clientKind(req) {
  const k = String(req.headers['x-client-kind'] || 'local');
  return ['local', 'lan', 'tunnel'].includes(k) ? k : 'lan';
}

function tunnelDenied(reply, title, message) {
  return sendRawHtml(reply.raw, 403, title, `<h1>Not available on the public link</h1><p>${lib.escapeHTML(message)}</p>`);
}

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
app.get('/robots.txt', async (_req, reply) => reply.code(200).type('text/plain').send('User-agent: *\nDisallow: /\n'));

app.get('/', async (_req, reply) => sendPage(reply, 'home.html'));

app.all('/admin', async (req, reply) => {
  const method = req.raw.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') return reply.code(405).send();
  if (clientKind(req) === 'tunnel') {
    return tunnelDenied(reply, 'Not available on the public link',
      'The admin console is only reachable from this computer, or from the network with an admin token.');
  }
  return sendPage(reply, 'admin.html');
});

app.all('/analytics', async (req, reply) => {
  const method = req.raw.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') return reply.code(405).send();
  if (clientKind(req) === 'tunnel') {
    return tunnelDenied(reply, 'Not available on the public link',
      'The analytics page lives on the admin console. Open the admin address printed on your computer.');
  }
  return sendPage(reply, 'analytics.html');
});

/* the Vite bundle's assets */
app.all('/app', appAssetRoute);
app.all('/app/*', appAssetRoute);

async function appAssetRoute(req, reply) {
  const { pathname } = new URL(req.raw.url || '/app', 'http://internal');
  if (req.raw.method !== 'GET' && req.raw.method !== 'HEAD') return reply.code(405).send();
  let rel;
  try { rel = decodeURIComponent(pathname.slice('/app/'.length)).replace(/\.\.+/g, ''); } catch { return reply.code(400).send(); }
  const base = PUBLIC_DIR;         // the Vite bundle writes assets/ next to the pages
  const fp = path.resolve(base, rel);
  if (!fp.startsWith(base + path.sep)) return reply.code(403).send();
  let data;
  try { data = fs.readFileSync(fp); } catch { return reply.code(404).send(); }
  const type = APP_TYPES[path.extname(fp).toLowerCase()];
  if (!type) return reply.code(404).send(); // stay tight: only known asset types
  const immutable = pathname.startsWith('/app/assets/');
  return reply.code(200)
    .type(type)
    .header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    .header('X-Robots-Tag', 'noindex')
    .send(data);
}

/* everything else */
app.setNotFoundHandler((req, reply) => {
  reply.hijack();
  sendRawHtml(reply.raw, 404, 'Nothing here', `<h1>Nothing here</h1>
<p>${lib.escapeHTML(clientKind(req) === 'tunnel'
    ? 'Nothing is shared at this address on the public link.'
    : 'Nothing is shared at this address.')}</p>`);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

const wantPort = lib.envPort('WEB') || lib.DEFAULT_PORTS.web;

(async () => {
  const port = await lib.bindWithBump(
    (p) => app.listen({ port: p, host: '127.0.0.1' }),
    wantPort,
  );
  lib.publishService('web', port);
  console.log(`web service ready on 127.0.0.1:${port} (app/dist: ${PUBLIC_DIR})`);
})().catch((err) => {
  console.error('web service failed to start:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled promise rejection:', err));
