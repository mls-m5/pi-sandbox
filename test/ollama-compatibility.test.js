import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { saveApiProfile } from '../src/api-auth.js';
import { prepareProxy } from '../src/proxy-runtime.js';
import { PI_VERSION } from '../src/container.js';
test('installed compatible Pi encodes local Ollama limits/roles and parses streamed tool calls with fake fetch only', { skip: !process.env.PIS_PI_PACKAGE, timeout: 20000 }, async t => {
  const pkg = path.resolve(process.env.PIS_PI_PACKAGE), version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  assert.ok(new RegExp(`^${PI_VERSION.split('.').slice(0, 2).join('\\.')}\\.\\d+$`).test(version));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-ollama-compat-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root); const store = new Store(path.join(base, 'store')), config = await store.register(root);
  config.credentials = { env: [], proxy: { provider: 'ollama', models: [] } };
  await saveApiProfile(store, 'ollama', 'http://127.0.0.1:11434/v1', undefined, [{ id: 'qwen2.5-coder:7b', contextWindow: 8192, maxTokens: 2048, reasoning: true }]);
  const proxy = await prepareProxy(store, config); t.after(() => proxy.close()); const report = path.join(base, 'network-attempts');
  let stdout;
  try { ({ stdout } = await promisify(execFile)(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/pi-rpc-network-guard.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/ollama-ai-probe.mjs', import.meta.url)), pkg, path.join(proxy.directory, 'models.json')], { cwd: root, timeout: 15000, maxBuffer: 65536, env: { PATH: process.env.PATH, HOME: base, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PIS_RPC_NETWORK_REPORT: report } })); }
  catch { throw new Error('Installed Pi Ollama fake-fetch compatibility probe failed.'); }
  assert.deepEqual(JSON.parse(stdout), { calls: 1, maxTokensField: 'max_tokens', toolCallParsed: true }); assert.equal(fs.existsSync(report), false);
  t.diagnostic(`Tested Pi AI via installed Pi ${version}; no real Ollama/model/socket request.`);
});
