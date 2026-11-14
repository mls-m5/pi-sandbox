import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { imagePlan } from '../src/container.js';
import { PiRpc } from '../src/pi-rpc.js';

// Explicit real-engine gate. No prompt/model request; fresh credential-free state.
test('real rootless Podman project RPC: state/history, exclusive lock and verified EOF cleanup', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 600_000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-project-rpc-integration-'));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root, 'rpc-integration');
  config.credentials = { env: [] }; config.extensions = []; config.image.packages = [];
  store.write(config);
  const image = imagePlan(config).image;
  let child, rpc;
  t.after(async () => {
    if (rpc && !rpc.closed) await rpc.shutdown({ graceMs: 1000, killMs: 60_000 }).catch(() => child.kill('SIGKILL'));
    const names = spawnSync('podman', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 15000 }).stdout || '';
    for (const name of names.trim().split('\n').filter(name => name.startsWith(`pis-${config.id}-`))) spawnSync('podman', ['rm', '--force', '--time', '1', name], { stdio: 'ignore', timeout: 15000 });
    spawnSync('podman', ['rmi', image], { stdio: 'ignore', timeout: 30000 });
    fs.rmSync(base, { recursive: true, force: true });
  });
  child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis-project-rpc.js', import.meta.url)), config.id], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: base, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PIS_HOME: store.root, PIS_AUTO_UPDATE: '0', PIS_AUTO_PRUNE: '0' },
  });
  rpc = new PiRpc(child, { timeoutMs: 500_000 });
  const state = await rpc.request('get_state');
  assert.equal(state.success, true); assert.equal(state.data.isStreaming, false);
  const lock = path.join(store.projectDir(config.id), 'project.lock'); assert.ok(fs.existsSync(lock));
  await assert.rejects(store.projectLock(config.id, () => {}), /busy/);
  const history = await rpc.request('get_messages');
  assert.equal(history.success, true);
  assert.ok(history.data.messages.every(message => message.role === 'system'));
  await rpc.shutdown({ graceMs: 1000, killMs: 60_000 });
  assert.equal(child.exitCode, 0); assert.equal(fs.existsSync(lock), false);
  const names = spawnSync('podman', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(names.status, 0); assert.ok(!names.stdout.split('\n').some(name => name.startsWith(`pis-${config.id}-`)));
});
