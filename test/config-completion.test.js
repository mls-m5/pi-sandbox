import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { completeConfig, defaults, validate } from '../src/config.js';
import { DEFAULT_EXTENSIONS, extensionSource } from '../src/extensions.js';
import { Store } from '../src/store.js';

test('configuration completion adds source defaults, hints and contextual fields without changing choices', () => {
  const old = { version: 1, id: 'abc12', root: '/work/project', image: {}, credentials: { env: [], proxy: { provider: 'openai-codex' } } };
  const before = structuredClone(old);
  const config = completeConfig(old);
  assert.deepEqual(old, before);
  assert.deepEqual(config.extensions, DEFAULT_EXTENSIONS);
  assert.equal(config.$schema, './project.schema.json');
  assert.match(config.hints.credentials, /Codex|openai-codex/);
  assert.equal(config.credentials.proxy.maxRequests, 1000);
  assert.ok(!('keyEnv' in config.credentials.proxy));
  assert.equal(config.examples.credentials.openai.proxy.keyEnv, 'OPENAI_API_KEY');
  assert.deepEqual(completeConfig(config), config);
  const direct = completeConfig({ ...old, credentials: { env: ['SOME_API_KEY'] }, extensions: [] });
  assert.deepEqual(direct.extensions, []);
  assert.deepEqual(direct.credentials, { env: ['SOME_API_KEY'] });
  const api = completeConfig({ ...old, credentials: { proxy: { provider: 'openai', maxRequests: 12 } } });
  assert.equal(api.credentials.proxy.maxRequests, 12);
  assert.equal(api.credentials.proxy.keyEnv, 'OPENAI_API_KEY');
});

test('completion preserves invalid values for validation rather than silently replacing them', () => {
  const base = defaults('abc12', '/work/project');
  for (const candidate of [{ ...base, credentials: null }, { ...base, extensions: null }, { ...base, mounts: false }, { ...base, credentials: { env: [], proxy: {} } }, { ...base, unexpected: true }]) {
    assert.throws(() => validate(completeConfig(candidate), { paths: false }));
  }
});

test('extension install sources validate names, versions, duplicates, and shell injection', () => {
  assert.equal(extensionSource('npm:pi-web-access@0.40.0').path, '/opt/pis/agent/npm/node_modules/pi-web-access');
  assert.equal(extensionSource('npm:@beyona/pi-zai-usage@1.1.0').name, '@beyona/pi-zai-usage');
  assert.equal(extensionSource('npm:pi-web-access').version, undefined);
  for (const source of ['npm install pi-web-access', 'npm:foo;touch /tmp/pwn', 'npm:foo@x\nRUN evil', '/home/user/ext.ts', 'https://user:secret@host/ext', 'npm:foo@../path']) assert.throws(() => extensionSource(source));
  const base = defaults('abc12', '/work/project');
  base.extensions = ['npm:foo@1.0.0', 'npm:foo@2.0.0'];
  assert.throws(() => validate(base, { paths: false }), /Duplicate extension/);
});

test('selected project refresh and edit-save backfill defaults, emit schema, and format JSON atomically', async t => {
  const dir = fs.mkdtempSync('/tmp/pis-config-completion-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(dir, 'store'));
  const registered = await store.register(root);
  const legacy = structuredClone(registered);
  delete legacy.extensions; delete legacy.hints; delete legacy.$schema;
  legacy.credentials = { env: [], proxy: { provider: 'openai-codex' } };
  fs.writeFileSync(store.configPath(registered.id), JSON.stringify(legacy));
  const refreshed = await store.refresh(registered.id);
  assert.deepEqual(refreshed.extensions, DEFAULT_EXTENSIONS);
  assert.equal(refreshed.credentials.proxy.maxConcurrent, 4);
  assert.ok(!('keyEnv' in refreshed.credentials.proxy));
  assert.match(fs.readFileSync(store.configPath(registered.id), 'utf8'), /\n  "hints":/);
  assert.ok(fs.existsSync(path.join(store.projectDir(registered.id), 'project.schema.json')));
  const changed = structuredClone(refreshed);
  changed.extensions = [];
  delete changed.credentials.proxy.models;
  delete changed.hints;
  await store.save(changed, refreshed);
  const saved = store.load(registered.id);
  assert.deepEqual(saved.extensions, []);
  assert.deepEqual(saved.credentials.proxy.models, []);
  assert.ok(saved.hints);
  assert.equal(fs.statSync(store.configPath(registered.id)).mode & 0o777, 0o600);
});
