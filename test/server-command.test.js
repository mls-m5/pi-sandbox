import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run } from '../src/util.js';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
test('pis --server forwards only server options to the fixed launcher, preserving argument boundaries and exit code', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-server-alias-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const capture = path.join(base, 'args');
  fs.writeFileSync(path.join(base, 'bash'), '#!/bin/bash\nprintf "%s\\0" "$@" > "$CAPTURE"\nexit 17\n', { mode: 0o700 });
  const home = path.join(base, 'pis-home');
  const env = { PATH: base, HOME: base, PIS_HOME: home, CAPTURE: capture };
  const args = ['--project', 'project with spaces', '--project', 'other', '--port', '43129'];
  const result = spawnSync(process.execPath, [cli, '--server', ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').split('\0').slice(0, -1), [fileURLToPath(new URL('../start_server.sh', import.meta.url)), ...args]);
  assert.equal(fs.existsSync(home), false);
  fs.unlinkSync(capture);
  for (const extra of [['--exec', 'touch bad'], ['--project'], ['--agent', 'claude'], ['--', 'command']]) {
    assert.equal(spawnSync(process.execPath, [cli, '--server', ...extra], { env }).status, 1);
    assert.equal(fs.existsSync(capture), false);
  }
});
test('process runner permits an explicit cleanup grace period without changing normal termination status', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-server-grace-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ready = path.join(base, 'ready'), done = path.join(base, 'done');
  const code = `const fs = require('fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(done)}, 'clean'); process.exit(0); }, 100)); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const pending = run(process.execPath, ['-e', code], { shutdownTimeoutMs: 2000, stdio: 'ignore' });
  for (let i = 0; i < 300 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready));
  process.emit('SIGTERM');
  assert.equal(await pending, 143);
  assert.equal(fs.readFileSync(done, 'utf8'), 'clean');
});

test('server help works before the normal Node version gate without storage, web imports or downloads', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-server-help-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process.versions, 'node', { value: '20.20.2' });")}`;
  const result = spawnSync(process.execPath, ['--import', preload, cli, '--server', '--help'], { env: { PATH: '/usr/bin:/bin', HOME: home, PIS_HOME: path.join(home, 'storage') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--project NAME/);
  assert.equal(fs.existsSync(path.join(home, 'storage')), false);
  assert.doesNotMatch(result.stderr, /download|Unsupported|Node.js 22/);
});
