'use strict';

import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..', '..');
const libPath = path.join(root, 'dist/server/lib.js');
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extranet-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function evaluate(dir: string, code: string) {
  const result = spawnSync(process.execPath, ['-e', `const lib = require(${JSON.stringify(libPath)}); ${code}`], {
    env: { ...process.env, EXTRANET_DATA_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('compiled CLI exposes help/version and rejects invalid ports', () => {
  const cli = path.join(root, 'dist/bin/cli.js');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: npx extranet/);
  const version = run('--version');
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  for (const args of [['--port'], ['--port', '6060oops'], ['--port', '0']]) {
    assert.equal(run(...args).status, 2);
  }
});

test('legacy config migrates without losing shares or the selected port', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'config.json');
  const legacy = { httpPort: 9123, adminToken: 'existing-token', mounts: [{ id: 'one', path: '/photos', dir: dir }] };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const config = evaluate(dir, 'console.log(JSON.stringify(lib.config))');
  assert.equal(config.proxyPort, 9123);
  assert.equal(config.routes[0].path, '/photos');
  assert.equal(config.adminToken, legacy.adminToken);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), legacy);
});

test('failed config refresh preserves the last valid state', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ adminToken: 'keep-me', routes: [{ id: 'one', path: '/photos' }] }));
  const result = evaluate(dir, `
    const fs = require('node:fs');
    fs.writeFileSync(lib.CONFIG_FILE, '{broken');
    let rejected = false;
    try { lib.refreshConfig(); } catch { rejected = true; }
    console.log(JSON.stringify({ rejected, config: lib.config }));
  `);
  assert.equal(result.rejected, true);
  assert.equal(result.config.adminToken, 'keep-me');
  assert.equal(result.config.routes.length, 1);
});

test('invalid config on startup fails without overwriting the file', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{broken');
  const result = spawnSync(process.execPath, [path.join(root, 'dist/server/index.js')], {
    env: { ...process.env, EXTRANET_DATA_DIR: dir }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('atomic saves preserve config and report write failures', (t) => {
  const dir = fixture(t);
  const result = evaluate(dir, `
    const fs = require('node:fs');
    lib.saveConfig();
    const before = fs.readFileSync(lib.CONFIG_FILE, 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated disk failure'); };
    let rejected = false;
    try { lib.saveConfig(); } catch { rejected = true; }
    fs.renameSync = rename;
    console.log(JSON.stringify({ rejected, unchanged: before === fs.readFileSync(lib.CONFIG_FILE, 'utf8'), files: fs.readdirSync(lib.DATA_DIR) }));
  `);
  assert.equal(result.rejected, true);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.files, ['config.json']);
});

async function eventually<T>(check: () => T | Promise<T>, timeout = 20000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (err) { last = err; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for services${last ? ': ' + String(last) : ''}`);
}

test('supervisor handles occupied ports, concurrent readiness, and a service restart', { timeout: 45000 }, async (t) => {
  const dir = fixture(t);
  const services = ['web', 'api', 'files', 'proxy'];
  const env: NodeJS.ProcessEnv = { ...process.env, EXTRANET_DATA_DIR: dir };
  delete env.EXTRANET_PORT;
  const blockers: net.Server[] = [];
  const selectedPorts: number[] = [];
  let child: ChildProcess | undefined;
  try {
    for (const name of services) {
      let server: net.Server;
      for (;;) {
        server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, name === 'proxy' ? '0.0.0.0' : '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        if (selectedPorts.every((other) => Math.abs(other - port) > 40)) { selectedPorts.push(port); break; }
        await new Promise((resolve) => server.close(resolve));
      }
      blockers.push(server);
      env[`EXTRANET_${name.toUpperCase()}_PORT`] = String((server.address() as net.AddressInfo).port);
    }
    // A previous run must never satisfy readiness for this run.
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ web: 1, api: 2, files: 3, proxy: 4, ts: Date.now() + 100000 }));
    child = spawn(process.execPath, [path.join(root, 'dist/bin/cli.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', (chunk) => { output += chunk; });
    child.stderr!.on('data', (chunk) => { output += chunk; });
    const readRuntime = () => JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
    const rt = await eventually(() => {
      assert.equal(child!.exitCode, null);
      const r = readRuntime();
      return services.every((name) => r.services?.[name]?.pid && r[name] > 1024) && output.includes('Extranet is running.') && r;
    });
    assert.ok(rt.runId);
    for (const name of services) assert.notEqual(rt[name], Number(env[`EXTRANET_${name.toUpperCase()}_PORT`]), name);
    const origin = `http://127.0.0.1:${rt.proxy}`;
    const response = await eventually(async () => {
      const r = await fetch(origin + '/api/state', { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()} runtime=${JSON.stringify(readRuntime())}`);
      return r;
    });
    const state = await response.json();
    assert.ok(state);
    const token = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).adminToken;
    assert.ok(token);
    const previousPid = rt.services.api.pid;
    process.kill(previousPid, 'SIGKILL');
    await eventually(() => {
      const r = readRuntime();
      return r.runId === rt.runId && r.services?.api?.pid !== previousPid && r.services?.api?.pid;
    });
    await eventually(async () => (await fetch(origin + '/api/state', { signal: AbortSignal.timeout(2000) })).ok);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).adminToken, token);
    assert.equal((output.match(/Extranet is running\./g) || []).length, 1);
  } finally {
    if (child && child!.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => { if (child!.exitCode !== null) resolve(); else child!.once('exit', resolve); });
    }
    await Promise.all(blockers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
