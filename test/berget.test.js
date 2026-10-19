import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { validate, completeConfig } from '../src/config.js';
import { saveApiProfile, readApiProfile, logoutApiProfile, apiProfileStatus, validateApiBaseUrl, publicHostLookup, promptApiProfile } from '../src/api-auth.js';
import { prepareProxy } from '../src/proxy-runtime.js';
import { podmanEnvironment, launchArgs } from '../src/container.js';

function terminal(answers) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.raw = false;
  input.setRawMode = value => { input.raw = value; };
  input.resume = () => { const answer = answers.shift(); if (answer !== undefined) setImmediate(() => input.emit('data', Buffer.from(`${answer}\r`))); };
  input.pause = () => {};
  let text = '';
  const output = { isTTY: true, write(value) { text += value; return true; } };
  return { input, output, text: () => text };
}

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-berget-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root);
  return { store, config };
}

test('Berget config, profile permissions, precedence, missing profile and logout', async t => {
  const { store, config } = await fixture(t);
  assert.equal(completeConfig({ credentials: { env: [], proxy: { provider: 'berget' } } }).credentials.proxy.keyEnv, 'BERGET_API_KEY');
  config.credentials.proxy = { provider: 'berget', profile: 'berget' };
  validate(config, { storage: store.root });
  assert.equal(completeConfig(config).credentials.proxy.profile, 'berget');
  assert.ok(!('keyEnv' in completeConfig(config).credentials.proxy));
  const invalid = structuredClone(config); invalid.credentials.proxy.keyEnv = 'BERGET_API_KEY';
  assert.throws(() => validate(invalid, { storage: store.root }), /Remove keyEnv/);
  const envKey = 'berget-env-should-not-win';
  const oldBergetKey = process.env.BERGET_API_KEY;
  process.env.BERGET_API_KEY = envKey;
  t.after(() => { if (oldBergetKey === undefined) delete process.env.BERGET_API_KEY; else process.env.BERGET_API_KEY = oldBergetKey; });
  await assert.rejects(prepareProxy(store, config), /missing/);
  const key = 'berget-test-secret-profile';
  await assert.rejects(saveApiProfile(store, 'berget', 'https://attacker.invalid/v1', key), /only permits/);
  await saveApiProfile(store, 'berget', 'https://api.berget.ai/v1', key);
  const file = path.join(store.root, 'auth/berget-api-key.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(readApiProfile(store, 'berget').key, key);
  assert.deepEqual(apiProfileStatus(store).find(p => p.provider === 'berget'), { provider: 'berget', profilePresent: true, environmentVariable: 'BERGET_API_KEY', environmentPresent: true, credentialPresent: true });
  const proxy = await prepareProxy(store, config);
  try {
    const models = JSON.parse(fs.readFileSync(path.join(proxy.directory, 'models.json')));
    assert.equal(models.providers.berget.api, 'openai-completions');
    assert.equal(models.providers.berget.baseUrl, 'http://127.0.0.1:43127/v1');
    assert.equal(models.providers.berget.models[0].id, 'google/gemma-4-31B-it');
    const args = launchArgs(store, config, ['pi'], { cwd: config.root, image: 'test', proxy }).args.join(' ');
    assert.ok(args.includes(`BERGET_API_KEY=${proxy.token}`));
    assert.ok(!args.includes(key));
    assert.ok(!args.includes(envKey));
    assert.ok(!JSON.stringify(podmanEnvironment(config)).includes(key));
    assert.ok(!Object.hasOwn(podmanEnvironment(config), 'BERGET_API_KEY'));
  } finally { await proxy.close(); }
  fs.chmodSync(file, 0o644);
  assert.throws(() => readApiProfile(store, 'berget'), /unsafe/);
  fs.chmodSync(file, 0o600);
  await logoutApiProfile(store, 'berget');
  assert.equal(readApiProfile(store, 'berget'), undefined);
});

test('interactive API-key login hides keys and cancellation writes no partial profile', async t => {
  const { store } = await fixture(t);
  const key = 'invisible-api-key-from-tty';
  const tty = terminal(['', key]);
  await promptApiProfile(store, 'berget', tty);
  assert.ok(!tty.text().includes(key));
  assert.equal(readApiProfile(store, 'berget').key, key);
  const cancelled = terminal(['\u0003']);
  const other = new Store(path.join(store.root, 'cancelled'));
  await assert.rejects(promptApiProfile(other, 'openai', cancelled), /cancelled/);
  assert.equal(readApiProfile(other, 'openai'), undefined);
  assert.equal(cancelled.input.raw, false);
});

test('Berget relay sends only chat completions to fixed path with host key and redacts streamed secrets', async t => {
  const { store, config } = await fixture(t);
  config.credentials.proxy = { provider: 'berget', keyEnv: 'BERGET_API_KEY', models: ['google/gemma-4-31B-it'] };
  validate(config, { storage: store.root });
  const key = 'berget-test-key-123456';
  const oldBergetKey = process.env.BERGET_API_KEY;
  process.env.BERGET_API_KEY = key;
  t.after(() => { if (oldBergetKey === undefined) delete process.env.BERGET_API_KEY; else process.env.BERGET_API_KEY = oldBergetKey; });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${key.slice(0, 6)}`);
    res.end(`${key.slice(6)}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const proxy = await prepareProxy(store, config, { upstream: `http://127.0.0.1:${server.address().port}` });
  t.after(() => proxy.close());
  const send = (route, model) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path.join(proxy.directory, 'api.sock'), path: route, method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json', cookie: 'stolen-cookie' } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject); request.end(JSON.stringify({ model, messages: [] }));
  });
  assert.equal((await send('/v1/responses', 'google/gemma-4-31B-it')).status, 403);
  assert.equal((await send('/v1/chat/completions', 'other')).status, 403);
  const result = await send('/v1/chat/completions', 'google/gemma-4-31B-it');
  assert.equal(result.status, 200);
  assert.ok(!result.text.includes(key));
  assert.ok(result.text.includes('[REDACTED]'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].auth, `Bearer ${key}`);
  assert.equal(requests[0].headers.cookie, undefined);
});

test('custom API profiles validate destinations, pinning rules, metadata, prefixed routes, and secret isolation', async t => {
  const { store, config } = await fixture(t);
  const baseUrl = 'https://example.com/tenant/v1';
  for (const bad of ['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?x=1', 'https://example.com/v1#frag', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://localhost/v1', 'https://example.com/tenant/../v1', 'https://example.com/api']) {
    assert.throws(() => validateApiBaseUrl(bad), undefined, bad);
  }
  assert.equal(validateApiBaseUrl(`${baseUrl}/`), baseUrl);
  await assert.rejects(publicHostLookup('localhost'), /private or unsafe/);
  const key = 'custom-profile-secret-abcdefgh';
  const catalog = [{ id: 'vendor/tool-model', contextWindow: 32768, maxTokens: 4096, images: true }];
  await saveApiProfile(store, 'custom', baseUrl, key, catalog);
  const saved = readApiProfile(store, 'custom');
  assert.deepEqual(saved.models[0], { id: 'vendor/tool-model', name: 'vendor/tool-model', reasoning: false, input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096 });
  config.credentials.proxy = { provider: 'custom', profile: 'custom' };
  validate(config, { storage: store.root });
  const invalid = structuredClone(config); delete invalid.credentials.proxy.profile;
  assert.throws(() => validate(invalid, { storage: store.root }), /requires credentials.proxy.profile/);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const proxy = await prepareProxy(store, config, { upstream: `http://127.0.0.1:${server.address().port}` });
  try {
    const overlay = JSON.parse(fs.readFileSync(path.join(proxy.directory, 'models.json')));
    assert.equal(overlay.providers.custom.api, 'openai-completions');
    assert.equal(overlay.providers.custom.models[0].contextWindow, 32768);
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ socketPath: path.join(proxy.directory, 'api.sock'), path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json', cookie: 'untrusted' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      request.on('error', reject); request.end(JSON.stringify({ model: 'vendor/tool-model', messages: [] }));
    });
    assert.equal(response, 200);
    assert.deepEqual(requests, [{ url: '/tenant/v1/chat/completions', authorization: `Bearer ${key}`, cookie: undefined }]);
    assert.ok(!JSON.stringify(launchArgs(store, config, ['pi'], { cwd: config.root, image: 'test', proxy }).args).includes(key));
  } finally { await proxy.close(); }
});
