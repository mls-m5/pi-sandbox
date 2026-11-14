import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../gnome-codex-usage/', import.meta.url));
const script = path.join(source, 'install.sh');
const files = ['metadata.json', 'extension.js', 'usage-format.js', 'usage-display.js'];
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-gnome-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home with spaces'); fs.mkdirSync(home);
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [script, ...args], { cwd: '/tmp', env: { PATH: '/usr/bin:/bin', HOME: home, ...extra }, encoding: 'utf8' });
  return { base, home, run };
}
test('GNOME installer copies all runtime files from any cwd, preserves unrelated files and supports repeat installs', { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t);
  const target = path.join(f.home, '.local/share/gnome-shell/extensions/codex-usage@pis');
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'keep-me'), 'untouched');
  for (let pass = 0; pass < 2; pass++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No Shell restart, logout or extension toggle was performed/);
    for (const file of files) {
      assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), fs.readFileSync(path.join(source, file), 'utf8'));
      assert.equal(fs.statSync(path.join(target, file)).mode & 0o777, 0o644);
    }
    assert.equal(fs.readFileSync(path.join(target, 'keep-me'), 'utf8'), 'untouched');
  }
});
test('GNOME installer respects absolute XDG data directory and refuses relative paths or symlink destinations', { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t), data = path.join(f.base, 'custom data');
  assert.equal(f.run([], { XDG_DATA_HOME: data }).status, 0);
  const target = path.join(data, 'gnome-shell/extensions/codex-usage@pis');
  assert.ok(fs.existsSync(path.join(target, 'usage-display.js')));
  assert.equal(fs.existsSync(path.join(f.home, '.local')), false);
  assert.equal(f.run([], { XDG_DATA_HOME: 'relative' }).status, 1);
  const victim = path.join(f.base, 'untouched'); fs.writeFileSync(victim, 'private');
  fs.unlinkSync(path.join(target, 'extension.js')); fs.symlinkSync(victim, path.join(target, 'extension.js'));
  assert.equal(f.run([], { XDG_DATA_HOME: data }).status, 1);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'private');
});
test('GNOME installer help has no install side effects and unknown flags are rejected', t => {
  const f = fixture(t);
  assert.equal(f.run(['--help']).status, 0);
  assert.equal(f.run(['--restart']).status, 2);
  assert.equal(fs.existsSync(path.join(f.home, '.local')), false);
});
