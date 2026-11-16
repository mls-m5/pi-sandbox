import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';
import { validate, completeConfig } from '../src/config.js';
import { PROJECT_SCHEMA } from '../src/config-schema.js';
import { API_PRESETS, validateOllamaBaseUrl, validateApiBaseUrl, saveApiProfile, readApiProfile, promptApiProfile, apiProfileStatus, logoutApiProfile } from '../src/api-auth.js';
import { prepareProxy } from '../src/proxy-runtime.js';
import { startOpenAIProxy } from '../src/proxy.js';
import { launchArgs } from '../src/container.js';
async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-ollama-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root); const store = new Store(path.join(base, 'store')), config = await store.register(root);
  config.credentials = { env: [], proxy: { provider: 'ollama', models: [] } }; return { base, root, store, config };
}
const models = [{ id: 'qwen2.5-coder:7b', contextWindow: 8192, maxTokens: 2048, images: false, reasoning: false }];
function terminal(answers) {
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = () => {}; input.pause = () => {};
  input.resume = () => { const answer = answers.shift(); if (answer !== undefined) setImmediate(() => input.emit('data', Buffer.from(answer + '\r'))); };
  let text = ''; const output = { isTTY: true, write(chunk) { text += chunk; return true; } }; return { input, output, text: () => text };
}
test('Ollama URLs require canonical literal loopback HTTP and never weaken public custom validation', () => {
  assert.equal(validateOllamaBaseUrl('http://127.0.0.1:11434/v1/'), API_PRESETS.ollama.url);
  assert.equal(validateOllamaBaseUrl('http://[::1]:11434/v1'), 'http://[::1]:11434/v1');
  assert.equal(validateOllamaBaseUrl('http://127.0.0.1:80/v1'), 'http://127.0.0.1/v1');
  for (const url of ['http://localhost:11434/v1', 'http://192.168.1.2:11434/v1', 'http://169.254.169.254/v1', 'https://example.com/v1', 'http://0.0.0.0:11434/v1', 'http://127.1:11434/v1', 'http://2130706433:11434/v1', 'http://127.0.0.1:11434/api/chat', 'http://127.0.0.1:11434/a/../v1', 'http://127.0.0.1:11434/v1?x=y', 'http://user:key@127.0.0.1:11434/v1', 'http://127.0.0.1:65536/v1', 'http://127.0.0.1:11434/v1\n', 'http://[::ffff:127.0.0.1]:11434/v1']) assert.throws(() => validateOllamaBaseUrl(url), undefined, url);
  for (const url of [API_PRESETS.ollama.url, 'https://127.0.0.1/v1', 'https://localhost/v1']) assert.throws(() => validateApiBaseUrl(url));
});
test('keyless Ollama login saves only private local setup/catalogue, preserves other logins and supports logout', async t => {
  const { store, config } = await fixture(t); validate(config, { storage: store.root });
  assert.equal(parse(['--login', 'ollama']).target, 'ollama');
  assert.ok(PROJECT_SCHEMA.properties.credentials.properties.proxy.properties.provider.enum.includes('ollama'));
  assert.equal(completeConfig({ credentials: config.credentials }).credentials.proxy.provider, 'ollama');
  await saveApiProfile(store, 'openai', 'https://api.openai.com/v1', 'fake-other-host-key');
  const old = fs.readFileSync(path.join(store.root, 'auth/openai-api-key.json'), 'utf8');
  const tty = terminal(['', 'y', models[0].id, '8192', '2048', 'n', 'n']); await promptApiProfile(store, 'ollama', tty);
  assert.ok(!tty.text().includes('API key (hidden)'));
  const record = readApiProfile(store, 'ollama'); assert.equal(record.auth, 'none'); assert.equal(Object.hasOwn(record, 'key'), false); assert.equal(record.models[0].id, models[0].id);
  const file = path.join(store.root, 'auth/ollama-local.json'); assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(apiProfileStatus(store).find(row => row.provider === 'ollama'), { provider: 'ollama', profilePresent: true, credentialPresent: false });
  await assert.rejects(saveApiProfile(store, 'ollama', API_PRESETS.ollama.url, 'must-not-store-a-key', models));
  fs.chmodSync(file, 0o644); assert.throws(() => readApiProfile(store, 'ollama')); fs.chmodSync(file, 0o600);
  for (const malicious of [{ ...record, url: 'http://192.168.1.2:11434/v1' }, { ...record, key: 'must-not-read-or-forward' }, { ...record, auth: 'bearer' }]) { fs.writeFileSync(file, JSON.stringify(malicious)); assert.throws(() => readApiProfile(store, 'ollama')); } fs.writeFileSync(file, JSON.stringify(record));
  await logoutApiProfile(store, 'ollama'); assert.equal(readApiProfile(store, 'ollama'), undefined); assert.equal(fs.readFileSync(path.join(store.root, 'auth/openai-api-key.json'), 'utf8'), old);
});
test('CLI reports local profile presence without inventing credentials, connecting or changing project defaults', async t => {
  const { store, config, root, base } = await fixture(t); store.write(config);
  await saveApiProfile(store, 'ollama', API_PRESETS.ollama.url, undefined, models);
  const invoke = args => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: base, PIS_HOME: store.root }, encoding: 'utf8' });
  const shown = invoke(['--show']); assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).credentialSource, { kind: 'host-local-model', provider: 'ollama', present: true });
  assert.ok(!shown.stdout.includes(API_PRESETS.ollama.url));
  const status = invoke(['--login-status']); assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).find(row => row.provider === 'ollama'), { provider: 'ollama', profilePresent: true, credentialPresent: false });
  const result = invoke(['--logout', 'ollama']); assert.equal(result.status, 0); assert.equal(readApiProfile(store, 'ollama'), undefined);
  assert.equal(store.load(config.id).credentials.proxy.provider, 'ollama', 'Logout must not silently select a different provider.');
});

test('production Ollama proxy uses only local chat with a capability, no upstream credentials or startup inference', async t => {
  const { store, config, root } = await fixture(t); let forwarded = 0, redirect = false;
  const upstream = http.createServer((req, res) => {
    forwarded++;
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['x-api-key'], undefined);
    req.resume(); if (redirect) { res.writeHead(302, { location: 'http://example.invalid/private' }); res.end('MUST_NOT_LEAK'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const url = `http://127.0.0.1:${upstream.address().port}/v1`; await saveApiProfile(store, 'ollama', url, undefined, models);
  const proxy = await prepareProxy(store, config); t.after(() => proxy.close()); assert.equal(forwarded, 0);
  const originalRequest = http.request; t.after(() => { http.request = originalRequest; });
  http.request = (...args) => { if (args[0] instanceof URL) { assert.notEqual(args[1].agent, http.globalAgent); assert.deepEqual(args[1].agent.options.proxyEnv, {}); } return originalRequest(...args); };
  const overlay = JSON.parse(fs.readFileSync(path.join(proxy.directory, 'models.json'))).providers.ollama;
  assert.equal(overlay.baseUrl, 'http://127.0.0.1:43127/v1'); assert.equal(overlay.apiKey, proxy.token); assert.equal(overlay.models[0].compat.maxTokensField, 'max_tokens'); assert.equal(overlay.models[0].compat.supportsDeveloperRole, false);
  const args = launchArgs(store, config, ['pi'], { cwd: root, image: 'test', proxy }).args;
  assert.ok(!args.some(value => value.includes(url))); assert.ok(!args.includes('--network=host')); assert.ok(args.some(value => value.includes('PIS_PROXY_PROVIDER=ollama')));
  const request = (route = '/v1/chat/completions', id = models[0].id, token = proxy.token, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(proxy.directory, 'api.sock'), path: route, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', cookie: 'never-forward', 'x-api-key': 'never-forward' } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text })); });
    req.on('error', reject); req.end(JSON.stringify({ model: id, messages: [], stream: true }));
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request('/v1/chat/completions', 'other-model')).status, 403);
  assert.equal((await request('/v1/chat/completions', models[0].id, 'wrong')).status, 401);
  for (const route of ['/v1/models', '/api/tags', '/api/pull', '/api/delete', '/v1/responses', '/v1/chat/completions?url=http://example.invalid']) assert.equal((await request(route)).status, 403);
  assert.equal((await request('/v1/models', models[0].id, proxy.token, 'GET')).status, 403); assert.equal(forwarded, 1);
  redirect = true; const response = await request(); assert.equal(response.status, 502); assert.ok(!response.text.includes('MUST_NOT_LEAK')); assert.equal(forwarded, 2);
});
test('Ollama setup refuses missing profiles, arbitrary transport/DNS overrides and host credentials', async t => {
  const { store, config, base } = await fixture(t); await assert.rejects(prepareProxy(store, config), /missing/);
  const defaults = { provider: 'ollama', socketPath: path.join(base, 'unused.sock'), upstreamBaseUrl: API_PRESETS.ollama.url, models: models.map(model => model.id) };
  for (const override of [{ models: [] }, { apiKey: 'fake-key-must-not-forward' }, { upstreamBaseUrl: 'http://192.168.1.2:11434/v1' }, { upstream: 'http://127.0.0.1:12345' }, { lookup() {} }, { getCredentials() {} }]) await assert.rejects(startOpenAIProxy({ ...defaults, ...override }));
  await saveApiProfile(store, 'ollama', API_PRESETS.ollama.url, undefined, models); config.credentials.proxy.models = ['unconfigured']; await assert.rejects(prepareProxy(store, config), /configured/);
});
