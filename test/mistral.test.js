import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';
import { completeConfig, validate } from '../src/config.js';
import { API_PRESETS, apiProfileStatus, promptApiProfile, readApiProfile, logoutApiProfile } from '../src/api-auth.js';
import { prepareProxy } from '../src/proxy-runtime.js';
import { launchArgs, podmanEnvironment } from '../src/container.js';

function terminal(answers) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => { const answer = answers.shift(); if (answer !== undefined) setImmediate(() => input.emit('data', Buffer.from(`${answer}\r`))); };
  input.pause = () => {};
  let text = '';
  const output = { isTTY: true, write(value) { text += value; return true; } };
  return { input, output, text: () => text };
}

test('Mistral host API-key login, proxy, model routes and logout', async t => {
  assert.equal(parse(['--login-mistral']).action, 'login-mistral');
  assert.equal(parse(['--logout-mistral']).action, 'logout-mistral');
  assert.throws(() => parse(['--login-mistral', '--project', 'abc12']));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-mistral-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(home, 'store'));
  const config = await store.register(root);
  config.credentials.proxy = { provider: 'mistral', profile: 'mistral', models: ['codestral-latest'] };
  validate(config, { storage: store.root });
  assert.equal(completeConfig({ credentials: { env: [], proxy: { provider: 'mistral' } } }).credentials.proxy.keyEnv, 'MISTRAL_API_KEY');
  assert.equal(API_PRESETS.mistral.url, 'https://api.mistral.ai/v1');
  const invalid = structuredClone(config); invalid.credentials.proxy.keyEnv = 'MISTRAL_API_KEY';
  assert.throws(() => validate(invalid, { storage: store.root }));
  const key = 'mistral-real-secret-only-on-host';
  const tty = terminal(['', key]);
  await promptApiProfile(store, 'mistral', tty);
  assert.ok(!tty.text().includes(key));
  assert.equal(readApiProfile(store, 'mistral').key, key);
  assert.equal(fs.statSync(path.join(store.root, 'auth/mistral-api-key.json')).mode & 0o777, 0o600);
  assert.equal(apiProfileStatus(store).find(p => p.provider === 'mistral').profilePresent, true);
  const previous = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = 'not-the-selected-key';
  t.after(() => { if (previous === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = previous; });
  let forwarded = 0;
  const upstream = http.createServer((req, res) => {
    forwarded++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.equal(req.headers['x-affinity'], undefined);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[]}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const proxy = await prepareProxy(store, config, { upstream: `http://127.0.0.1:${upstream.address().port}` });
  t.after(() => proxy.close());
  const model = JSON.parse(fs.readFileSync(path.join(proxy.directory, 'models.json'))).providers.mistral;
  assert.equal(model.baseUrl, 'http://127.0.0.1:43127'); // Pi appends /v1/chat/completions.
  assert.equal(JSON.parse(fs.readFileSync(path.join(proxy.directory, 'auth.json'))).mistral.key, proxy.token);
  const invocation = launchArgs(store, config, ['pi'], { cwd: root, image: 'test', proxy }).args.join(' ');
  assert.ok(invocation.includes(`MISTRAL_API_KEY=${proxy.token}`));
  assert.ok(!invocation.includes(key));
  assert.ok(!JSON.stringify(podmanEnvironment(config)).includes(key));
  assert.ok(!Object.hasOwn(podmanEnvironment(config), 'MISTRAL_API_KEY'));
  const request = (url, modelId = 'codestral-latest') => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(proxy.directory, 'api.sock'), path: url, method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json', 'x-affinity': 'untrusted' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end(JSON.stringify({ model: modelId, messages: [] }));
  });
  assert.equal((await request('/v1/chat/completions')).status, 200);
  assert.equal((await request('/v1/chat/completions', 'other')).status, 403);
  assert.equal((await request('/v1/responses')).status, 403);
  assert.equal((await request('/v1/models')).status, 403);
  assert.equal(forwarded, 1);
  await logoutApiProfile(store, 'mistral');
  assert.equal(readApiProfile(store, 'mistral'), undefined);
});
