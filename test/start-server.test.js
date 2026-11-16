import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, { installed = true, node, bundled, npm = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-start-server-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout with spaces'), bin = path.join(base, 'bin'), home = path.join(base, 'home');
  fs.mkdirSync(root); fs.mkdirSync(bin); fs.mkdirSync(home);
  fs.copyFileSync(new URL('../start_server.sh', import.meta.url), path.join(root, 'start_server.sh'));
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  if (installed) { fs.mkdirSync(path.join(root, 'web/node_modules/ws'), { recursive: true }); fs.writeFileSync(path.join(root, 'web/node_modules/ws/package.json'), '{}'); }
  const capture = path.join(base, 'arguments');
  const tool = (file, label, compatible) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/bash\nif [[ "\${1:-}" == '-e' ]]; then exit ${compatible ? 0 : 1}; fi\nprintf '%s\\0' '${label}' "$@" > "$CAPTURE"\nexit 17\n`, { mode: 0o700 });
  };
  if (node !== undefined) tool(path.join(bin, 'node'), 'path-node', node);
  if (bundled !== undefined) tool(path.join(home, '.local/share/pi-node/current/bin/node'), 'bundled-node', bundled);
  if (npm) tool(path.join(bin, 'npm'), 'npm', false);
  const run = (args = []) => spawnSync('/bin/bash', [path.join(root, 'start_server.sh'), ...args], { cwd: '/tmp', env: { PATH: bin, HOME: home, CAPTURE: capture }, encoding: 'utf8' });
  const recorded = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\0').slice(0, -1) : [];
  return { run, recorded, root };
}

test('server launcher prefers compatible PATH Node and preserves paths/arguments/exit status', t => {
  const f = fixture(t, { node: true, bundled: true });
  assert.equal(f.run(['--port', '43129', '--project', 'my-app', '--project', 'other-app']).status, 17);
  assert.deepEqual(f.recorded(), ['path-node', path.join(f.root, 'web/supervisor.js'), 'start', '--port', '43129', '--project', 'my-app', '--project', 'other-app']);
});

test('server launcher uses a compatible bundled Node when PATH Node is too old', t => {
  const f = fixture(t, { node: false, bundled: true });
  assert.equal(f.run().status, 17);
  assert.equal(f.recorded()[0], 'bundled-node');
});

test('server launcher falls back to npm Node 24 without installing/changing a default Node', t => {
  const f = fixture(t, { node: false, bundled: false });
  const result = f.run(['--password-stdin']);
  assert.equal(result.status, 17);
  assert.deepEqual(f.recorded(), ['npm', 'exec', '--yes', '--package=node@24', '--', 'node', path.join(f.root, 'web/supervisor.js'), 'start', '--password-stdin']);
  assert.match(result.stderr, /may download/);
});

test('server launcher fails with instructions when dependencies or usable tools are missing', t => {
  const missing = fixture(t, { installed: false });
  assert.equal(missing.run().status, 1);
  assert.match(missing.run().stderr, /npm --prefix web ci --ignore-scripts/);
  assert.deepEqual(missing.recorded(), []);
  const noTools = fixture(t, { node: false, npm: false });
  assert.equal(noTools.run().status, 1);
  assert.match(noTools.run().stderr, /working npm/);
});

test('server launcher help needs no dependency, downloads or password', t => {
  const f = fixture(t, { installed: false, npm: false });
  const result = f.run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dummy-only/);
  assert.deepEqual(f.recorded(), []);
});
