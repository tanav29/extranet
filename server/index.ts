#!/usr/bin/env node
import type { Runtime, ServiceName } from './types';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
/*
 * Extranet supervisor — the process `npm start` runs.
 *
 * New architecture: one small reverse proxy is the only public listener, and
 * it routes by URL path to four separate services it supervises:
 *
 *     8787  proxy  (this is the port to share — tunnel, LAN, everything)
 *      web   app/dist UI: "/" start page, /admin, /analytics, /app/*
 *      api   /api/* registry + analytics + settings + tunnel control
 *      files /files/* folder shares (listings, viewers, downloads, zips)
 *      proxy dynamic port routes: any path a share points at a local port
 *
 * Why so the supervisor: the services are four independent processes that
 * share no in-memory state — the registry lives in data/config.json, the
 * actually-bound ports in data/runtime.json, the access log in data/logs.json
 * (see lib.ts). This process only starts the four, relays their output with a
 * "[name]" prefix, restarts them when they crash, prints the banner once every
 * service has published its port, and tears everything down on Ctrl+C.
 *
 * Small dependencies: none here — plain node:child_process.
 */
'use strict';

import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as lib from './lib';

const SERVICES: ServiceName[] = ['web', 'api', 'files', 'proxy'];
const RESTART_DELAY = 800;    // ms before relaunching a crashed child
const RESTART_CAP = 10;       // then give up on that child

// Persist one shared token before any child loads config. Never replace a corrupt file.
lib.saveConfig();
const runtime: Runtime & { services: NonNullable<Runtime["services"]> } = { runId: crypto.randomUUID(), services: {} };
lib.writeRuntime(runtime);
const children = new Map<ServiceName, { child: ChildProcess; restarts: number }>();          // name -> { child, restarts }
let stopping = false;
let bannerShown = false;

/* ------------------------------------------------------------------ */
/* Process management                                                   */
/* ------------------------------------------------------------------ */

function serverScript(name: ServiceName) {
  return path.join(__dirname, `${name}.js`);
}

function killChild(child: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (lib.IS_WIN) {
      // /T takes the whole tree (services may spawn cloudflared)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
    }
  } catch { /* already gone */ }
}

function killAll() {
  for (const { child } of children.values()) killChild(child);
}

/* one crash restarts with a delay; give up after RESTART_CAP attempts */
function onChildExit(name: ServiceName) {
  return (code: number | null, signal: NodeJS.Signals | null) => {
    const entry = children.get(name);
    if (!entry) return;
    console.log(`[${name}] exited (code ${code === null ? '-' : code}${signal ? `, ${signal}` : ''})`);
    delete runtime[name];
    delete runtime.services[name];
    runtime.ts = Date.now();
    lib.writeRuntime(runtime);
    if (stopping) return;
    if (entry.restarts >= RESTART_CAP) {
      console.error(`[supervisor] giving up on ${name} after ${RESTART_CAP} restarts — the stack is degraded`);
      return;
    }
    entry.restarts += 1;
    console.log(`[supervisor] restarting ${name} in ${RESTART_DELAY}ms (attempt ${entry.restarts}/${RESTART_CAP})`);
    setTimeout(() => { if (!stopping) startChild(name, entry.restarts); }, RESTART_DELAY);
  };
}

function lineRelay(name: ServiceName, stream: Readable) {
  /* buffer partial lines, tag every complete one with [name] */
  let buf = '';
  const MAX = 16 * 1024;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.length) console.log(`[${name}] ${line}`);
    }
    if (buf.length > MAX) buf = buf.slice(-MAX);   // pathological output: drop the head
  });
  stream.on('end', () => { if (buf.trim()) console.log(`[${name}] ${buf.trim()}`); buf = ''; });
}

function startChild(name: ServiceName, restarts = 0) {
  const child = spawn(
    process.execPath,
    [serverScript(name)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env, windowsHide: true },
  );
  children.set(name, { child, restarts });
  child.on('message', (value) => {
    if (!value || typeof value !== 'object') return;
    const message = value as { type?: string; name?: string; port?: number };
    if (stopping || children.get(name)?.child !== child) return;
    if (message?.type !== 'service-ready' || message.name !== name
        || typeof message.port !== 'number' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
    runtime[name] = message.port;
    runtime.services[name] = { pid: child.pid!, port: message.port };
    runtime.ts = Date.now();
    lib.writeRuntime(runtime);
    maybePrintBanner(runtime);
  });
  lineRelay(name, child.stdout!);
  lineRelay(name, child.stderr!);
  child.on('error', (err) => console.error(`[supervisor] could not start ${name}: ${err.message}`));
  child.on('exit', onChildExit(name));
  return child;
}

/* ------------------------------------------------------------------ */
/* Banner — once every service has published its actual port            */
/* ------------------------------------------------------------------ */

function allServicesPublished(rt: Runtime) {
  return rt.runId === runtime.runId && SERVICES.every((s) => {
    const child = children.get(s)?.child;
    return child && child.exitCode === null && child.signalCode === null
      && Number.isInteger(rt[s]) && rt.services?.[s]?.pid === child.pid;
  });
}

function maybePrintBanner(rt: Runtime) {
  if (bannerShown || !allServicesPublished(rt)) return;
  bannerShown = true;
  const primary = lib.lanIPs()[0] && lib.lanIPs()[0].address;
  const lines: string[] = [];
  lines.push('');
  lines.push('Extranet is running.');
  lines.push(`  Admin (this computer)     http://localhost:${rt.proxy}/admin`);
  lines.push(`  Start page (everyone)     http://localhost:${rt.proxy}/  — directory of visible shares`);
  lines.push(`  Analytics (this computer) http://localhost:${rt.proxy}/analytics  — logs, client IPs, blocking`);
  lines.push('  Everything above also works from the Cloudflare tunnel once it is');
  lines.push("  started from the admin console's Connect tab (single URL, path-based).");
  if (primary) {
    lines.push(`  On this Wi-Fi             http://${primary}:${rt.proxy}/<share>`);
  } else {
    lines.push('  (no LAN IP found — Wi-Fi sharing unavailable)');
  }
  lines.push(`  Services (loopback only)  web :${rt.web} · api :${rt.api} · files :${rt.files}`);
  lines.push(`  Admin token (only needed to manage from another device): ${lib.config.adminToken}`);
  lines.push('  Tip: if Windows asks about the firewall, allow Node.js on private networks.');
  console.log(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Boot + teardown                                                      */
/* ------------------------------------------------------------------ */

console.log(`supervisor starting ${SERVICES.length} services (proxy + web + api + files)…`);
for (const name of SERVICES) startChild(name);

/* Ctrl+C or a service manager asking us to stop: take everything down. */
function shutdown() {
  if (stopping) { killAll(); process.exit(1); }   // second Ctrl+C = force
  stopping = true;
  console.log('\nsupervisor: stopping services…');
  killAll();
  // children dying triggers onChildExit; without a restart we just exit
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled promise rejection:', err));
