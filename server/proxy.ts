import type { AccessEvent, ClientStats, AccessLog, Share, VisitorContext, Runtime, ServiceName, ClientKind } from './types';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
'use strict';
/*
 * Extranet reverse proxy — the public edge on :8787.
 *
 * The Cloudflare quick tunnel dials this port, and so do Wi-Fi guests; the
 * three services behind it bind 127.0.0.1 only and are reachable exclusively
 * through here. There are no subdomains to hand out (quick tunnels mint one
 * name), so everything is routed by path through a dynamic route registry:
 *
 *   registry entry            answers
 *   ────────────────────────────────────────────────────────────────
 *   /files        (service)   the files service  — folder shares under /files/<name>
 *   /api          (service)   the api service    — the JSON API
 *   /             (service)   the web service    — the compiled UI (catch-all)
 *   /movies       (folder)    → also the files service, share "movies"
 *   /webapp       (port)      → forwarded to a local port, root-absolute
 *                             HTML/CSS/Location/Set-Cookie repaired on the way
 *
 * Folder and app-port entries are the shares the owner manages in the admin
 * console; the registry file (config.json) is watched, so shares appear and
 * disappear live without a restart.
 *
 * This process is also the security + accounting edge for guest traffic:
 * blocklist, PIN gates for app-port shares, visitor scopes (Wi-Fi vs internet
 * link) and the access log all live here, because it is the one place every
 * request passes through.
 *
 * Deliberately plain Node http (no framework): request and response bodies
 * stream through untouched unless a small uncompressed HTML/CSS body from an
 * app-port share is being rewritten.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as lib from './lib';
import { t3Bootstrap, rewriteT3Script } from './t3-adapter';

const { HOP_SKIP_REQ, HOP_SKIP_RES, EDGE_HEADERS, rawHeaderPairs } = lib;

/* ------------------------------------------------------------------ */
/* Access log + blocklist (the /api/analytics data)                     */
/* ------------------------------------------------------------------ */

const LOG_CAP = 3000;   // requests kept in memory & on disk
const IP_CAP = 600;     // client entries kept on disk

const logStore: { entries: AccessEvent[]; ips: Map<string, ClientStats>; t: ReturnType<typeof setTimeout> | 0 } = { entries: [], ips: new Map(), t: 0 };

(function loadLogs() {
  try {
    const d: AccessLog = JSON.parse(fs.readFileSync(lib.LOG_FILE, 'utf8'));
    if (Array.isArray(d.entries)) logStore.entries = d.entries.slice(-LOG_CAP);
    for (const [ip, s] of Object.entries(d.ips || {})) {
      if (s && typeof s === 'object' && typeof s.count === 'number') logStore.ips.set(ip, s);
    }
  } catch { /* fresh */ }
})();

function writeLogs() {
  try {
    fs.mkdirSync(lib.DATA_DIR, { recursive: true });
    const ips = [...logStore.ips.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, IP_CAP);
    const tmp = lib.LOG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ entries: logStore.entries.slice(-LOG_CAP), ips: Object.fromEntries(ips) }));
    fs.renameSync(tmp, lib.LOG_FILE);
  } catch { /* best effort */ }
}

/* the api service reads this file for /api/analytics — keep it fresh */
function scheduleFlush() {
  if (logStore.t) return;
  logStore.t = setTimeout(() => { logStore.t = 0; writeLogs(); }, 2000);
}

function isBlocked(ip: string) {
  return lib.config.blockedIPs.some((b) => b.ip === ip);
}

function recordEvent(ev: AccessEvent) {
  logStore.entries.push(ev);
  if (logStore.entries.length > LOG_CAP) logStore.entries.splice(0, logStore.entries.length - LOG_CAP);
  let s = logStore.ips.get(ev.ip);
  if (!s) {
    s = { count: 0, bytes: 0, first: ev.t, last: ev.t, ua: ev.ua, lan: false, tunnel: false };
    logStore.ips.set(ev.ip, s);
  }
  s.count += 1;
  s.bytes += ev.bytes || 0;
  s.last = ev.t;
  if (ev.ua) s.ua = ev.ua;
  if (ev.kind === 'tunnel') s.tunnel = true;
  else if (ev.kind === 'lan') s.lan = true;
  if (logStore.ips.size > IP_CAP * 2) {
    const keep = [...logStore.ips.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, IP_CAP);
    logStore.ips = new Map(keep);
  }
  scheduleFlush();
}

/* owner machinery stays out of the guest log; the one guest-facing API call
 * (/api/directory, the start page's data) is tracked, like ?json=1 was before */
function isTrackablePath(p: string) {
  if (p.startsWith('/admin')) return false;
  if (p === '/app' || p.startsWith('/app/')) return false;
  if (p === '/analytics') return false;
  if (p === '/favicon.ico' || p === '/robots.txt') return false;
  if (p === '/__ctl' || p.startsWith('/__ctl/')) return false;
  if (p === '/api' || (p.startsWith('/api/') && p !== '/api/directory')) return false;
  return true;
}

function maybeRecord(ev: AccessEvent) {
  if (ev.blocked) return recordEvent(ev);   // security events always get logged
  if (!isTrackablePath(ev.path)) return;    // admin pages & static assets stay out
  recordEvent(ev);                          // guests AND the owner checking their own share
}

/* count bytes written to a response (for the analytics "data served" stat) */
function tapResponse(res: TappedResponse) {
  if (res.__tap) return;
  res.__tap = true;
  res.__bytes = 0;
  const size = (c: unknown) => {
    if (!c) return;
    try { res.__bytes! += typeof c === 'string' ? Buffer.byteLength(c) : c instanceof Uint8Array ? c.length : 0; } catch { /* ignore */ }
  };
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = ((...args: unknown[]) => { size(args[0]); return Reflect.apply(origWrite, res, args); }) as ServerResponse['write'];
  res.end = ((...args: unknown[]) => { size(args[0]); return Reflect.apply(origEnd, res, args); }) as ServerResponse['end'];
}

/* ------------------------------------------------------------------ */
/* The route registry                                                   */
/* ------------------------------------------------------------------ */

/* the three services — fixed registry entries, always present */
type TappedResponse = ServerResponse & { __bytes?: number; __tap?: boolean };
type ProxyMount = Share;
type DynamicRoute = { kind: 'folder' | 'port'; path: string; prefix: string; mount: Share };
type ServiceRoute = { kind: 'service'; service: ServiceName; path: string };

const SERVICE_ROUTES: ServiceRoute[] = [
  { kind: 'service', service: 'files', path: '/files' },
  { kind: 'service', service: 'api', path: '/api' },
  { kind: 'service', service: 'web', path: '/' },   // catch-all
];

/* the owner's shares, as routable entries (folder shares answer under the
 * /files prefix, app-port shares at their own top-level address) */
function dynamicRoutes(): DynamicRoute[] {
  const out: DynamicRoute[] = [];
  for (const m of lib.config.routes) {
    if (!m.path) continue;
    if (m.kind === 'folder' && m.dir) out.push({ kind: 'folder', path: m.path, prefix: '/files' + m.path, mount: m });
    else if (m.kind === 'port' && m.port) out.push({ kind: 'port', path: m.path, prefix: m.path, mount: m });
  }
  return out;
}

/* which routes this kind of visitor may see */
function routeVisible(mount: Share, kind: ClientKind) {
  if (kind === 'tunnel') return mount.public === true;
  if (kind === 'local') return true;
  return mount.lan !== false;
}

/* longest-prefix match; the catch-all service route is handled by the caller */
function resolveRoute(pathname: string, kind: ClientKind) {
  let best: DynamicRoute | null = null;
  for (const r of dynamicRoutes()) {
    if (!routeVisible(r.mount, kind)) continue;
    if (r.prefix !== pathname && !pathname.startsWith(r.prefix + '/')) continue;
    if (!best || r.prefix.length > best.prefix.length) best = r;
  }
  if (best) return best;
  for (const r of SERVICE_ROUTES) {
    if (r.path !== '/' && (r.path === pathname || pathname.startsWith(r.path + '/'))) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Visitor context                                                      */
/* ------------------------------------------------------------------ */

function requestIP(raw: IncomingMessage, isTunnel: boolean) {
  if (isTunnel) {
    const cf = raw.headers['cf-connecting-ip'];
    if (cf) return lib.normIP(cf);
    const xff = String(raw.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return lib.normIP(xff);
  }
  return lib.normIP(raw.socket && raw.socket.remoteAddress);
}

function requestCtx(raw: IncomingMessage): VisitorContext {
  const host = String(raw.headers.host || '').toLowerCase();
  const sock = raw.socket;
  // tunnel guests arrive through the local cloudflared process, so the
  // trycloudflare Host only counts from this computer; a LAN device faking
  // the header stays on its own address (and its own blocklist entry)
  const isTunnel = lib.TUNNEL_HOST_RE.test(host) && lib.isLocalSocket(sock);
  const local = !isTunnel && lib.isLocalSocket(sock);
  const ip = requestIP(raw, isTunnel);
  const kind = isTunnel ? 'tunnel' : local ? 'local' : 'lan';
  return { isTunnel, local, ip, kind };
}

/* ------------------------------------------------------------------ */
/* Forwarding to the internal services (files / api / web)              */
/* ------------------------------------------------------------------ */

let runtime: Runtime = {};   // watched copy of runtime.json: the ports services bound

function serviceUnavailable(res: ServerResponse, service: ServiceName) {
  return lib.sendRawHtml(res, 502, 'Service unavailable', `<h1>Service unavailable</h1>
<p>The ${lib.escapeHTML(service)} service is not answering. Restart Extranet (<code>npx extranet</code>) and try again.</p>`);
}

/*
 * Stream a request through to an internal service. Bodies are never
 * buffered — folder downloads, ZIPs and range requests all pass in one
 * uninterrupted pipe both ways. Only this proxy may tag the request with
 * the visitor context; anything a client sneaks in is dropped first.
 */
function forwardService(service: ServiceName, req: IncomingMessage, res: ServerResponse, ctx: VisitorContext) {
  const port = runtime[service];
  if (!port) return serviceUnavailable(res, service);

  const headers: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (HOP_SKIP_REQ.has(name)) continue;
    if (EDGE_HEADERS.has(name)) continue;
    headers[k] = v;
  }
  headers['x-client-ip'] = ctx.ip;
  headers['x-client-kind'] = ctx.kind;
  headers['x-extranet-edge'] = '1';

  let up;
  try {
    up = http.request({
      host: '127.0.0.1',
      port,
      path: req.url,          // exact bytes — services parse their own URLs
      method: req.method,
      headers,
    }, (uRes) => {
      if (res.writableEnded || res.destroyed) { try { uRes.destroy(); } catch { /* ignore */ } return; }
      try {
        res.writeHead(uRes.statusCode || 502, rawHeaderPairs(uRes.rawHeaders, HOP_SKIP_RES));
        res.on('error', () => { try { uRes.destroy(); } catch { /* ignore */ } });
        uRes.pipe(res);
      } catch {
        try { uRes.destroy(); } catch { /* ignore */ }
        try { res.destroy(); } catch { /* ignore */ }
      }
    });
  } catch {
    return serviceUnavailable(res, service);
  }
  up.on('error', () => {
    if (res.headersSent || res.destroyed) { try { res.destroy(); } catch { /* ignore */ } return; }
    serviceUnavailable(res, service);
  });
  req.on('error', () => { try { up.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { if (!res.writableEnded) { try { up.destroy(); } catch { /* ignore */ } } });
  req.pipe(up);
}

/* ------------------------------------------------------------------ */
/* App-port shares — expose a local port under the share's URL path     */
/* ------------------------------------------------------------------ */

/*
 * Root-absolute URLs in HTML and CSS are prefixed with the share path. Runtime
 * URLs must retain their prefix. Native apps configure their own base path;
 * the T3 adapter supplies router and runtime URL compatibility.
 */

const REWRITE_LIMIT = 4 * 1024 * 1024;
const PORT_SHARE_COOKIE = 'extranet-port-share';
const REWRITEABLE_TYPE = /(?:^|;)\s*(?:application\/(?:xhtml(?:\+xml)?|manifest\+json)|text\/(?:html|css))\s*(?:;|$)/i;

/* attributes that carry URLs the guest's browser will load */
const REF_ATTRS = new Set([
  'src', 'href', 'action', 'formaction', 'poster', 'manifest',
  'xlink:href', 'data-src', 'data-href', 'data-url',
]);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
const SCRIPT_OPEN_RE = /<script\b(?:[^>'"]|"[^"]*"|'[^']*')*>/gi;
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style[^>]*>)/gi;
const MARKUP_TAG_RE = /<([a-zA-Z][\w:.-]*)([^>]*)>/g;
const MARKUP_ATTR_RE = /\s([a-zA-Z][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g;

/*
 * Returns the ref repointed into the share, or null when it must stay as-is:
 * empty / fragmentish values, protocol-relative and backslash forms (//host,
 * /\host read as hosts in browsers), and refs the app already writes under
 * the share path.
 */
function shareRef(value: string, mountPath: string) {
  const v = String(value ?? '');
  if (!v) return null;
  if (v.charCodeAt(0) !== 0x2f) return null;                        // '/…' only
  if (v.length > 1) {
    const c = v.charCodeAt(1);
    if (c === 0x2f || c === 0x5c) return null;                      // '//' , '/\'
  }
  if (v === mountPath || v.startsWith(mountPath + '/')) return null; // already shared
  return mountPath + v;
}

function rewriteSrcsetValue(value: string, mountPath: string) {
  return String(value).split(',').map((part) => part.replace(
    /^(\s*)(\S*)/,
    (m, pad, url) => {
      const nv = shareRef(url, mountPath);
      return nv ? pad + nv : m;
    },
  )).join(',');
}

/* url(/a.png), @import url(/theme.css) and @import "/theme.css" */
function rewriteCssText(css: string, mountPath: string) {
  return String(css)
    .replace(/url\(\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^'"\s()]*))\s*\)/gi,
      (m, q, sq, dq, bare) => {
        const v = sq !== undefined ? sq : dq !== undefined ? dq : bare;
        const nv = shareRef(v, mountPath);
        if (!nv) return m;
        const close = q[0] === "'" || q[0] === '"' ? q[0] : '';
        return `url(${close}${nv}${close})`;
      })
    .replace(/@import\s+(?:'([^']*)'|"([^"]*)")(?=[\s;{,}]|$)/gi,
      (m, sq, dq) => {
        const v = sq !== undefined ? sq : dq;
        const nv = shareRef(v, mountPath);
        if (!nv) return m;
        return `@import ${sq !== undefined ? "'" : '"'}${nv}${sq !== undefined ? "'" : '"'}`;
      });
}

/* attribute pass within one tag — only URL-carrying values are repointed,
   while tag syntax outside the value (name, =, quotes, spacing) is kept
   intact so the document never shifts around a changed ref */
function rewriteTagAttrs(tagAttrs: string, mountPath: string) {
  return tagAttrs.replace(MARKUP_ATTR_RE, (m, name, value) => {
    const attr = name.toLowerCase();
    const quoted = value.charCodeAt(0) === 0x22 || value.charCodeAt(0) === 0x27;
    const head = quoted ? value[0] : '';
    const tail = quoted && value[value.length - 1] === value[0] ? value[0] : '';
    const inner = quoted ? value.slice(1, value.length - (tail ? 1 : 0)) : value;

    let nv = null;
    if (SRCSET_ATTRS.has(attr)) nv = rewriteSrcsetValue(inner, mountPath);
    else if (REF_ATTRS.has(attr)) nv = shareRef(inner, mountPath);
    else if (attr === 'style') nv = rewriteCssText(inner, mountPath);
    else if (attr === 'content') {
      // direct URL value, e.g. <meta property="og:image" content="/social-share.png">
      const direct = shareRef(inner, mountPath);
      if (direct) nv = direct;
      else {
        // <meta http-equiv="refresh" content="0; url=/next">
        nv = inner.replace(/^([0-9.]+\s*;[^;]*?url=)\/(?!\/)(.*)$/is, (n: string, pre: string, rest: string) => {
          const pr = shareRef('/' + rest, mountPath);
          return pr ? pre + pr : n;
        });
      }
    }
    if (nv == null || nv === inner) return m;
    return m.slice(0, m.length - value.length) + head + nv + tail;
  });
}

/* attributes inside real tags; text nodes, comments and doctypes stay untouched */
function rewriteTags(html: string, mountPath: string) {
  MARKUP_TAG_RE.lastIndex = 0;
  let out = '';
  let from = 0;
  let t;
  while ((t = MARKUP_TAG_RE.exec(html))) {
    out += html.slice(from, t.index)
      + t[0].slice(0, t[0].length - t[2].length - 1)  // '<'+name up to the attrs
      + rewriteTagAttrs(t[2], mountPath) + '>';
    from = t.index + t[0].length;
  }
  return out + html.slice(from);
}

/* markup without script elements: tag attributes plus inline <style> bodies.
   <style> content is CSS-shaped text, so it gets the same treatment as a
   .css response; an unterminated one simply stays raw. */
function rewriteMarkup(html: string, mountPath: string) {
  STYLE_BLOCK_RE.lastIndex = 0;
  let out = '';
  let from = 0;
  let s;
  while ((s = STYLE_BLOCK_RE.exec(html))) {
    out += rewriteTags(html.slice(from, s.index), mountPath)
      + s[1] + rewriteCssText(s[2], mountPath) + s[3];
    from = s.index + s[0].length;
  }
  out += rewriteTags(html.slice(from), mountPath);
  return out;
}

/*
 * script elements keep their exact bytes — a damaged page is worse than an
 * unrewritten one — but the <script src=…> open tag still gets its attributes
 * repointed, and so does everything between script elements. An element with
 * no closing tag, or no '>' ending the closing tag, leaves the whole document
 * untouched instead of guessing where the code ends.
 */
function rewriteHtmlDoc(text: string, mountPath: string) {
  SCRIPT_OPEN_RE.lastIndex = 0;
  const lower = text.toLowerCase();
  let out = '';
  let from = 0;
  let s;
  while ((s = SCRIPT_OPEN_RE.exec(text))) {
    const openEnd = s.index + s[0].length;
    const end = lower.indexOf('</script', openEnd);
    if (end < 0) return text; // unterminated script: leave instead of guessing
    const closeEnd = lower.indexOf('>', end);
    if (closeEnd < 0) return text;
    out += rewriteMarkup(text.slice(from, s.index), mountPath)
      + rewriteMarkup(s[0], mountPath)              // open tag, incl. src=
      + text.slice(openEnd, end)                    // body, byte-exact
      + text.slice(end, closeEnd + 1);              // </script … >
    from = closeEnd + 1;
  }
  out += rewriteMarkup(text.slice(from), mountPath);
  return out;
}

/* web app manifest: repoint root-absolute icon/start_url/scope values under the share */
function rewriteManifestJson(text: string, mountPath: string) {
  return String(text).replace(/"(\/[^"]*)"/g, (m, v) => {
    const nv = shareRef(v, mountPath);
    return nv ? `"${nv}"` : m;
  });
}

/* Preserve cookie names for browser readers and scope paths to their app. */
function namespaceAppCookie(cookie: string, mount: Share) {
  let value = cookie.replace(/;\s*domain\s*=\s*[^;]*/ig, '');
  if (/;\s*path\s*=/i.test(value)) {
    value = value.replace(/;\s*path\s*=\s*([^;]*)/i, (_m, path) =>
      '; Path=' + (shareRef(path.trim(), mount.path) || path.trim()));
  } else value += '; Path=' + mount.path + '/';
  return value;
}

function appCookiesForUpstream(header: string | string[] | undefined, _mount: Share) {
  return String(header || '').split(';').map(p => p.trim()).filter(p => {
    const name = p.slice(0, p.indexOf('='));
    return name !== PORT_SHARE_COOKIE && !name.startsWith('xpin-') && !name.startsWith('xproxy-');
  }).join('; ');
}

/*
 * Location header: prefix path-absolute targets; absolute URLs minted against
 * the upstream host (127.0.0.1:<port>) become share-relative.
 */
function proxyLocation(value: string, mountPath: string) {
  let v = String(value);
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?=[/?#]|$)/i.test(v)) {
    let u;
    try { u = new URL(v); } catch { return null; }
    v = (u.pathname + u.search + u.hash) || '/';
  }
  return shareRef(v, mountPath);
}

function proxyResponseHeaders(uRes: IncomingMessage, mount: ProxyMount) {
  const pairs = rawHeaderPairs(uRes.rawHeaders, HOP_SKIP_RES);
  for (let i = 0; i < pairs.length; i += 2) {
    const name = pairs[i];
    let value = pairs[i + 1];
    if (name === 'location') {
      const lv = proxyLocation(value, mount.path);
      if (lv != null) value = lv;
    } else if (name === 'set-cookie') {
      value = namespaceAppCookie(value, mount);
    }
    pairs[i + 1] = value;
  }
  return pairs;
}

function pipeUpstream(uRes: IncomingMessage, res: ServerResponse, mount: ProxyMount) {
  try {
    res.writeHead(uRes.statusCode || 502, proxyResponseHeaders(uRes, mount));
    res.on('error', () => { try { uRes.destroy(); } catch { /* ignore */ } });
    uRes.pipe(res);
  } catch {
    try { uRes.destroy(); } catch { /* ignore */ }
    try { res.destroy(); } catch { /* ignore */ }
  }
}

/* exact-size read; null when the stream ended short or overflowed */
function drainUpstream(uRes: IncomingMessage, size: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let got = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    uRes.on('data', (c) => {
      if (done) return;
      got += c.length;
      if (got > size) { finish(null); uRes.destroy(); return; }
      chunks.push(c);
      if (got >= size) { finish(Buffer.concat(chunks)); uRes.pause(); }
    });
    uRes.on('end', () => { if (!done) finish(got === size ? Buffer.concat(chunks) : null); });
    uRes.on('error', () => { if (!done) finish(null); });
  });
}

/*
 * Response body: rewrite complete, uncompressed, reasonably small HTML/CSS
 * pages; everything else (streams, compressed bodies, redirects to absolute
 * off-host URLs…) is forwarded byte for byte. Redirects always pass through —
 * their Location header is already fixed up by proxyResponseHeaders().
 * Responses to HEAD never get rewritten: no body arrives on the wire, so
 * their "content-length" is metadata, not bytes that will stream through.
 */
function sendUpstreamBody(uRes: IncomingMessage, res: ServerResponse, mount: ProxyMount, noResponseBody: boolean) {
  if (res.writableEnded || res.destroyed || res.socket == null) { uRes.destroy(); return; }
  const ctype = String(uRes.headers['content-type'] || '');
  const size = parseInt(uRes.headers['content-length'] || '', 10);
  const hasCL = Number.isInteger(size) && size >= 0;
  const isRedirect = (uRes.statusCode || 0) >= 300 && (uRes.statusCode || 0) < 400;
  const potentiallyRewriteable = !noResponseBody
    && !uRes.headers['content-encoding']
    && (REWRITEABLE_TYPE.test(ctype) || (mount.adapter === 't3' && /(?:javascript|ecmascript)/i.test(ctype)))
    && !isRedirect;

  if (potentiallyRewriteable && hasCL && size > REWRITE_LIMIT) return pipeUpstream(uRes, res, mount);
  if (!potentiallyRewriteable) return pipeUpstream(uRes, res, mount);

  (async () => {
    try {
      let body: Buffer | null = null;
      let overflow = false;
      const chunks: Buffer[] = [];
      if (hasCL) {
        body = await drainUpstream(uRes, size);
        if (body == null) { uRes.destroy(); try { res.destroy(); } catch { /* ignore */ } return; }
      } else {
        // no content-length (often chunked): buffer up to the limit so we can
        // still repair root-absolute refs in complete, reasonably small pages
        uRes.pause();
        let total = 0;
        try {
          for await (const chunk of uRes.iterator({ destroyOnReturn: false })) {
            if (total + chunk.length > REWRITE_LIMIT) {
              overflow = true;
              chunks.push(chunk);
              total += chunk.length;
              break;
            }
            chunks.push(chunk);
            total += chunk.length;
          }
        } catch {
          uRes.destroy();
          try { res.destroy(); } catch { /* ignore */ }
          return;
        }
        if (overflow) {
          // too big to rewrite: forward everything we have and stream the rest
          const pairs = proxyResponseHeaders(uRes, mount);
          res.writeHead(uRes.statusCode || 502, pairs);
          res.on('error', () => { try { uRes.destroy(); } catch { /* ignore */ } });
          for (const c of chunks) res.write(c);
          uRes.resume();
          uRes.pipe(res);
          return;
        }
        body = Buffer.concat(chunks);
      }

      const isCss = /^\s*text\/css\b/i.test(ctype);
      const isManifest = /manifest\+json/i.test(ctype);
      const isScript = /(?:javascript|ecmascript)/i.test(ctype);
      let text = isScript ? rewriteT3Script(body.toString('utf8'), mount.path) : isCss ? rewriteCssText(body.toString('utf8'), mount.path)
        : isManifest ? rewriteManifestJson(body.toString('utf8'), mount.path)
        : rewriteHtmlDoc(body.toString('utf8'), mount.path);
      if (mount.adapter === 't3' && /(?:text\/html|xhtml)/i.test(ctype)) {
        text = text.replace(/<head\b[^>]*>/i, tag => tag + `<script src="${mount.path}/__extranet_bootstrap.js"></script>`);
      }
      const out = Buffer.from(text, 'utf8');

      const pairs = proxyResponseHeaders(uRes, mount);
      const final: string[] = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const name = pairs[i];
        if (name === 'content-length' || name === 'etag' || name === 'last-modified' || name === 'content-md5' || name === 'accept-ranges') continue;
        final.push(name, pairs[i + 1]);
      }
      final.push('content-length', String(out.length));

      res.writeHead(uRes.statusCode || 502, final);
      res.on('error', () => { try { uRes.destroy(); } catch { /* ignore */ } });
      res.end(out);
    } catch {
      try { uRes.destroy(); } catch { /* ignore */ }
      try { res.destroy(); } catch { /* ignore */ }
    }
  })();
}

/* target path for an app-port upstream: the share prefix comes off, and the
 * PIN parameter (already consumed by the gate) doesn't travel downstream */
function proxyTargetPath(url: URL, upstreamBase: string) {
  let pathname;
  if (!upstreamBase) pathname = url.pathname;
  else if (url.pathname === upstreamBase) pathname = '/';
  else if (url.pathname.startsWith(upstreamBase + '/')) pathname = url.pathname.slice(upstreamBase.length);
  else pathname = '/';
  const search = new URLSearchParams(url.searchParams);
  search.delete('pin');
  const q = search.toString();
  return pathname + (q ? `?${q}` : '');
}

function servePortRoute(req: IncomingMessage, res: ServerResponse, route: DynamicRoute, url: URL, ctx: VisitorContext, upstreamBase: string) {
  const mount = route.mount;
  const proxyMount = mount;
  const method = (req.method || 'GET').toUpperCase();

  // 6-digit PIN check first (the gate page and the redirect that consumes an
  // entered PIN both answer here; the owner's own computer never needs it)
  if (!lib.enforceSharePinRaw(req, res, mount, url, ctx.ip, ctx.local)) return;
  if (mount.adapter === 't3' && url.pathname === mount.path + '/__extranet_bootstrap.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(t3Bootstrap(mount.path));
  }

  const parsed = lib.parseSegments(url.pathname);
  const urlPath = parsed ? '/' + parsed.segs.join('/') : url.pathname;
  const trailing = parsed ? parsed.trailing : false;

  const entryPath = mount.entryPath || (mount.adapter === 't3' ? '/pair' : '/');
  if ((method === 'GET' || method === 'HEAD') && entryPath !== '/' && urlPath === mount.path) {
    res.writeHead(302, {
      Location: mount.path + entryPath + (url.search || ''),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  // /webapp → /webapp/ : document-relative refs inside the app then resolve
  // under the share instead of the proxy root
  if ((method === 'GET' || method === 'HEAD') && urlPath === mount.path && !trailing) {
    res.writeHead(301, {
      Location: mount.path + '/' + (url.search || ''),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    return res.end();
  }

  const headers: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_SKIP_REQ.has(k.toLowerCase())) continue;
    headers[k] = k.toLowerCase() === 'cookie' ? appCookiesForUpstream(v, mount) : v;
  }
  // Ask app origins for identity responses when the browser requests markup
  // or CSS so root-absolute paths can be rewritten before they reach clients.
  const wantsRewriteable = /\btext\/html\b|\btext\/css\b|manifest\+json/i.test(String(req.headers.accept || ''))
    || /\.css(?:[?#]|$)/i.test(url.pathname);
  if (wantsRewriteable || mount.adapter === 't3') {
    headers['accept-encoding'] = 'identity';
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  headers.host = `127.0.0.1:${mount.port}`;
  headers['x-forwarded-host'] = String(req.headers.host || '');
  headers['x-forwarded-prefix'] = mount.path;   // public path the app lives under
  headers['x-forwarded-proto'] = externalProtocol(req, ctx);
  headers['x-forwarded-for'] = ctx.ip || '?';

  // request body streams straight through — no buffering, no size cap
  const noResponseBody = method === 'HEAD';
  let up;
  try {
    up = http.request({
      host: '127.0.0.1',
      port: mount.port,
      path: proxyTargetPath(url, mount.upstreamPath === 'preserve' ? '' : upstreamBase),
      method: req.method,
      headers,
      agent: false, // one fresh upstream connection per visitor request
    }, (uRes) => sendUpstreamBody(uRes, res, proxyMount, noResponseBody));
  } catch (caught) { const err = caught as NodeJS.ErrnoException;
    return appUnavailable(res, mount, err);
  }
  up.on('error', () => {
    if (res.headersSent || res.destroyed) { try { res.destroy(); } catch { /* ignore */ } return; }
    appUnavailable(res, mount);
  });
  req.on('error', () => { try { up.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { if (!res.writableEnded) { try { up.destroy(); } catch { /* ignore */ } } });
  req.pipe(up);
}

function appUnavailable(res: ServerResponse, mount: Share, err?: Error) {
  if (res.headersSent || res.destroyed) { try { res.destroy(); } catch { /* ignore */ } return; }
  lib.sendRawHtml(res, 502, 'App unavailable', `<h1>Can't reach the app</h1>
<p>The share <code>${lib.escapeHTML(mount.path)}</code> forwards to port ${mount.port} on this computer, but nothing is answering there right now.
The app may be stopped — ask the owner to start it, then refresh.</p>`);
}

/* ------------------------------------------------------------------ */
/* Internal control endpoint (localhost + admin token only)             */
/* ------------------------------------------------------------------ */

function handleCtl(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const denied = () => lib.notFoundRaw(res, 'Nothing is shared at this address.');
  if (!lib.isLocalSocket(req.socket)) return denied();
  if (!lib.timingSafeToken(String(req.headers['x-admin-token'] || ''), lib.config.adminToken)) return denied();
  if (req.method !== 'POST' || pathname !== '/__ctl/clear-logs') return denied();
  logStore.entries.length = 0;
  logStore.ips.clear();
  writeLogs();
  return lib.jsonRaw(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Request dispatch                                                     */
/* ------------------------------------------------------------------ */

function handle(req: IncomingMessage, res: ServerResponse) {
  const rawUrl = req.url || '/';

  let url;
  try { url = new URL(rawUrl, 'http://internal'); } catch { return lib.jsonRaw(res, 400, { error: 'bad url' }); }
  if (rawUrl.startsWith('//')) return lib.jsonRaw(res, 400, { error: 'bad url' });
  const pathname = url.pathname;

  const ctx = requestCtx(req);

  // access log entry — filled in when the response finishes
  tapResponse(res);
  const ev: AccessEvent = {
    t: Date.now(), ip: ctx.ip, method: req.method || 'GET', path: lib.obscurePinnedPath(rawUrl),
    status: 0, bytes: 0, ua: String(req.headers['user-agent'] || '').slice(0, 160),
    share: undefined, kind: ctx.kind, blocked: false,
  };
  res.on('finish', () => {
    ev.status = res.statusCode;
    ev.bytes = (res as TappedResponse).__bytes || 0;
    try { maybeRecord(ev); } catch { /* never break a response over logging */ }
  });

  // internal control endpoint (the api service clears the live log here)
  if (pathname === '/__ctl' || pathname.startsWith('/__ctl/')) {
    return handleCtl(req, res, pathname);
  }

  // blocked clients: guests get rejected before anything is served
  if (!ctx.local && isBlocked(ctx.ip)) {
    ev.blocked = true;
    return lib.blockedRaw(res, ctx.ip);
  }

  // 1) Explicit share routes (longest prefix wins) always own their paths.
  const route = resolveRoute(pathname, ctx.kind);
  if (route && route.kind !== 'service') {
    if (route.kind === 'folder') {
      ev.share = route.prefix;                 // e.g. /files/movies
      return forwardService('files', req, res, ctx);
    }
    ev.share = route.path;                     // e.g. /webapp
    return servePortRoute(req, res, route, url, ctx, route.path);
  }

  // Unprefixed URLs belong to Extranet. Never guess an app from a cookie or Referer.
  if (route) return forwardService(route.service, req, res, ctx);
  return forwardService('web', req, res, ctx);
}

function externalProtocol(req: IncomingMessage, ctx: VisitorContext) {
  // Only the local tunnel is trusted to supply forwarding metadata.
  return ctx.isTunnel && String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https' ? 'https' : 'http';
}

function handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  const deny = (code: number) => socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  let url: URL;
  try { url = new URL(req.url || '/', 'http://internal'); } catch { deny(400); return; }
  const ctx = requestCtx(req);
  if ((req.url || '').startsWith('//')) { deny(400); return; }
  if (!ctx.local && isBlocked(ctx.ip)) { deny(403); return; }
  const route = resolveRoute(url.pathname, ctx.kind);
  if (!route || route.kind !== 'port') { deny(404); return; }
  const mount = route.mount;
  // Upgrade handshakes cannot display a PIN form. Authenticate through the page first.
  if (mount.pin && !ctx.local && !lib.timingSafeToken(lib.pinCookieFromRequest(req, mount) || '', lib.pinCookieValue(mount))) {
    deny(401); return;
  }
  const headers: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_SKIP_REQ.has(k)) headers[k] = v;
  headers.host = `127.0.0.1:${mount.port}`;
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;
  headers.cookie = appCookiesForUpstream(req.headers.cookie, mount);
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-prefix'] = mount.path;
  headers['x-forwarded-proto'] = externalProtocol(req, ctx);
  headers['x-forwarded-for'] = ctx.ip;
  const up = http.request({ host: '127.0.0.1', port: mount.port,
    path: proxyTargetPath(url, mount.upstreamPath === 'preserve' ? '' : mount.path), headers });
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  up.on('error', () => { if (!socket.destroyed) deny(502); });
  up.on('response', res => { res.resume(); deny(res.statusCode || 502); });
  up.on('upgrade', (res, upstream, upstreamHead) => {
    if (socket.destroyed) { upstream.destroy(); return; }
    const pairs = proxyResponseHeaders(res, mount);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`);
    for (let i = 0; i < pairs.length; i += 2) socket.write(`${pairs[i]}: ${pairs[i + 1]}\r\n`);
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstream.write(head);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  up.end();
}

/* ------------------------------------------------------------------ */
/* Listener (rebinds itself when the saved proxy port changes)          */
/* ------------------------------------------------------------------ */

const server = http.createServer(handle);
server.on('upgrade', handleUpgrade);
server.on('error', (err) => console.error('proxy server error:', err.message));

/* an EXTRANET_PORT / --port flag wins for one run — never persisted */
const wantPortOverride = (() => {
  const legacy = Number.parseInt(process.env.EXTRANET_PORT || '', 10);
  if (Number.isInteger(legacy) && legacy >= 1024 && legacy <= 65535) return legacy;
  return lib.envPort('PROXY');
})();
const PORT_LOCKED = wantPortOverride != null;

function listenOn(port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: '0.0.0.0' });
  });
}

let boundPort: number = 0;
let rebinding = false;

async function bindProxy(preferred: number) {
  return lib.bindWithBump((p) => listenOn(p), preferred);
}

async function rebind(preferred: number) {
  const old = boundPort;
  await new Promise<void>((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
    setTimeout(() => { try { server.closeAllConnections(); } catch { /* ignore */ } resolve(); }, 1500);
  });
  try {
    boundPort = await bindProxy(preferred);
  } catch (caught) { const err = caught as NodeJS.ErrnoException;
    console.error(`proxy could not bind port ${preferred} (${err.message}) — back to ${old}`);
    boundPort = await bindProxy(old);
  }
  lib.publishService('proxy', boundPort);
  console.log(`proxy now on 0.0.0.0:${boundPort} (was ${old})`);
}

lib.watchRuntime((r) => { runtime = r; });

lib.startConfigWatch(() => {
  // routes, scopes, PINs and the blocklist are read live from lib.config;
  // only the proxy's own port needs a rebind
  if (PORT_LOCKED || rebinding) return;
  const want = lib.config.proxyPort;
  if (want === boundPort) return;
  rebinding = true;
  rebind(want).finally(() => { rebinding = false; });
});

(async () => {
  boundPort = await bindProxy(wantPortOverride ?? lib.config.proxyPort);
  lib.publishService('proxy', boundPort);
  console.log(`reverse proxy ready on 0.0.0.0:${boundPort} (the public edge — the tunnel dials this port)`);
})().catch((err) => {
  console.error('proxy failed to start:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { writeLogs(); process.exit(0); });
process.on('SIGTERM', () => { writeLogs(); process.exit(0); });
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled promise rejection:', err));
