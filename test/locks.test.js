import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';
import { lockOwnerState, processIdentity, withLock } from '../src/util.js';
import { maintenanceEnvironment, projectContainers, recoverLock, recoverProjectLocks, inspectLock } from '../src/locks.js';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
const dead = () => 'dead';
function fixture(t) {
  const base = fs.mkdtempSync('/tmp/pis-lock-test-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(path.join(base, 'storage'));
  const file = path.join(store.root, 'registry.lock');
  const save = (value = { pid: 12345 }) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { base, store, file, save };
}

test('unlock options are explicit and preserve normal management/session restrictions', () => {
  assert.equal(parse(['--unlock']).action, 'unlock');
  assert.equal(parse(['--project', 'abc12', '--unlock', '--dry-run']).dryRun, true);
  for (const args of [['--unlock', '--force'], ['--unlock', '--fresh'], ['--unlock', '--bash'], ['--unlock', '--', 'rm'], ['--unlock', '--prune'], ['--dry-run']]) assert.throws(() => parse(args));
});

test('new locks record process identity and never unlink a replacement on exit', async t => {
  const { file } = fixture(t);
  const identity = processIdentity();
  assert.match(identity.bootId, /^[a-f0-9-]{36}$/);
  assert.match(identity.startTime, /^\d+$/);
  await withLock(file, async () => {
    const owner = JSON.parse(fs.readFileSync(file));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.bootId, identity.bootId);
    assert.equal(lockOwnerState(owner), 'alive');
    await assert.rejects(withLock(file, async () => {}), /pis --unlock/);
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'replacement' }), { mode: 0o600 });
  });
  assert.equal(JSON.parse(fs.readFileSync(file)).nonce, 'replacement');
});

test('owner checks fail closed for live/unknown legacy owners and identify old boot/reused PID stamps', () => {
  const identity = () => ({ bootId: 'current', startTime: '20' });
  assert.equal(lockOwnerState({ pid: process.pid }), 'alive');
  assert.equal(lockOwnerState({ pid: 1 }, { identity, kill: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } }), 'unknown');
  assert.equal(lockOwnerState({ pid: 1 }, { identity, kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } }), 'dead');
  assert.equal(lockOwnerState({ pid: 1, bootId: 'old' }, { identity, kill: () => assert.fail() }), 'dead');
  assert.equal(lockOwnerState({ pid: 1, bootId: 'current', startTime: '19' }, { identity, kill: () => assert.fail() }), 'dead');
});

test('legacy stale registry recovery needs no Podman and dry-run does not remove it', t => {
  const { file, save } = fixture(t);
  save();
  assert.equal(recoverLock(file, 'registry', { dryRun: true, ownerState: dead, containers: () => assert.fail() }).status, 'would-remove');
  assert.ok(fs.existsSync(file));
  assert.equal(recoverLock(file, 'registry', { ownerState: dead }).status, 'removed');
  assert.equal(recoverLock(file, 'registry').status, 'absent');
  save({ pid: process.pid });
  assert.equal(recoverLock(file, 'registry').status, 'blocked');
  assert.ok(fs.existsSync(file));
});

test('unsafe lock metadata/links never unlock and are not printed', t => {
  const { base, file, save } = fixture(t);
  for (const record of [{ pid: 0 }, { pid: -1 }, { pid: '123' }, { pid: 10, command: 'secret-token' }, { pid: 10, bootId: 'bad' }]) {
    save(record);
    const result = recoverLock(file, 'registry', { ownerState: () => assert.fail('Unsafe metadata reached owner probe') });
    assert.equal(result.status, 'blocked');
    assert.ok(!JSON.stringify(result).includes('secret-token'));
    fs.unlinkSync(file);
  }
  for (const contents of ['', 'private-key-not-json', 'x'.repeat(4097)]) {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    assert.equal(recoverLock(file, 'registry', { ownerState: dead }).status, 'blocked'); fs.unlinkSync(file);
  }
  save(); fs.chmodSync(file, 0o644);
  assert.equal(recoverLock(file, 'registry', { ownerState: dead }).status, 'blocked'); fs.unlinkSync(file);
  const outside = path.join(base, 'outside'); fs.writeFileSync(outside, '{"pid":123}', { mode: 0o600 });
  fs.symlinkSync(outside, file);
  assert.equal(recoverLock(file, 'registry', { ownerState: dead }).status, 'blocked'); fs.unlinkSync(file);
  fs.linkSync(outside, file);
  assert.equal(recoverLock(file, 'registry', { ownerState: dead }).status, 'blocked'); fs.unlinkSync(file);
  assert.equal(spawnSync('mkfifo', [file]).status, 0);
  assert.equal(recoverLock(file, 'registry', { ownerState: dead }).status, 'blocked'); fs.unlinkSync(file);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"pid":123}');
});

test('project recovery refuses remaining containers and unavailable/remote engines; no stop/delete commands', t => {
  const { file, save } = fixture(t); save();
  assert.equal(recoverLock(file, 'project', { ownerState: dead, projectId: 'abc12', containers: () => ['pis-abc12-orphan'] }).status, 'blocked');
  assert.equal(recoverLock(file, 'project', { ownerState: dead, projectId: 'abc12', containers: () => { throw new Error('secret failure'); } }).status, 'blocked');
  const commands = [];
  const execute = (_program, args) => {
    commands.push(args);
    return { status: 0, stdout: JSON.stringify(args[0] === 'info' ? { host: { security: { rootless: true }, serviceIsRemote: false } } : [{ Names: ['pis-abc12-orphan'] }, { Names: 'pis-other-project' }]) };
  };
  assert.deepEqual(projectContainers('abc12', { execute }), ['pis-abc12-orphan']);
  assert.deepEqual(commands.map(args => args[0]), ['info', 'ps']);
  assert.throws(() => projectContainers('abc12', { execute: () => ({ status: 0, stdout: '{"host":{"security":{"rootless":true},"serviceIsRemote":true}}' }) }), /Cannot verify/);
  assert.equal(recoverLock(file, 'project', { ownerState: dead, projectId: 'abc12', containers: () => [] }).status, 'removed');
});

test('update maintenance locks are visible and explicit recovery refuses live owners or orphan probes', async t => {
  const { base, store } = fixture(t);
  const root = path.join(base, 'project'); fs.mkdirSync(root); const config = await store.register(root);
  const file = path.join(store.projectDir(config.id), 'updates.lock');
  assert.equal(inspectLock(file).status, 'absent');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.equal(inspectLock(file).status, 'locked');
  assert.equal(recoverProjectLocks(store, { cwd: root, containers: () => assert.fail() }).locks.at(-1).status, 'blocked');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, bootId: '00000000-0000-0000-0000-000000000000' }));
  assert.equal(inspectLock(file).status, 'stale');
  assert.equal(recoverProjectLocks(store, { cwd: root, containers: () => [`pis-${config.id}-update-orphan`] }).locks.at(-1).status, 'blocked');
  assert.equal(recoverProjectLocks(store, { cwd: root, containers: () => [] }).locks.at(-1).status, 'removed');
});

test('recovery rechecks inode/content/owner and never deletes a changed replacement', t => {
  const { file, save } = fixture(t); save();
  const result = recoverLock(file, 'registry', { ownerState: dead, beforeRemove: () => { fs.unlinkSync(file); save({ pid: process.pid }); } });
  assert.equal(result.status, 'blocked');
  assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
  fs.unlinkSync(file); save();
  let probes = 0;
  assert.equal(recoverLock(file, 'registry', { ownerState: () => ++probes === 1 ? 'dead' : 'alive' }).status, 'blocked');
  assert.ok(fs.existsSync(file));
});

test('global registry recovery is independent of a busy project and does not acquire the stale registry lock', async t => {
  const { base, store, file, save } = fixture(t);
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const config = await store.register(root);
  save();
  const lock = path.join(store.projectDir(config.id), 'project.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const result = recoverProjectLocks(store, { cwd: root, ownerState: owner => owner.pid === process.pid ? 'alive' : 'dead' });
  assert.deepEqual(result.locks.map(entry => entry.status), ['removed', 'blocked']);
  assert.ok(!fs.existsSync(file)); assert.ok(fs.existsSync(lock));
});

test('actual pis --unlock uses kernel recovery serialization and handles the reported stale registry error', async t => {
  const { base, store, file, save } = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  save({ pid: exited.pid });
  const env = { ...process.env, PIS_HOME: store.root };
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { cwd: base, env, encoding: 'utf8', timeout: 10000 });
  const preview = invoke(['--unlock', '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).locks[0].status, 'would-remove');
  assert.ok(fs.existsSync(file));
  const fixed = invoke(['--unlock']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(JSON.parse(fixed.stdout).locks[0].status, 'removed');
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.statSync(path.join(store.root, 'lock-recovery.flock')).mode & 0o777, 0o600);
  save({ pid: exited.pid });
  const guard = path.join(store.root, 'lock-recovery.flock');
  const holder = spawn('/usr/bin/flock', ['--exclusive', '--no-fork', guard, process.execPath, '-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => { holder.once('error', reject); holder.stdout.once('data', resolve); });
  const busy = invoke(['--unlock']);
  assert.notEqual(busy.status, 0); assert.match(busy.stderr, /Another lock recovery/);
  assert.ok(fs.existsSync(file));
  const gone = new Promise(resolve => holder.once('exit', resolve)); holder.kill('SIGKILL'); await gone;
  const recovered = invoke(['--unlock']); // No stale recovery guard after SIGKILL.
  assert.equal(recovered.status, 0, recovered.stderr);
});

test('maintenance workers never inherit API credentials or Node injection options', () => {
  assert.deepEqual(maintenanceEnvironment({ HOME: '/home/test', PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--import unsafe.js' }), { PATH: '/usr/bin', HOME: '/home/test', XDG_RUNTIME_DIR: '/run/user/1000' });
});
