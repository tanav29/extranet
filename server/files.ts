import type { Share, ClientKind } from './types';
import type { FastifyRequest, FastifyReply, FastifyBodyParser } from 'fastify';
import type { ServerResponse } from 'node:http';
'use strict';
/*
 * Extranet files service — serves folder shares on :8080 under /files/<share>.
 *
 *   /files/movies/                 browse page (app/dist/browse.html) or JSON listing
 *   /files/movies/sub/             same for subfolders (?json=1 / Accept: json → JSON)
 *   /files/movies/file.mp4         the bytes (Range supported, ?dl=1 to download)
 *   /files/movies/?zip=1           the whole folder as one streamed .zip
 *
 * The route registry (config.json) says which folder each share maps to and
 * whether it needs a 6-digit PIN. The file is watched, so adding/removing a
 * share or changing a PIN in the admin console applies here within ~0.5s,
 * without a restart.
 *
 * Internal service: binds 127.0.0.1 only — the reverse proxy is the only way
 * in from the outside. The proxy tags each request with x-client-kind
 * (local | lan | tunnel); a missing tag means the owner hit this service
 * directly on this computer.
 */

import * as fs from 'fs';
const fsp = fs.promises;
import * as path from 'path';
import * as zlib from 'zlib';
import Fastify from 'fastify';
import * as lib from './lib';

const { PUBLIC_DIR, parseSegments, sendRawHtml, notFoundRaw } = lib;

/* ------------------------------------------------------------------ */
/* Route resolution (folder shares under /files)                        */
/* ------------------------------------------------------------------ */

/* which routes this kind of visitor may see — same rule the proxy applies */
function visible(mount: Share, kind: ClientKind) {
  if (kind === 'tunnel') return mount.public === true;
  if (kind === 'local') return true;
  return mount.lan !== false;
}

/* longest folder share whose path claims innerPath ("/movies" claims "/movies/…") */
function findFolderRoute(innerPath: string, kind: ClientKind) {
  let best: (Share & { dir: string }) | null = null;
  for (const m of lib.config.routes) {
    if (m.kind !== 'folder' || !m.path || !m.dir) continue;
    if (m.path !== innerPath && !innerPath.startsWith(m.path + '/')) continue;
    if (!visible(m, kind)) continue;
    if (!best || m.path.length > best.path.length) best = m as Share & { dir: string };
  }
  return best;
}

function clientKind(req: FastifyRequest) {
  const k = String(req.headers['x-client-kind'] || 'local');
  return k === 'local' || k === 'tunnel' ? k : 'lan';
}

function clientIP(req: FastifyRequest) {
  return lib.normIP(req.headers['x-client-ip'] || req.socket.remoteAddress);
}

/* ------------------------------------------------------------------ */
/* The app                                                              */
/* ------------------------------------------------------------------ */

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
const rawBodyParser: FastifyBodyParser<Buffer> = (_req, body, done) => done(null, body == null ? '' : body);
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawBodyParser);
app.addContentTypeParser('*', { parseAs: 'buffer' }, rawBodyParser);

app.all('/files', shareHandler);
app.all('/files/*', shareHandler);
app.setNotFoundHandler((req, reply) => {
  reply.hijack();
  notFoundRaw(reply.raw, 'Nothing is shared at this address.');
});

async function shareHandler(req: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  const raw = req.raw;
  const kind = clientKind(req);
  const ip = clientIP(req);
  const method = (raw.method || 'GET').toUpperCase();

  let url;
  try { url = new URL(raw.url || '/', 'http://internal'); } catch { return notFoundRaw(res, 'This link is broken.'); }

  /* /files/<share-path>/… — the /files prefix belongs to this service */
  const inner = url.pathname.slice('/files'.length) || '/';
  const parsedPath = parseSegments(inner);
  if (!parsedPath) return notFoundRaw(res, 'This link is broken.');
  const { segs, trailing } = parsedPath;

  if (!segs.length) return notFoundRaw(res, 'Nothing is shared at this address.');

  const urlPath = '/' + segs.join('/');
  const route = findFolderRoute(urlPath, kind);
  if (!route) {
    return notFoundRaw(res, kind === 'tunnel'
      ? 'Nothing is shared under this address on the public link.'
      : 'Nothing is shared under this address.');
  }

  // 6-digit PIN check (once per device — a cookie remembers it; the owner's
  // own computer never needs it). Sends the gate page or a redirect and stops.
  if (!lib.enforceSharePinRaw(raw, res, route, url, ip, kind === 'local')) return;

  // /files/movies → /files/movies/ : document-relative refs inside the
  // browser page then resolve under the share
  if ((method === 'GET' || method === 'HEAD') && urlPath === route.path && !trailing) {
    res.writeHead(301, {
      Location: '/files' + route.path + '/' + url.search,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    return res.end();
  }

  // compute absolute path within the share
  const relSegs = segs.slice(route.path.split('/').length - 1);
  let abs = route.dir;
  for (const s of relSegs) abs = path.resolve(abs, s);

  const rootReal = await fsp.realpath(route.dir).catch(() => null);
  if (!rootReal) return notFoundRaw(res, 'The folder this share points to no longer exists.');
  const absReal = await fsp.realpath(abs).catch(() => null);
  if (!absReal) return notFoundRaw(res, 'There is no file or folder at this address.');
  const rootL = rootReal.toLowerCase();
  const absL = absReal.toLowerCase();
  if (absL !== rootL && !absL.startsWith(rootL + path.sep)) {
    return notFoundRaw(res, 'This link is broken.');
  }

  let st;
  try { st = await fsp.stat(absReal); } catch { return notFoundRaw(res, 'This file is gone.'); }

  if (st.isDirectory()) {
    if (!trailing && urlPath !== route.path) {
      res.writeHead(301, { Location: encodeURI(url.pathname + '/') });
      return res.end();
    }
    return serveDirectory(req, res, url, route, urlPath, absReal, st);
  }
  if (st.isFile()) return serveFile(req, res, absReal, st, { download: url.searchParams.get('dl') === '1' });
  return notFoundRaw(res, 'This item is not a viewable file or folder.');
}

/* ------------------------------------------------------------------ */
/* Directories                                                          */
/* ------------------------------------------------------------------ */

async function serveDirectory(req: FastifyRequest, res: ServerResponse, url: URL, route: Share, urlPath: string, absDir: string, st: fs.Stats) {
  if (url.searchParams.get('zip') === '1') {
    const last = urlPath.split('/').filter(Boolean).pop() || 'share';
    let zipName;
    try { zipName = decodeURIComponent(last); } catch (caught) { const err = caught as NodeJS.ErrnoException; return lib.jsonRaw(res, 400, { error: err.message }); }
    try {
      await sendZip(res, absDir, zipName);
    } catch (caught) { const err = caught as NodeJS.ErrnoException;
      if (!res.headersSent) return lib.jsonRaw(res, 400, { error: err.message });
      try { res.destroy(); } catch { /* ignore */ }
    }
    return;
  }
  const wantJSON = url.searchParams.get('json') === '1' || String(req.headers.accept || '').includes('application/json');
  if (wantJSON) {
    const entries = await listDir(absDir);
    return lib.jsonRaw(res, 200, {
      mount: '/files' + route.path,
      dir: '/files' + urlPath,
      entries,
    });
  }
  return sendPage(res, 'browse.html');
}

async function listDir(absDir: string) {
  const items = await fsp.readdir(absDir, { withFileTypes: true });
  const entries: { name: string; dir: boolean; size: number | null; mtime: number | null }[] = [];
  for (const it of items) {
    if (it.name === '.') continue;
    const isDir = it.isDirectory();
    let size: number | null = null, mtime: number | null = null;
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

function sendPage(res: ServerResponse, name: string) {
  let buf;
  try { buf = fs.readFileSync(path.join(PUBLIC_DIR, name)); }
  catch {
    return sendRawHtml(res, 200, 'UI not built', `<h1>UI not built</h1>
<p>The interface is missing. Run <code>npx extranet --build</code> once, then restart.</p>`);
  }
  try {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    res.end(buf);
  } catch { /* client gone */ }
}

/* ------------------------------------------------------------------ */
/* Files                                                                */
/* ------------------------------------------------------------------ */

function serveFile(req: FastifyRequest, res: ServerResponse, absFile: string, st: fs.Stats, opts: { download: boolean }) {
  const size = st.size;
  const type = lib.mimeFor(absFile);
  const name = path.basename(absFile);
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Disposition': lib.contentDisposition(opts.download ? 'attachment' : 'inline', name),
    'X-Robots-Tag': 'noindex',
  };
  const range = String((req.headers || {}).range || '');
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
  const headers: import("node:http").OutgoingHttpHeaders = { ...base, 'Content-Length': end - start + 1 };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if ((req.method || 'GET').toUpperCase() === 'HEAD') return res.end();
  const stream = fs.createReadStream(absFile, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* Streaming ZIP writer (store/deflate, no dependencies)                */
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
  c: number;
  n: number;
  constructor() { this.c = 0xFFFFFFFF; this.n = 0; }
  update(buf: Buffer | string) {
    let c = this.c;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ (typeof buf === 'string' ? buf.charCodeAt(i) : buf[i])) & 0xFF] ^ (c >>> 8);
    this.c = c;
    this.n += buf.length;
  }
  get value() { return (this.c ^ 0xFFFFFFFF) >>> 0; }
}

function dosTime(d: Date) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
  };
}

const ZIP_LIMITS = { entries: 8000, bytes: 3 * 1024 * 1024 * 1024 };

async function collectTree(rootDir: string) {
  const entries: { abs: string; rel: string; isDir: boolean; size?: number }[] = [];
  let total = 0;
  async function walk(dir: string, rel: string) {
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

async function sendZip(res: ServerResponse, rootDir: string, zipName: string) {
  const entries = await collectTree(rootDir);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': lib.contentDisposition('attachment', zipName.endsWith('.zip') ? zipName : zipName + '.zip'),
    'Cache-Control': 'no-store',
  });
  const { time, date } = dosTime(new Date());
  const central: { nameBuf: Buffer; flags: number; method: number; crc: number; csize: number; usize: number; offset: number; isDir: boolean }[] = [];
  let offset = 0;

  const localHeader = (nameLen: number, flags: number, method: number, crc: number, csize: number, usize: number) => {
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

  const write = (buf: Buffer) => {
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
      await new Promise<void>((resolve) => {
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
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

lib.startConfigWatch();   // shares, PINs and scopes refresh live

const wantPort = lib.envPort('FILES') || lib.DEFAULT_PORTS.files;

(async () => {
  const port = await lib.bindWithBump(
    (p) => app.listen({ port: p, host: '127.0.0.1' }),
    wantPort,
  );
  lib.publishService('files', port);
  console.log(`files service ready on 127.0.0.1:${port} (shares under /files/<name>)`);
})().catch((err) => {
  console.error('files service failed to start:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled promise rejection:', err));
