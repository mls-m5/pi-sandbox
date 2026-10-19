import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { validate } from '../src/config.js';
import { prepareProxy, PROXY_BASE_URL, CODEX_PROXY_BASE_URL } from '../src/proxy-runtime.js';
import { saveCodexCredential } from '../src/codex-auth.js';
import { fakeCodexCredential } from './fixtures/codex.js';
import { launchArgs, imagePlan } from '../src/container.js';

async function fixture(t) {
  const base = fs.mkdtempSync('/tmp/pis-runtime-test-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root);
  const agent = path.join(store.projectDir(config.id), 'state', '.pi', 'agent');
  fs.mkdirSync(agent, { recursive: true });
  const keyName = `PIS_TEST_PROXY_KEY_${config.id.toUpperCase()}`;
  config.credentials.proxy.keyEnv = keyName;
  process.env[keyName] = 'sk-host-secret-must-stay-outside';
  t.after(() => { delete process.env[keyName]; });
  return { base, root, store, config, agent, keyName };
}

test('new projects default to host proxy; schema disallows forwarding keys or changing upstream', async t => {
  const { store, config } = await fixture(t);
  assert.deepEqual(config.credentials.env, []);
  assert.equal(config.credentials.proxy.provider, 'openai');
  validate(config, { storage: store.root });
  for (const change of [p => { p.env = ['OPENAI_API_KEY']; }, p => { p.proxy.upstream = 'https://attacker'; }, p => { p.proxy.provider = 'other'; }, p => { p.proxy.maxRequests = 0; }, p => { p.proxy.maxConcurrent = 65; }, p => { p.proxy.keyEnv = '!print-secret'; }]) {
    const candidate = structuredClone(config); change(candidate.credentials);
    assert.throws(() => validate(candidate, { storage: store.root }));
  }
});

test('runtime overlays replace stale OpenAI auth and endpoints, without editing originals or leaking key', async t => {
  const { root, store, config, agent, keyName } = await fixture(t);
  const oldModels = { providers: { openai: { baseUrl: 'https://old', headers: { Authorization: process.env[keyName] }, apiKey: process.env[keyName] }, other: { baseUrl: 'https://other' } } };
  const oldAuth = { openai: { type: 'api_key', key: process.env[keyName] }, other: { type: 'api_key', key: 'other-key' } };
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify(oldModels));
  fs.writeFileSync(path.join(agent, 'auth.json'), JSON.stringify(oldAuth));
  const before = imagePlan(config).image;
  const proxy = await prepareProxy(store, config);
  const dir = proxy.directory;
  try {
    const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json')));
    assert.deepEqual(models.providers.openai, { baseUrl: PROXY_BASE_URL, apiKey: proxy.token });
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json')));
    assert.equal(auth.openai.key, proxy.token);
    assert.equal(auth.other.key, 'other-key');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, 'auth.json'))), oldAuth);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, 'models.json'))), oldModels);
    const invocation = launchArgs(store, config, ['pi', '--continue'], { cwd: root, image: 'test', proxy });
    assert.ok(invocation.args.includes(`OPENAI_API_KEY=${proxy.token}`));
    assert.ok(!invocation.args.includes(keyName));
    assert.ok(!JSON.stringify(invocation.args).includes(process.env[keyName]));
    assert.ok(invocation.args.includes(`${dir}:/pis/proxy:ro`));
    assert.ok(invocation.args.includes('/pis/proxy/entry.mjs'));
    for (const file of ['entry.mjs', 'models.json', 'auth.json']) assert.ok(!fs.readFileSync(path.join(dir, file), 'utf8').includes(process.env[keyName]));
    assert.equal(imagePlan(config).image, before);
  } finally { await proxy.close(); }
  assert.ok(!fs.existsSync(dir));
});

test('Codex snapshots and environment contain only synthetic credentials, never host OAuth tokens', async t => {
  const { root, store, config, agent } = await fixture(t);
  const credential = fakeCodexCredential();
  await saveCodexCredential(store, credential);
  config.credentials = { env: [], proxy: { provider: 'openai-codex' } };
  validate(config, { storage: store.root });
  const bad = structuredClone(config); bad.credentials.proxy.keyEnv = 'CODEX_TOKEN';
  assert.throws(() => validate(bad, { storage: store.root }), /remove keyEnv/);
  fs.writeFileSync(path.join(agent, 'auth.json'), JSON.stringify({ 'openai-codex': credential }));
  const proxy = await prepareProxy(store, config);
  try {
    const models = JSON.parse(fs.readFileSync(path.join(proxy.directory, 'models.json')));
    assert.equal(models.providers['openai-codex'].baseUrl, `${CODEX_PROXY_BASE_URL}/codex/responses`);
    const invocation = launchArgs(store, config, ['pi'], { cwd: root, image: 'test', proxy });
    assert.ok(invocation.args.includes('OPENAI_API_KEY='));
    assert.ok(invocation.args.includes(`PIS_PROXY_TOKEN=${proxy.token}`));
    for (const text of [JSON.stringify(invocation.args), ...['auth.json', 'models.json', 'entry.mjs'].map(file => fs.readFileSync(path.join(proxy.directory, file), 'utf8'))]) {
      assert.ok(!text.includes(credential.access));
      assert.ok(!text.includes(credential.refresh));
      assert.ok(!text.includes(credential.accountId));
    }
  } finally { await proxy.close(); }
});

test('proxy setup refuses missing host keys and never silently falls back to direct mode', async t => {
  const { store, config, keyName } = await fixture(t);
  delete process.env[keyName];
  await assert.rejects(prepareProxy(store, config), /Set .* on the host/);
  assert.throws(() => launchArgs(store, config, ['pi'], { cwd: config.root, image: 'test' }), /active host proxy/);
});

test('sandbox-controlled state cannot use symlinks or FIFOs to read host files or block startup', async t => {
  const { base, store, config, agent } = await fixture(t);
  const host = path.join(base, 'host.json'); fs.writeFileSync(host, '{"secret":"host-only"}');
  fs.symlinkSync(host, path.join(agent, 'models.json'));
  await assert.rejects(prepareProxy(store, config));
  fs.unlinkSync(path.join(agent, 'models.json'));
  assert.equal(spawnSync('mkfifo', [path.join(agent, 'models.json')]).status, 0);
  await assert.rejects(prepareProxy(store, config), /regular/);
  fs.unlinkSync(path.join(agent, 'models.json'));
  fs.rmSync(agent, { recursive: true });
  fs.symlinkSync(base, agent);
  await assert.rejects(prepareProxy(store, config), /symlink/);
});
