import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { imageCommand, initializeWebSettings } from '../src/runtime/image-entry.mjs';
import { usageProxyRequest } from '../src/runtime/fetch-bridge.mjs';
import { extensionManifest } from '../src/extensions.js';
import { imagePlan } from '../src/container.js';
import { defaults } from '../src/config.js';

const extensions = extensionManifest();

test('image startup loads installed package directories without remote install requests', () => {
  const command = imageCommand(['pi', '--continue', '-p', 'hello'], extensions);
  assert.deepEqual(command.slice(0, 3), ['/usr/local/bin/pis-pi-real', '--extension', extensions[0].path]);
  assert.ok(command.includes(extensions[1].path));
  assert.deepEqual(command.slice(-3), ['--continue', '-p', 'hello']);
  assert.deepEqual(imageCommand(['pi', '--no-extensions'], extensions), ['/usr/local/bin/pis-pi-real', '--no-extensions']);
  assert.deepEqual(imageCommand(['pi', '-ne', '-e', '/project/probe.ts'], extensions), ['/usr/local/bin/pis-pi-real', '-ne', '-e', '/project/probe.ts']);
  assert.deepEqual(imageCommand(['pi', 'install', 'npm:foo'], extensions), ['/usr/local/bin/pis-pi-real', 'install', 'npm:foo']);
  assert.deepEqual(imageCommand(['bash', '-i'], extensions), ['bash', '-i']);
});

test('web settings fill proxy-compatible defaults but preserve explicit preferences and invalid files', t => {
  const dir = fs.mkdtempSync('/tmp/pis-web-defaults-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { PI_CODING_AGENT_DIR: dir, PIS_PROXY_PROVIDER: 'openai-codex' };
  initializeWebSettings(extensions, env);
  const file = path.join(dir, 'web-search.json');
  let config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.openaiUseProviderBaseUrl, true);
  assert.deepEqual(config.openaiSearchProviders, ['openai-codex']);
  assert.equal(config.workflow, 'none');
  config.autoOpenBrowser = true; config.workflow = 'auto-summary';
  fs.writeFileSync(file, JSON.stringify(config));
  initializeWebSettings(extensions, env);
  assert.equal(JSON.parse(fs.readFileSync(file)).autoOpenBrowser, true);
  fs.writeFileSync(file, '{invalid-private-data');
  assert.throws(() => initializeWebSettings(extensions, env), error => !error.message.includes('private-data'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid-private-data');
});

test('usage compatibility redirects only the exact endpoint and authenticated dummy capability', () => {
  const env = { PIS_PROXY_PROVIDER: 'openai-codex', PIS_PROXY_TOKEN: 'synthetic-capability', PIS_PROXY_BASE_URL: 'http://127.0.0.1:43127/backend-api' };
  const request = usageProxyRequest('https://chatgpt.com/backend-api/wham/usage', { headers: { authorization: 'Bearer synthetic-capability', 'chatgpt-account-id': 'dummy-account' } }, env);
  assert.equal(request.url, 'http://127.0.0.1:43127/backend-api/wham/usage');
  assert.equal(request.headers.get('authorization'), 'Bearer synthetic-capability');
  assert.equal(request.headers.get('chatgpt-account-id'), null);
  for (const url of ['https://chatgpt.com/backend-api/wham/usage?other=1', 'https://attacker/backend-api/wham/usage', 'https://status.openai.com/api/v2/status.json']) assert.equal(usageProxyRequest(url, undefined, env), undefined);
  assert.throws(() => usageProxyRequest('https://chatgpt.com/backend-api/wham/usage', {}, env), /capability/);
});

test('image context contains only generated build files and install specs affect the fingerprint', () => {
  const config = defaults('abc12', '/work/project');
  const plan = imagePlan(config);
  assert.deepEqual(Object.keys(plan.files).sort(), ['Containerfile', 'extensions.json', 'fetch-bridge.mjs', 'image-entry.mjs', 'pi-launcher']);
  assert.match(plan.content, /NPM_CONFIG_IGNORE_SCRIPTS=true pi install 'npm:pi-usage-bar-focus@0\.5\.0'/);
  assert.ok(!Object.values(plan.files).join('').includes(config.root));
  config.extensions = [];
  const without = imagePlan(config);
  assert.notEqual(without.image, plan.image);
  assert.doesNotMatch(without.content, /pi install /);
});
