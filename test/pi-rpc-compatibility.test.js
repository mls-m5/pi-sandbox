import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PI_VERSION } from '../src/container.js';
import { PiRpc, PiControl } from '../src/pi-rpc.js';
import { PiView, VIEW_LIMITS } from '../src/pi-view.js';

// Opt-in only. Never discovers/loads personal configuration or sends prompts.
test('installed compatible Pi: isolated RPC state/history and orderly shutdown without network/model calls', {
  skip: !process.env.PIS_PI_PACKAGE, timeout: 20_000,
}, async t => {
  const pkg = path.resolve(process.env.PIS_PI_PACKAGE);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  const baseline = PI_VERSION.split('.').slice(0, 2).join('.');
  assert.ok(new RegExp(`^${baseline.replaceAll('.', '\\.')}\\.\\d+$`).test(manifest.version), 'Probe accepts stable patches of the image baseline only.');
  t.diagnostic(`Image baseline ${PI_VERSION}; tested installed Pi ${manifest.version}. No image pin is changed.`);
  const cli = path.join(pkg, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-rpc-compat-'));
  const home = path.join(base, 'home'), cwd = path.join(base, 'project'), agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}', { mode: 0o600 });
  const report = path.join(base, 'network-attempts');
  const child = spawn(process.execPath, [
    '--import', fileURLToPath(new URL('./fixtures/pi-rpc-network-guard.mjs', import.meta.url)), cli,
    '--mode', 'rpc', '--offline', '--no-session', '--no-tools', '--no-extensions', '--no-mcp',
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
  ], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, TERM: 'dumb', NO_COLOR: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agent, PIS_RPC_NETWORK_REPORT: report },
  });
  const rpc = new PiRpc(child, { timeoutMs: 10_000 });
  t.after(async () => {
    try { await rpc.shutdown({ graceMs: 500, killMs: 500 }); }
    finally { if (!rpc.closed) child.kill('SIGKILL'); fs.rmSync(base, { recursive: true, force: true }); }
  });
  const faults = [];
  rpc.on('fault', code => faults.push(code));
  const control = new PiControl(rpc);
  const command = (id, action) => ({ v: 1, generation: control.generation, id, action });
  const [state, history] = await Promise.all([control.execute(command('state', 'state')), control.execute(command('history', 'history'))]);
  assert.equal(state.success, true);
  assert.equal(state.data.isStreaming, false);
  assert.equal(state.data.isCompacting, false);
  assert.equal(state.data.pendingMessageCount, 0);
  assert.equal(rpc.status, 'idle');
  assert.equal(history.success, true);
  assert.ok(Array.isArray(history.data.messages));
  assert.ok(history.data.messages.every(message => message.role === 'system'), 'No user/model/tool work may be present.');
  assert.deepEqual(await control.execute(command('state', 'state')), { duplicate: true });
  const view = new PiView(rpc, control);
  t.after(() => view.detach());
  const projectedState = await view.execute(command('view-state', 'state'));
  const projectedHistory = await view.execute(command('view-history', 'history'));
  assert.equal(projectedState.data.success, true);
  assert.equal(projectedState.data.state.isStreaming, false);
  assert.ok(!('sessionFile' in projectedState.data.state));
  assert.equal(projectedHistory.data.success, true);
  assert.ok(Array.isArray(projectedHistory.data.history.messages));
  assert.ok(Buffer.byteLength(JSON.stringify(projectedHistory)) <= VIEW_LIMITS.historyBytes);
  assert.equal(projectedHistory.stable, true);
  await rpc.shutdown();
  assert.deepEqual(faults, []);
  assert.equal(child.exitCode, 0);
  assert.equal(rpc.status, 'offline');
  assert.equal(fs.existsSync(report), false, 'Even attempted network access fails this probe.');
  assert.equal(fs.readFileSync(path.join(agent, 'auth.json'), 'utf8'), '{}');
});
