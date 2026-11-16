import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { subagentWorktreeEnvironment } from '../src/runtime/image-entry.mjs';

const active = ['/usr/local/bin/pis-pi-real', '--continue'];
const extensions = [{ name: 'pi-subagents' }];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-worktree-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'extensions/subagent/config.json');
  const source = { PI_CODING_AGENT_DIR: root, TEST_SETTING: 'preserved' };
  const prepare = (command = active, env = source) =>
    subagentWorktreeEnvironment(command, extensions, env);
  const write = (value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  return { root, file, source, prepare, write };
}

test('native worktree default uses existing sandbox state without creating or overwriting config', (t) => {
  const f = fixture(t),
    expected = path.join(f.root, 'worktrees');
  const result = f.prepare();
  assert.deepEqual(result, { ...f.source, PI_SUBAGENTS_WORKTREE_DIR: expected });
  assert.equal(
    f.source.PI_SUBAGENTS_WORKTREE_DIR,
    undefined,
    'Caller/process environment is not mutated.',
  );
  assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(f.file), false);
  f.write({ custom: 'retained', worktreeProvider: 'native' });
  const before = fs.readFileSync(f.file),
    stat = fs.statSync(f.file);
  assert.deepEqual(f.prepare(), result);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.statSync(f.file).ino, stat.ino);
  assert.equal(fs.statSync(f.file).mode, stat.mode);
});

test('explicit config, providers and environment remain authoritative', (t) => {
  for (const config of [
    { worktreeBaseDir: '/explicit/root', other: 1 },
    { worktreeProvider: 'auto' },
    { worktreeProvider: 'worktrunk' },
  ]) {
    const f = fixture(t);
    f.write(config);
    const bytes = fs.readFileSync(f.file);
    assert.deepEqual(f.prepare(), f.source);
    assert.deepEqual(fs.readFileSync(f.file), bytes);
    assert.equal(fs.existsSync(path.join(f.root, 'worktrees')), false);
  }
  const f = fixture(t),
    env = { ...f.source, PI_SUBAGENTS_WORKTREE_DIR: '/environment/root' };
  assert.deepEqual(f.prepare(active, env), env);
  assert.equal(fs.existsSync(path.join(f.root, 'worktrees')), false);
  assert.equal(fs.existsSync(f.file), false);
});

test('default is skipped for disabled extensions, management, non-Pi and Claude but not disabled skills', (t) => {
  const f = fixture(t);
  for (const command of [
    ['bash'],
    ['claude'],
    ['/usr/local/bin/pis-pi-real', 'install', 'npm:example'],
    ['/usr/local/bin/pis-pi-real', 'list'],
    ['/usr/local/bin/pis-pi-real', 'auth', 'check'],
    ['/usr/local/bin/pis-pi-real', '--no-extensions'],
    ['/usr/local/bin/pis-pi-real', '-ne'],
    ...['--help', '-h', '--version', '-v', '--list-models', '--list-models=test', '--export'].map(
      (flag) => [active[0], flag],
    ),
  ])
    assert.deepEqual(f.prepare(command), f.source);
  assert.deepEqual(f.prepare(active, { ...f.source, CLAUDE_CONFIG_DIR: '/claude' }), {
    ...f.source,
    CLAUDE_CONFIG_DIR: '/claude',
  });
  assert.deepEqual(subagentWorktreeEnvironment(active, [], f.source), f.source);
  assert.deepEqual(fs.readdirSync(f.root), []);
  for (const args of [['--no-skills'], ['-ns'], ['--', '--no-extensions'], ['--', '--help']]) {
    assert.equal(
      f.prepare([active[0], ...args]).PI_SUBAGENTS_WORKTREE_DIR,
      path.join(f.root, 'worktrees'),
    );
  }
});

test('HOME fallback selects only its sandbox-local agent state', (t) => {
  const f = fixture(t),
    env = { HOME: f.root };
  const result = f.prepare(active, env);
  assert.equal(result.PI_SUBAGENTS_WORKTREE_DIR, path.join(f.root, '.pi/agent/worktrees'));
  assert.deepEqual(env, { HOME: f.root });
  assert.equal(fs.existsSync(path.join(f.root, '.pi/agent/extensions')), false);
  assert.throws(
    () => f.prepare(active, { PI_CODING_AGENT_DIR: 'relative/state' }),
    /unsafe or invalid/,
  );
});

test('malformed, oversized, conflicting and unsafe configs fail bounded without rewrite', (t) => {
  const f = fixture(t);
  f.write({});
  for (const data of [
    '{synthetic-secret-payload',
    '[]',
    'null',
    '{"worktreeProvider":"invalid"}',
    '{"worktreeBaseDir":7}',
    '{"worktreeProvider":"worktrunk","worktreeBaseDir":"/root"}',
    ' '.repeat(65537),
  ]) {
    fs.writeFileSync(f.file, data);
    assert.throws(
      () => f.prepare(),
      (error) => {
        assert.equal(
          error.message,
          'Sandbox pi-subagents worktree configuration is unsafe or invalid; no config was changed.',
        );
        assert.ok(!error.message.includes('synthetic-secret-payload'));
        return true;
      },
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), data);
    assert.equal(fs.existsSync(path.join(f.root, 'worktrees')), false);
  }
  fs.unlinkSync(f.file);
  fs.symlinkSync('/dev/null', f.file);
  assert.throws(() => f.prepare(), /unsafe or invalid/);
  fs.unlinkSync(f.file);
  f.write({});
  const link = `${f.file}.linked`;
  fs.linkSync(f.file, link);
  assert.throws(() => f.prepare(), /unsafe or invalid/);
  fs.unlinkSync(link);
  fs.unlinkSync(f.file);
  assert.equal(spawnSync('mkfifo', [f.file]).status, 0);
  assert.throws(() => f.prepare(), /unsafe or invalid/);
});

test('default directories reject symlinks and nonprivate existing roots without chmod or writes', (t) => {
  const f = fixture(t),
    outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  const parent = path.join(f.root, 'extensions');
  fs.symlinkSync(outside, parent);
  assert.throws(() => f.prepare(), /unsafe or invalid/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(parent);
  const worktrees = path.join(f.root, 'worktrees');
  fs.symlinkSync(outside, worktrees);
  assert.throws(() => f.prepare(), /unsafe or invalid/);
  fs.unlinkSync(worktrees);
  fs.mkdirSync(worktrees, { mode: 0o755 });
  fs.chmodSync(worktrees, 0o755);
  assert.throws(() => f.prepare(), /unsafe or invalid/);
  assert.equal(fs.statSync(worktrees).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(f.file), false);
});
