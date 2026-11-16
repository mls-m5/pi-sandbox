import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { defaults } from '../src/config.js';
import { resolveWebProjects, resolveConnectProject } from '../src/project-rpc.js';
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
if (args[0] === 'info' && process.env.TEST_ENGINE_FAIL === '1') { console.error('private diagnostic MUST_NOT_LEAK'); process.exit(2); }
if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
if (args[0] === 'image' && (process.env.TEST_BUILD === '1' || process.env.TEST_BUILD_FAIL === '1')) process.exitCode = 1;
if (args[0] === 'build') { console.log('fake build diagnostics, not protocol'); if (process.env.TEST_BUILD_FAIL === '1') process.exit(3); }
if (args[0] === 'container') process.exitCode = process.env.TEST_UNKNOWN_CONTAINER === '1' ? 0 : 1;
if (args[0] === 'run') {
  if (process.env.TEST_PI_FAIL === '1') process.exit(4);
  else if (process.env.TEST_STALL === '1') setInterval(() => {}, 1000);
  else if (process.env.TEST_BAD_RPC === '1') console.log('MUST_NOT_LEAK not a protocol record');
  else import(${JSON.stringify(fake)});
}
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

test('connect project lookup accepts IDs/names/unique folder basenames and rejects ambiguity without changing projects', async t => {
  const f = await fixture(t);
  assert.equal(resolveConnectProject(f.config.id, f.store).id, f.config.id);
  assert.equal(resolveConnectProject('web-test', f.store).id, f.config.id);
  assert.equal(resolveConnectProject(path.basename(f.root), f.store).id, f.config.id);
  const parent = path.join(f.base, 'other'); fs.mkdirSync(parent);
  const root = path.join(parent, path.basename(f.root)); fs.mkdirSync(root); await f.store.register(root, 'other-project');
  assert.throws(() => resolveConnectProject(path.basename(root), f.store), error => error.code === 'CONNECT_PROJECT_AMBIGUOUS');
  assert.equal(resolveConnectProject('web-test', f.store).id, f.config.id, 'Exact registered name wins over folder fallback.');
  assert.throws(() => resolveConnectProject('missing', f.store), /No registered project/);
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

test('opted-in web Git proposal waits for verified sandbox shutdown and host IPC approval; decline never pushes', { skip: process.getuid() === 0, timeout: 15000 }, async t => {
  for (const unknown of [false, true]) {
  const f = await fixture(t);
  const git = args => execFileSync('/usr/bin/git', ['-C', f.root, ...args], { env: { PATH: '/usr/bin:/bin', HOME: f.base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  git(['init']); fs.writeFileSync(path.join(f.root, 'hello'), 'test'); git(['add', 'hello']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test']); git(['remote', 'add', 'origin', 'git@example.invalid:owner/project.git']);
  const commit = git(['rev-parse', 'HEAD']);
  const child = spawn(process.execPath, [wrapper, f.config.id], { cwd: f.root, env: { ...f.env, PIS_ALLOW_WEB_GIT: '1', TEST_UNKNOWN_CONTAINER: unknown ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ipc'] });
  const rpc = new PiRpc(child, { timeoutMs: 3000 });
  t.after(async () => { if (!rpc.closed) await rpc.shutdown({ graceMs: 500, killMs: 1000 }); });
  const messages = []; child.on('message', value => messages.push(value));
  assert.equal((await rpc.request('get_state')).success, true);
  const calls = () => fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse);
  const args = calls().find(value => value[0] === 'run'); assert.ok(args.includes('PIS_HOST_GIT_ONLY=1'));
  const volume = args.find(value => value.includes(':/pis/apt:ro')); assert.ok(volume);
  const socket = net.createConnection(path.join(volume.split(':')[0], 'request.sock'));
  await once(socket, 'connect'); const reply = once(socket, 'data');
  socket.end(JSON.stringify({ type: 'git-command', repo: '.', args: ['push', 'origin', `${commit}:refs/heads/main`], reason: 'Test decline, never push' }) + '\n');
  assert.equal(JSON.parse((await reply)[0].toString()).ok, true);
  assert.equal(messages.length, 0, 'No approval before the container has exited.');
  const closed = once(child, 'close'); child.stdin.end();
  if (unknown) { await closed; assert.equal(child.exitCode, 1); assert.ok(fs.existsSync(f.lock)); assert.equal(messages.length, 0, 'Unconfirmed shutdown must never expose host approval.'); continue; }
  for (let i = 0; i < 300 && !messages.some(value => value.type === 'web_git_proposal'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const proposal = messages.find(value => value.type === 'web_git_proposal')?.proposal; assert.ok(proposal); assert.equal(proposal.commit, commit);
  assert.ok(calls().some(value => value[0] === 'rm')); assert.ok(calls().some(value => value[0] === 'container' && value[1] === 'exists'));
  assert.ok(fs.existsSync(f.lock), 'Project stays locked during review.');
  child.send({ type: 'web_git_decision', id: proposal.id, approved: false, code: '' }); await closed;
  assert.equal(child.exitCode, 0); assert.equal(fs.existsSync(f.lock), false); assert.ok(messages.some(value => value.phase === 'declined'));
  }
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
  for (const step of ['Kontrollerar projektlåset', 'Kontrollerar rootless Podman', 'Förbereder sandbox-image', 'Startar container', 'Pi har svarat', 'Agentanslutningen bekräftad', 'Terminalen ska nu stå kvar']) assert.ok(output.includes(step), step);
  assert.ok(fs.existsSync(f.lock));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  assert.equal(child.exitCode, 0); assert.equal(fs.existsSync(f.lock), false);
});

test('project startup failures report fixed specific phases without exposing stderr or raw RPC', { skip: process.getuid() === 0 || !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)), timeout: 20000 }, async t => {
  const { startProjectConnector } = await import('../web/project-connector.js');
  const keys = ['PATH', 'PIS_AUTO_UPDATE', 'PIS_AUTO_PRUNE', 'TEST_ENGINE_FAIL', 'TEST_BUILD_FAIL', 'TEST_PI_FAIL', 'TEST_STALL', 'TEST_BAD_RPC'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  for (const [flag, expected] of [['TEST_ENGINE_FAIL', 'engine_failed'], ['TEST_BUILD_FAIL', 'image_failed'], ['TEST_PI_FAIL', 'pi_failed'], ['TEST_STALL', 'startup_timeout'], ['TEST_BAD_RPC', 'rpc_failed'], ['PROXY', 'proxy_failed']]) {
    const f = await fixture(t);
    for (const key of keys) delete process.env[key];
    for (const key of ['PATH', 'PIS_AUTO_UPDATE', 'PIS_AUTO_PRUNE']) process.env[key] = f.env[key];
    if (flag === 'PROXY') { f.config.credentials = defaults(f.config.id, f.root).credentials; f.store.write(f.config); }
    else process.env[flag] = '1';
    const phases = [];
    await assert.rejects(startProjectConnector({ project: resolveWebProjects(['web-test'], f.store)[0], origin: 'http://127.0.0.1:43128', token: 'a'.repeat(43), startupTimeoutMs: flag === 'TEST_STALL' ? 250 : 3000, onProgress: phase => phases.push(phase) }), error => {
      assert.equal(error.code, 'PROJECT_STARTUP_FAILED'); assert.equal(error.phase, expected); return true;
    });
    assert.equal(phases.at(-1), expected); assert.ok(!JSON.stringify(phases).includes('MUST_NOT_LEAK'));
    assert.equal(fs.existsSync(f.lock), false);
  }
});

test('web CLI keeps the server alive with a visible failed agent when Podman startup fails', { skip: process.getuid() === 0 || !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)), timeout: 15000 }, async t => {
  const f = await fixture(t), reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../web/cli.js', import.meta.url)), 'start', '--project', 'web-test', '--port', String(port), '--password-stdin'], { cwd: f.root, env: { ...f.env, TEST_ENGINE_FAIL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stderr.on('data', chunk => { output += chunk; }); child.stdout.resume(); child.stdin.end('temporary-failed-project-password\n');
  for (let i = 0; i < 500 && !output.includes('projekt kunde inte startas') && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(output, /Podman-kontrollen misslyckades/); assert.match(output, /Webbservern är igång/);
  assert.ok(!output.includes('MUST_NOT_LEAK')); assert.ok(!output.includes('connection(s) ready'));
  assert.equal(child.exitCode, null); assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  assert.equal(fs.existsSync(f.lock), false);
});

test('independent registered agent CLI keeps Pi inside existing project boundary and never mounts its key', { skip: process.getuid() === 0 || !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)), timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { startWebServer } = await import('../web/server.js');
  const { hashPassword, randomKey } = await import('../web/common.js');
  const password = randomKey(), server = await startWebServer({ port: 0, passwordHash: await hashPassword(password) });
  t.after(() => server.close());
  const headers = { Origin: server.origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' };
  const login = await fetch(`${server.origin}/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
  const cookie = login.headers.getSetCookie()[0].split(';')[0], csrf = (await login.json()).csrf;
  const registrationResponse = await fetch(`${server.origin}/agents`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ label: 'Independent Pi', kind: 'pi' }) });
  assert.equal(registrationResponse.status, 201); const registration = await registrationResponse.json();
  const cli = fileURLToPath(new URL('../web/agent-cli.js', import.meta.url));
  const register = spawn(process.execPath, [cli, 'register', 'independent', '--server', server.origin, '--project', 'web-test', '--key-stdin'], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; register.stderr.on('data', data => { output += data; }); register.stdout.resume(); register.stdin.end(`${registration.token}\n`);
  await once(register, 'close'); assert.equal(register.exitCode, 0); assert.equal(fs.existsSync(f.trace), false, 'Registration must not start Podman.');
  const profile = path.join(f.store.root, 'web-agents', 'independent.json');
  assert.equal(JSON.parse(fs.readFileSync(profile)).projectId, f.config.id);
  const runner = spawn(process.execPath, [cli, 'run', 'independent'], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (runner.exitCode === null) runner.kill('SIGKILL'); }); runner.stdin.end(); runner.stdout.resume(); runner.stderr.on('data', data => { output += data; });
  for (let index = 0; index < 700 && !server.roster()[0]?.online && runner.exitCode === null; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(server.roster()[0]?.online, true); assert.ok(fs.existsSync(f.lock));
  const calls = fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse), run = calls.find(args => args[0] === 'run');
  assert.ok(run.includes('--cap-drop=all')); assert.ok(!JSON.stringify(calls).includes(registration.token));
  assert.ok(!run.some(argument => argument.includes('web-agents') || argument.includes('PIS_APT_SOCKET') || argument.includes('PIS_CODEX_AUTO_SOCKET')));
  server.revokeAgent(registration.id);
  await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(runner.exitCode, null); assert.ok(fs.existsSync(f.lock), 'Revocation must not tear down local Pi.');
  const closed = once(runner, 'close'); runner.kill('SIGTERM'); await closed;
  assert.equal(runner.exitCode, 0); assert.equal(fs.existsSync(f.lock), false); assert.ok(!output.includes(registration.token));
  const shortcutRoot = path.join(f.base, 'folder-app'); fs.mkdirSync(shortcutRoot);
  const shortcutConfig = await f.store.register(shortcutRoot, 'another-registered-name');
  shortcutConfig.credentials = { env: [] }; shortcutConfig.extensions = []; shortcutConfig.image.packages = []; f.store.write(shortcutConfig);
  const ticketResponse = await fetch(`${server.origin}/enrollment-keys`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': csrf }, body: '{}' });
  assert.equal(ticketResponse.status, 201); const ticket = await ticketResponse.json();
  const shortcut = spawn(process.execPath, [cli, 'folder-app', '--server', server.origin, '--key-stdin'], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (shortcut.exitCode === null) shortcut.kill('SIGKILL'); }); shortcut.stdout.resume(); shortcut.stderr.on('data', data => { output += data; }); shortcut.stdin.end(`${ticket.token}\n`);
  for (let index = 0; index < 700 && !server.roster().some(agent => agent.label === 'folder-app' && agent.online) && shortcut.exitCode === null; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(server.roster().some(agent => agent.label === 'folder-app' && agent.online), 'One command must resolve the unique folder and start Pi without run.');
  const shortcutProfile = path.join(f.store.root, 'web-agents', 'folder-app.json'), saved = fs.readFileSync(shortcutProfile, 'utf8');
  assert.equal(JSON.parse(saved).projectId, shortcutConfig.id);
  const busy = spawn(process.execPath, [cli, 'folder-app', '--server', server.origin, '--key-stdin'], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let busyOutput = ''; busy.stderr.on('data', data => { busyOutput += data; }); busy.stdout.resume(); busy.stdin.end(`${randomKey()}\n`);
  await once(busy, 'close'); assert.equal(busy.exitCode, 1); assert.match(busyOutput, /projektet körs redan/); assert.equal(shortcut.exitCode, null); assert.equal(fs.readFileSync(shortcutProfile, 'utf8'), saved);
  const shortcutClosed = once(shortcut, 'close'); shortcut.kill('SIGTERM'); await shortcutClosed; assert.equal(shortcut.exitCode, 0);
  const trace = fs.readFileSync(f.trace, 'utf8'); assert.ok(!trace.includes(ticket.token)); assert.ok(!trace.includes(JSON.parse(saved).token)); assert.ok(!output.includes(ticket.token));
});

test('connector replaces only verified Git-flow runtimes, stays registered and sends no continuation prompt', { skip: process.getuid() === 0 || !fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url)), timeout: 30000 }, async t => {
  const { startWebServer } = await import('../web/server.js'), { startProjectConnector } = await import('../web/project-connector.js');
  const { hashPassword, randomKey, digest } = await import('../web/common.js'), { default: WebSocket } = await import('../web/node_modules/ws/wrapper.mjs');
  const keys = ['PATH', 'PIS_AUTO_UPDATE', 'PIS_AUTO_PRUNE', 'TEST_UNKNOWN_CONTAINER', 'TEST_PI_FAIL', 'PIS_TEST_RPC_TRACE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE'], saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const until = async predicate => { for (let i = 0; i < 700; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Runtime replacement deadline.'); };
  for (const mode of ['declined', 'unconfirmed', 'ordinary-exit', 'cancelled', 'replacement-fails', 'replacement-unclean', 'replacement-code-corrupt']) {
    const f = await fixture(t), trace = path.join(f.base, 'rpc-types');
    for (const key of ['PATH', 'PIS_AUTO_UPDATE', 'PIS_AUTO_PRUNE']) process.env[key] = f.env[key];
    process.env.TEST_UNKNOWN_CONTAINER = mode === 'unconfirmed' ? '1' : '0'; process.env.TEST_PI_FAIL = '0'; process.env.PIS_TEST_RPC_TRACE = trace;
    const git = args => execFileSync('/usr/bin/git', ['-C', f.root, ...args], { env: { PATH: '/usr/bin:/bin', HOME: f.base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
    git(['init']); fs.writeFileSync(path.join(f.root, 'hello'), 'test'); git(['add', 'hello']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test']); git(['remote', 'add', 'origin', 'git@example.invalid:owner/project.git']);
    const hookMarker = path.join(f.base, 'hook-must-not-run'), hook = path.join(f.base, 'mutable-hook.mjs');
    fs.writeFileSync(hook, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(hookMarker)}, 'executed');`);
    process.env.NODE_OPTIONS = `--import=${hook}`; process.env.NODE_PATH = path.join(f.base, 'untrusted-modules');
    const injectedCache = path.join(f.base, 'injected-compile-cache'); process.env.NODE_COMPILE_CACHE = injectedCache; process.env.NODE_DISABLE_COMPILE_CACHE = '0';
    const commit = git(['rev-parse', 'HEAD']), token = randomKey(), password = randomKey(), steps = [];
    const server = await startWebServer({ port: 0, passwordHash: await hashPassword(password), agents: [{ id: 'pi-replace', label: 'Project', kind: 'pi', tokenHash: digest(token) }] }); t.after(() => server.close());
    const connector = await startProjectConnector({ project: resolveWebProjects(['web-test'], f.store)[0], origin: server.origin, token, allowWebGit: true, startupTimeoutMs: 3000, onProgress: phase => steps.push(phase) }); t.after(() => connector.close().catch(() => {}));
    const generation = connector.view.control.generation, network = connector.network;
    const trustedEntry = connector.rpc.child.spawnargs[1]; assert.ok(trustedEntry.startsWith(path.join(f.store.root, 'web-runtime-code') + path.sep));
    const response = await fetch(server.origin + '/login', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password }) }); await response.json();
    const browser = new WebSocket(server.origin.replace('http:', 'ws:') + '/browser', { headers: { Origin: server.origin, Cookie: response.headers.getSetCookie()[0].split(';')[0] } }), messages = [];
    browser.on('message', data => messages.push(JSON.parse(data))); browser.on('error', () => {}); t.after(() => browser.terminate()); await once(browser, 'open');
    const send = value => browser.send(JSON.stringify({ v: 1, agentId: 'pi-replace', generation, ...value }));
    browser.send(JSON.stringify({ v: 1, type: 'select', agentId: 'pi-replace', id: token.slice(0, 20) })); await until(() => messages.some(value => value.type === 'selected'));
    const calls = () => fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse), runs = () => calls().filter(args => args[0] === 'run');
    if (mode !== 'ordinary-exit') {
      const volume = runs()[0].find(value => value.includes(':/pis/apt:ro'));
      const socket = net.createConnection(path.join(volume.split(':')[0], 'request.sock')); await once(socket, 'connect'); const reply = once(socket, 'data');
      socket.end(JSON.stringify({ type: 'git-command', repo: '.', args: ['push', 'origin', `${commit}:refs/heads/main`], reason: 'Test decline only; no external push' }) + '\n'); assert.equal(JSON.parse((await reply)[0].toString()).ok, true);
    }
    connector.rpc.child.stdin.end();
    if (mode === 'unconfirmed' || mode === 'ordinary-exit') {
      await until(() => connector.isClosed); assert.equal(runs().length, 1);
      if (mode === 'unconfirmed') { assert.ok(fs.existsSync(f.lock)); await assert.rejects(connector.close()); }
      else await connector.close();
    } else {
      await until(() => messages.some(value => value.type === 'host_push' && value.push.phase === 'pending'));
      const push = messages.find(value => value.type === 'host_push').push;
      if (mode === 'cancelled') { await connector.close(); assert.equal(runs().length, 1); }
      else {
        send({ type: 'host_push_review', id: push.id }); await until(() => messages.some(value => value.type === 'host_push_review'));
        const reviewId = messages.find(value => value.type === 'host_push_review').reviewId;
        if (['replacement-fails', 'replacement-unclean'].includes(mode)) process.env.TEST_PI_FAIL = '1';
        if (mode === 'replacement-code-corrupt') fs.appendFileSync(trustedEntry, '\n// changed private bundle\n');
        if (mode === 'replacement-unclean') process.env.TEST_UNKNOWN_CONTAINER = '1';
        send({ type: 'host_push_decision', id: push.id, reviewId, approved: false, code: '' });
        if (mode.startsWith('replacement-')) {
          await until(() => connector.isClosed); assert.equal(runs().length, mode === 'replacement-code-corrupt' ? 1 : 2);
          const phase = mode === 'replacement-unclean' ? 'cleanup_unconfirmed' : mode === 'replacement-code-corrupt' ? 'failed' : 'pi_failed'; assert.ok(steps.includes(phase));
          await assert.rejects(connector.close(), error => error.code === 'PROJECT_REPLACEMENT_FAILED' && error.phase === phase);
          assert.equal(fs.existsSync(f.lock), mode === 'replacement-unclean');
        }
        else {
          await until(() => connector.view.control.generation !== generation && server.roster()[0].generation === connector.view.control.generation && server.roster()[0].status === 'idle');
          assert.equal(connector.rpc.child.spawnargs[1], trustedEntry);
          assert.equal(connector.network, network); assert.equal(connector.isClosed, false); assert.equal(runs().length, 2); assert.ok(fs.existsSync(f.lock));
          const stale = await connector.view.execute({ v: 1, generation, id: 'stale', action: 'prompt', message: 'must not replay' }); assert.equal(stale.data.error, 'control_stale_generation');
          assert.deepEqual([...new Set(fs.readFileSync(trace, 'utf8').trim().split('\n'))], ['get_state']);
          const secondGeneration = connector.view.control.generation, secondVolume = runs()[1].find(value => value.includes(':/pis/apt:ro'));
          const secondSocket = net.createConnection(path.join(secondVolume.split(':')[0], 'request.sock')); await once(secondSocket, 'connect'); const secondReply = once(secondSocket, 'data');
          secondSocket.end(JSON.stringify({ type: 'git-command', repo: '.', args: ['push', 'origin', `${commit}:refs/heads/main`], reason: 'Second independent decline; never push' }) + '\n'); assert.equal(JSON.parse((await secondReply)[0].toString()).ok, true);
          connector.rpc.child.stdin.end();
          await until(() => messages.some(value => value.type === 'host_push' && value.generation === secondGeneration && value.push.phase === 'pending'));
          const secondPush = messages.find(value => value.type === 'host_push' && value.generation === secondGeneration).push;
          send({ type: 'host_push_review', generation: secondGeneration, id: secondPush.id }); await until(() => messages.some(value => value.type === 'host_push_review' && value.id === secondPush.id));
          send({ type: 'host_push_decision', generation: secondGeneration, id: secondPush.id, reviewId: messages.find(value => value.type === 'host_push_review' && value.id === secondPush.id).reviewId, approved: false, code: '' });
          await until(() => connector.view.control.generation !== secondGeneration && server.roster()[0].generation === connector.view.control.generation && server.roster()[0].status === 'idle');
          assert.equal(runs().length, 3); assert.equal(connector.network, network); assert.equal(connector.isClosed, false);
          assert.deepEqual([...new Set(fs.readFileSync(trace, 'utf8').trim().split('\n'))], ['get_state']);
          await connector.close();
        }
      }
    }
    for (const args of runs()) {
      assert.deepEqual(args.slice(-6), ['pi', '--tui-mode', 'regular', '--continue', '--mode', 'rpc']);
      assert.ok(!args.some(value => value.includes('web-runtime-code')), 'Trusted host code bundle must not be a sandbox mount.');
    }
    assert.equal(fs.existsSync(hookMarker), false, 'Opted-in wrapper must not inherit Node startup hooks.');
    assert.equal(fs.existsSync(injectedCache), false, 'Opted-in wrapper must not read or write injected compile caches.');
    browser.terminate(); await server.close();
  }
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
  const steps = [];
  const connector = await startProjectConnector({ project: resolveWebProjects(['web-test'], f.store)[0], origin: server.origin, token, startupTimeoutMs: 3000, onProgress: phase => steps.push(phase) });
  assert.deepEqual(steps, ['starting_wrapper', 'project_lock', 'checking_engine', 'preparing_image', 'image_ready', 'starting_container', 'rpc_ready', 'connected']);
  assert.equal(server.roster()[0].online, true, 'Ready requires server registration acknowledgement, not just an open local RPC pipe.');
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
