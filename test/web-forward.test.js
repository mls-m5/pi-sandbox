import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseForwardAddress, startBrowserForward } from '../src/forward-command.js';
import { waitFor } from './fixtures/transport.js';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-forward-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('forward syntax defaults are memorable and help starts no project or SSH', (t) => {
  const target = parseForwardAddress(['ssh://alice@host.example']);
  assert.equal(target.sshPort, 22);
  assert.equal(target.serverPort, 43128);
  assert.equal(parseForwardAddress(['ssh://host.example:2222/43129']).serverPort, 43129);
  for (const args of [
    [],
    ['http://127.0.0.1:43128'],
    ['ssh://host', '--port', '43210'],
    ['ssh://host', 'extra'],
  ])
    assert.throws(() => parseForwardAddress(args));
  const dir = directory(t),
    home = path.join(dir, 'not-created');
  const result = spawnSync(process.execPath, [cli, '--forward', '--help'], {
    env: { PATH: process.env.PATH, HOME: home, PIS_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  for (const text of [
    '43128',
    '22',
    'Ctrl-C',
    'StrictHostKeyChecking',
    '127.0.0.1',
    'ssh://alice@server.example',
  ])
    assert.ok(result.stdout.includes(text));
  assert.equal(fs.existsSync(home), false);
});
test('busy local port fails before opening any SSH transport and never falls back', async (t) => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  let opens = 0;
  await assert.rejects(
    startBrowserForward(`ssh://host/${busy.address().port}`, {
      openTransport: async () => {
        opens++;
      },
    }),
    /Local browser port .* unavailable/,
  );
  assert.equal(opens, 0);
});
test('HTTP forwarding preserves exact Host/Origin and loopback bind, then frees the port on close', async (t) => {
  const dir = directory(t),
    socket = path.join(dir, 'remote'),
    port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.host, new URL(origin).host);
    assert.equal(req.headers.origin, origin);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('browser-ready');
  });
  await new Promise((resolve) => upstream.listen(socket, resolve));
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise((resolve) => upstream.close(resolve));
  });
  let closed = 0;
  const forward = await startBrowserForward(`ssh://alice@host/${port}`, {
    openTransport: async () => ({
      createConnection: () => net.connect(socket),
      close: async () => {
        closed++;
      },
    }),
  });
  t.after(() => forward.close());
  assert.equal(forward.url, `${origin}/`);
  const response = await fetch(forward.url, { headers: { Origin: origin } });
  assert.equal(await response.text(), 'browser-ready');
  await forward.close();
  await forward.close();
  assert.equal(closed, 1);
  const rebound = net.createServer();
  await new Promise((resolve) => rebound.listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => rebound.close(resolve));
});
test(
  'browser WebSocket upgrades pass through without Host or Origin rewriting',
  { skip: !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)) },
  async (t) => {
    const { WebSocketServer, WebSocket } = await import('../web/node_modules/ws/wrapper.mjs');
    const dir = directory(t),
      socket = path.join(dir, 'ws-remote'),
      port = await unusedPort(),
      origin = `http://127.0.0.1:${port}`;
    const remote = http.createServer();
    const wss = new WebSocketServer({
      server: remote,
      verifyClient: (info) =>
        info.origin === origin && info.req.headers.host === new URL(origin).host,
    });
    wss.on('connection', (ws) => ws.on('message', (data) => ws.send(data.toString())));
    await new Promise((resolve) => remote.listen(socket, resolve));
    t.after(() => {
      for (const peer of wss.clients) peer.terminate();
      wss.close();
      return new Promise((resolve) => remote.close(resolve));
    });
    const forward = await startBrowserForward(`ssh://host/${port}`, {
      openTransport: async () => ({
        createConnection: () => net.connect(socket),
        close: async () => {},
      }),
    });
    t.after(() => forward.close());
    const client = new WebSocket(`ws://127.0.0.1:${port}/browser`, { headers: { Origin: origin } });
    t.after(() => client.terminate());
    await once(client, 'open');
    const reply = once(client, 'message');
    client.send('browser-control');
    assert.equal((await reply)[0].toString(), 'browser-control');
    client.terminate();
    await forward.close();
  },
);

test('transport startup failure and cancellation release the local port', async () => {
  const port = await unusedPort();
  await assert.rejects(
    startBrowserForward(`ssh://host/${port}`, {
      openTransport: async () => {
        throw new Error('fixed failure');
      },
    }),
    /fixed failure/,
  );
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  await assert.rejects(
    startBrowserForward(`ssh://host/${port}`, {
      signal: controller.signal,
      openTransport: async () => {
        opened = true;
      },
    }),
  );
  assert.equal(opened, false);
  const rebound = net.createServer();
  await new Promise((resolve) => rebound.listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => rebound.close(resolve));
});
test('runtime listener errors settle the forward and close its transport without leaking details', async (t) => {
  const original = net.createServer;
  let listener,
    closes = 0;
  t.mock.method(net, 'createServer', (...args) => {
    listener = original(...args);
    return listener;
  });
  const port = await unusedPort();
  const forward = await startBrowserForward(`ssh://host/${port}`, {
    openTransport: async () => ({
      close: async () => {
        closes++;
      },
      createConnection: () => assert.fail('No browser connection expected.'),
    }),
  });
  listener.emit('error', new Error('synthetic-private-listener-detail'));
  await forward.closed;
  await forward.close();
  assert.equal(closes, 1);
  assert.equal(listener.listening, false);
});

test(
  'CLI prints a browser link after SSH is ready and cleans its forward on Ctrl-C',
  { timeout: 15000 },
  async (t) => {
    const dir = directory(t),
      bin = path.join(dir, 'bin'),
      socket = path.join(dir, 'remote'),
      log = path.join(dir, 'args');
    fs.mkdirSync(bin);
    const remote = http.createServer((_req, res) => res.end('remote-browser'));
    await new Promise((resolve) => remote.listen(socket, resolve));
    t.after(() => {
      remote.closeAllConnections();
      return new Promise((resolve) => remote.close(resolve));
    });
    fs.writeFileSync(
      path.join(bin, 'ssh'),
      `#!${process.execPath}
import net from 'node:net'; import fs from 'node:fs';
const args = process.argv.slice(2); fs.writeFileSync(process.env.FORWARD_TEST_LOG, JSON.stringify(args));
const local = /^(.*):127\\.0\\.0\\.1:[0-9]+$/.exec(args[args.indexOf('-L')+1])[1];
const sockets = new Set();
const server = net.createServer(socket => { const peer = net.connect(process.env.FORWARD_TEST_SOCKET); sockets.add(socket); sockets.add(peer); socket.pipe(peer).pipe(socket); socket.on('error',()=>peer.destroy()); peer.on('error',()=>socket.destroy()); });
server.listen(local);
if (process.env.FORWARD_TEST_DIE) setTimeout(() => process.exit(9), 500);
process.on('SIGTERM',()=> { for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0)); });
`,
      { mode: 0o755 },
    );
    const port = await unusedPort();
    const child = spawn(process.execPath, [cli, '--forward', `ssh://alice@host/${port}`], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        PIS_HOME: path.join(dir, 'unused-state'),
        FORWARD_TEST_LOG: log,
        FORWARD_TEST_SOCKET: socket,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    });
    let output = '';
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (output += bytes));
    await waitFor(() => output.includes(`http://127.0.0.1:${port}/`));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'remote-browser');
    assert.equal(fs.existsSync(path.join(dir, 'unused-state')), false);
    const args = JSON.parse(fs.readFileSync(log)),
      socketDir = path.dirname(args[args.indexOf('-L') + 1].split(':127.0.0.1:')[0]);
    const ended = once(child, 'exit');
    child.kill('SIGINT');
    assert.equal((await ended)[0], 0);
    assert.equal(fs.existsSync(socketDir), false);
    const failing = spawn(process.execPath, [cli, '--forward', `ssh://alice@host/${port}`], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        FORWARD_TEST_LOG: log,
        FORWARD_TEST_SOCKET: socket,
        FORWARD_TEST_DIE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (failing.exitCode === null) failing.kill('SIGTERM');
    });
    let failureOutput = '';
    failing.stdout.on('data', (bytes) => (failureOutput += bytes));
    failing.stderr.on('data', (bytes) => (failureOutput += bytes));
    const failureEnded = once(failing, 'exit');
    assert.equal((await failureEnded)[0], 1);
    assert.match(failureOutput, /No automatic reconnect/);
    const failureArgs = JSON.parse(fs.readFileSync(log));
    assert.equal(
      fs.existsSync(
        path.dirname(failureArgs[failureArgs.indexOf('-L') + 1].split(':127.0.0.1:')[0]),
      ),
      false,
    );
  },
);
