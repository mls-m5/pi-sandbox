import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { completeConfig, defaults, validate } from '../src/config.js';
import { parse } from '../src/cli.js';
import { imagePlan, launchArgs, interactiveOutput, podmanEnvironment } from '../src/container.js';
import {
  CLAUDE_VERSION, checkClaudeToken, claudeProxyLogger, claudeCommand, claudeHasSession, claudeNeedsLogin, claudeLoginEnvironment, claudeState, loginClaude,
  logoutClaudeToken, prepareClaudeProxy, readClaudeToken, removeLegacyClaudeCredentials, saveClaudeToken,
  startClaudeProxy, validateClaudeToken,
} from '../src/claude-code.js';

const TOKEN = `sk-ant-oat01-${'x'.repeat(40)}`;

function terminal() {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let text = ''; output.on('data', data => { text += data; });
  return { input, output, text: () => text };
}

async function fixture(t) {
  const base = fs.mkdtempSync('/tmp/pis-claude-test-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const binary = path.join(base, 'official-claude'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root);
  return { base, root, binary, store, config };
}

function unixRequest(socketPath, { method = 'POST', url = '/v1/messages?beta=true', headers = {}, body = '{"model":"m"}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function fakeAnthropic(t, respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); respond(req, res, body); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { upstream: `http://127.0.0.1:${server.address().port}`, seen };
}

test('Claude agent selection, --claude shorthand, image and placeholder-only launch arguments', () => {
  const pi = defaults('abc12', '/work/project');
  assert.equal(pi.agent, 'pi');
  assert.equal(completeConfig({ credentials: { env: [] } }).agent, 'pi');
  const config = { ...pi, agent: 'claude' };
  validate(config, { paths: false });
  assert.throws(() => validate({ ...config, agent: 'other' }, { paths: false }), /agent must/);
  assert.equal(parse(['--agent', 'claude', '--', '-p', 'hello']).agent, 'claude');
  assert.equal(parse(['--claude', '--', '--continue']).agent, 'claude');
  assert.equal(parse(['--claude', '--show']).action, 'show');
  assert.throws(() => parse(['--claude', '--agent', 'pi']), /Repeated option/);
  assert.equal(parse(['--login', 'claude']).target, 'claude');
  assert.equal(parse(['--login-claude']).action, 'login-claude');
  assert.throws(() => parse(['--project', 'abc12', '--login-claude']), /--project is not valid/);
  assert.throws(() => parse(['--agent', 'other']), /--agent must/);
  assert.throws(() => parse(['--claude', '--login-claude']), /--agent is only/);
  assert.deepEqual(claudeCommand(['--continue']), ['claude', '--continue']);
  const session = { hasSession: true };
  assert.deepEqual(claudeCommand([], session), ['claude', '--continue']);
  assert.deepEqual(claudeCommand(['hello'], session), ['claude', '--continue', 'hello']);
  assert.deepEqual(claudeCommand([], { hasSession: false }), ['claude']);
  assert.deepEqual(claudeCommand([], { ...session, fresh: true }), ['claude']);
  for (const explicit of [['--continue'], ['-c'], ['--resume'], ['-r', 'abc'], ['--resume=abc'], ['--session-id', 'x'], ['-p', 'hi'], ['--print'], ['--version'], ['--help'], ['auth', 'status'], ['mcp', 'list']])
    assert.deepEqual(claudeCommand(explicit, session), ['claude', ...explicit], explicit.join(' '));
  assert.equal(claudeNeedsLogin(['--version']), false);
  assert.equal(claudeNeedsLogin(['auth', 'status']), false);
  assert.equal(claudeNeedsLogin(['-p', 'hello']), true);
  assert.equal(interactiveOutput(['claude', '-p', 'hello']), false);
  assert.equal(interactiveOutput(['claude']), true);
  const image = imagePlan(config);
  assert.match(image.content, new RegExp(`@anthropic-ai/claude-code@${CLAUDE_VERSION.replaceAll('.', '\\.')}`));
  assert.match(image.content, /--ignore-scripts.*claude-code.*&& node .*install\.cjs/);
  assert.doesNotMatch(imagePlan(pi).content, /@anthropic-ai\/claude-code/);
  const store = { projectDir: () => '/storage/projects/abc12' };
  const bare = launchArgs(store, config, ['claude', '--version'], { cwd: config.root, image: image.image, tty: false, stdinIsTTY: true }).args;
  assert.ok(bare.includes('/storage/projects/abc12/claude-state:/pis/home:rw'));
  assert.ok(bare.includes('CLAUDE_CONFIG_DIR=/pis/home/.claude'));
  assert.ok(!bare.some(arg => /ANTHROPIC_|CLAUDE_CODE_OAUTH|PIS_PROXY|PIS_APT|OPENAI_API_KEY/.test(arg)));
  const proxy = { provider: 'claude', directory: '/tmp/pis-claude-x' };
  const { args } = launchArgs(store, config, ['claude', '-p', 'hi'], { cwd: config.root, image: image.image, proxy, tty: false, stdinIsTTY: true });
  for (const expected of ['ANTHROPIC_UNIX_SOCKET=/pis/proxy/claude.sock', 'CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder', 'ANTHROPIC_BASE_URL=http://pis-claude-proxy.invalid', '/tmp/pis-claude-x:/pis/proxy:ro'])
    assert.ok(args.includes(expected), expected);
  assert.ok(!args.includes('/pis/proxy/entry.mjs'));
  assert.ok(!args.some(arg => arg.includes(TOKEN) || /PIS_PROXY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/.test(arg)));
  // The Claude token proxy is never offered to Pi, and Pi's proxy never to Claude.
  assert.throws(() => launchArgs(store, { ...pi, credentials: { env: [], proxy: { provider: 'openai-codex' } } }, ['pi'], { cwd: pi.root, proxy }), /only available to Claude/);
  assert.throws(() => launchArgs(store, config, ['claude'], { cwd: config.root, proxy: { provider: 'openai-codex' } }), /does not use Pi/);
});

test('global token profile accepts only private subscription OAuth tokens', async t => {
  const { base, store } = await fixture(t);
  assert.equal(readClaudeToken(store), undefined);
  assert.throws(() => validateClaudeToken(`sk-ant-api03-${'x'.repeat(40)}`), /API key/);
  assert.throws(() => validateClaudeToken('short'), /Invalid Claude token/);
  assert.throws(() => validateClaudeToken(`other-${'x'.repeat(40)}`), /sk-ant-oat/);
  await assert.rejects(saveClaudeToken(store, `sk-ant-api03-${'x'.repeat(40)}`), /API key/);
  await saveClaudeToken(store, TOKEN);
  const file = path.join(store.root, 'auth', 'claude-oauth-token.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readClaudeToken(store), TOKEN);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readClaudeToken(store), error => /unsafe/.test(error.message) && !error.message.includes(TOKEN));
  fs.chmodSync(file, 0o600);
  const outside = path.join(base, 'outside.json'); fs.copyFileSync(file, outside); fs.chmodSync(outside, 0o600);
  fs.rmSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => readClaudeToken(store), /unsafe/);
  await assert.rejects(saveClaudeToken(store, TOKEN), /unsafe/);
  fs.rmSync(file); await saveClaudeToken(store, TOKEN);
  await logoutClaudeToken(store);
  assert.equal(readClaudeToken(store), undefined);
});

test('login runs isolated official setup-token, then saves the pasted token without echo', async t => {
  const { root, binary, store } = await fixture(t);
  const tty = terminal();
  const calls = [];
  const execute = async (program, args, options) => {
    calls.push({ program, args, options });
    assert.notEqual(options.cwd, root);
    assert.equal(options.cwd, options.env.CLAUDE_CONFIG_DIR);
    assert.ok(options.env.CLAUDE_CONFIG_DIR.startsWith(path.join(store.root, 'auth')));
    setImmediate(() => tty.input.write(`${TOKEN}\r`));
    return 0;
  };
  const pending = loginClaude(store, { binary, execute, input: tty.input, output: tty.output });
  tty.input.write('\r');
  await pending;
  assert.deepEqual(calls.map(call => [call.program, call.args]), [[binary, ['setup-token']]]);
  assert.equal(readClaudeToken(store), TOKEN);
  assert.ok(!tty.text().includes(TOKEN));
  assert.ok(!fs.readdirSync(path.join(store.root, 'auth')).some(name => name.startsWith('claude-login-')));
  // Failure of the official command keeps the previous login.
  const failing = terminal();
  const failed = loginClaude(store, { binary, execute: async () => 1, input: failing.input, output: failing.output });
  failing.input.write('y\r');
  await assert.rejects(failed, /setup-token failed/);
  assert.equal(readClaudeToken(store), TOKEN);
  // Skipping the command still requires a valid subscription token.
  const manual = terminal();
  const skipped = loginClaude(store, { binary, execute: async () => assert.fail('must not run'), input: manual.input, output: manual.output });
  manual.input.write('n\r'); setImmediate(() => manual.input.write(`sk-ant-api03-${'y'.repeat(40)}\r`));
  await assert.rejects(skipped, /API key/);
  const untrusted = path.join(root, 'claude'); fs.copyFileSync(binary, untrusted); fs.chmodSync(untrusted, 0o700);
  const sandboxBinary = terminal();
  await assert.rejects(loginClaude(store, { binary: untrusted, execute, input: sandboxBinary.input, output: sandboxBinary.output }), /sandbox-writable/);
  await assert.rejects(loginClaude(store, { binary, execute, input: new PassThrough(), output: new PassThrough() }), /interactively/);
});

test('host proxy injects the token only into fixed model routes and forwards Anthropic responses', async t => {
  const { base } = await fixture(t);
  const { upstream, seen } = await fakeAnthropic(t, (req, res, body) => {
    if (body.includes('overload')) {
      res.writeHead(529, { 'content-type': 'application/json', 'set-cookie': 'secret=1' });
      return res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    }
    if (body.includes('redirect')) { res.writeHead(307, { location: 'https://elsewhere.example/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed', 'request-id': 'req_1', 'set-cookie': 'secret=1' });
    res.end(`event: message_start\ndata: {"echo":"${req.headers.authorization}"}\n\n`);
  });
  const socketPath = path.join(base, 'claude.sock');
  const proxy = await startClaudeProxy({ socketPath, token: TOKEN, upstream, maxRequests: 4 });
  t.after(() => proxy.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const ok = await unixRequest(socketPath, { headers: {
    authorization: 'Bearer ssh-placeholder', 'x-api-key': 'sk-ant-api03-must-not-forward', cookie: 'c=1', host: 'evil.example',
    'anthropic-beta': 'claude-code-20250219,fine-grained-tool-streaming-2025-05-14', 'anthropic-version': '2023-06-01',
    'x-app': 'cli', 'user-agent': 'claude-cli/test', 'x-forwarded-for': '1.2.3.4', 'x-stainless-retry-count': '0',
  } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'text/event-stream');
  assert.equal(ok.headers['anthropic-ratelimit-unified-status'], 'allowed');
  assert.equal(ok.headers['request-id'], 'req_1');
  assert.equal(ok.headers['set-cookie'], undefined);
  assert.ok(!ok.body.includes(TOKEN) && ok.body.includes('[REDACTED]'));
  const forwarded = seen[0];
  assert.equal(forwarded.url, '/v1/messages?beta=true');
  assert.equal(forwarded.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(forwarded.headers['anthropic-beta'], 'claude-code-20250219,fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20');
  assert.equal(forwarded.headers['x-api-key'], undefined);
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers['x-forwarded-for'], undefined);
  assert.equal(forwarded.headers.host, upstream.slice('http://'.length));
  assert.equal(forwarded.headers['x-app'], 'cli');
  assert.equal(forwarded.headers['x-stainless-retry-count'], '0');
  assert.equal(forwarded.body, '{"model":"m"}');
  const overloaded = await unixRequest(socketPath, { url: '/v1/messages/count_tokens?beta=true', body: '{"overload":true}' });
  assert.equal(overloaded.status, 529);
  assert.match(overloaded.body, /overloaded_error/);
  assert.equal(overloaded.headers['set-cookie'], undefined);
  const redirected = await unixRequest(socketPath, { body: '{"redirect":true}' });
  assert.equal(redirected.status, 502);
  const before = seen.length;
  for (const request of [
    { url: '/api/oauth/profile', method: 'GET', body: '' }, { url: '/v1/messages?beta=true&x=1' }, { url: '/v1/complete' },
    { url: 'http://evil.example/v1/messages' }, { url: '/v1/messages/../files' }, { url: '/v1/messages', method: 'GET', body: '' },
  ]) assert.equal((await unixRequest(socketPath, request)).status, 404, request.url);
  assert.equal((await unixRequest(socketPath, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(seen.length, before);
  assert.ok(proxy.refused().includes('GET /api/oauth/profile'));
  await unixRequest(socketPath);
  const exhausted = await unixRequest(socketPath);
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.headers['x-should-retry'], 'false');
  assert.match(exhausted.body, /"type":"error"/);
});

test('prepared proxy requires a saved login and cleans up its private runtime directory', async t => {
  const { store } = await fixture(t);
  await assert.rejects(prepareClaudeProxy(store), /pis --login claude/);
  await saveClaudeToken(store, TOKEN);
  const proxy = await prepareClaudeProxy(store, { upstream: 'http://127.0.0.1:9' });
  assert.equal(fs.statSync(proxy.directory).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(proxy.directory, 'claude.sock')));
  assert.deepEqual(fs.readdirSync(proxy.directory), ['claude.sock']); // No token file is ever mounted.
  await proxy.close();
  assert.ok(!fs.existsSync(proxy.directory));
  await assert.rejects(startClaudeProxy({ socketPath: '/tmp/unused.sock', token: TOKEN, upstream: 'http://evil.example' }), /fixed HTTPS/);
});

test('legacy per-project real-token copies are removable without touching sessions', async t => {
  const { store, config } = await fixture(t);
  const state = claudeState(store, config.id);
  fs.writeFileSync(state.legacyCredential, '{"claudeAiOauth":{}}', { mode: 0o600 });
  fs.writeFileSync(path.join(state.config, 'history.jsonl'), 'keep');
  fs.mkdirSync(path.join(store.root, 'auth'), { mode: 0o700, recursive: true });
  const snapshot = path.join(store.root, 'auth', `claude-${config.id}.json`);
  fs.writeFileSync(snapshot, '{}', { mode: 0o600 });
  assert.equal(await removeLegacyClaudeCredentials(store, config.id), 2);
  assert.ok(!fs.existsSync(state.legacyCredential) && !fs.existsSync(snapshot));
  assert.ok(fs.existsSync(path.join(state.config, 'history.jsonl')));
});

test('CLI Claude launch uses the host proxy socket and never passes host credentials', async t => {
  const { base, store, config } = await fixture(t);
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
    const fs = require('fs');
    const args = process.argv.slice(2);
    if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
    else if (args[0] === 'run') {
      const volume = args.find(arg => arg.endsWith(':/pis/proxy:ro'));
      const socket = volume ? volume.split(':')[0] + '/claude.sock' : undefined;
      console.log(JSON.stringify({ args, socket: socket && fs.statSync(socket).isSocket(), hostKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) }));
    }
    else if (args[0] === 'container') process.exitCode = 1;
  `, { mode: 0o700 });
  const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: config.root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PIS_HOME: store.root, PIS_AUTO_PRUNE: '0', PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'test-only-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-only-token' },
  });
  const shown = invoke(['--claude', '--show']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).credentialSource, { kind: 'host-oauth-proxy', provider: 'claude', present: false });
  const version = invoke(['--claude', '--', '--version']);
  assert.equal(version.status, 0, version.stderr);
  const bare = JSON.parse(version.stdout);
  assert.equal(bare.hostKeyPresent, false);
  assert.deepEqual(bare.args.slice(-3), ['/opt/pis/image-entry.mjs', 'claude', '--version']);
  assert.ok(!bare.args.some(arg => /ANTHROPIC_UNIX_SOCKET|PIS_PROXY|PIS_APT/.test(arg)));
  const missing = invoke(['--claude', '--', '-p', 'not-a-real-request']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /pis --login claude/);
  await saveClaudeToken(store, TOKEN);
  const launched = invoke(['--claude', '--', '-p', 'not-sent-by-fake-podman']);
  assert.equal(launched.status, 0, launched.stderr);
  const result = JSON.parse(launched.stdout);
  assert.equal(result.socket, true);
  assert.equal(result.hostKeyPresent, false);
  assert.ok(result.args.includes('ANTHROPIC_UNIX_SOCKET=/pis/proxy/claude.sock'));
  assert.ok(!result.args.some(arg => arg.includes(TOKEN)));
  assert.ok(!fs.existsSync(result.args.find(arg => arg.endsWith(':/pis/proxy:ro')).split(':')[0]));
  assert.equal(store.load(config.id).agent, 'pi'); // CLI override is not persisted.
  const status = JSON.parse(invoke(['--login-status']).stdout);
  assert.deepEqual(status.find(entry => entry.provider === 'claude'), { provider: 'claude', profilePresent: true, credentialPresent: true });
  const loggedOut = invoke(['--logout', 'claude']);
  assert.equal(loggedOut.status, 0, loggedOut.stderr);
  assert.equal(readClaudeToken(store), undefined);
});

test('Claude environment selection never inherits API keys or alternative auth modes', () => {
  const env = claudeLoginEnvironment('/host-only/config', {
    PATH: '/usr/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_OAUTH_TOKEN: 'fake-token',
    ANTHROPIC_BASE_URL: 'https://untrusted.example', CLAUDE_CONFIG_DIR: '/untrusted', PIS_PROXY_TOKEN: 'fake-proxy', NODE_OPTIONS: '--require untrusted.js',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/test', CLAUDE_CONFIG_DIR: '/host-only/config', DISABLE_UPDATES: '1' });
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-key';
  try { assert.equal(podmanEnvironment(defaults('abc12', '/work/project')).ANTHROPIC_API_KEY, undefined); }
  finally { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; }
});

test('Claude continues by default only when this project already has a session for the working directory', async t => {
  const { store, config } = await fixture(t);
  const cwd = config.root;
  assert.equal(claudeHasSession(store, config.id, cwd), false);
  const sessions = path.join(claudeState(store, config.id).config, 'projects');
  const dir = path.join(sessions, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(claudeHasSession(store, config.id, cwd), false); // directory without a transcript
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), '{}\n');
  assert.equal(claudeHasSession(store, config.id, cwd), true);
  assert.equal(claudeHasSession(store, config.id, path.join(cwd, 'sub')), false);
});

test('launch removes a stale per-project Claude login only when a host login exists, keeping sessions', async t => {
  const { base, store, config } = await fixture(t);
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
    else if (args[0] === 'run') console.log(JSON.stringify({ args }));
    else if (args[0] === 'container') process.exitCode = 1;
  `, { mode: 0o700 });
  const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: config.root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PIS_HOME: store.root, PIS_AUTO_PRUNE: '0', PATH: `${bin}:${process.env.PATH}` },
  });
  const state = claudeState(store, config.id);
  const history = path.join(state.config, 'history.jsonl');
  const snapshot = path.join(store.root, 'auth', `claude-${config.id}.json`);
  const stale = () => { fs.writeFileSync(state.legacyCredential, '{"claudeAiOauth":{"accessToken":"old-expired"}}', { mode: 0o600 }); fs.mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 }); fs.writeFileSync(snapshot, '{}', { mode: 0o600 }); fs.writeFileSync(history, 'keep'); };

  // Without a saved host login the only working login might be the old one: keep it, warn.
  stale();
  const kept = invoke(['--claude', '--', '--version']);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(fs.existsSync(state.legacyCredential));
  assert.match(kept.stderr, /still in this sandbox state and no host login is saved/);

  await saveClaudeToken(store, TOKEN);
  const cleaned = invoke(['--claude', '--', '-p', 'x']);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.match(cleaned.stderr, /removed an old per-project Claude login/);
  assert.ok(!fs.existsSync(state.legacyCredential) && !fs.existsSync(snapshot));
  assert.equal(fs.readFileSync(history, 'utf8'), 'keep'); // sessions/history untouched
  assert.equal(readClaudeToken(store), TOKEN); // the global host token is untouched
  assert.ok(!cleaned.stderr.includes('old-expired') && !cleaned.stdout.includes('old-expired'));

  const quiet = invoke(['--claude', '--', '-p', 'x']);
  assert.doesNotMatch(quiet.stderr, /removed an old per-project/); // nothing left to remove
});

test('proxy diagnostics log status, request id and Anthropic error type without tokens, bodies or prompts', async t => {
  const { base, store } = await fixture(t);
  const { upstream } = await fakeAnthropic(t, (req, res, body) => {
    if (body.includes('badtoken')) {
      res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_401abc' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `OAuth access token is invalid ${TOKEN}` } }));
    }
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_ok1' });
    res.end('{"ok":true,"secret_prompt_echo":"private"}');
  });
  const events = [];
  const socketPath = path.join(base, 'diag.sock');
  const proxy = await startClaudeProxy({ socketPath, token: TOKEN, upstream, onEvent: line => events.push(line) });
  t.after(() => proxy.close());
  assert.equal((await unixRequest(socketPath, { body: '{"prompt":"my private prompt"}' })).status, 200);
  assert.equal((await unixRequest(socketPath, { body: '{"badtoken":true}' })).status, 401);
  assert.equal((await unixRequest(socketPath, { method: 'GET', url: '/api/oauth/profile?x=secret' })).status, 404);
  await new Promise(resolve => setTimeout(resolve, 50));
  const text = events.join('\n');
  assert.match(text, /POST \/v1\/messages -> 200 request-id=req_ok1/);
  assert.match(text, /POST \/v1\/messages -> 401 request-id=req_401abc error=authentication_error: OAuth access token is invalid \[REDACTED\]/);
  assert.match(text, /refused GET \/api\/oauth\/profile \(not a model route/);
  for (const secret of [TOKEN, 'my private prompt', 'secret_prompt_echo', 'x=secret']) assert.ok(!text.includes(secret), secret);
});

test('PIS_CLAUDE_PROXY_DEBUG writes a private log with token kind and login age, and is off by default', async t => {
  const { store } = await fixture(t);
  await saveClaudeToken(store, TOKEN);
  const log = path.join(store.root, 'claude-proxy.log');
  const quiet = await prepareClaudeProxy(store);
  await quiet.close();
  assert.equal(fs.existsSync(log), false);
  process.env.PIS_CLAUDE_PROXY_DEBUG = '1';
  t.after(() => { delete process.env.PIS_CLAUDE_PROXY_DEBUG; });
  const proxy = await prepareClaudeProxy(store);
  await proxy.close();
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /proxy started: token kind=oat01, length=53, login file saved 0 day\(s\) ago/);
  assert.match(text, /proxy closed after 0 forwarded request\(s\)/);
  assert.ok(!text.includes(TOKEN));
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(typeof claudeProxyLogger, 'function');
});

test('claude-check sends one token-count request and reports only status, request id and error type', async t => {
  const { store } = await fixture(t);
  await assert.rejects(checkClaudeToken(store), /No Claude login saved/);
  await saveClaudeToken(store, TOKEN);
  let mode = 'reject';
  const { upstream, seen } = await fakeAnthropic(t, (req, res) => {
    if (mode === 'reject') {
      res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_chk1' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad ${TOKEN}` } }));
    }
    if (mode === 'refused') { res.writeHead(400, { 'request-id': 'req_chk2' }); return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"x"}}'); }
    res.writeHead(200, { 'request-id': 'req_chk3' }); res.end('{"input_tokens":8}');
  });
  const rejected = await checkClaudeToken(store, { upstream });
  assert.deepEqual(rejected, { status: 401, requestId: 'req_chk1', errorType: 'authentication_error', tokenKind: 'oat01', tokenLength: TOKEN.length });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/messages/count_tokens?beta=true');
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.match(seen[0].headers['anthropic-beta'], /oauth-2025-04-20/);
  assert.ok(!JSON.stringify(rejected).includes(TOKEN));
  mode = 'refused';
  assert.equal((await checkClaudeToken(store, { upstream })).status, 400);
  mode = 'ok';
  assert.deepEqual(await checkClaudeToken(store, { upstream }), { status: 200, requestId: 'req_chk3', tokenKind: 'oat01', tokenLength: TOKEN.length });
  assert.equal(parse(['--claude-check']).action, 'claude-check');
  assert.throws(() => parse(['--project', 'abc12', '--claude-check']), /--project is not valid/);
});
