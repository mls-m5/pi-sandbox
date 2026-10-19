import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));

test('real rootless Podman: build, identity, mounts, credentials, state, Pi, pipes, exit codes', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 600_000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-integration-'));
  let image, projectId;
  t.after(() => {
    if (projectId) {
      const containers = spawnSync('podman', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '';
      for (const name of containers.trim().split('\n').filter(name => name.startsWith(`pis-${projectId}-`))) {
        spawnSync('podman', ['rm', '--force', '--time', '1', name], { stdio: 'ignore', timeout: 15_000 });
      }
    }
    if (image) spawnSync('podman', ['rmi', image], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'project with spaces'), shared = path.join(base, 'shared'), writable = path.join(base, 'writable');
  for (const dir of [root, shared, writable]) fs.mkdirSync(dir);
  const sub = path.join(root, 'sub'); fs.mkdirSync(sub);
  const outside = path.join(base, 'host-only'); fs.writeFileSync(outside, 'must not be exposed');
  const env = { ...process.env, PIS_HOME: path.join(base, 'storage'), OPENAI_API_KEY: 'dummy-integration-key', PIS_UNSELECTED_SECRET: 'must-not-leak' };
  const invoke = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 500_000, maxBuffer: 16 * 1024 * 1024, ...options });
  const success = (args, options) => {
    const result = invoke(args, options);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  success(['--doctor']);
  success(['--new', '--name', 'integration']);
  const shown = JSON.parse(success(['--show']).stdout);
  const config = shown.config;
  projectId = config.id;
  // Keep coverage for explicitly opted-in legacy/direct credential forwarding.
  config.credentials = { env: ['OPENAI_API_KEY'] };
  config.image.packages = ['jq'];
  config.image.extraInstructions = ['RUN printf customization-works > /opt/pis-build-marker'];
  config.mounts = [{ source: shared }, { source: writable, access: 'read-write' }];
  fs.writeFileSync(shown.configurationFile, JSON.stringify(config));
  image = JSON.parse(success(['--show']).stdout).image;
  success(['--build']);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(shown.configurationFile), 'build')), ['Containerfile']);

  const script = `
    const fs = require('fs');
    const result = { uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(), key: process.env.OPENAI_API_KEY, leaked: process.env.PIS_UNSELECTED_SECRET, outside: fs.existsSync(${JSON.stringify(outside)}), customization: fs.readFileSync('/opt/pis-build-marker', 'utf8') };
    fs.writeFileSync('created.txt', 'project-write');
    try { fs.writeFileSync(${JSON.stringify(path.join(shared, 'must-not-write'))}, 'no'); result.readOnly = false; } catch { result.readOnly = true; }
    fs.writeFileSync(${JSON.stringify(path.join(writable, 'allowed'))}, 'yes');
    fs.writeFileSync(process.env.HOME + '/state-marker', 'persistent');
    console.log(JSON.stringify(result));
  `;
  const execution = success(['--exec', '--', 'node', '-e', script], { cwd: sub });
  const result = JSON.parse(execution.stdout);
  assert.equal(result.uid, process.getuid());
  assert.equal(result.gid, process.getgid());
  assert.equal(result.cwd, sub);
  assert.equal(result.key, env.OPENAI_API_KEY);
  assert.equal(result.leaked, undefined);
  assert.equal(result.outside, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.customization, 'customization-works');
  assert.equal(fs.statSync(path.join(sub, 'created.txt')).uid, process.getuid());
  assert.equal(fs.readFileSync(path.join(writable, 'allowed'), 'utf8'), 'yes');
  assert.equal(success(['--exec', '--', 'bash', '-c', 'cat "$HOME/state-marker"']).stdout, 'persistent');
  assert.equal(success(['--exec', '--', 'jq', '--version']).stdout.trim().startsWith('jq-'), true);
  assert.equal(success(['--exec', '--', 'cat'], { input: 'piped-input\n' }).stdout, 'piped-input\n');
  const failure = invoke(['--exec', '--', 'bash', '-c', 'printf failure >&2; exit 7']);
  assert.equal(failure.status, 7, failure.stderr);
  assert.match(failure.stderr, /failure/);
  assert.match(success(['--', '--version']).stdout, /1\.2\.0/);
  assert.match(success(['--fresh', '--', '--help']).stdout, /continue/);
  // script(1) allocates a real terminal, exercising --tty and interactive Bash.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const terminal = spawnSync('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(cli)} --bash`, '/dev/null'], { cwd: sub, env, input: 'printf "shell-test:%s\\n" "$PWD"; exit\n', encoding: 'utf8', timeout: 30_000 });
  assert.equal(terminal.status, 0, terminal.stdout + terminal.stderr);
  assert.ok(terminal.stdout.includes(`shell-test:${sub}`), terminal.stdout);

  // A live project is exclusive; terminating its client must remove its container and lock.
  const ready = path.join(root, 'signal-ready');
  const child = spawn(process.execPath, [cli, '--exec', '--', 'node', '-e', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErrors = '';
  child.stderr.on('data', chunk => { childErrors += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  for (let i = 0; i < 300 && !fs.existsSync(ready) && child.exitCode === null; i++) await delay(100);
  assert.ok(fs.existsSync(ready), childErrors || 'Signal test did not start.');
  const busy = invoke(['--exec', '--', 'true']);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /busy/);
  child.kill('SIGTERM');
  const timer = delay(30_000, null, { ref: false }).then(() => { throw new Error('Interrupted pis did not exit.'); });
  const ended = await Promise.race([exited, timer]);
  assert.equal(ended.code, 143, childErrors);
  assert.ok(!fs.existsSync(path.join(path.dirname(shown.configurationFile), 'project.lock')));
  const inspect = spawnSync('podman', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  assert.ok(!inspect.stdout.includes(`pis-${config.id}-`));
});
