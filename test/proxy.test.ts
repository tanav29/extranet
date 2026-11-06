import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { rewriteT3Script, t3Bootstrap } from '../server/t3-adapter';

test('T3 adapter changes router/preload configuration while preserving route definitions', () => {
  const source = 'function router(e){return cv({routeTree:tree,history:e,context:{}})};function preload(e){return`/`+e};const route={path:`/pair`};';
  const output = rewriteT3Script(source, '/t3');
  assert.match(output, /basepath:"\/t3",routeTree:tree/);
  assert.match(output, /return "\/t3\/"\+e/);
  assert.match(output, /path:`\/pair`/);
});

test('T3 browser adapter keeps API/socket requests inside each tab prefix', async () => {
  for (const prefix of ['/t3', '/other']) {
    const calls: string[] = [];
    class Socket { constructor(url: string) { calls.push(url); } }
    const window = { URL, Request, WebSocket: Socket, EventSource: Socket,
      fetch: async (input: string | Request) => { calls.push(typeof input === 'string' ? input : input.url); } };
    runInNewContext(t3Bootstrap(prefix), { window, URL, Request, location: { href: `https://shared.example${prefix}/pair`, host: 'shared.example' } });
    await window.fetch('/api/session');
    await window.fetch(new Request('https://shared.example/api/session', { method: 'POST', body: 'body' }));
    new window.WebSocket('wss://shared.example/ws');
    await window.fetch('https://external.example/api');
    assert.deepEqual(calls, [`https://shared.example${prefix}/api/session`, `https://shared.example${prefix}/api/session`, `wss://shared.example${prefix}/ws`, 'https://external.example/api']);
  }
});

test('prefix proxy isolates apps, forwards WebSockets, preserves native paths and repairs T3', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extranet-proxy-'));
  const largeBody = 'x'.repeat(4 * 1024 * 1024 + 500);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/pair') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head></head><body><script src="/assets/main.js"></script></body></html>');
    } else if (req.url === '/assets/main.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('cv({routeTree:tree,history:e});function preload(e){return`/`+e}');
    } else if (req.url === '/large') {
      res.setHeader('Content-Type', 'text/css');
      res.write(largeBody.slice(0, 1024));
      res.end(largeBody.slice(1024));
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/pair', 'Set-Cookie': 'session=one; Path=/; HttpOnly; SameSite=Lax' }); res.end();
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: req.url, prefix: req.headers['x-forwarded-prefix'] })); }
  });
  upstream.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(req.url!);
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as net.AddressInfo).port;
  const blocker = net.createServer();
  await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
  const proxyPort = (blocker.address() as net.AddressInfo).port;
  await new Promise<void>(r => blocker.close(() => r()));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ adminToken: 'test', proxyPort, routes: [
    { id: 'one', kind: 'port', path: '/t3', port, adapter: 't3', lan: true },
    { id: 'two', kind: 'port', path: '/demo', port, upstreamPath: 'preserve', lan: true },
    { id: 'locked', kind: 'port', path: '/locked', port, pin: '123456', public: true, lan: true },
  ] }));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/proxy.js')], {
    env: { ...process.env, EXTRANET_DATA_DIR: dir, EXTRANET_PROXY_PORT: String(proxyPort) }, windowsHide: true, stdio: 'pipe',
  });
  t.after(async () => {
    child.kill();
    await new Promise<void>(r => { if (child.exitCode !== null) r(); else child.once('exit', () => r()); });
    upstream.closeAllConnections();
    await new Promise<void>(r => upstream.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', c => { if (String(c).includes('reverse proxy ready')) resolve(); });
    child.once('exit', code => reject(new Error(`proxy exited ${code}`)));
  });
  const origin = `http://127.0.0.1:${proxyPort}`;
  const redirect = await fetch(origin + '/t3/', { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/t3/pair');
  const html = await (await fetch(origin + '/t3/pair')).text();
  assert.match(html, /<head><script src="\/t3\/__extranet_bootstrap.js"><\/script>/);
  assert.match(html, /src="\/t3\/assets\/main.js"/);
  assert.match(await (await fetch(origin + '/t3/assets/main.js')).text(), /basepath:"\/t3"/);
  assert.match(await (await fetch(origin + '/t3/__extranet_bootstrap.js')).text(), /window.fetch/);
  assert.equal(await (await fetch(origin + '/t3/large')).text(), largeBody);
  assert.deepEqual(await (await fetch(origin + '/t3/api/users?q=1')).json(), { url: '/api/users?q=1', prefix: '/t3' });
  assert.deepEqual(await (await fetch(origin + '/demo/api/users?q=2')).json(), { url: '/demo/api/users?q=2', prefix: '/demo' });
  const cookies = await fetch(origin + '/t3/redirect', { redirect: 'manual' });
  assert.equal(cookies.headers.get('location'), '/t3/pair');
  assert.match(cookies.headers.get('set-cookie')!, /session=one; Path=\/t3\//);
  const unprefixed = await fetch(origin + '/api/users', { headers: { referer: origin + '/t3/pair', cookie: 'extranet-port-share=one' } });
  assert.equal(unprefixed.status, 502); // no internal API configured: must not hit the app
  // Simulate a trusted local tunnel connection; do not use localhost's PIN bypass.
  const tunnelGet = (target: string) => new Promise<http.IncomingMessage>((resolve, reject) => {
    http.get(origin + target, { headers: { host: 'test.trycloudflare.com' } }, response => { response.resume(); resolve(response); }).on('error', reject);
  });
  assert.equal((await tunnelGet('/locked/')).statusCode, 401);
  const unlocked = await tunnelGet('/locked/?pin=123456');
  const pinCookie = unlocked.headers['set-cookie']![0].split(';')[0];
  assert.equal(unlocked.statusCode, 303);
  for (const [target, cookie, status] of [
    ['/locked/ws', '', 401], ['/locked/ws', pinCookie, 101], ['/t3/ws', '', 404],
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1');
      socket.setTimeout(3000, () => socket.destroy(new Error('handshake timed out')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: test.trycloudflare.com\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      socket.once('data', data => { assert.match(data.toString(), new RegExp(`^HTTP/1.1 ${status} `)); socket.destroy(); resolve(); });
    });
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write('GET /t3/ws?token=test HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('/ws?token=test')) { assert.match(data, /101 Switching Protocols/); socket.destroy(); resolve(); }
    });
  });
});
