import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { serverAddress } from '../web/server-address.js';
import { openServerTransport } from '../web/ssh-transport.js';
import {
  readAgentProfile,
  saveAgentProfile,
  readDefaultServer,
  saveDefaultServer,
  identifyAgent,
} from '../web/agent-profile.js';
import { randomKey, hashPassword } from '../web/common.js';
import { pairAgent } from '../web/pairing-client.js';
import { parseAgentOptions } from '../web/agent-cli.js';
import { shellQuote } from '../src/extensions.js';
import { waitFor } from './fixtures/transport.js';

function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-test-ssh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('SSH address defaults and overrides are canonical, bounded and never shell syntax', () => {
  assert.deepEqual(serverAddress('ssh://192.0.2.1'), {
    address: 'ssh://192.0.2.1',
    origin: 'http://127.0.0.1:43128',
    kind: 'ssh',
    host: '192.0.2.1',
    user: undefined,
    sshPort: 22,
    serverPort: 43128,
  });
  assert.equal(
    serverAddress('ssh://alice@host.example:22/43128').address,
    'ssh://alice@host.example',
  );
  const other = serverAddress('ssh://alice@host.example:2222/43129');
  assert.equal(other.origin, 'http://127.0.0.1:43129');
  assert.equal(other.sshPort, 2222);
  assert.equal(serverAddress('ssh://[2001:db8::1]').host, '2001:db8::1');
  assert.equal(serverAddress('http://127.0.0.1:43128').kind, 'local');
  for (const value of [
    'http://192.0.2.1:43128',
    'https://host.example',
    'ssh://alice:password@host',
    'ssh://-host',
    'ssh://host/0',
    'ssh://host/65536',
    'ssh://host/43128/extra',
    'ssh://host:0',
    'ssh://host:65536',
    'ssh://host?x=1',
    'ssh://host#part',
    'ssh://user%40x@host',
    'ssh://host;touch',
    'ssh://host\\other',
    'ssh://host\n',
    'ssh://-oProxyCommand@host',
  ])
    assert.throws(() => serverAddress(value), /Invalid server address/);
});
test('CLI accepts SSH defaults and overrides without starting a tunnel to save a preference', (t) => {
  const directory = root(t);
  const address = 'ssh://alice@host.example';
  assert.equal(parseAgentOptions(['--set-server', address]).server, address);
  assert.equal(parseAgentOptions(['--server', address]).server, address);
  const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--connect', '--set-server', address], {
    env: { PATH: process.env.PATH, HOME: directory, PIS_HOME: directory },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readDefaultServer(directory), address);
  const help = spawnSync(process.execPath, [cli, '--connect', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /43128/);
  assert.match(help.stdout, /port 22/);
  assert.match(help.stdout, /StrictHostKeyChecking/);
  assert.match(help.stdout, /ssh:\/\/alice@server.example/);
});

test(
  'bare interactive connect asks for and saves a missing server address before tunnel startup',
  { skip: spawnSync('script', ['--version'], { stdio: 'ignore' }).status !== 0, timeout: 10000 },
  async (t) => {
    const directory = root(t),
      bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}\nprocess.exit(1);\n`, {
      mode: 0o755,
    });
    const command = [
      process.execPath,
      fileURLToPath(new URL('../bin/pis.js', import.meta.url)),
      '--connect',
      '--dummy',
    ]
      .map(shellQuote)
      .join(' ');
    const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory, PIS_HOME: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });
    let output = '';
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (output += bytes));
    const ended = once(child, 'exit');
    await waitFor(() => output.includes('Serveradress'));
    child.stdin.write('ssh://alice@host.example\r');
    assert.equal((await ended)[0], 1, 'The fake SSH refuses; no runtime or enrollment starts.');
    assert.equal(readDefaultServer(directory), 'ssh://alice@host.example');
    assert.equal(readAgentProfile(directory, 'dummy'), undefined);
  },
);

test('private preference and profile persist SSH destination, never temporary forwarding paths', async (t) => {
  const dir = root(t);
  const address = 'ssh://alice@host.example';
  await saveDefaultServer(dir, address);
  assert.equal(readDefaultServer(dir), address);
  const profile = {
    version: 1,
    origin: address,
    token: randomKey(),
    agentId: 'test',
    kind: 'dummy',
    projectId: null,
  };
  await saveAgentProfile(dir, 'ssh-test', profile);
  assert.deepEqual(readAgentProfile(dir, 'ssh-test'), profile);
  await assert.rejects(saveDefaultServer(dir, 'ssh://user:private-secret@host'));
  assert.equal(readDefaultServer(dir), address);
});
test('SSH startup failure and abort are bounded, redact stderr and do not retry', async () => {
  let calls = 0;
  await assert.rejects(
    openServerTransport('ssh://host', {
      spawnImpl: () => {
        calls++;
        const child = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('error', new Error('synthetic-private-detail')));
        return child;
      },
    }),
    (error) => {
      assert.ok(!error.message.includes('synthetic-private-detail'));
      return true;
    },
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    openServerTransport('ssh://host', {
      signal: controller.signal,
      spawnImpl: () => {
        calls++;
      },
    }),
  );
  assert.equal(calls, 1);
});

test('SSH timeout and cancellation terminate only the owned process and remove its socket directory', async () => {
  for (const cause of ['timeout', 'cancel']) {
    const controller = new AbortController();
    let args,
      calls = 0,
      kills = [];
    await assert.rejects(
      openServerTransport('ssh://host', {
        timeoutMs: 25,
        signal: controller.signal,
        spawnImpl: (_command, values) => {
          calls++;
          args = values;
          const child = new EventEmitter();
          child.kill = (signal) => {
            kills.push(signal);
            queueMicrotask(() => child.emit('exit', 0));
          };
          if (cause === 'cancel') queueMicrotask(() => controller.abort());
          return child;
        },
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(kills, ['SIGTERM']);
    const socket = args[args.indexOf('-L') + 1].split(':127.0.0.1:')[0];
    assert.equal(fs.existsSync(path.dirname(socket)), false);
  }
});

// Fake only the ssh executable: real private Unix forwarding sockets and HTTP/WS
// still exercise origin/Host checks, token paths, framing and connector lifecycle.
function fakeSsh(t, directory, logs) {
  const file = path.join(directory, 'fake-ssh.mjs');
  fs.writeFileSync(
    file,
    `import net from 'node:net'; import fs from 'node:fs';
const args = process.argv.slice(2); const forwarding = args[args.indexOf('-L') + 1];
const match = /^(.*):127\\.0\\.0\\.1:([0-9]+)$/.exec(forwarding);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\\n');
const sockets = new Set();
const server = net.createServer(socket => {
  const target = net.connect(Number(match[2]), '127.0.0.1'); sockets.add(socket); sockets.add(target);
  socket.pipe(target).pipe(socket); socket.on('error', () => {}); target.on('error', () => socket.destroy());
  socket.on('close', () => { sockets.delete(socket); target.destroy(); }); target.on('close', () => sockets.delete(target));
});
server.listen(match[1]);
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
`,
  );
  const children = [];
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'ssh');
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
    const child = spawn(process.execPath, [file, ...args], {
      ...options,
      env: { ...process.env, FAKE_SSH_LOG: logs },
    });
    children.push(child);
    return child;
  };
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { spawnImpl, children, file };
}
const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
test(
  'private SSH forwarding keeps exact Host validation for enrollment, identity and WebSocket control',
  { skip: !installed, timeout: 15000 },
  async (t) => {
    const { startWebServer } = await import('../web/server.js');
    const { startDummyConnector } = await import('../web/connector.js');
    const directory = root(t),
      log = path.join(directory, 'args.jsonl'),
      password = 'ssh-test-password-only-strong';
    const server = await startWebServer({ port: 0, passwordHash: await hashPassword(password) });
    t.after(() => server.close());
    const fake = fakeSsh(t, directory, log);
    const destination = `ssh://alice@host.example:2222/${new URL(server.origin).port}`;
    const transport = await openServerTransport(destination, { spawnImpl: fake.spawnImpl });
    t.after(() => transport.close());
    assert.equal(transport.origin, server.origin);
    let request;
    const login = await fetch(`${server.origin}/login`, {
      method: 'POST',
      headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' },
      body: JSON.stringify({ password }),
    });
    const csrf = (await login.json()).csrf,
      cookie = login.headers.getSetCookie()[0].split(';')[0];
    const identity = await pairAgent(
      transport.origin,
      { clientId: crypto.randomUUID(), label: 'SSH dummy', kind: 'dummy', previousToken: null },
      {
        intervalMs: 1,
        fetchImpl: async (url, options) => {
          const response = await transport.fetchImpl(url, options);
          if (url.endsWith('/agent/requests')) {
            request = await response.clone().json();
            const approved = await fetch(`${server.origin}/pending-clients/approve`, {
              method: 'POST',
              headers: {
                Origin: server.origin,
                Cookie: cookie,
                'X-CSRF-Token': csrf,
                'Content-Type': 'application/json',
                'X-Pis-Web': '1',
              },
              body: JSON.stringify({ id: request.id, code: request.code }),
            });
            assert.equal(approved.status, 200);
          }
          return response;
        },
      },
    );
    assert.deepEqual(
      await identifyAgent(transport.origin, identity.token, { fetchImpl: transport.fetchImpl }),
      { id: identity.id, kind: 'dummy' },
    );
    const connector = await startDummyConnector({
      origin: transport.origin,
      token: identity.token,
      createConnection: transport.createConnection,
    });
    t.after(() => connector.close());
    await waitFor(() => server.roster()[0]?.online);
    const args = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    for (const option of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'ExitOnForwardFailure=yes',
      'ControlMaster=no',
      'ControlPath=none',
    ])
      assert.ok(args.includes(option));
    assert.equal(args[args.indexOf('-p') + 1], '2222');
    assert.equal(args[args.indexOf('-l') + 1], 'alice');
    assert.equal(args.at(-1), 'host.example');
    assert.equal(args.at(-2), '--');
    assert.ok(!JSON.stringify(args).includes(identity.token));
    assert.ok(!JSON.stringify(args).includes(request.token));
    const socket = args[args.indexOf('-L') + 1].split(':127.0.0.1:')[0],
      privateDir = path.dirname(socket);
    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
    const exited = once(fake.children[0], 'exit');
    fake.children[0].kill('SIGTERM');
    await exited;
    await waitFor(() => !server.roster()[0]?.online);
    assert.equal(connector.rpc.closed, false, 'Tunnel loss does not kill local agent work.');
    assert.equal(fake.children.length, 1, 'No tunnel replacement or enrollment replay.');
    await connector.close();
    await transport.close();
    await transport.close();
    assert.equal(fs.existsSync(privateDir), false);
    assert.notEqual(fake.children[0].exitCode, null);
    await assert.rejects(transport.fetchImpl(`${server.origin}/agent/identity`));
  },
);
test(
  'CLI reuses one tunnel through pairing and runtime, persists SSH address and closes it on exit',
  { skip: !installed, timeout: 15000 },
  async (t) => {
    const { startWebServer } = await import('../web/server.js');
    const { default: WS } = await import('../web/node_modules/ws/wrapper.mjs');
    const directory = root(t),
      log = path.join(directory, 'ssh-log');
    const server = await startWebServer({
      port: 0,
      passwordHash: await hashPassword('ssh-cli-test-password-only'),
    });
    t.after(() => server.close());
    const fake = fakeSsh(t, directory, log),
      bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'ssh'),
      `#!${process.execPath}\n${fs.readFileSync(fake.file, 'utf8')}`,
      { mode: 0o755 },
    );
    const address = `ssh://host.example/${new URL(server.origin).port}`;
    await saveDefaultServer(directory, address);
    const login = await fetch(`${server.origin}/login`, {
      method: 'POST',
      headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' },
      body: JSON.stringify({ password: 'ssh-cli-test-password-only' }),
    });
    const csrf = (await login.json()).csrf,
      cookie = login.headers.getSetCookie()[0].split(';')[0];
    const ws = new WS(`${server.origin.replace('http:', 'ws:')}/browser`, {
      headers: { Origin: server.origin, Cookie: cookie },
    });
    t.after(() => ws.terminate());
    let requests = [];
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes);
      if (message.type === 'pending_clients') requests = message.requests;
    });
    await once(ws, 'open');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--connect', 'ssh-cli', '--dummy'],
      {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: directory,
          PIS_HOME: directory,
          FAKE_SSH_LOG: log,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    });
    let output = '';
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (output += bytes));
    await waitFor(() => /kod ([0-9]{2})/.test(output) && requests.length === 1);
    const approved = await fetch(`${server.origin}/pending-clients/approve`, {
      method: 'POST',
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
        'X-Pis-Web': '1',
      },
      body: JSON.stringify({ id: requests[0].id, code: /kod ([0-9]{2})/.exec(output)[1] }),
    });
    assert.equal(approved.status, 200);
    await waitFor(() => server.roster()[0]?.online && output.includes('ansluten och registrerad'));
    const profile = readAgentProfile(directory, 'ssh-cli');
    assert.equal(profile.origin, address);
    assert.ok(!output.includes(profile.token));
    const calls = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1, 'Pairing, identity and runtime share one tunnel.');
    const socketPath = calls[0][calls[0].indexOf('-L') + 1].split(':127.0.0.1:')[0];
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    assert.ok(
      [0, 143].includes((await ended)[0]),
      'Normal wrapper termination may preserve SIGTERM exit status.',
    );
    assert.equal(fs.existsSync(path.dirname(socketPath)), false);
  },
);

test('local transport never starts SSH and remote transport cannot redirect requests to another origin', async (t) => {
  const local = await openServerTransport('http://127.0.0.1:43128', {
    spawnImpl: () => assert.fail('Must not spawn ssh.'),
  });
  assert.equal(local.fetchImpl, globalThis.fetch);
  await local.close();
  const directory = root(t),
    log = path.join(directory, 'log'),
    fake = fakeSsh(t, directory, log);
  const transport = await openServerTransport('ssh://host', { spawnImpl: fake.spawnImpl });
  t.after(() => transport.close());
  await assert.rejects(transport.fetchImpl('http://127.0.0.1:9999/agent/identity'));
  await assert.rejects(transport.fetchImpl(`${transport.origin}/agent/identity?token=not-allowed`));
  assert.equal(fake.children.length, 1);
});
