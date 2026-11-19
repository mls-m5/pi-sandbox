import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { imageCommand, initializeWebSettings, startupProgress } from '../src/runtime/image-entry.mjs';
import { usageProxyRequest } from '../src/runtime/fetch-bridge.mjs';
import { extensionManifest } from '../src/extensions.js';
import { imagePlan } from '../src/container.js';
import { defaults } from '../src/config.js';

const extensions = extensionManifest();

test('startup progress is opt-in, timed and absent from protocol output by default', () => {
  const lines = [];
  const write = text => lines.push(text);
  startupProgress('hidden', {}, write, 3000);
  startupProgress('invalid', { PIS_STARTUP_STARTED: 'bad' }, write, 3000);
  assert.deepEqual(lines, []);
  startupProgress('Container started', { PIS_STARTUP_STARTED: '1000' }, write, 3500);
  assert.deepEqual(lines, ['pis: [2.5s] Container started']);
});

test('image startup loads installed package directories without remote install requests', () => {
  const command = imageCommand(['pi', '--continue', '-p', 'hello'], extensions, {});
  assert.deepEqual(extensions.map(entry => entry.source), ['npm:pi-web-access@0.40.0', 'npm:pi-subagents@0.88.1']);
  assert.deepEqual(command.slice(0, 7), ['/usr/local/bin/pis-pi-real', '--extension', extensions[0].path, '--extension', extensions[1].path, '--skill', `${extensions[1].path}/skills`]);
  assert.equal(command.filter(value => value === '--extension').length, 2);
  assert.deepEqual(command.slice(-3), ['--continue', '-p', 'hello']);
  assert.deepEqual(imageCommand(['pi', '--continue'], extensions, { PIS_APT_SOCKET: '/pis/apt/request.sock' }), ['/usr/local/bin/pis-pi-real', '--extension', extensions[0].path, '--extension', extensions[1].path, '--skill', `${extensions[1].path}/skills`, '--extension', '/opt/pis/request-apt.mjs', '--continue']);
  assert.deepEqual(imageCommand(['pi', '--no-extensions'], extensions, { PIS_APT_SOCKET: '/pis/apt/request.sock' }), ['/usr/local/bin/pis-pi-real', '--no-extensions']);
  assert.deepEqual(imageCommand(['pi', '-ne', '-e', '/project/probe.ts'], extensions, {}), ['/usr/local/bin/pis-pi-real', '-ne', '-e', '/project/probe.ts']);
  assert.deepEqual(imageCommand(['pi', '--no-skills', '--'], extensions, {}), ['/usr/local/bin/pis-pi-real', '--extension', extensions[0].path, '--extension', extensions[1].path, '--no-skills', '--']);
  assert.deepEqual(imageCommand(['pi', '-ns', 'prompt'], extensions, {}), ['/usr/local/bin/pis-pi-real', '--extension', extensions[0].path, '--extension', extensions[1].path, '-ns', 'prompt']);
  assert.deepEqual(imageCommand(['pi', '--', '--no-skills'], extensions, {}), ['/usr/local/bin/pis-pi-real', '--extension', extensions[0].path, '--extension', extensions[1].path, '--skill', `${extensions[1].path}/skills`, '--', '--no-skills']);
  assert.deepEqual(imageCommand(['pi', 'install', 'npm:foo'], extensions, {}), ['/usr/local/bin/pis-pi-real', 'install', 'npm:foo']);
  assert.deepEqual(imageCommand(['pi', 'auth', 'check'], extensions, {}), ['/usr/local/bin/pis-pi-real', 'auth', 'check']);
  assert.deepEqual(imageCommand(['pi', '--continue'], [], {}), ['/usr/local/bin/pis-pi-real', '--continue']);
  assert.deepEqual(imageCommand(['bash', '-i'], extensions, {}), ['bash', '-i']);
});

test('web Git opt-in adds only a fixed additive tool modifier and preserves explicit selections', () => {
  const env = { PIS_APT_SOCKET: '/pis/apt/request.sock', PIS_HOST_GIT_ONLY: '1' };
  const command = imageCommand(['pi', '--mode', 'rpc', '--continue'], [], env);
  assert.deepEqual(command, ['/usr/local/bin/pis-pi-real', '--extension', '/opt/pis/request-apt.mjs', '--tools', '+request_host_git', '--mode', 'rpc', '--continue']);
  for (const args of [['--tools', 'read'], ['-t', 'read'], ['--tools=read'], ['--no-tools'], ['-nt'], ['--no-extensions'], ['-ne']]) {
    assert.ok(!imageCommand(['pi', ...args], [], env).includes('+request_host_git'));
  }
  for (const other of [{ PIS_APT_SOCKET: env.PIS_APT_SOCKET }, { PIS_HOST_GIT_ONLY: '1' }, {}]) assert.ok(!imageCommand(['pi'], [], other).includes('+request_host_git'));
  assert.deepEqual(imageCommand(['bash'], [], env), ['bash']);
  assert.ok(!imageCommand(['pi', 'install', 'npm:foo'], [], env).includes('+request_host_git'));
  const excluded = imageCommand(['pi', '--exclude-tools', 'request_host_git'], [], env); assert.ok(excluded.includes('--exclude-tools'));
  const prompt = imageCommand(['pi', '--', '--tools'], [], env); assert.ok(prompt.indexOf('+request_host_git') < prompt.indexOf('--'));
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
  assert.deepEqual(Object.keys(plan.files).sort(), ['Containerfile', 'claude-host-mcp.mjs', 'claude-network-hook.mjs', 'codex-auto.mjs', 'extensions.json', 'fetch-bridge.mjs', 'image-entry.mjs', 'network-client.mjs', 'network-tools.mjs', 'pi-launcher', 'probe-policy.json', 'request-apt.mjs', 'update-probe.mjs']);
  assert.match(plan.content, /NPM_CONFIG_IGNORE_SCRIPTS=true pi install 'npm:pi-web-access@0\.40\.0'/);
  assert.match(plan.content, /NPM_CONFIG_IGNORE_SCRIPTS=true pi install 'npm:pi-subagents@0\.88\.1'/);
  assert.match(plan.content, /'build-essential'/);
  assert.match(plan.content, /'python3'/);
  assert.ok(!Object.values(plan.files).join('').includes(config.root));
  config.extensions = [];
  const without = imagePlan(config);
  assert.notEqual(without.image, plan.image);
  assert.doesNotMatch(without.content, /pi install /);
});
