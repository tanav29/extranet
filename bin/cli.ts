#!/usr/bin/env node
/*
 * Extranet launcher — the single command that runs the whole app:
 *
 *     extranet                     (installed package)
 *     npm start                    (source checkout)
 *
 * It makes sure the UI bundle exists (building it once if the toolchain is
 * installed), applies command-line overrides, and then starts the Fastify
 * server in dist/server/index.js (which prints the addresses and admin token).
 *
 * Flags:
 *   --port <n>     listen on this port instead of the saved one
 *   --build        force a rebuild of the UI before starting
 *   --help         show this help
 *   --version      show the version
 */
'use strict';

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..', '..');
const UI_DIR = path.join(ROOT, 'app');
const SERVER = path.join(ROOT, 'dist', 'server', 'index.js');

const USAGE = `Extranet — share folders and app ports from this computer.

Usage: npx extranet [options]

Options:
  --port <n>     listen on this port (default: the saved port, usually 8787)
  --build        rebuild the web UI from app/ before starting
  --help         show this help
  --version      show the version

After it starts, open the admin console it prints, e.g.
  http://localhost:8787/admin`;

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
  catch { return { version: '1.0.0' }; }
})();

const args = process.argv.slice(2);
let port: string | null = null;
let forceBuild = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  if (a === '--version' || a === '-v') { console.log(pkg.version); process.exit(0); }
  if (a === '--build') { forceBuild = true; continue; }
  if (a === '--port' || a === '-p') {
    port = args[++i] ?? null;
    if (port === null) { console.error('--port requires a number'); process.exit(2); }
    continue;
  }
  if (/^--port=\d+$/.test(a)) { port = a.split('=')[1]; continue; }
  console.error(`Unknown option: ${a}` + '\nRun "npx extranet --help" for usage.');
  process.exit(2);
}

if (port != null) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    console.error('--port must be a number between 1024 and 65535');
    process.exit(2);
  }
  process.env.EXTRANET_PORT = String(p);
}

function uiBuilt() {
  return fs.existsSync(path.join(UI_DIR, 'dist', 'admin.html'));
}

function buildUI() {
  if (!fs.existsSync(path.join(UI_DIR, 'package.json'))) {
    console.error('This package contains a prebuilt UI. Reinstall it to restore missing assets; --build is for source checkouts.');
    process.exit(1);
  }
  const hasToolchain = fs.existsSync(path.join(UI_DIR, 'node_modules'));
  if (!hasToolchain && uiBuilt() && !forceBuild) return;        // prebuilt bundle is enough
  if (!hasToolchain) {
    console.error('The UI is not built and there is no build toolchain installed.');
    console.error(`Fix it once with:  npm install --prefix ${UI_DIR}`);
    console.error(`then rebuild with:  npm run build --prefix ${UI_DIR}`);
    process.exit(1);
  }
  console.log('Building the UI (one-time, ~10s)…');
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: UI_DIR, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (r.status !== 0 || !uiBuilt()) {
    console.error('UI build failed — see the output above.');
    process.exit(1);
  }
}

if (forceBuild || !uiBuilt()) buildUI();
require(SERVER);
