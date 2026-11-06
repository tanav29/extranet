import type { Config, Share, Runtime, ServiceName } from './types';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
'use strict';
/*
 * Shared bits for the four Extranet services (proxy, files, web, api).
 *
 * The services run as four separate processes, so the only state they share
 * lives on disk:
 *
 *   data/config.json   — the route registry + settings (every process watches
 *                        the file and re-reads it within ~0.5s of a change)
 *   data/runtime.json  — the ports each service actually bound to (written by
 *                        whoever binds, watched by whoever needs to dial)
 *   data/logs.json     — the access log (written by the proxy, read by the api)
 *
 * Nothing here talks HTTP; each service owns its own listener.
 */

import * as fs from 'fs';
const fsp = fs.promises;
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/* ------------------------------------------------------------------ */
/* Paths                                                                */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = process.env.EXTRANET_PUBLIC_DIR
  ? path.resolve(process.env.EXTRANET_PUBLIC_DIR)
  : path.join(ROOT, 'app', 'dist');
const DATA_DIR = process.env.EXTRANET_DATA_DIR
  ? path.resolve(process.env.EXTRANET_DATA_DIR)
  : (fs.existsSync(path.join(ROOT, 'data')) ? path.join(ROOT, 'data')
    : path.join(os.homedir(), '.extranet', 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const LOG_FILE = path.join(DATA_DIR, 'logs.json');
const BIN_DIR = path.join(DATA_DIR, 'bin');

const IS_WIN = process.platform === 'win32';
const TUNNEL_HOST_RE = /\.trycloudflare\.com$/i;

/* the ports the services prefer (bumped to the next free one when taken) */
const DEFAULT_PORTS = {
  proxy: 8787,
  web: 3000,
  api: 5000,
  files: 8080,
};

function envPort(name: string) {
  const n = Number.parseInt(process.env[`EXTRANET_${name}_PORT`] || '', 10);
  return (Number.isInteger(n) && n >= 1024 && n <= 65535) ? n : null;
}

/* addresses dynamic routes may never claim (service routes live here) */
const RESERVED_PREFIXES = [
  '/admin', '/api', '/files', '/analytics', '/app',
  '/favicon.ico', '/robots.txt', '/__ctl',
];

/* ------------------------------------------------------------------ */
/* Config — the route registry                                          */
/* ------------------------------------------------------------------ */

function defaultConfig(): Config {
  return {
    proxyPort: DEFAULT_PORTS.proxy,
    adminToken: crypto.randomBytes(6).toString('hex'),
    routes: [], // { id, kind: "folder"|"port", path: "/name", dir?, port?, pin?, lan: bool, public: bool }
    recentDirs: [], // folders ever shared, so re-adding is one click
    blockedIPs: [], // { ip, ts, note? } — rejected for guest traffic at the proxy
  };
}

function normalizeRoute(m: Share) {
  m.kind = m.kind === 'port' ? 'port' : 'folder';
  m.lan = m.lan !== false;
  m.public = m.public === true;
  delete (m as Share & { url?: string }).url;                     // link routes are retired
  if (m.kind === 'port') {
    const p = Number(m.port);
    m.port = (Number.isInteger(p) && p >= 1 && p <= 65535) ? p : null;
  } else {
    delete m.port;
  }
  m.pin = /^\d{6}$/.test(String(m.pin || '')) ? String(m.pin) : null;
  return m;
}

/* load + migrate. Old single-server configs (httpPort + mounts) roll over:
 * mounts become routes, httpPort becomes proxyPort. */
function readConfigFile(allowMissing = true) {
  const cfg = defaultConfig();
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('expected a config object');
    if (!Array.isArray(loaded.routes) && Array.isArray(loaded.mounts)) loaded.routes = loaded.mounts;
    if (!Number.isInteger(loaded.proxyPort) && Number.isInteger(loaded.httpPort)) loaded.proxyPort = loaded.httpPort;
    Object.assign(cfg, loaded);
    for (const key of ['httpPort', 'mounts', 'httpsPort', 'httpsEnabled']) delete (cfg as unknown as Record<string, unknown>)[key];
  } catch (caught) { const err = caught as NodeJS.ErrnoException;
    if (!allowMissing || err.code !== 'ENOENT') {
      throw new Error(`Cannot read ${CONFIG_FILE}: ${err.message}`);
    }
  }
  if (!Number.isInteger(cfg.proxyPort) || cfg.proxyPort < 1024 || cfg.proxyPort > 65535) {
    cfg.proxyPort = DEFAULT_PORTS.proxy;
  }
  if (typeof cfg.adminToken !== 'string' || !cfg.adminToken) cfg.adminToken = defaultConfig().adminToken;
  if (!Array.isArray(cfg.routes)) cfg.routes = [];
  cfg.routes = cfg.routes.filter((m) => m && typeof m === 'object').map(normalizeRoute);
  if (!Array.isArray(cfg.recentDirs)) cfg.recentDirs = [];
  if (!Array.isArray(cfg.blockedIPs)) cfg.blockedIPs = [];
  cfg.blockedIPs = cfg.blockedIPs
    .filter((b) => b && typeof b.ip === 'string' && b.ip.length <= 64)
    .map((b) => ({ ip: b.ip, ts: Number(b.ts) || 0, note: b.note ? String(b.note).slice(0, 120) : undefined }));
  return cfg;
}

/* the live registry — every process holds its own copy, refreshed by the watcher */
const config = readConfigFile();

function refreshConfig() {
  const next = readConfigFile(false);
  for (const k of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[k];
  Object.assign(config, next);
}

function saveConfig() {
  writeJsonAtomic(CONFIG_FILE, config);
}

/* watch a data file (config.json / runtime.json): mtime+size poll, re-read
 * on change. Cheap and reliable across processes on all platforms. */
function watchFile(file: string, onChange: () => void) {
  let last: fs.Stats | null = null;
  try { last = fs.statSync(file); } catch { /* appears later */ }
  const iv = setInterval(() => {
    let st: fs.Stats | null = null;
    try { st = fs.statSync(file); } catch { return; }   // gone: keep the last good copy
    if (last && st.mtimeMs === last.mtimeMs && st.size === last.size) return;
    last = st;
    onChange();
  }, 500);
  if (iv.unref) iv.unref();
  return iv;
}

function startConfigWatch(onChange?: () => void) {
  watchFile(CONFIG_FILE, () => {
    try { refreshConfig(); onChange && onChange(); } catch { /* keep the last good copy */ }
  });
}

/* ------------------------------------------------------------------ */
/* Runtime ports — who bound where                                      */
/* ------------------------------------------------------------------ */

function readRuntime(): Runtime {
  try {
    const d = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}

// Unique staging files prevent collisions; rename exposes only complete JSON.
function writeJsonAtomic(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (caught) { const err = caught as NodeJS.ErrnoException; if (err.code !== 'ENOENT') throw err; }
  }
}

function writeRuntime(obj: Runtime) {
  writeJsonAtomic(RUNTIME_FILE, obj);
}

// Supervised children report readiness over IPC. Only the supervisor writes
// runtime.json, so simultaneous binds cannot overwrite another service's port.
function publishService(name: ServiceName, port: number) {
  if (typeof process.send === 'function') {
    process.send({ type: 'service-ready', name, port });
    return;
  }
  const cur = readRuntime();
  cur[name] = port;
  cur.ts = Date.now();
  writeRuntime(cur);
}

function watchRuntime(onChange: (runtime: Runtime) => void) {
  watchFile(RUNTIME_FILE, () => { try { onChange(readRuntime()); } catch { /* ignore */ } });
  onChange(readRuntime());
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function escapeHTML(s: unknown) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function pageHTML(title: string, bodyHtml: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#1c1e21;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34em;padding:2rem;text-align:center}h1{font-size:1.3rem;font-weight:600}p{color:#6b7280}</style><main>${bodyHtml}`;
}

/* raw-server response helpers (the proxy + hijacked replies all use these) */
function sendRawHtml(res: ServerResponse, status: number, title: string, bodyHtml: string) {
  try {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    res.end(pageHTML(title, bodyHtml));
  } catch { /* client gone */ }
}

function notFoundRaw(res: ServerResponse, message: string) {
  return sendRawHtml(res, 404, 'Nothing here', `<h1>Nothing here</h1><p>${escapeHTML(message)}</p>`);
}

function blockedRaw(res: ServerResponse, ip: string) {
  return sendRawHtml(res, 403, 'Blocked', `<h1>Blocked</h1>
<p>The owner of this server has blocked this address.</p>
<p style="font:12px monospace">${escapeHTML(ip || '')}</p>`);
}

function jsonRaw(res: ServerResponse, status: number, obj: unknown) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  } catch { /* client gone */ }
}

function timingSafeToken(got: unknown, want: unknown) {
  if (!got || !want) return false;
  const a = crypto.createHash('sha256').update(String(got)).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}

/* keep PIN entries out of the access log & analytics */
function obscurePinnedPath(u: string) {
  return String(u).replace(/(pin=)\d{6}/g, '$1\u2022\u2022\u2022\u2022\u2022\u2022');
}

function normIP(raw: unknown) {
  let s = String(raw || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s || '?';
}

function isLocalSocket(sock: Socket | null | undefined) {
  const a = sock && sock.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function lanIPs() {
  const virtualHint = /wsl|hyper-|vethernet|vmware|virtualbox|loopback|docker|vpn/i;
  const out: { name: string; address: string; score: number }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const [a, b, c] = ni.address.split('.').map(Number);
      let score = 0;
      if (a === 192 && b === 168) score = 0;        // typical home/small-office Wi-Fi
      else if (a === 10) score = 1;                  // other private
      else if (a === 172 && b >= 16 && b <= 31) score = 2;
      else score = 3;
      if (virtualHint.test(name)) score += 3;        // vEthernet/WSL/etc — likely not the real LAN
      out.push({ name, address: ni.address, score });
    }
  }
  out.sort((x, y) => x.score - y.score);
  return out.map(({ name, address }) => ({ name, address }));
}

/* hop-by-hop headers never cross a proxy hop */
const HOP_SKIP_REQ = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'expect', 'host',
]);
const HOP_SKIP_RES = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer',
]);

/* headers only this reverse proxy may set — never trusted from a client */
const EDGE_HEADERS = new Set(['x-client-ip', 'x-client-kind', 'x-extranet-edge']);

/* rawHeaders → flat [name, value, …] pairs with hop-by-hop entries dropped */
function rawHeaderPairs(rawHeaders: string[], skip: Set<string>) {
  const pairs: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (skip.has(name)) continue;
    pairs.push(name, rawHeaders[i + 1]);
  }
  return pairs;
}

/* ------------------------------------------------------------------ */
/* URL parsing helpers                                                  */
/* ------------------------------------------------------------------ */

/* returns { segs: [...], trailing } or null for invalid ("..") */
function parseSegments(rawPathname: string) {
  const segs: string[] = [];
  let trailing = false;
  for (const part of rawPathname.split('/')) {
    if (part === '') { if (rawPathname.endsWith('/') && segs.length) trailing = true; continue; }
    let d;
    try { d = decodeURIComponent(part); } catch { return null; }
    if (d === '.' || d === '..' || /[\x00-\x1f]/.test(d)) return null;
    segs.push(d);
  }
  return { segs, trailing };
}

/* share address validation for the registry (admin API) */
function normUrlPath(input: unknown) {
  let p = String(input || '').trim().replace(/^\/+/, '');
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!p) return null;
  const segs = p.split('/');
  if (segs.some((s) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s))) return null;
  return '/' + segs.join('/');
}

function isReserved(p: string) {
  return RESERVED_PREFIXES.some((r) => p === r || p.startsWith(r + '/'));
}

/* ------------------------------------------------------------------ */
/* MIME + disposition (folder/file serving)                             */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.apk': 'application/vnd.android.package-archive',
};

function mimeFor(name: string) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function contentDisposition(kind: string, name: string) {
  const fallback = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ------------------------------------------------------------------ */
/* Share PIN gate (6 digits, remembered once per device via cookie)     */
/* Shared by the proxy (app-port routes) and the files service (folders).*/
/* ------------------------------------------------------------------ */

const PIN_COOKIE_PREFIX = 'xpin-';
const PIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days — enter the PIN once per device

function pinCookieKey(id: string) {
  return PIN_COOKIE_PREFIX + String(id).replace(/[^a-zA-Z0-9-]/g, '');
}

function pinCookieValue(mount: Share) {
  return crypto.createHash('sha256').update(`${mount.id}|${mount.pin}|${config.adminToken}`).digest('hex');
}

function pinCookieFromRequest(rawReq: IncomingMessage, mount: Share) {
  const raw = String((rawReq.headers && rawReq.headers.cookie) || '');
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === pinCookieKey(mount.id)) return pair.slice(i + 1).trim();
  }
  return null;
}

function setPinCookie(res: ServerResponse, mount: Share) {
  res.setHeader('Set-Cookie', `${pinCookieKey(mount.id)}=${pinCookieValue(mount)}; Path=/; Max-Age=${PIN_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`);
}

/*
 * Brute-force throttle, per IP + share: 30 wrong entries inside 10 minutes
 * cools down that IP for 15 minutes. In-memory only; localhost is never throttled.
 */
const PINS_WINDOW = 10 * 60 * 1000;
const PINS_LIMIT = 30;
const PINS_COOLDOWN = 15 * 60 * 1000;
const pinFailures = new Map(); // key "ip|mountId" -> { n, first, until }

function pinThrottled(ip: string, mountId: string) {
  const e = pinFailures.get(`${ip}|${mountId}`);
  return !!(e && e.until > Date.now());
}

function pinNoteFailure(ip: string, mountId: string) {
  const key = `${ip}|${mountId}`;
  const now = Date.now();
  let e = pinFailures.get(key);
  if (!e || now - e.first > PINS_WINDOW) e = { n: 0, first: now, until: 0 };
  e.n += 1;
  e.first = now;
  if (e.n >= PINS_LIMIT) { e.until = now + PINS_COOLDOWN; e.n = 0; }
  pinFailures.set(key, e);
  if (pinFailures.size > 2000) {
    for (const [k, v] of pinFailures) {
      if (!(v.until > now) && now - v.first > PINS_WINDOW) pinFailures.delete(k);
    }
  }
}

function pinClearFailure(ip: string, mountId: string) {
  pinFailures.delete(`${ip}|${mountId}`);
}

function pinGateHtml(mountPath: string, opts?: { wrong?: boolean; cooldown?: boolean }) {
  const { wrong = false, cooldown = false } = opts || {};
  const msg = cooldown
    ? 'Too many wrong attempts. Wait a bit and try again.'
    : wrong
      ? 'That PIN isn\u2019t right — try again.'
      : 'Enter the 6-digit PIN the owner gave you.';
  return `<h1>\u{1F512} This share is locked</h1>
<p>${escapeHTML(msg)}</p>
<form method="GET" action="${escapeHTML(mountPath)}" style="display:flex;gap:8px;justify-content:center;margin-top:10px">
  <input name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus
    placeholder="\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}" required
    style="font:18px/1.5 ui-monospace,SFMono-Regular,monospace;letter-spacing:6px;text-align:center;width:11em;padding:8px 10px;border:1px solid #d4d4d8;border-radius:8px">
  <button style="font:600 14px system-ui,sans-serif;padding:8px 16px;border:0;border-radius:8px;background:#1c1e21;color:#fff;cursor:pointer">Open</button>
</form>`;
}

/*
 * Enforce the PIN of a share on a raw request/response pair. Returns true
 * when access may continue; false when a gate page (or the redirect that
 * consumes the entered PIN) has already been sent.
 */
function enforceSharePinRaw(rawReq: IncomingMessage, res: ServerResponse, mount: Share, url: URL, ip: string, isLocal: boolean) {
  if (!mount.pin || isLocal) return true;

  if (pinCookieValue(mount) === pinCookieFromRequest(rawReq, mount)) return true;

  if (pinThrottled(ip, mount.id)) {
    sendRawHtml(res, 403, 'Locked', pinGateHtml(url.pathname, { cooldown: true }));
    return false;
  }

  const entered = (url.searchParams.get('pin') || '').trim();
  if (entered && timingSafeToken(entered, mount.pin)) {
    pinClearFailure(ip, mount.id);
    setPinCookie(res, mount);
    // drop the PIN from the visible URL (HTTP 303 forces a GET)
    const search = new URLSearchParams(url.searchParams);
    search.delete('pin');
    const q = search.toString();
    res.writeHead(303, { Location: url.pathname + (q ? `?${q}` : '') });
    res.end();
    return false;
  }

  if (entered) pinNoteFailure(ip, mount.id);
  sendRawHtml(res, entered ? 403 : 401, 'Locked', pinGateHtml(url.pathname, { wrong: !!entered }));
  return false;
}

/* ------------------------------------------------------------------ */
/* Listening with a port bump                                           */
/* ------------------------------------------------------------------ */

function isAddrInUse(err: NodeJS.ErrnoException) {
  return !!err && (err.code === 'EADDRINUSE' || /address (already )?in use/i.test(String((err && err.message) || '')));
}

/*
 * bind(port) → Promise must start listening or throw (EADDRINUSE moves to
 * the next port). Returns the port that worked.
 */
async function bindWithBump(bind: (port: number) => Promise<unknown>, basePort: number, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const port = basePort + i;
    try {
      await bind(port);
      return port;
    } catch (caught) { const err = caught as NodeJS.ErrnoException;
      if (!isAddrInUse(err as NodeJS.ErrnoException)) throw err;
    }
  }
  throw new Error(`no free port found from ${basePort}`);
}

export {
  ROOT, PUBLIC_DIR, DATA_DIR, CONFIG_FILE, RUNTIME_FILE, LOG_FILE, BIN_DIR,
  IS_WIN, TUNNEL_HOST_RE, DEFAULT_PORTS, envPort, RESERVED_PREFIXES,
  config, refreshConfig, saveConfig, startConfigWatch,
  readRuntime, writeRuntime, publishService, watchRuntime,
  escapeHTML, pageHTML, sendRawHtml, notFoundRaw, blockedRaw, jsonRaw,
  timingSafeToken, obscurePinnedPath, normIP, isLocalSocket, lanIPs,
  HOP_SKIP_REQ, HOP_SKIP_RES, EDGE_HEADERS, rawHeaderPairs,
  parseSegments, normUrlPath, isReserved,
  MIME, mimeFor, contentDisposition,
  pinCookieKey, pinCookieValue, pinCookieFromRequest, setPinCookie,
  pinThrottled, pinNoteFailure, pinClearFailure, pinGateHtml, enforceSharePinRaw,
  bindWithBump, isAddrInUse,
};
