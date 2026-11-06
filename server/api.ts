import type { Share, ServiceName, ClientKind, VisitorContext, Battery, Tunnel, AccessLog } from './types';
import type { FastifyRequest, FastifyReply, FastifyBodyParser } from 'fastify';
'use strict';
/*
 * Extranet API service — the JSON API on :5000.
 *
 *   GET  /api/directory      public: the guest start page's data (host facts +
 *                            the shares this visitor may see), no token
 *   GET  /api/state          admin: full console state
 *   POST /api/routes         admin: add a share to the route registry
 *   PATCH/DELETE /api/routes/:id
 *   GET  /api/analytics      admin: access log + clients (reads data/logs.json,
 *                            which the proxy owns and flushes)
 *   POST /api/block          admin: block/unblock an address
 *   POST /api/logs/clear     admin: clear the log (asks the proxy to drop its
 *                            in-memory copy, then empties the file)
 *   GET  /api/qr             admin: QR code for a link
 *   GET  /api/fs             admin: folder browser for the share picker
 *   PATCH /api/settings      admin: proxy port (the proxy rebinds itself)
 *   POST /api/tunnel/start|stop|install   admin: the Cloudflare quick tunnel,
 *                            which dials 127.0.0.1:<proxy port>
 *
 * Internal service: binds 127.0.0.1 only — the reverse proxy is the only way
 * in from the outside. The proxy tags each request with x-client-kind
 * (local | lan | tunnel); a missing tag means the owner hit this service
 * directly on this computer. Admin calls from other machines still need the
 * admin token.
 */

import * as http from 'http';
import * as https from 'https'; // used only for the cloudflared download
import * as fs from 'fs';
const fsp = fs.promises;
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as dns from 'dns';
import { spawn, spawnSync } from 'child_process';
import Fastify from 'fastify';
import * as lib from './lib';

const { IS_WIN, BIN_DIR } = lib;

let QRCode: typeof import('qrcode') | null = null;
try { QRCode = require('qrcode'); } catch { /* optional: served without QR */ }

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function json(reply: FastifyReply, status: number, obj: unknown) {
  return reply.code(status).header('Cache-Control', 'no-store').send(obj);
}

/* request bodies arrive as raw buffers (or '' when empty) — parse client JSON out */
function parseBody(req: FastifyRequest) {
  const b = req.body;
  if (b == null) return {};
  if (Buffer.isBuffer(b)) return b.length ? JSON.parse(b.toString('utf8')) : {};
  return JSON.parse(String(b));
}

function pushRecentDir(dir: string) {
  const d = String(dir || '').trim();
  if (!d) return;
  lib.config.recentDirs = [d, ...lib.config.recentDirs.filter((x) => String(x).toLowerCase() !== d.toLowerCase())].slice(0, 10);
}

function publicSharePath(m: Share) {
  return (m.kind === 'folder' ? '/files' : '') + m.path;
}

/* the port a service actually bound (runtime.json), else its preferred one */
function portsState() {
  const r = lib.readRuntime();
  const pick = (name: ServiceName, fallback: number) => (Number.isInteger(r[name]) ? r[name]! : fallback);
  return {
    proxy: pick('proxy', lib.config.proxyPort),
    web: pick('web', lib.DEFAULT_PORTS.web),
    api: pick('api', lib.DEFAULT_PORTS.api),
    files: pick('files', lib.DEFAULT_PORTS.files),
  };
}

/* ------------------------------------------------------------------ */
/* Machine facts for the start page (battery, host internet)            */
/* ------------------------------------------------------------------ */

const sys: { battery: Battery | null; internet: boolean | null; busy: boolean } = { battery: null, internet: null, busy: false };

function runTool(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => { if (out.length < 8192) out += c; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/* Windows: .NET's SystemInformation.PowerStatus in one PowerShell line.
 * Sent base64-UTF16LE ("EncodedCommand") so no shell quoting can bite. */
function batteryFromPowershell() {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$p = [System.Windows.Forms.SystemInformation]::PowerStatus;' +
    '@{ hasBattery = -not ($p.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery); ' +
    'level = [Math]::Round($p.BatteryLifePercent * 100); ' +
    'online = ($p.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online) } | ConvertTo-Json -Compress';
  return runTool('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 8000);
}

/* macOS: pmset prints e.g. "54%; discharging; ..." or "100%; charged;" */
async function batteryFromPmset() {
  const out = await runTool('pmset', ['-g', 'batt'], 6000);
  if (!out || /no batteries available/i.test(String(out))) return null;
  const m = /\b(\d+)%;\s*([a-z-]+);/.exec(String(out)) || /\b(\d+)%/.exec(String(out));
  if (!m) return null;
  const level = parseInt(m[1], 10);
  if (level === null || !(level >= 0 && level <= 100)) return null;
  const state = (m[2] || '').toLowerCase();
  const ac = /'AC Power'/.test(out);
  return { present: true, level, charging: state === 'charging', ac };
}

/* Linux: /sys/class/power_supply — a BAT* entry holds capacity + status, mains
 * adapters live in the sibling entries */
async function batteryFromSysfs() {
  let names: string[] = [];
  try { names = await fsp.readdir('/sys/class/power_supply'); } catch { return null; }
  const bat = names.find((n) => /^BAT/i.test(n));
  if (!bat) return null;
  let level: number | null = null, status = '';
  try { level = parseInt((await fsp.readFile(`/sys/class/power_supply/${bat}/capacity`, 'utf8')).trim(), 10); } catch { /* gone */ }
  try { status = (await fsp.readFile(`/sys/class/power_supply/${bat}/status`, 'utf8')).trim().toLowerCase(); } catch { /* gone */ }
  if (level === null || !(level >= 0 && level <= 100)) return null;
  let ac = false;
  for (const n of names) {
    if (/^BAT/i.test(n)) continue;
    try {
      const t = (await fsp.readFile(`/sys/class/power_supply/${n}/type`, 'utf8')).trim().toLowerCase();
      if (t === 'mains') { ac = true; break; }
    } catch { /* not a mains entry */ }
  }
  return { present: true, level, charging: status === 'charging', ac };
}

async function readBattery() {
  try {
    if (IS_WIN) {
      let d: { hasBattery?: boolean; level?: number; online?: boolean } | null = null;
      const out = await batteryFromPowershell();
      try { d = JSON.parse(String(out).trim()); } catch { /* unreadable */ }
      if (!d || d.hasBattery !== true) return null;
      const level = Math.round(Number(d.level));
      if (level === null || !(level >= 0 && level <= 100)) return null;
      return { present: true, level, charging: d.online === true && level < 100, ac: d.online === true };
    }
    if (process.platform === 'darwin') return await batteryFromPmset();
    return await batteryFromSysfs();
  } catch { return null; }
}

/* one cheap OS resolver hit — "does this machine itself reach the internet" */
function checkInternet(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      dns.lookup('one.one.one.one', (err, address) => resolve(!err && !!address));
    } catch { resolve(false); }
  });
}

async function refreshSys() {
  if (sys.busy) return;
  sys.busy = true;
  try {
    const [battery, internet] = await Promise.all([readBattery(), checkInternet()]);
    sys.battery = battery;
    sys.internet = internet;
  } catch { /* next tick */ } finally { sys.busy = false; }
}

function startSysTicker() {
  const tick = () => refreshSys();
  setTimeout(tick, 300);               // warm up just after boot
  const iv = setInterval(tick, 60 * 1000);
  if (iv.unref) iv.unref();
}

/* ------------------------------------------------------------------ */
/* Cloudflare quick tunnel (dials the reverse proxy)                    */
/* ------------------------------------------------------------------ */

const tunnel: Tunnel = {
  proc: null,
  status: 'stopped', // stopped | starting | running | stopping
  url: null,
  error: null,
  log: [],
  installing: false,
  installProgress: '',
  binPath: null,
};

function cfBinary() {
  if (tunnel.binPath) return tunnel.binPath;
  const exe = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(BIN_DIR, exe);
  if (fs.existsSync(local)) { tunnel.binPath = local; return local; }
  try {
    const r = spawnSync('cloudflared', ['--version'], { windowsHide: true, timeout: 5000 });
    if (!r.error && r.status === 0) { tunnel.binPath = 'cloudflared'; return 'cloudflared'; }
  } catch { /* not on PATH */ }
  return null;
}

async function installCloudflared() {
  if (tunnel.installing) return { ok: false, error: 'already installing' };
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  const url = IS_WIN
    ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`
    : null;
  if (!url) return { ok: false, error: `automatic install is Windows-only here; install cloudflared manually (brew install cloudflared / apt install cloudflared)` };
  tunnel.installing = true;
  tunnel.installProgress = 'downloading';
  tunnel.error = null;
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const dest = path.join(BIN_DIR, 'cloudflared.exe');
    await downloadToFile(url, dest, (p) => { tunnel.installProgress = p; });
    tunnel.binPath = dest;
    tunnel.installProgress = 'done';
    return { ok: true };
  } catch (caught) { const err = caught as NodeJS.ErrnoException;
    tunnel.error = 'download failed: ' + err.message;
    tunnel.installProgress = 'failed';
    return { ok: false, error: tunnel.error };
  } finally {
    tunnel.installing = false;
  }
}

function downloadToFile(url: string, dest: string, onProgress: (progress: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const get = (u: string, hops: number) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'extranet/1.0' } }, (res) => {
        if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).href, hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total) onProgress(`downloading ${Math.round((got / total) * 100)}%`);
          else onProgress(`downloading ${Math.round(got / 1024 / 1024)} MB`);
        });
        out.on('error', reject);
        res.pipe(out);
        out.on('finish', () => resolve());
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/* the public edge the tunnel dials (whatever port the proxy actually bound) */
function proxyPortForTunnel() {
  return portsState().proxy;
}

function startTunnel() {
  return new Promise((resolve) => {
    if (tunnel.proc) return resolve({ ok: false, error: 'tunnel is already running' });
    const bin = cfBinary();
    if (!bin) return resolve({ ok: false, error: 'cloudflared is not installed — use "Set up internet link"' });
    tunnel.status = 'starting';
    tunnel.error = null;
    tunnel.url = null;
    tunnel.log = [];
    const args = ['tunnel', '--url', `http://127.0.0.1:${proxyPortForTunnel()}`, '--no-autoupdate'];
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true });
    } catch (caught) { const err = caught as NodeJS.ErrnoException;
      tunnel.status = 'stopped';
      tunnel.error = err.message;
      return resolve({ ok: false, error: err.message });
    }
    tunnel.proc = proc;
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      tunnel.log.push(s);
      if (tunnel.log.length > 60) tunnel.log.splice(0, tunnel.log.length - 60);
      const m = TUNNEL_URL_RE.exec(s);
      if (m) { tunnel.url = m[0]; tunnel.status = 'running'; }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      tunnel.error = err.message;
      tunnel.status = 'stopped';
      tunnel.proc = null;
      resolve({ ok: false, error: err.message });
    });
    proc.on('exit', (code) => {
      tunnel.proc = null;
      tunnel.status = 'stopped';
      if (!tunnel.url) tunnel.error = `tunnel exited (code ${code})${tunnel.log.length ? ' — ' + tunnel.log[tunnel.log.length - 1].trim() : ''}`;
      else tunnel.error = null;
    });
    // quick tunnels usually announce their URL within ~3s
    let startedAt = Date.now();
    const check = setInterval(() => {
      if (tunnel.proc !== proc) { clearInterval(check); }
      if (tunnel.status === 'running' || tunnel.proc !== proc) {
        clearInterval(check);
        resolve({ ok: tunnel.status === 'running', url: tunnel.url, error: tunnel.error, status: tunnel.status });
      } else if (Date.now() - startedAt > 12000) {
        clearInterval(check);
        resolve({ ok: false, url: null, status: tunnel.status, error: tunnel.error || 'no URL yet — it may still come up, or the network may block it' });
      }
    }, 400);
  });
}

function stopTunnel() {
  if (!tunnel.proc) { tunnel.status = 'stopped'; return { ok: true }; }
  tunnel.status = 'stopping';
  try { tunnel.proc.kill(); } catch { /* already gone */ }
  return { ok: true };
}

function tunnelState() {
  return {
    installed: !!cfBinary(),
    status: tunnel.status,
    url: tunnel.url,
    error: tunnel.error,
    installing: tunnel.installing,
    installProgress: tunnel.installProgress,
  };
}

/* ------------------------------------------------------------------ */
/* Directory (guest start page payload) + console state                 */
/* ------------------------------------------------------------------ */

function directoryState(ctx: VisitorContext) {
  const shares = lib.config.routes
    .filter((m) => {
      if (ctx.isTunnel) return m.public === true;   // internet link guests: internet-marked shares only
      if (ctx.local) return true;                    // the owner sees every share
      return m.lan !== false;                        // Wi-Fi guests: Wi-Fi-marked shares only
    })
    .map((m) => {
      const out: { path: string; kind: string; pin: boolean; dir?: string | null; port?: number | null; scope?: string } = { path: publicSharePath(m), kind: m.kind === 'port' ? 'app' : 'folder', pin: !!m.pin };
      if (ctx.local) {
        out.dir = m.dir || null;
        out.port = m.port || null;
        out.scope = m.public ? (m.lan !== false ? 'both' : 'internet') : 'lan';
      }
      return out;
    });
  const ips = lib.lanIPs();
  return {
    name: os.hostname(),
    platform: IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
    battery: sys.battery,
    // an outbound-internet fact only makes sense for visitors close by — inter-
    // net-link guests got here over the internet already
    internet: ctx.isTunnel ? null : sys.internet,
    // primary network address belongs to the host's own network: withheld from
    // internet-link visitors
    connection: ctx.isTunnel ? null : (ips[0] || null),
    shares,
    local: ctx.local,
    ...(ctx.local ? { tunnelLive: !!(tunnel.proc && tunnel.url) } : {}),
  };
}

function publicRoute(m: Share) {
  return {
    id: m.id,
    kind: m.kind || 'folder',
    path: m.path,
    dir: m.dir,
    port: m.port,
    pin: m.pin,
    lan: m.lan !== false,
    public: m.public === true,
  };
}

function buildState(ctx: VisitorContext) {
  return {
    app: 'Extranet',
    hostname: os.hostname(),
    platform: process.platform,
    home: os.homedir(),
    ips: lib.lanIPs(),
    ports: portsState(),
    qrAvailable: !!QRCode,
    routes: lib.config.routes.map(publicRoute),
    tunnel: tunnelState(),
    recentDirs: lib.config.recentDirs,
    blockedCount: lib.config.blockedIPs.length,
    tokenRequired: !ctx.local,
    token: ctx.local ? lib.config.adminToken : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Analytics (reads the log file the proxy owns)                        */
/* ------------------------------------------------------------------ */

function isBlocked(ip: string) {
  return lib.config.blockedIPs.some((b) => b.ip === ip);
}

async function readAnalytics(limit: number) {
  let d: AccessLog = { entries: [], ips: {} };
  try { d = JSON.parse(fs.readFileSync(lib.LOG_FILE, 'utf8')); } catch { /* fresh */ }
  const all = Array.isArray(d.entries) ? d.entries : [];
  const entries = all.slice(-limit).reverse();
  const ips = Object.entries(d.ips || {})
    .filter(([, s]) => s && typeof s === 'object' && typeof s.count === 'number')
    .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
    .slice(0, 400)
    .map(([cip, s]) => ({ ip: cip, ...s, blocked: isBlocked(cip) }));
  return { entries, ips, blocked: lib.config.blockedIPs, kept: all.length };
}

/* ask the proxy to drop its in-memory log copy (it owns the live one) */
function clearProxyLogs() {
  return new Promise((resolve) => {
    try {
      const req = http.request({
        host: '127.0.0.1',
        port: portsState().proxy,
        path: '/__ctl/clear-logs',
        method: 'POST',
        headers: { 'x-admin-token': lib.config.adminToken },
        timeout: 3000,
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

function writeEmptyLogs() {
  try {
    fs.mkdirSync(lib.DATA_DIR, { recursive: true });
    const tmp = lib.LOG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ entries: [], ips: {} }));
    fs.renameSync(tmp, lib.LOG_FILE);
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* Auth (same model as before: local is trusted, LAN needs the token,   */
/* the public link is never allowed to manage anything)                 */
/* ------------------------------------------------------------------ */

function canManage(req: FastifyRequest, url: URL, ctx: VisitorContext) {
  if (ctx.isTunnel) return false;
  if (ctx.local) return true;
  const hdr = String(req.raw.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const q = url.searchParams.get('t') || '';
  return lib.timingSafeToken(hdr || q, lib.config.adminToken);
}

function adminDenied(reply: FastifyReply, ctx: VisitorContext) {
  if (ctx.isTunnel) {
    return lib.sendRawHtml(reply.raw, 403, 'Not available on the public link', `<h1>Not available on the public link</h1>
<p>This address is the public internet link — shares only. Open the link the app printed on your computer instead.</p>`);
  }
  return json(reply, 401, { error: '🔒 admin token required', tokenRequired: true });
}

/* ------------------------------------------------------------------ */
/* Route registry validation                                            */
/* ------------------------------------------------------------------ */

function normPortNumber(v: unknown, _label: string) {
  const n = Number(v);
  if (v === undefined || v === null || String(v).trim() === '' || !Number.isInteger(n) || n < 1024 || n > 65535) {
    return { error: 'the port number must be between 1024 and 65535' };
  }
  return null;
}

/* body.pin: 6 digits to set, "" to clear; returns an error string or null */
function applyPin(route: Share, value: unknown) {
  if (value === undefined) return null;
  const s = String(value ?? '').trim();
  if (!s) { route.pin = null; return null; }
  const digits = s.replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(digits)) return 'the PIN must be exactly 6 digits';
  route.pin = digits;
  return null;
}

/* ------------------------------------------------------------------ */
/* Folder browser (admin share picker)                                  */
/* ------------------------------------------------------------------ */

async function handleFsBrowse(reply: FastifyReply, input: string) {
  let p = String(input).trim().replace(/^["']|["']$/g, '');
  if (!p) {
    const drives: { path: string; name: string }[] = [];
    if (IS_WIN) {
      for (let i = 67; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try { fs.statSync(d); drives.push({ path: d, name: d.slice(0, 2) }); } catch { /* absent */ }
      }
      try { fs.statSync('C:\\'); } catch { /* C absent, rare */ }
    }
    return json(reply, 200, {
      path: '',
      parent: null,
      name: process.platform === 'win32' ? 'This PC' : '/',
      dirs: (IS_WIN ? drives : [{ path: '/', name: 'root' }]),
      drives: true,
    });
  }
  let abs = path.resolve(p);
  let st = await fsp.stat(abs).catch(() => null);
  if (!st) return json(reply, 400, { error: `no folder found at ${abs}` });
  if (!st.isDirectory()) return json(reply, 400, { error: `${abs} is a file, not a folder` });
  try { abs = await fsp.realpath(abs); } catch { /* keep resolved */ }
  let dirs: { path: string; name: string }[] = [];
  try {
    const items = await fsp.readdir(abs, { withFileTypes: true });
    dirs = items
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .filter((d) => !/^(system volume information|\$recycle\.bin|windows|program files(x)?|programdata|appdata)$/i.test(d.name))
      .slice(0, 500)
      .map((d) => ({ path: path.join(abs, d.name), name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch (caught) { const err = caught as NodeJS.ErrnoException;
    return json(reply, 400, { error: `can't read ${abs}: ${err.message}` });
  }
  const parent = path.dirname(abs);
  return json(reply, 200, {
    path: abs,
    parent: parent === abs ? null : parent,
    name: path.basename(abs) || abs,
    dirs,
  });
}

/* ------------------------------------------------------------------ */
/* The Fastify app                                                      */
/* ------------------------------------------------------------------ */

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
const rawBodyParser: FastifyBodyParser<Buffer> = (_req, body, done) => done(null, body == null ? '' : body);
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawBodyParser);
app.addContentTypeParser('*', { parseAs: 'buffer' }, rawBodyParser);

/* visitor context: the proxy tags every request; without a tag it's the
 * owner dialing this service directly on this computer */
app.addHook('onRequest', (req, _reply, done) => {
  const raw = req.raw;
  const k = String(raw.headers['x-client-kind'] || 'local');
  const kind: ClientKind = k === 'local' || k === 'tunnel' ? k : 'lan';
  req.ctx = {
    kind,
    isTunnel: kind === 'tunnel',
    local: kind === 'local',
    ip: lib.normIP(raw.headers['x-client-ip'] || raw.socket.remoteAddress),
  };
  const method = raw.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD' && !raw.headers['content-type'] && raw.headers['content-length']) {
    raw.headers['content-type'] = 'application/json';
  }
  done();
});

app.all('/api', apiRoute);
app.all('/api/*', apiRoute);
app.setNotFoundHandler((req, reply) => apiRoute(req, reply));

async function apiRoute(req: FastifyRequest, reply: FastifyReply) {
  const url = new URL(req.raw.url || '/api', 'http://internal');
  if (!url.pathname.startsWith('/api')) return json(reply, 404, { error: 'not found' });
  const ctx = req.ctx;
  const method = req.raw.method || 'GET';
  const api = url.pathname === '/api' || url.pathname === '/api/' ? null : url.pathname.slice('/api/'.length);

  /* the one public endpoint: the guest start page's data */
  if (method === 'GET' && api === 'directory') {
    return json(reply, 200, directoryState(ctx));
  }

  if (!canManage(req, url, ctx)) return adminDenied(reply, ctx);

  if (method === 'GET' && api === 'state') {
    return json(reply, 200, buildState(ctx));
  }

  if (method === 'GET' && api === 'analytics') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 1000);
    return json(reply, 200, await readAnalytics(limit));
  }

  if (method === 'POST' && api === 'block') {
    let body;
    try { body = parseBody(req); } catch { return json(reply, 400, { error: 'bad json' }); }
    const ip = lib.normIP(body.ip);
    if (!ip || ip === '?' || ip.length > 64) return json(reply, 400, { error: 'bad ip' });
    if (ip === '127.0.0.1' || ip === '::1') return json(reply, 400, { error: "won't block this computer itself" });
    if (body.block === false) {
      lib.config.blockedIPs = lib.config.blockedIPs.filter((b) => b.ip !== ip);
    } else if (!lib.config.blockedIPs.some((b) => b.ip === ip)) {
      const note = String(body.note || '').trim().slice(0, 120);
      lib.config.blockedIPs.push({ ip, ts: Date.now(), ...(note ? { note } : {}) });
    }
    lib.saveConfig();   // the proxy re-reads the file and enforces within ~0.5s
    return json(reply, 200, { ok: true, blocked: lib.config.blockedIPs });
  }

  if (method === 'POST' && api === 'logs/clear') {
    const cleared = await clearProxyLogs();
    if (!cleared) return json(reply, 502, { error: 'the proxy service is not answering — try again' });
    writeEmptyLogs();
    return json(reply, 200, { ok: true });
  }

  if (method === 'GET' && api === 'qr') {
    const link = url.searchParams.get('u') || '';
    if (!/^https?:\/\/[^\s"'<>]+$/.test(link)) return json(reply, 400, { error: 'bad url' });
    if (!QRCode) { reply.code(501).type('text/plain').send('QR unavailable: npm package "qrcode" missing'); return reply; }
    const svg = await QRCode.toString(link, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M' });
    return reply.code(200).type('image/svg+xml').header('Cache-Control', 'no-store').send(svg);
  }

  if (method === 'GET' && api === 'fs') {
    return handleFsBrowse(reply, url.searchParams.get('path') || '');
  }

  /* ---- the route registry ---- */

  if (method === 'POST' && api === 'routes') {
    let body;
    try { body = parseBody(req); } catch { return json(reply, 400, { error: 'bad json' }); }
    const p = lib.normUrlPath(body.path);
    if (!p) return json(reply, 400, { error: 'web address must look like /photos (lowercase letters, numbers, - . _)' });
    if (lib.isReserved(p)) return json(reply, 400, { error: `the address ${p} is reserved` });
    if (lib.config.routes.some((m) => m.path === p)) return json(reply, 400, { error: `the address ${p} is already used` });
    const kind = body.kind === 'port' ? 'port' : 'folder';
    const route: Share = {
      id: crypto.randomUUID(),
      kind,
      path: p,
      lan: body.lan !== false,
      public: body.public === true,
    };
    if (kind === 'port') {
      const err = normPortNumber(body.port, 'port');
      if (err) return json(reply, 400, { error: err.error });
      if (Number(body.port) === portsState().proxy) {
        return json(reply, 400, { error: "that's the port the reverse proxy runs on — it would loop forever" });
      }
      route.port = Number(body.port);
    } else {
      const dir = String(body.dir || '').trim();
      const st = await fsp.stat(path.resolve(dir)).catch(() => null);
      if (!st || !st.isDirectory()) return json(reply, 400, { error: `no folder found at ${dir}` });
      route.dir = path.resolve(dir);
    }
    const pinErr = applyPin(route, body.pin);
    if (pinErr) return json(reply, 400, { error: pinErr });
    lib.config.routes.push(route);
    if (route.dir) pushRecentDir(route.dir);
    lib.saveConfig();   // the proxy + files service pick the route up live
    return json(reply, 200, { ok: true, route: publicRoute(route) });
  }

  const rMatch = /^routes\/([A-Za-z0-9-]+)$/.exec(api || '');
  const route = rMatch ? lib.config.routes.find((m) => m.id === rMatch[1]) : null;
  if (rMatch && !route) return json(reply, 404, { error: 'share not found' });

  if (method === 'PATCH' && route) {
    let body;
    try { body = parseBody(req); } catch { return json(reply, 400, { error: 'bad json' }); }
    if (body.path !== undefined) {
      const p = lib.normUrlPath(body.path);
      if (!p) return json(reply, 400, { error: 'bad address' });
      if (lib.isReserved(p)) return json(reply, 400, { error: 'reserved address' });
      if (lib.config.routes.some((m) => m.path === p && m.id !== route.id)) return json(reply, 400, { error: 'address already used' });
      route.path = p;
    }
    if (body.dir !== undefined) {
      const st = await fsp.stat(path.resolve(body.dir)).catch(() => null);
      if (!st || !st.isDirectory()) return json(reply, 400, { error: 'no such folder' });
      route.dir = path.resolve(body.dir);
      pushRecentDir(route.dir);
    }
    if (body.kind !== undefined && ['port', 'folder'].includes(body.kind) && body.kind !== route.kind) {
      if (body.kind === 'port') {
        const err = normPortNumber(body.port !== undefined ? body.port : route.port, 'port');
        if (err) return json(reply, 400, { error: err.error });
        route.port = Number(body.port !== undefined ? body.port : route.port);
        delete route.dir;
      } else {
        const st = await fsp.stat(path.resolve(body.dir || '')).catch(() => null);
        if (!st || !st.isDirectory()) return json(reply, 400, { error: 'to switch to a folder share, pick the folder too' });
        route.dir = path.resolve(body.dir);
        delete route.port;
      }
      route.kind = body.kind;
    }
    if (body.port !== undefined && route.kind === 'port') {
      const err = normPortNumber(body.port, 'port');
      if (err) return json(reply, 400, { error: err.error });
      if (Number(body.port) === portsState().proxy) {
        return json(reply, 400, { error: "that's the port the reverse proxy runs on — it would loop forever" });
      }
      route.port = Number(body.port);
    }
    if (body.pin !== undefined) {
      const pinErr = applyPin(route, body.pin);
      if (pinErr) return json(reply, 400, { error: pinErr });
    }
    if (body.lan !== undefined) route.lan = body.lan === true;
    if (body.public !== undefined) route.public = body.public === true;
    lib.saveConfig();
    return json(reply, 200, { ok: true, route: publicRoute(route) });
  }

  if (method === 'DELETE' && route) {
    lib.config.routes = lib.config.routes.filter((m) => m.id !== route.id);
    lib.saveConfig();
    return json(reply, 200, { ok: true });
  }

  if (method === 'PATCH' && api === 'settings') {
    let body;
    try { body = parseBody(req); } catch { return json(reply, 200, { ok: false, error: 'bad json' }); }
    try {
      // validate + persist, answer, then let the proxy rebind itself (it
      // watches this file); restart the tunnel afterwards if it was live
      if (body.proxyPort !== undefined) {
        const n = Number(body.proxyPort);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('proxy port must be 1024–65535');
        lib.config.proxyPort = n;
      }
      lib.saveConfig();
      const tunnelWasRunning = !!tunnel.proc;
      if (tunnelWasRunning) stopTunnel();
      json(reply, 200, { ok: true, messages: ['settings applied'], tunnelRestarted: tunnelWasRunning });
      if (tunnelWasRunning) {
        // give the proxy time to notice the file and rebind before dialing it
        setTimeout(() => startTunnel(), 2500);
      }
      return;
    } catch (caught) { const err = caught as NodeJS.ErrnoException;
      return json(reply, 400, { error: err.message });
    }
  }

  if (method === 'POST' && api === 'tunnel/start') return json(reply, 200, await startTunnel());
  if (method === 'POST' && api === 'tunnel/stop') return json(reply, 200, stopTunnel());
  if (method === 'POST' && api === 'tunnel/install') {
    const r = await installCloudflared();
    return json(reply, 200, { ...r, installState: tunnelState() });
  }

  return json(reply, 404, { error: 'unknown admin api' });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

startSysTicker();

const wantPort = lib.envPort('API') || lib.DEFAULT_PORTS.api;

(async () => {
  const port = await lib.bindWithBump(
    (p) => app.listen({ port: p, host: '127.0.0.1' }),
    wantPort,
  );
  lib.publishService('api', port);
  console.log(`api service ready on 127.0.0.1:${port} (registry + admin + tunnel)`);
})().catch((err) => {
  console.error('api service failed to start:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { stopTunnel(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled promise rejection:', err));
