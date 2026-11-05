import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from '../src/cli.js';
import { defaults } from '../src/config.js';
import { piCommand, launchArgs, restartOptions } from '../src/container.js';
import { imageCommand } from '../src/runtime/image-entry.mjs';
import { startCodexAutoServer, validateCodexAuto } from '../src/codex-auto.js';
import codexAutoExtension, { AUTO_RESUME_NOTICE, isCodexQuotaError, requestCodexWait } from '../src/runtime/codex-auto.mjs';

const quota = used => ({ rate_limit: { primary_window: { used_percent: used, reset_after_seconds: 120 }, secondary_window: { used_percent: 10, reset_after_seconds: 86400 } } });
const errorMessage = (text = '429 Provider upstream returned status 429.') => ({ role: 'assistant', provider: 'openai-codex', model: 'test-codex', stopReason: 'error', errorMessage: text });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function service(t, options = {}) {
  const server = await startCodexAutoServer({}, options);
  t.after(() => server.close());
  return { ...server, socket: path.join(server.directory, 'wait.sock') };
}

function rawQuery(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Test timed out.')));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', data => { response += data; });
    socket.on('error', reject);
    socket.on('close', () => resolve(response));
  });
}

function mockExtension(request, socketPath = '/test/wait.sock') {
  const handlers = new Map(), commands = new Map(), sent = [], notices = [], statuses = [], scheduled = [];
  const state = { file: '/pis/home/.pi/agent/sessions/current.jsonl', leaf: 'failed-leaf', model: { provider: 'openai-codex', id: 'test-codex' }, idle: true, queued: false, input: undefined };
  const ctx = {
    mode: 'tui', hasUI: true,
    get model() { return state.model; },
    isIdle: () => state.idle, hasPendingMessages: () => state.queued,
    sessionManager: { getSessionFile: () => state.file, getLeafId: () => state.leaf },
    ui: {
      setStatus: (key, value) => statuses.push([key, value]),
      notify: (text, level) => notices.push([text, level]),
      onTerminalInput: fn => { state.input = fn; return () => { state.input = undefined; }; },
    },
  };
  const pi = {
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: text => sent.push(text),
  };
  codexAutoExtension(pi, { request, socketPath, defer: fn => scheduled.push(fn) });
  const emit = async (name, event = {}) => {
    const result = [];
    for (const handler of handlers.get(name) || []) result.push(await handler(event, ctx));
    return result;
  };
  const flush = async () => { for (const fn of scheduled.splice(0)) fn(); await tick(); };
  const fail = async () => { await emit('message_end', { message: errorMessage() }); await emit('agent_settled', { aborted: false }); };
  return { ctx, state, sent, notices, statuses, scheduled, emit, flush, fail, command: args => commands.get('codex-auto').handler(args, ctx) };
}

test('auto-wait is opt-in, supports an initial task/fresh session and requires terminal Codex Pi with extensions', () => {
  const config = defaults('abc12', '/work/project');
  const options = parse(['--auto-wait-codex', '--fresh', '--', 'Work on this task']);
  assert.equal(options.autoWaitCodex, true);
  assert.equal(parse([]).autoWaitCodex, undefined);
  validateCodexAuto(config, options, piCommand(options.args, true), { terminal: true });
  assert.equal(restartOptions(options).autoWaitCodex, true);
  assert.equal(parse(['--wait-codex', '--auto-wait-codex']).waitCodex, true);
  for (const args of [['--auto-wait-codex', '--auto-wait-codex'], ['--auto-wait-codex', '--bash'], ['--auto-wait-codex', '--build'], ['--auto-wait-codex', '--agent', 'claude']]) assert.throws(() => parse(args), /auto-wait-codex/);
  for (const args of [['-p', 'task'], ['--mode', 'json'], ['--mode=rpc'], ['--no-session'], ['--no-extensions'], ['-ne'], ['auth', 'check'], ['--help']]) {
    assert.throws(() => validateCodexAuto(config, { mode: 'pi' }, piCommand(args), { terminal: true }), /normal terminal Pi/);
  }
  assert.throws(() => validateCodexAuto(config, options, piCommand(), { terminal: false }), /normal terminal Pi/);
  assert.throws(() => validateCodexAuto(config, { mode: 'pi', stdio: 'inherit' }, piCommand(), { terminal: true }), /custom stdio/);
  assert.throws(() => validateCodexAuto({ ...config, agent: 'claude' }, options, piCommand(), { terminal: true }), /host proxy/);
  assert.throws(() => validateCodexAuto({ ...config, credentials: { env: [] } }, options, piCommand(), { terminal: true }), /host proxy/);
});

test('image-owned auto extension and read-only socket mount are absent unless explicitly enabled', () => {
  const env = { PIS_CODEX_AUTO_SOCKET: '/pis/codex-auto/wait.sock' };
  assert.deepEqual(imageCommand(['pi', '--continue'], [], env), ['/usr/local/bin/pis-pi-real', '--extension', '/opt/pis/codex-auto.mjs', '--continue']);
  assert.deepEqual(imageCommand(['pi', '--continue'], [], {}), ['/usr/local/bin/pis-pi-real', '--continue']);
  assert.deepEqual(imageCommand(['claude'], [], env), ['claude']);
  const config = defaults('abc12', '/work/project');
  const store = { projectDir: () => '/storage/projects/abc12' };
  const proxy = { directory: '/private/proxy', token: 'dummy', provider: 'openai-codex', baseUrl: 'http://127.0.0.1:43127/backend-api' };
  const args = launchArgs(store, config, ['pi'], { cwd: config.root, image: 'image', proxy, codexAuto: { directory: '/private/wait' }, selinux: true }).args;
  assert.ok(args.includes('PIS_CODEX_AUTO_SOCKET=/pis/codex-auto/wait.sock'));
  assert.ok(args.includes('/private/wait:/pis/codex-auto:ro,z'));
  const normal = launchArgs(store, config, ['pi'], { cwd: config.root, image: 'image', proxy }).args;
  assert.ok(!normal.some(arg => arg.includes('codex-auto')));
});

test('host requires exhausted usage followed by fresh positive usage; available quota never triggers auto-retry', async t => {
  let calls = 0;
  const available = await service(t, { usage: async () => { calls++; return quota(0); } });
  assert.equal(await requestCodexWait(available.socket), 'not-quota');
  assert.equal(calls, 1);
  const replies = [quota(100), quota(0)];
  let sleeps = 0, waiting = 0;
  const exhausted = await service(t, { usage: async () => replies.shift(), sleep: async () => { sleeps++; } });
  assert.equal(await requestCodexWait(exhausted.socket, { onWaiting: () => { waiting++; } }), 'ready');
  assert.equal(sleeps, 1);
  assert.ok(waiting > 0);
  assert.equal(replies.length, 0);
  assert.equal(fs.statSync(exhausted.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(exhausted.socket).mode & 0o777, 0o600);
  await exhausted.close(); await exhausted.close();
  assert.ok(!fs.existsSync(exhausted.directory));
});

test('host rejects arbitrary operations/data, invalid usage and auth errors without exposing secrets', async t => {
  let checks = 0;
  const server = await service(t, { usage: async () => { checks++; return quota(0); }, minCheckInterval: 0 });
  for (const request of [{ type: 'apt-packages', packages: ['git'] }, { type: 'codex-wait', command: 'untrusted' }, { type: 'codex-wait', session: '/host/secret' }]) {
    assert.equal(await rawQuery(server.socket, JSON.stringify(request) + '\n'), '{"state":"error"}\n');
  }
  assert.equal(await rawQuery(server.socket, 'x'.repeat(129)), '');
  assert.equal(checks, 0);
  const invalid = await service(t, { usage: async () => ({ rate_limit: {} }) });
  assert.equal(await requestCodexWait(invalid.socket), 'error');
  const auth = await service(t, { usage: async () => { throw new Error('private-token-do-not-expose'); } });
  assert.equal(await requestCodexWait(auth.socket), 'error');
});

test('one active host waiter and check throttling bound sandbox queries; disconnect aborts polling', async t => {
  let clock = 0, checks = 0, aborted = false;
  const asleep = deferred();
  const server = await service(t, {
    now: () => clock,
    usage: async () => { checks++; return quota(checks === 1 ? 100 : 0); },
    sleep: async (_ms, _value, { signal }) => {
      asleep.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    },
  });
  const controller = new AbortController();
  const first = requestCodexWait(server.socket, { signal: controller.signal });
  const cancelled = assert.rejects(first, /cancelled/);
  await asleep.promise;
  assert.equal(await requestCodexWait(server.socket), 'busy');
  controller.abort();
  await cancelled;
  for (let i = 0; i < 20 && !aborted; i++) await tick();
  assert.equal(aborted, true);
  assert.equal(await requestCodexWait(server.socket), 'busy');
  clock = 61_000;
  assert.equal(await requestCodexWait(server.socket), 'not-quota');
  assert.equal(checks, 2);
});

test('runtime recognizes only quota-like failed Codex assistant messages, not model claims, aborts or other providers', () => {
  assert.equal(isCodexQuotaError(errorMessage()), true);
  assert.equal(isCodexQuotaError(errorMessage('You have hit your ChatGPT usage limit.')), true);
  assert.equal(isCodexQuotaError(errorMessage('usage_limit_reached')), true);
  for (const message of [{ ...errorMessage(), stopReason: 'stop' }, { ...errorMessage(), stopReason: 'aborted' }, { ...errorMessage(), provider: 'openai' }, errorMessage('Provider connection failed.'), { role: 'toolResult', errorMessage: '429' }]) assert.equal(isCodexQuotaError(message), false);
});

test('same-session continuation is deferred until settlement and sent once, with later quota episodes supported', async () => {
  let checks = 0;
  const mock = mockExtension(async (_socket, { onWaiting }) => { checks++; onWaiting(); return 'ready'; });
  await mock.emit('session_start');
  await mock.fail();
  assert.equal(checks, 0); // Notification handler does not start a new turn.
  await mock.flush();
  assert.deepEqual(mock.sent, [AUTO_RESUME_NOTICE]);
  await mock.emit('agent_settled', { aborted: false }); await mock.flush();
  assert.equal(checks, 1);
  await mock.emit('before_agent_start'); mock.state.leaf = 'next-failed-leaf';
  await mock.fail(); await mock.flush();
  assert.deepEqual(mock.sent, [AUTO_RESUME_NOTICE, AUTO_RESUME_NOTICE]);
  assert.equal(mock.state.file, '/pis/home/.pi/agent/sessions/current.jsonl');
  assert.ok(mock.statuses.some(([, value]) => value?.includes('exhausted')));
  assert.deepEqual(await mock.emit('cache_warming_decision'), [{ action: 'stop' }]);
  await mock.emit('session_shutdown');
  assert.equal(mock.state.input, undefined);
});

test('transient limits, denied checks, successful runs and user-aborted runs never auto-continue', async () => {
  for (const result of ['not-quota', 'busy', 'error']) {
    const mock = mockExtension(async () => result);
    await mock.emit('session_start'); await mock.fail(); await mock.flush();
    assert.deepEqual(mock.sent, []);
    await mock.emit('session_shutdown');
  }
  const mock = mockExtension(async () => { throw new Error('Must not be called'); });
  await mock.emit('session_start');
  await mock.emit('message_end', { message: { ...errorMessage(), stopReason: 'stop' } });
  await mock.emit('agent_settled', { aborted: false }); await mock.flush();
  await mock.emit('message_end', { message: errorMessage() });
  await mock.emit('agent_settled', { aborted: true }); await mock.flush();
  assert.deepEqual(mock.sent, []);
  assert.equal(mock.scheduled.length, 0);
});

test('quota failure during interrupted overflow recovery is handled, but idle/manual/extension compaction is not', async () => {
  const mock = mockExtension(async () => 'ready');
  await mock.emit('session_start');
  for (const event of [
    { reason: 'manual', aborted: false, fromExtension: false },
    { reason: 'threshold', aborted: false, fromExtension: false },
    { reason: 'overflow', aborted: true, fromExtension: false },
    { reason: 'overflow', aborted: false, fromExtension: true },
  ]) {
    await mock.emit('session_compact_failed', { ...event, errorMessage: '429 usage limit reached' });
    await mock.emit('agent_settled', { aborted: false }); await mock.flush();
    assert.deepEqual(mock.sent, []);
  }
  await mock.emit('session_compact_failed', { reason: 'overflow', aborted: false, fromExtension: false, errorMessage: '429 usage limit reached' });
  await mock.emit('agent_settled', { aborted: false }); await mock.flush();
  assert.deepEqual(mock.sent, [AUTO_RESUME_NOTICE]);
  await mock.emit('before_agent_start');
  await mock.emit('message_end', { message: errorMessage() });
  await mock.emit('session_before_compact', { reason: 'threshold' });
  await mock.emit('session_compact_failed', { reason: 'threshold', aborted: false, fromExtension: false, errorMessage: '429' });
  await mock.emit('agent_settled', { aborted: false }); await mock.flush();
  assert.deepEqual(mock.sent, [AUTO_RESUME_NOTICE, AUTO_RESUME_NOTICE]);
});

test('new activity, session changes and shutdown cancel a pending wait even if a late ready response arrives', async () => {
  for (const event of ['input', 'before_agent_start', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact', 'model_select', 'thinking_level_select', 'user_bash', 'session_shutdown']) {
    const response = deferred(); let signal;
    const mock = mockExtension(async (_socket, options) => { signal = options.signal; return response.promise; });
    await mock.emit('session_start'); await mock.fail(); await mock.flush();
    await mock.emit(event);
    assert.equal(signal.aborted, true, event);
    response.resolve('ready'); await tick();
    assert.deepEqual(mock.sent, [], event);
  }
  const mock = mockExtension(async () => { assert.fail('Cancelled before deferred callback'); });
  await mock.emit('session_start'); await mock.fail();
  await mock.emit('input'); await mock.flush();
  assert.deepEqual(mock.sent, []);
});

test('Escape/Ctrl-C and /codex-auto off cancel; stale session/model/leaf or queued work also prevents resume', async () => {
  for (const key of ['\x1b', '\x03', '\x1b[27u', '\x1b[99;5u']) {
    const response = deferred(); let signal;
    const mock = mockExtension(async (_socket, options) => { signal = options.signal; return response.promise; });
    await mock.emit('session_start'); await mock.fail(); await mock.flush();
    assert.equal(mock.state.input(key), undefined); assert.equal(signal.aborted, true);
    response.resolve('ready'); await tick(); assert.deepEqual(mock.sent, []);
    await mock.emit('session_shutdown');
  }
  for (const change of [state => { state.file = 'other-session'; }, state => { state.leaf = 'other-branch'; }, state => { state.model = { provider: 'openai', id: 'other' }; }, state => { state.queued = true; }, state => { state.idle = false; }]) {
    const response = deferred();
    const mock = mockExtension(async () => response.promise);
    await mock.emit('session_start'); await mock.fail(); await mock.flush();
    change(mock.state); response.resolve('ready'); await tick();
    assert.deepEqual(mock.sent, []); await mock.emit('session_shutdown');
  }
  let checks = 0;
  const mock = mockExtension(async () => { checks++; return 'ready'; });
  await mock.emit('session_start'); await mock.command('off');
  await mock.fail(); await mock.flush(); assert.equal(checks, 0);
  assert.deepEqual(await mock.emit('cache_warming_decision'), [undefined]);
  await mock.command('on'); await mock.fail(); await mock.flush();
  assert.equal(checks, 1);
});

test('extension plus actual host socket waits and resumes the original session using only fake quota calls', async t => {
  const asleep = deferred(), release = deferred();
  let checks = 0;
  const server = await service(t, {
    usage: async () => quota(checks++ === 0 ? 100 : 0),
    sleep: async (_ms, _value, { signal }) => {
      asleep.resolve();
      await Promise.race([release.promise, new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    },
  });
  const mock = mockExtension(requestCodexWait, server.socket);
  t.after(() => mock.emit('session_shutdown'));
  await mock.emit('session_start'); await mock.fail(); await mock.flush();
  await asleep.promise;
  assert.equal(mock.sent.length, 0);
  release.resolve();
  const deadline = Date.now() + 2000;
  while (!mock.sent.length && Date.now() < deadline) await delay(5);
  assert.deepEqual(mock.sent, [AUTO_RESUME_NOTICE]);
  assert.equal(checks, 2);
});

test('client rejects malformed/unconfirmed protocol responses instead of resuming', async t => {
  const dir = fs.mkdtempSync('/tmp/pis-auto-protocol-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [index, payload] of ['{"state":"ready"}\n', '{"state":"ready","text":"untrusted"}\n', 'x'.repeat(129), '{"state":"unknown"}\n'].entries()) {
    const socket = path.join(dir, `${index}.sock`);
    const server = net.createServer(peer => { peer.on('error', () => {}); peer.on('data', () => peer.end(payload)); });
    await new Promise(resolve => server.listen(socket, resolve));
    try { await assert.rejects(requestCodexWait(socket), /Codex wait response/); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
});
