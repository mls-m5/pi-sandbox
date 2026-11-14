import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { resolveWebProjects } from '../src/project-rpc.js';
import { PiRpc } from '../src/pi-rpc.js';
import { withLock } from '../src/util.js';
import { launch } from '../src/container.js';

const wrapper = fileURLToPath(new URL('../bin/pis-project-rpc.js', import.meta.url));
async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-project-rpc-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project with spaces'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root, 'web-test');
  config.credentials = { env: [] }; config.extensions = []; config.image.packages = [];
  store.write(config);
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  const trace = path.join(base, 'trace');
  const fake = fileURLToPath(new URL('./fixtures/pi-rpc-child.mjs', import.meta.url));
  fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
const fs = require('fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
if (args[0] === 'image' && process.env.TEST_BUILD === '1') process.exitCode = 1;
if (args[0] === 'build') console.log('fake build diagnostics, not protocol');
if (args[0] === 'container') process.exitCode = process.env.TEST_UNKNOWN_CONTAINER === '1' ? 0 : 1;
if (args[0] === 'run') import(${JSON.stringify(fake)});
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PIS_HOME: store.root, PIS_AUTO_UPDATE: '0', PIS_AUTO_PRUNE: '0' };
  const start = (extra = {}) => {
    const child = spawn(process.execPath, [wrapper, config.id], { cwd: root, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = new PiRpc(child, { timeoutMs: 3000 });
    t.after(async () => { if (!rpc.closed) await rpc.shutdown({ graceMs: 200, killMs: 1000 }).catch(() => child.kill('SIGKILL')); });
    return { child, rpc };
  };
  return { base, root, store, config, env, trace, start, lock: path.join(store.projectDir(config.id), 'project.lock') };
}

test('project selection requires existing distinct configured Pi projects, preserving explicit config', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.store.configPath(f.config.id), 'utf8');
  const projects = resolveWebProjects(['web-test'], f.store);
  assert.equal(projects[0].id, f.config.id);
  assert.equal(projects[0].root, f.root);
  assert.equal(fs.readFileSync(f.store.configPath(f.config.id), 'utf8'), before);
  assert.throws(() => resolveWebProjects(['web-test', f.config.id], f.store), /same project/);
  assert.throws(() => resolveWebProjects(['unknown'], f.store), /Unknown project/);
  f.config.agent = 'claude'; f.store.write(f.config);
  assert.throws(() => resolveWebProjects(['web-test'], f.store), /not Claude/);
});

test('fixed project wrapper preserves clean RPC, exclusive lock and sandbox flags; EOF verifies cleanup', { skip: process.getuid() === 0 }, async t => {
  const f = await fixture(t), { rpc, child } = f.start({ TEST_BUILD: '1' });
  assert.equal((await rpc.request('get_state')).success, true);
  assert.ok(fs.existsSync(f.lock));
  const second = f.start();
  await assert.rejects(second.rpc.request('get_state'), /rpc_/);
  assert.ok(fs.existsSync(f.lock));
  const calls = fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse);
  const runs = calls.filter(args => args[0] === 'run'); assert.equal(runs.length, 1);
  const args = runs[0];
  assert.ok(args.includes('--interactive')); assert.ok(!args.includes('--tty'));
  assert.ok(args.includes('--cap-drop=all')); assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(!args.some(value => value.includes('PIS_APT_SOCKET') || value.includes('PIS_CODEX_AUTO_SOCKET')));
  assert.deepEqual(args.slice(-6), ['pi', '--tui-mode', 'regular', '--continue', '--mode', 'rpc']);
  await rpc.shutdown({ graceMs: 1000, killMs: 1000 });
  assert.equal(child.exitCode, 0); assert.equal(fs.existsSync(f.lock), false);
  const after = fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(after.some(args => args[0] === 'rm'));
  assert.ok(after.some(args => args[0] === 'container' && args[1] === 'exists'));
});

test('unconfirmed container shutdown fails wrapper and retains the project lock', { skip: process.getuid() === 0 }, async t => {
  const f = await fixture(t), { rpc, child } = f.start({ TEST_UNKNOWN_CONTAINER: '1' });
  await rpc.request('get_state');
  await rpc.shutdown({ graceMs: 1000, killMs: 1000 });
  assert.equal(child.exitCode, 1); assert.ok(fs.existsSync(f.lock));
});

test('web runtime rejects mutable launch controls under the project lock before Podman starts', async t => {
  const f = await fixture(t);
  const options = { cwd: f.root, mode: 'pi', args: ['--mode', 'rpc'], webRpc: true };
  for (const extra of [{ agent: 'claude' }, { autoWaitCodex: true }, { waitCodex: true }, { args: ['--mode', 'rpc', 'unwanted initial prompt'] }, { fresh: true }, { stdio: 'inherit' }]) {
    await assert.rejects(launch(f.store, f.config, { ...options, ...extra }), /Web RPC/);
    assert.equal(fs.existsSync(f.lock), false);
  }
  f.config.agent = 'claude'; f.store.write(f.config);
  await assert.rejects(launch(f.store, { ...f.config, agent: 'pi' }, options), /Web RPC/);
  assert.equal(fs.existsSync(f.trace), false);
});

test('lock retention is explicit and does not affect ordinary failed actions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-retain-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'lock');
  await assert.rejects(withLock(file, () => { throw new Error('ordinary'); }));
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(withLock(file, () => { throw Object.assign(new Error('unknown'), { code: 'UNKNOWN' }); }, { retainOnError: error => error.code === 'UNKNOWN' }));
  assert.equal(fs.existsSync(file), true);
});

test('web CLI starts an explicitly selected registered project and shuts down with verified lock cleanup', { skip: process.getuid() === 0 || !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)), timeout: 15000 }, async t => {
  const f = await fixture(t);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../web/cli.js', import.meta.url)), 'start', '--project', 'web-test', '--port', String(port), '--password-stdin'], {
    cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stderr.on('data', chunk => { output += chunk; }); child.stdout.resume();
  child.stdin.end('temporary-project-cli-password\n');
  for (let i = 0; i < 500 && !output.includes('connection(s) ready') && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(output.includes('connection(s) ready'), output);
  assert.match(output, /EXPERIMENTAL/); assert.ok(!output.includes('temporary-project-cli-password'));
  assert.ok(fs.existsSync(f.lock));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  assert.equal(child.exitCode, 0); assert.equal(fs.existsSync(f.lock), false);
});

test('project connector keeps wrapper and lock alive across network reconnect, then cleans up locally', { skip: process.getuid() === 0 || !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)), timeout: 15000 }, async t => {
  const f = await fixture(t);
  const { startWebServer } = await import('../web/server.js');
  const { startProjectConnector } = await import('../web/project-connector.js');
  const { hashPassword, randomKey, digest } = await import('../web/common.js');
  const token = randomKey();
  const server = await startWebServer({ port: 0, passwordHash: await hashPassword('fake-project-connector-password'), agents: [{ id: 'project-test', kind: 'pi', label: 'Project', tokenHash: digest(token) }] });
  t.after(() => server.close());
  const saved = { ...process.env };
  for (const key of ['PATH', 'PIS_AUTO_UPDATE', 'PIS_AUTO_PRUNE']) process.env[key] = f.env[key];
  t.after(() => { for (const key of ['PATH', 'PIS_AUTO_UPDATE', 'PIS_AUTO_PRUNE']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const connector = await startProjectConnector({ project: resolveWebProjects(['web-test'], f.store)[0], origin: server.origin, token, startupTimeoutMs: 3000 });
  t.after(() => connector.close());
  const waitOnline = async () => {
    for (let i = 0; i < 300; i++) { if (server.roster()[0].online) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Project connection deadline');
  };
  await waitOnline();
  assert.equal(server.roster()[0].kind, 'pi');
  const generation = connector.view.control.generation;
  const reconnect = new Promise(resolve => connector.network.events.once('connected', resolve));
  connector.network.disconnect(); await reconnect;
  await waitOnline();
  assert.equal(connector.view.control.generation, generation); assert.ok(fs.existsSync(f.lock));
  assert.equal(fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse).filter(args => args[0] === 'run').length, 1);
  await connector.close(); assert.equal(fs.existsSync(f.lock), false);
});
