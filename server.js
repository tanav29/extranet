#!/usr/bin/env node
/*
 * Extranet — share folders from this computer.
 *
 *  - Fastify Node.js server (two instances: HTTP + self-signed HTTPS)
 *  - Serves each configured folder ("share") under a URL path, e.g. /photos
 *  - The React app in web/ compiles into public/app and is served statically:
 *    admin console (/admin), guest browser (any share path), analytics (/analytics)
 *  - LAN over HTTPS (self-signed) and HTTP, plus a Cloudflare quick-tunnel for internet access
 *  - Admin console at /admin (this machine only, or with a token)
 *
 * Small dependencies: fastify, qrcode, selfsigned.
 */
'use strict';

const https = require('https'); // used only for the cloudflared download
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const Fastify = require('fastify');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CERT_FILE = path.join(DATA_DIR, 'certs', 'cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'certs', 'key.pem');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BIN_DIR = path.join(ROOT, 'bin');

const TUNNEL_HOST_RE = /\.trycloudflare\.com$/i;

let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* optional: served without QR */ }
let selfsigned = null;
try { selfsigned = require('selfsigned'); } catch { /* optional: http only */ }

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function defaultConfig() {
  return {
    httpPort: 5050,
    httpsPort: 5443,
    httpsEnabled: true,
    adminToken: crypto.randomBytes(6).toString('hex'),
    mounts: [], // { id, path: "/name", dir, lan: bool, public: bool }
    recentDirs: [], // folders ever shared, so re-adding is one click
    blockedIPs: [], // { ip, ts, note? } — rejected for guest traffic
  };
}

let config = defaultConfig();
try {
  const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  config = { ...defaultConfig(), ...loaded };
  if (!Array.isArray(config.mounts)) config.mounts = [];
  for (const m of config.mounts) {
    m.lan = m.lan !== false;
    m.public = m.public === true;
  }
  if (!Array.isArray(config.recentDirs)) config.recentDirs = [];
  if (!Array.isArray(config.blockedIPs)) config.blockedIPs = [];
  config.blockedIPs = config.blockedIPs
    .filter((b) => b && typeof b.ip === 'string' && b.ip.length <= 64)
    .map((b) => ({ ip: b.ip, ts: Number(b.ts) || 0, note: b.note ? String(b.note).slice(0, 120) : undefined }));
} catch { /* fresh config */ }

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
saveConfig();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const IS_WIN = process.platform === 'win32';

function lanIPs() {
  const virtualHint = /wsl|hyper-|vethernet|vmware|virtualbox|loopback|docker|vpn/i;
  const out = [];
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

function isLocalSocket(sock) {
  const a = sock && sock.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function json(reply, status, obj) {
  return reply.code(status).header('Cache-Control', 'no-store').send(obj);
}

function html(reply, status, title, bodyHtml) {
  return reply.code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔗</text></svg>">
<style>body{font:16px/1.6 system-ui,sans-serif;color:#1c1e21;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34em;padding:2rem;text-align:center}h1{font-size:1.3rem;font-weight:600}p{color:#6b7280}</style>
<main>${bodyHtml}</main>`);
}

function pageHTML(title, bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#1c1e21;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34em;padding:2rem;text-align:center}h1{font-size:1.3rem;font-weight:600}p{color:#6b7280}</style><main>${bodyHtml}</main>`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timingSafeToken(got, want) {
  if (!got || !want) return false;
  const a = crypto.createHash('sha256').update(String(got)).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}

function pushRecentDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return;
  config.recentDirs = [d, ...config.recentDirs.filter((x) => String(x).toLowerCase() !== d.toLowerCase())].slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Access log + blocklist (the /analytics page)                        */
/* ------------------------------------------------------------------ */

const LOG_FILE = path.join(DATA_DIR, 'logs.json');
const LOG_CAP = 3000;   // requests kept in memory & on disk
const IP_CAP = 600;     // client entries kept on disk

const logStore = { entries: [], ips: new Map(), t: 0 };

(function loadLogs() {
  try {
    const d = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (Array.isArray(d.entries)) logStore.entries = d.entries.slice(-LOG_CAP);
    for (const [ip, s] of Object.entries(d.ips || {})) {
      if (s && typeof s === 'object' && typeof s.count === 'number') logStore.ips.set(ip, s);
    }
  } catch { /* fresh */ }
})();

function writeLogs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const ips = [...logStore.ips.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, IP_CAP);
    fs.writeFileSync(LOG_FILE + '.tmp', JSON.stringify({ entries: logStore.entries.slice(-LOG_CAP), ips: Object.fromEntries(ips) }));
    fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
  } catch { /* best effort */ }
}

function scheduleFlush() {
  if (logStore.t) return;
  logStore.t = setTimeout(() => { logStore.t = 0; writeLogs(); }, 4000);
}

function normIP(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s || '?';
}

function requestIP(req, isTunnel) {
  if (isTunnel) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return normIP(cf);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return normIP(xff);
  }
  return normIP(req.socket && req.socket.remoteAddress);
}

function isBlocked(ip) {
  return config.blockedIPs.some((b) => b.ip === ip);
}

function recordEvent(ev) {
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

function isTrackablePath(p) {
  if (p.startsWith('/admin')) return false;
  if (p === '/app' || p.startsWith('/app/')) return false;
  if (p === '/analytics') return false;
  if (p === '/fonts.css' || p.startsWith('/fonts/')) return false;
  if (p === '/favicon.ico' || p === '/robots.txt') return false;
  return true;
}

function maybeRecord(ev, local) {
  if (ev.blocked) return recordEvent(ev);   // security events always get logged
  if (!isTrackablePath(ev.path)) return;    // admin pages & static assets stay out
  recordEvent(ev);                          // guests AND the owner checking their own share
}

/* count bytes written to a response (for the analytics "data served" stat) */
function tapResponse(res) {
  if (res.__tap) return;
  res.__tap = true;
  res.__bytes = 0;
  const size = (c) => {
    if (!c) return;
    try { res.__bytes += typeof c === 'string' ? Buffer.byteLength(c) : c.length; } catch { /* ignore */ }
  };
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = function (chunk, ...rest) { size(chunk); return origWrite(chunk, ...rest); };
  res.end = function (chunk, ...rest) { size(chunk); return origEnd(chunk, ...rest); };
}

/* ------------------------------------------------------------------ */
/* MIME + preview categories                                           */
/* ------------------------------------------------------------------ */

const MIME = {
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

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function contentDisposition(kind, name) {
  const fallback = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ------------------------------------------------------------------ */
/* Streaming ZIP writer (store/deflate, no dependencies)               */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

class CrcStream {
  constructor() { this.c = 0xFFFFFFFF; this.n = 0; }
  update(buf) {
    let c = this.c;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    this.c = c;
    this.n += buf.length;
  }
  get value() { return (this.c ^ 0xFFFFFFFF) >>> 0; }
}

function dosTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
  };
}

const ZIP_LIMITS = { entries: 8000, bytes: 3 * 1024 * 1024 * 1024 };

async function collectTree(rootDir) {
  const entries = [];
  let total = 0;
  async function walk(dir, rel) {
    if (entries.length > ZIP_LIMITS.entries) throw new Error('too many files to zip (limit 8000)');
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      const relp = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        entries.push({ abs, rel: relp, isDir: true });
        await walk(abs, relp);
      } else if (it.isFile()) {
        let st;
        try { st = await fsp.stat(abs); } catch { continue; }
        total += st.size;
        if (total > ZIP_LIMITS.bytes) throw new Error('folder is too large to zip in the browser (limit 3 GB per share)');
        entries.push({ abs, rel: relp, isDir: false, size: st.size });
      }
    }
  }
  await walk(rootDir, '');
  return entries;
}

async function sendZip(res, rootDir, zipName) {
  const entries = await collectTree(rootDir);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', zipName.endsWith('.zip') ? zipName : zipName + '.zip'),
    'Cache-Control': 'no-store',
  });
  const { time, date } = dosTime(new Date());
  const central = [];
  let offset = 0;

  const localHeader = (nameLen, flags, method, crc, csize, usize) => {
    const b = Buffer.alloc(30);
    b.writeUInt32LE(0x04034b50, 0);
    b.writeUInt16LE(20, 4);            // version needed
    b.writeUInt16LE(flags, 6);
    b.writeUInt16LE(method, 8);
    b.writeUInt16LE(time, 10);
    b.writeUInt16LE(date, 12);
    b.writeUInt32LE(crc, 14);
    b.writeUInt32LE(csize, 18);
    b.writeUInt32LE(usize, 22);
    b.writeUInt16LE(nameLen, 26);
    b.writeUInt16LE(0, 28);            // extra len
    return b;
  };

  const write = (buf) => {
    offset += buf.length;
    if (!res.write(buf)) {
      return new Promise((r) => res.once('drain', r));
    }
  };

  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel + (e.isDir ? '/' : ''), 'utf8');
    if (e.isDir) {
      const entryOffset = offset;
      await write(Buffer.concat([localHeader(nameBuf.length, 0x800, 0, 0, 0, 0), nameBuf]));
      central.push({ nameBuf, flags: 0x800, method: 0, crc: 0, csize: 0, usize: 0, offset: entryOffset, isDir: true });
    } else {
      const descOffset = offset;
      await write(Buffer.concat([localHeader(nameBuf.length, 0x800 | 0x08, 8, 0, 0, 0), nameBuf]));
      const crc = new CrcStream();
      let csize = 0;
      await new Promise((resolve) => {
        const rs = fs.createReadStream(e.abs);
        const def = zlib.createDeflateRaw({ level: 5 });
        rs.on('data', (c) => crc.update(c));
        def.on('data', (c) => {
          csize += c.length;
          offset += c.length;
          if (!res.write(c)) { rs.pause(); res.once('drain', () => rs.resume()); }
        });
        def.on('end', resolve);
        def.on('error', resolve);
        rs.on('error', () => { try { rs.destroy(); def.destroy(); } catch {} resolve(); });
        rs.pipe(def);
      });
      // data descriptor: signature + crc + compressed + uncompressed
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc.value, 4);
      d.writeUInt32LE(csize, 8);
      d.writeUInt32LE(crc.n, 12);
      await write(d);
      central.push({ nameBuf, flags: 0x800 | 0x08, method: 8, crc: crc.value, csize, usize: crc.n, offset: descOffset, isDir: false });
    }
  }

  // central directory
  const cdStart = offset;
  for (const c of central) {
    const b = Buffer.alloc(46);
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE(20, 4);            // version made by
    b.writeUInt16LE(20, 6);            // version needed
    b.writeUInt16LE(c.flags, 8);
    b.writeUInt16LE(c.method, 10);
    b.writeUInt16LE(time, 12);
    b.writeUInt16LE(date, 14);
    b.writeUInt32LE(c.crc, 16);
    b.writeUInt32LE(c.csize, 20);
    b.writeUInt32LE(c.usize, 24);
    b.writeUInt16LE(c.nameBuf.length, 28);
    b.writeUInt16LE(0, 30);            // extra
    b.writeUInt16LE(0, 32);            // comment
    b.writeUInt16LE(0, 34);            // disk start
    b.writeUInt16LE(0, 36);            // internal attrs
    b.writeUInt32LE((c.isDir ? 0x10 : 0) << 16, 38); // external attrs
    b.writeUInt32LE(c.offset, 42);
    await write(Buffer.concat([b, c.nameBuf]));
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  res.end(eocd);
}

/* ------------------------------------------------------------------ */
/* Certificate (self-signed HTTPS)                                     */
/* ------------------------------------------------------------------ */

function ensureCertificate() {
  if (!selfsigned) throw new Error('the "selfsigned" package is not installed (run: npm install)');
  fs.mkdirSync(path.dirname(CERT_FILE), { recursive: true });
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  const alt = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 2, value: os.hostname() }];
  for (const { address } of lanIPs()) alt.push({ type: 7, ip: address });
  const pems = selfsigned.generate([{ name: 'commonName', value: os.hostname() }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: alt }],
  });
  fs.writeFileSync(KEY_FILE, pems.private);
  fs.writeFileSync(CERT_FILE, pems.cert);
  return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
}

/* ------------------------------------------------------------------ */
/* Cloudflare quick tunnel                                             */
/* ------------------------------------------------------------------ */

const tunnel = {
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
  } catch (err) {
    tunnel.error = 'download failed: ' + err.message;
    tunnel.installProgress = 'failed';
    return { ok: false, error: tunnel.error };
  } finally {
    tunnel.installing = false;
  }
}

function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (u, hops) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'extranet/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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

function startTunnel() {
  return new Promise((resolve) => {
    if (tunnel.proc) return resolve({ ok: false, error: 'tunnel is already running' });
    const bin = cfBinary();
    if (!bin) return resolve({ ok: false, error: 'cloudflared is not installed — use "Set up internet link"' });
    tunnel.status = 'starting';
    tunnel.error = null;
    tunnel.url = null;
    tunnel.log = [];
    const args = ['tunnel', '--url', `http://127.0.0.1:${servers.httpPort}`, '--no-autoupdate'];
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      tunnel.status = 'stopped';
      tunnel.error = err.message;
      return resolve({ ok: false, error: err.message });
    }
    tunnel.proc = proc;
    const onData = (buf) => {
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

/* ------------------------------------------------------------------ */
/* The Fastify app                                                     */
/* ------------------------------------------------------------------ */

/* Built frontend (web/ → npm run build → public/app) */
const APP_TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function appPage(name) {
  try { return fs.readFileSync(path.join(PUBLIC_DIR, 'app', name)); }
  catch {
    return Buffer.from(pageHTML('UI not built', `<h1>UI not built</h1>
<p>The interface is missing. Run <code>npm run build</code> inside the <code>web/</code> folder once, then restart.</p>`));
  }
}

function sendPage(reply, name) {
  return reply.code(200)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex')
    .send(appPage(name));
}

function notFoundPage(reply, message) {
  return html(reply, 404, 'Nothing here', `<h1>Nothing here</h1><p>${escapeHTML(message)}</p>`);
}

function blockedPage(reply, ip) {
  return html(reply, 403, 'Blocked', `<h1>Blocked</h1>
<p>The owner of this server has blocked this address.</p>
<p class="mono" style="font:12px monospace">${escapeHTML(ip || '')}</p>`);
}

/*
 * Build one protocol's app. Called once for HTTP and (independently) for HTTPS,
 * so settings changes can close and rebuild instances.
 */
function buildApp(httpsCreds) {
  const app = Fastify({
    ...(httpsCreds ? { https: httpsCreds } : {}),
    logger: false,
    bodyLimit: 2 * 1024 * 1024, // same cap as the previous readBody()
  });

  /*
   * Parse every request body as plain text; the admin endpoints JSON.parse it
   * themselves (like the old readBody() did), so bad JSON keeps producing the
   * same friendly "bad json" errors instead of Fastify's stricter ones.
   */
  const rawBodyParser = (_req, body, done) => done(null, body == null ? '' : String(body));
  app.addContentTypeParser('application/json', { parseAs: 'string' }, rawBodyParser);
  app.addContentTypeParser('*', { parseAs: 'string' }, rawBodyParser);
  app.decorateRequest('ctx', null);
  app.decorateRequest('__ev', null);

  app.addHook('onRequest', onRequestSetup);

  app.get('/favicon.ico', faviconRoute);
  app.get('/robots.txt', robotsRoute);
  app.get('/fonts.css', fontsRoute);
  app.get('/fonts/*', fontsRoute);
  app.all('/app', appAssetRoute);   // non-GET methods must still 405, like before
  app.all('/app/*', appAssetRoute);
  app.all('/admin', adminRoute);
  app.all('/admin/*', adminRoute);
  app.all('/analytics', analyticsRoute);
  app.get('/', rootRoute);

  // Everything else is a share
  app.setNotFoundHandler((req, reply) => serveShare(req, reply));

  return app;
}

/* --- per-request setup: analytics event, byte tap, blocklist --- */

async function onRequestSetup(req, reply) {
  const raw = req.raw;
  const rawUrl = raw.url || '/';

  if (rawUrl.startsWith('//')) return json(reply, 400, { error: 'bad url' });

  const local = isLocalSocket(raw.socket);
  const isTunnel = TUNNEL_HOST_RE.test(String(raw.headers.host || '').toLowerCase());
  const ip = requestIP(raw, isTunnel);
  const kind = isTunnel ? 'tunnel' : local ? 'local' : 'lan';
  req.ctx = { isTunnel, local, ip, kind };

  // bodies without a content-type are interpreted as JSON (as before)
  const method = raw.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD' && !raw.headers['content-type'] && raw.headers['content-length']) {
    raw.headers['content-type'] = 'application/json';
  }

  // access log entry — filled in when the response finishes
  tapResponse(reply.raw);
  const ev = {
    t: Date.now(), ip, method, path: rawUrl,
    status: 0, bytes: 0, ua: String(raw.headers['user-agent'] || '').slice(0, 160),
    share: null, kind, blocked: false,
  };
  req.__ev = ev;
  reply.raw.on('finish', () => {
    ev.status = reply.raw.statusCode;
    ev.bytes = reply.raw.__bytes || 0;
    if (!ev.share) {
      let pathname = ev.path.split('?')[0];
      try { pathname = new URL(ev.path, 'http://internal').pathname; } catch { /* keep raw */ }
      const m = findMount(pathname, isTunnel);
      ev.share = m ? m.path : null;
    }
    try { maybeRecord(ev, local); } catch { /* never break a response over logging */ }
  });

  // blocked clients: guests get rejected before anything is served
  if (!local && isBlocked(ip)) {
    ev.blocked = true;
    return blockedPage(reply, ip);
  }
}

/* --- small global routes --- */

async function faviconRoute(_req, reply) {
  return reply.code(204).send();
}

async function robotsRoute(_req, reply) {
  return reply.code(200).type('text/plain').send('User-agent: *\nDisallow: /\n');
}

async function fontsRoute(req, reply) {
  const { pathname } = new URL(req.raw.url || '/fonts.css', 'http://internal');
  const rel = pathname.slice(1).replace(/\.\./g, '');
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR)) return reply.code(403).send();
  let data = null;
  try { data = fs.readFileSync(fp); } catch { /* fall through */ }
  if (!data) return reply.code(404).send();
  const type = fp.endsWith('.css') ? 'text/css; charset=utf-8' : fp.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
  return reply.code(200).type(type).header('Cache-Control', 'public, max-age=86400').send(data);
}

async function appAssetRoute(req, reply) {
  const { pathname } = new URL(req.raw.url || '/app', 'http://internal');
  if (req.raw.method !== 'GET' && req.raw.method !== 'HEAD') return reply.code(405).send();
  let rel;
  try { rel = decodeURIComponent(pathname.slice('/app/'.length)).replace(/\.\.+/g, ''); } catch { return reply.code(400).send(); }
  const base = path.join(PUBLIC_DIR, 'app');
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

async function analyticsRoute(req, reply) {
  const ctx = req.ctx;
  if (ctx.isTunnel) {
    return html(reply, 403, 'Not available on the public link', `<h1>Not available on the public link</h1><p>The analytics page lives on the admin console. Open the admin address printed on your computer.</p>`);
  }
  const method = req.raw.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') return json(reply, 405, { error: 'method not allowed' });
  return sendPage(reply, 'analytics.html');
}

async function rootRoute(req, reply) {
  const ctx = req.ctx;
  if (!ctx.isTunnel) return reply.code(302).header('Location', '/admin').send();
  return serveShare(req, reply); // the public link serves shares only
}

/* ------------------------------------------------------------------ */
/* Routing helpers for shares                                          */
/* ------------------------------------------------------------------ */

function parseSegments(rawPathname) {
  // returns { segs: [...], trailingSlash } or null for invalid ("..")
  const segs = [];
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

function findMount(urlPath, wantPublic) {
  let best = null;
  for (const m of config.mounts) {
    if (!m.path) continue;
    if (m.path !== urlPath && !urlPath.startsWith(m.path + '/')) continue;
    if (wantPublic && !m.public) continue;
    if (!best || m.path.length > best.path.length) best = m;
  }
  return best;
}

function normUrlPath(input) {
  let p = String(input || '').trim().replace(/^\/+/, '');
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!p) return null;
  const segs = p.split('/');
  if (segs.some((s) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s))) return null;
  return '/' + segs.join('/');
}

const RESERVED_PREFIXES = ['/admin', '/analytics', '/app', '/favicon.ico', '/robots.txt', '/fonts'];

function isReserved(p) {
  return RESERVED_PREFIXES.some((r) => p === r || p.startsWith(r + '/'));
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

function canManage(req, url, ctx) {
  if (ctx.isTunnel) return false;
  if (ctx.local) return true;
  const hdr = String(req.raw.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const q = url.searchParams.get('t') || '';
  return timingSafeToken(hdr || q, config.adminToken);
}

function adminDenied(reply, ctx) {
  if (ctx.isTunnel) {
    return html(reply, 403, 'Not available on the public link', `<h1>Not available on the public link</h1>
<p>This address is the public internet link — shares only. Open the link the app printed on your computer instead.</p>`);
  }
  return json(reply, 401, { error: '🔒 admin token required', tokenRequired: true });
}

async function adminRoute(req, reply) {
  const url = new URL(req.raw.url || '/admin', 'http://internal');
  const ctx = req.ctx;
  const method = req.raw.method || 'GET';

  // Static admin page
  if (url.pathname === '/admin' && (method === 'GET' || method === 'HEAD')) {
    if (ctx.isTunnel) {
      return html(reply, 403, 'Not available on the public link', `<h1>Not available on the public link</h1><p>The admin console is only reachable from this computer, or from the network with an admin token.</p>`);
    }
    return sendPage(reply, 'admin.html');
  }

  if (!canManage(req, url, ctx)) return adminDenied(reply, ctx);

  const api = url.pathname === '/admin/' ? null : url.pathname.slice('/admin/'.length);

  if (method === 'GET' && api === 'api/state') {
    return json(reply, 200, buildState(ctx));
  }

  /* ---- analytics: access log, clients, blocklist ---- */

  if (method === 'GET' && api === 'api/analytics') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 1000);
    const entries = logStore.entries.slice(-limit).reverse();
    const ips = [...logStore.ips.entries()]
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, 400)
      .map(([cip, s]) => ({ ip: cip, ...s, blocked: isBlocked(cip) }));
    return json(reply, 200, { entries, ips, blocked: config.blockedIPs, kept: logStore.entries.length });
  }

  if (method === 'POST' && api === 'api/block') {
    let body;
    try { body = JSON.parse(req.body || '{}'); } catch { return json(reply, 400, { error: 'bad json' }); }
    const ip = normIP(body.ip);
    if (!ip || ip === '?' || ip.length > 64) return json(reply, 400, { error: 'bad ip' });
    if (ip === '127.0.0.1' || ip === '::1') return json(reply, 400, { error: "won't block this computer itself" });
    if (body.block === false) {
      config.blockedIPs = config.blockedIPs.filter((b) => b.ip !== ip);
    } else if (!config.blockedIPs.some((b) => b.ip === ip)) {
      const note = String(body.note || '').trim().slice(0, 120);
      config.blockedIPs.push({ ip, ts: Date.now(), ...(note ? { note } : {}) });
    }
    saveConfig();
    return json(reply, 200, { ok: true, blocked: config.blockedIPs });
  }

  if (method === 'POST' && api === 'api/logs/clear') {
    logStore.entries.length = 0;
    logStore.ips.clear();
    writeLogs();
    return json(reply, 200, { ok: true });
  }

  if (method === 'GET' && api === 'qr') {
    const link = url.searchParams.get('u') || '';
    if (!/^https?:\/\/[^\s"'<>]+$/.test(link)) return json(reply, 400, { error: 'bad url' });
    if (!QRCode) { reply.code(501).type('text/plain').send('QR unavailable: npm package "qrcode" missing'); return reply; }
    const svg = await QRCode.toString(link, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M' });
    return reply.code(200).type('image/svg+xml').header('Cache-Control', 'no-store').send(svg);
  }

  if (method === 'GET' && api === 'api/fs') {
    return handleFsBrowse(reply, url.searchParams.get('path') || '');
  }

  if (method === 'POST' && api === 'api/mounts') {
    let body;
    try { body = JSON.parse(req.body || '{}'); } catch { return json(reply, 400, { error: 'bad json' }); }
    const p = normUrlPath(body.path);
    if (!p) return json(reply, 400, { error: 'web address must look like /photos (lowercase letters, numbers, - . _)' });
    if (isReserved(p)) return json(reply, 400, { error: `the address ${p} is reserved` });
    if (config.mounts.some((m) => m.path === p)) return json(reply, 400, { error: `the address ${p} is already used` });
    const dir = String(body.dir || '').trim();
    const st = await fsp.stat(path.resolve(dir)).catch(() => null);
    if (!st || !st.isDirectory()) return json(reply, 400, { error: `no folder found at ${dir}` });
    const mount = {
      id: crypto.randomUUID(),
      path: p,
      dir: path.resolve(dir),
      lan: body.lan !== false,
      public: body.public === true,
    };
    config.mounts.push(mount);
    pushRecentDir(mount.dir);
    saveConfig();
    return json(reply, 200, { ok: true, mount: publicMount(mount) });
  }

  const mMatch = /^api\/mounts\/([A-Za-z0-9-]+)$/.exec(api || '');
  const mount = mMatch ? config.mounts.find((m) => m.id === mMatch[1]) : null;
  if (mMatch && !mount) return json(reply, 404, { error: 'share not found' });

  if (method === 'PATCH' && mount) {
    let body;
    try { body = JSON.parse(req.body || '{}'); } catch { return json(reply, 400, { error: 'bad json' }); }
    if (body.path !== undefined) {
      const p = normUrlPath(body.path);
      if (!p) return json(reply, 400, { error: 'bad address' });
      if (isReserved(p)) return json(reply, 400, { error: 'reserved address' });
      if (config.mounts.some((m) => m.path === p && m.id !== mount.id)) return json(reply, 400, { error: 'address already used' });
      mount.path = p;
    }
    if (body.dir !== undefined) {
      const st = await fsp.stat(path.resolve(body.dir)).catch(() => null);
      if (!st || !st.isDirectory()) return json(reply, 400, { error: 'no such folder' });
      mount.dir = path.resolve(body.dir);
      pushRecentDir(mount.dir);
    }
    if (body.lan !== undefined) mount.lan = body.lan === true;
    if (body.public !== undefined) mount.public = body.public === true;
    saveConfig();
    return json(reply, 200, { ok: true, mount: publicMount(mount) });
  }

  if (method === 'DELETE' && mount) {
    config.mounts = config.mounts.filter((m) => m.id !== mount.id);
    saveConfig();
    return json(reply, 200, { ok: true });
  }

  if (method === 'PATCH' && api === 'api/settings') {
    let body;
    try { body = JSON.parse(req.body || '{}'); } catch { return json(reply, 200, { ok: false, error: 'bad json' }); }
    try {
      // validate + persist first, answer, then restart listeners in the background
      if (body.httpPort !== undefined || body.httpsPort !== undefined) {
        const hnum = Number(body.httpPort !== undefined ? body.httpPort : config.httpPort);
        const snum = Number(body.httpsPort !== undefined ? body.httpsPort : config.httpsPort);
        for (const [label, p] of [['HTTP', hnum], ['HTTPS', snum]]) {
          if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`${label} port must be 1024–65535`);
        }
        if (snum === hnum) throw new Error('HTTP and HTTPS ports must differ');
      }
      if (body.httpsEnabled !== undefined) config.httpsEnabled = body.httpsEnabled === true;
      if (body.httpPort !== undefined) config.httpPort = Number(body.httpPort);
      if (body.httpsPort !== undefined) config.httpsPort = Number(body.httpsPort);
      saveConfig();
      const tunnelWasRunning = !!tunnel.proc;
      if (tunnelWasRunning) stopTunnel();
      json(reply, 200, { ok: true, messages: ['settings applied'], tunnelRestarted: tunnelWasRunning });
      setTimeout(() => {
        startServers().then(() => { if (tunnelWasRunning) startTunnel(); })
          .catch((err) => console.error('restart after settings change failed:', err));
      }, 400);
      return;
    } catch (err) {
      return json(reply, 400, { error: err.message });
    }
  }

  if (method === 'POST' && api === 'api/tunnel/start') return json(reply, 200, await startTunnel());
  if (method === 'POST' && api === 'api/tunnel/stop') return json(reply, 200, stopTunnel());
  if (method === 'POST' && api === 'api/tunnel/install') {
    const r = await installCloudflared();
    return json(reply, 200, { ...r, installState: tunnelState() });
  }

  return json(reply, 404, { error: 'unknown admin api' });
}

function publicMount(m) {
  return { id: m.id, path: m.path, dir: m.dir, lan: m.lan !== false, public: m.public === true };
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

function buildState(ctx) {
  return {
    app: 'Extranet',
    hostname: os.hostname(),
    platform: process.platform,
    home: os.homedir(),
    ips: lanIPs(),
    ports: { http: servers.httpPort, https: servers.https && !servers.httpsError ? servers.httpsPort : null },
    configuredHttpsPort: config.httpsPort,
    httpsError: servers.httpsError,
    qrAvailable: !!QRCode,
    mounts: config.mounts.map(publicMount),
    tunnel: tunnelState(),
    recentDirs: config.recentDirs,
    blockedCount: config.blockedIPs.length,
    tokenRequired: !ctx.local,
    token: ctx.local ? config.adminToken : undefined,
  };
}

async function handleFsBrowse(reply, input) {
  let p = String(input).trim().replace(/^["']|["']$/g, '');
  if (!p) {
    const drives = [];
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
  let dirs = [];
  try {
    const items = await fsp.readdir(abs, { withFileTypes: true });
    dirs = items
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .filter((d) => !/^(system volume information|\$recycle\.bin|windows|program files(x)?|programdata|appdata)$/i.test(d.name))
      .slice(0, 500)
      .map((d) => ({ path: path.join(abs, d.name), name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch (err) {
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
/* Shares (guest view)                                                 */
/* ------------------------------------------------------------------ */

async function serveShare(req, reply) {
  const url = new URL(req.raw.url || '/', 'http://internal');
  const ctx = req.ctx || { isTunnel: TUNNEL_HOST_RE.test(String(req.raw.headers.host || '').toLowerCase()), local: false, ip: '?', kind: 'lan' };
  const parsedPath = parseSegments(url.pathname);
  if (!parsedPath) return notFoundPage(reply, 'This link is broken.');
  const segs = parsedPath.segs;

  if (!segs.length) {
    if (ctx.isTunnel) return notFoundPage(reply, 'Nothing is shared at the root of this link — add the share name to the URL.');
    return notFoundPage(reply, 'Nothing here. Ask the person sharing files for a direct link.');
  }

  const urlPath = '/' + segs.join('/');
  const wantPublic = ctx.isTunnel;
  const mount = findMount(urlPath, wantPublic);
  if (!mount || !(mount.lan || ctx.isTunnel)) {
    if (ctx.isTunnel) return notFoundPage(reply, 'Nothing is shared under this address on the public link.');
    return notFoundPage(reply, 'Nothing is shared under this address.');
  }

  // compute absolute path within the mount
  const relSegs = segs.slice(mount.path.split('/').length - 1);
  let abs = mount.dir;
  for (const s of relSegs) abs = path.resolve(abs, s);

  const rootReal = await fsp.realpath(mount.dir).catch(() => null);
  if (!rootReal) return notFoundPage(reply, 'The folder this share points to no longer exists.');
  const absReal = await fsp.realpath(abs).catch(() => null);
  if (!absReal) return notFoundPage(reply, 'There is no file or folder at this address.');
  const rootL = rootReal.toLowerCase();
  const absL = absReal.toLowerCase();
  if (absL !== rootL && !absL.startsWith(rootL + path.sep)) {
    return notFoundPage(reply, 'This link is broken.');
  }

  let st;
  try { st = await fsp.stat(absReal); } catch { return notFoundPage(reply, 'This file is gone.'); }

  if (st.isDirectory()) {
    if (!parsedPath.trailing && urlPath !== mount.path) {
      return reply.code(301).header('Location', encodeURI(url.pathname + '/')).send();
    }
    return serveDirectory(req, reply, url, mount, urlPath, absReal, st);
  }
  if (st.isFile()) return serveFile(req, reply, absReal, st, { download: url.searchParams.get('dl') === '1' });
  return notFoundPage(reply, 'This item is not a viewable file or folder.');
}

async function serveDirectory(req, reply, url, mount, urlPath, absDir, st) {
  if (url.searchParams.get('zip') === '1') {
    const last = urlPath.split('/').filter(Boolean).pop() || 'share';
    let zipName;
    try { zipName = decodeURIComponent(last); } catch (err) { return json(reply, 400, { error: err.message }); }
    reply.hijack();
    try {
      await sendZip(reply.raw, absDir, zipName);
    } catch (err) {
      if (!reply.raw.headersSent) return json(reply, 400, { error: err.message });
      try { reply.raw.destroy(); } catch { /* ignore */ }
    }
    return;
  }
  const wantJSON = url.searchParams.get('json') === '1' || String(req.raw.headers.accept || '').includes('application/json');
  if (wantJSON) {
    const entries = await listDir(absDir);
    return json(reply, 200, {
      mount: mount.path,
      dir: urlPath,
      entries,
    });
  }
  return sendPage(reply, 'browse.html');
}

async function listDir(absDir) {
  const items = await fsp.readdir(absDir, { withFileTypes: true });
  const entries = [];
  for (const it of items) {
    if (it.name === '.') continue;
    const isDir = it.isDirectory();
    let size = null, mtime = null;
    if (!isDir) {
      try {
        const st = await fsp.stat(path.join(absDir, it.name));
        if (st.isFile()) { size = st.size; mtime = st.mtimeMs; }
        else continue; // symlink / device: skip for safety
      } catch { continue; }
    }
    entries.push({ name: it.name, dir: isDir, size, mtime });
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return entries;
}

function serveFile(req, reply, absFile, st, opts) {
  const res = reply.raw;
  reply.hijack();
  const size = st.size;
  const type = mimeFor(absFile);
  const name = path.basename(absFile);
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Disposition': contentDisposition(opts.download ? 'attachment' : 'inline', name),
    'X-Robots-Tag': 'noindex',
  };
  const range = String((req.raw.headers || {}).range || '');
  let start = 0, end = size - 1, status = 200;

  if (size === 0) {
    res.writeHead(200, { ...base, 'Content-Length': 0 });
    return res.end();
  }
  if (range && /^bytes=/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (m[1] === '' && m[2] !== '') {
      const n = parseInt(m[2], 10);
      start = Math.max(0, size - n); end = size - 1;
    } else {
      start = parseInt(m[1] || '0', 10);
      end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = { ...base, 'Content-Length': end - start + 1 };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if ((req.raw.method || 'GET') === 'HEAD') return res.end();
  const stream = fs.createReadStream(absFile, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* Servers (HTTP + HTTPS)                                              */
/* ------------------------------------------------------------------ */

const servers = {
  http: null,
  https: null,
  httpPort: config.httpPort,
  httpsPort: config.httpsPort,
  httpsError: null,
};

function isAddrInUse(err) {
  return !!err && (err.code === 'EADDRINUSE' || /address (already )?in use/i.test(String((err && err.message) || '')));
}

async function listenWithBump(makeApp, basePort, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const port = basePort + i;
    let app = null;
    try {
      app = makeApp();
      await app.listen({ port, host: '0.0.0.0' });
      return { app, port };
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
      if (app) { try { await app.close(); } catch { /* ignore */ } }
    }
  }
  throw new Error(`no free port found from ${basePort}`);
}

async function closeServer(app) {
  if (!app) return;
  const raw = app.server;
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  try { raw && raw.closeAllConnections && raw.closeAllConnections(); } catch { /* ignore */ }
}

async function startServers() {
  await closeServer(servers.http);
  await closeServer(servers.https);
  servers.httpsError = null;

  const httpRes = await listenWithBump(() => buildApp(null), config.httpPort);
  servers.http = httpRes.app;
  servers.httpPort = httpRes.port;
  if (config.httpPort !== httpRes.port) config.httpPort = httpRes.port;

  if (config.httpsEnabled) {
    try {
      const creds = ensureCertificate();
      const httpsRes = await listenWithBump(() => buildApp(creds), config.httpsPort);
      servers.https = httpsRes.app;
      servers.httpsPort = httpsRes.port;
      if (config.httpsPort !== httpsRes.port) config.httpsPort = httpsRes.port;
    } catch (err) {
      servers.https = null;
      servers.httpsError = err.message;
    }
  } else {
    servers.https = null;
  }
  saveConfig();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  await startServers();

  const ips = lanIPs();
  const primary = ips[0] && ips[0].address;
  const lines = [];
  lines.push('');
  lines.push('Extranet is running.');
  lines.push(`  Admin (this computer)     http://localhost:${servers.httpPort}/admin`);
  lines.push(`  Analytics (this computer) http://localhost:${servers.httpPort}/analytics  — logs, client IPs, blocking`);
  if (primary) {
    if (servers.https && !servers.httpsError) lines.push(`  On this Wi-Fi (HTTPS)     https://${primary}:${servers.httpsPort}/<share>`);
    lines.push(`  On this Wi-Fi (HTTP)      http://${primary}:${servers.httpPort}/<share>`);
  } else {
    lines.push('  (no LAN IP found — Wi-Fi sharing unavailable)');
  }
  lines.push('  Share folders by opening the admin page and adding them.');
  if (servers.httpsError) lines.push(`  HTTPS problem: ${servers.httpsError}`);
  lines.push(`  Admin token (only needed to manage from another device): ${config.adminToken}`);
  lines.push('  Tip: if Windows asks about the firewall, allow Node.js on private networks.');
  console.log(lines.join('\n'));

  if (!config.mounts.length) {
    console.log('  No shares yet — the guest page is empty until you add one.');
  }
}

process.on('SIGINT', () => { stopTunnel(); writeLogs(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); writeLogs(); process.exit(0); });
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled promise rejection:', err));

boot();
