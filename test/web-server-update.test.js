import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServerUpdater, publicGithubUrl } from '../web/server-update.js';
import { hashPassword, randomKey } from '../web/common.js';
const old = 'a'.repeat(40), next = 'b'.repeat(40);
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-server-update-')); fs.mkdirSync(path.join(root, '.git'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; let restarts = 0;
  const run = async args => {
    calls.push(args);
    if (args[0] === 'rev-parse') return args[1] === '--show-toplevel' ? root : args[1] === 'HEAD' ? old : options.target || next;
    if (args[0] === 'config') return args.includes('--list') ? options.config || '' : args.at(-1) === 'remote.origin.url' ? options.url || 'https://github.com/example/pis.git' : args.at(-1).endsWith('.remote') ? 'origin' : 'refs/heads/main';
    if (args[0] === 'status') return options.dirty ? ' M README.md' : '';
    if (args[0] === 'symbolic-ref') return 'main';
    if (args[0] === 'diff') return options.dependencies ? 'web/package-lock.json' : '';
    if (args[0] === options.fail) throw new Error('raw secret stderr must not be copied');
    return '';
  };
  const updater = createServerUpdater({ root, enabled: options.enabled !== false, run, validateCandidate: async () => { if (options.invalid) throw new Error('syntax failure'); }, restart: async () => { restarts++; } });
  return { updater, calls, restarts: () => restarts };
}
async function finish(updater) { for (let i = 0; i < 100; i++) { const status = updater.status(); if (['current', 'failed', 'restarting'].includes(status.phase)) return status; await new Promise(resolve => setImmediate(resolve)); } throw new Error('update deadline'); }
test('only public exact HTTPS GitHub repository sources are allowed', () => {
  assert.ok(publicGithubUrl('https://github.com/example/pis.git'));
  for (const url of ['git@github.com:x/y', 'https://user:secret@github.com/x/y', 'https://github.com/x/y?token=x', 'https://github.com/x/y/../z', 'http://github.com/x/y', 'https://evil.invalid/x/y', 'https://github.com:443/x/y', 'https://github.com/x/y\nother']) assert.equal(publicGithubUrl(url), false);
});
test('explicit update uses isolated fetch ref, validates and fast-forwards before one restart', async t => {
  const f = fixture(t); assert.ok(f.updater.start()); assert.equal(f.updater.start(), false);
  assert.equal((await finish(f.updater)).phase, 'restarting'); assert.equal(f.restarts(), 1); assert.equal(f.updater.start(), false);
  assert.ok(f.calls.some(args => args[0] === 'fetch' && args.includes('--no-write-fetch-head') && args.at(-1).includes(':refs/pis-server-updates/')));
  assert.deepEqual(f.calls.find(args => args[0] === 'merge'), ['merge', '--ff-only', '--no-edit', '--no-stat', next]);
});
test('dirty trees, unsafe config/source, divergence, dependencies and invalid candidates never activate', async t => {
  for (const options of [{ dirty: true }, { config: 'filter.x.smudge=host-command' }, { config: 'include.path=other' }, { config: 'url.https://evil.invalid/.insteadof=https://github.com/' }, { url: 'https://user:secret@github.com/x/y' }, { fail: 'merge-base' }, { dependencies: true }, { invalid: true }]) {
    const f = fixture(t, options); f.updater.start(); const status = await finish(f.updater);
    assert.equal(status.phase, 'failed'); assert.equal(f.restarts(), 0); assert.ok(!f.calls.some(args => args[0] === 'merge')); assert.ok(!JSON.stringify(status).includes('secret'));
  }
  const current = fixture(t, { target: old }); current.updater.start(); assert.equal((await finish(current.updater)).phase, 'current'); assert.equal(current.restarts(), 0);
  assert.equal(fixture(t, { enabled: false }).updater.start(), false);
});
const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
test('server update requires browser authentication, Origin, CSRF and explicit confirmation; never a machine key', { skip: !installed }, async t => {
  const { startWebServer } = await import('../web/server.js'); let starts = 0;
  const password = randomKey(), server = await startWebServer({ port: 0, passwordHash: await hashPassword(password), updater: { status: () => ({ phase: 'idle' }), start: () => { starts++; return true; } } });
  t.after(() => server.close());
  const post = (route, value, headers = {}) => fetch(server.origin + route, { method: 'POST', headers: { Connection: 'close', Origin: server.origin, 'X-Pis-Web': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await post('/server/update', { confirm: true })).status, 403);
  const login = await post('/login', { password }), credentials = { Cookie: login.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': (await login.json()).csrf };
  assert.equal((await post('/server/update', { confirm: true }, { Cookie: credentials.Cookie })).status, 403);
  assert.equal((await post('/server/update', { confirm: true }, { ...credentials, Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await post('/server/update', { confirm: true }, { ...credentials, Authorization: `Bearer ${randomKey()}` })).status, 403);
  assert.equal((await post('/server/update', {}, credentials)).status, 400);
  assert.equal(starts, 0);
  assert.equal((await post('/server/update', { confirm: true }, credentials)).status, 202); assert.equal(starts, 1);
});
test('supervisor retains only password hash over explicit restart and does not restart ordinary exits', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-supervisor-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(new URL('../web/supervisor.js', import.meta.url), path.join(root, 'supervisor.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'cli.js'), `import fs from 'node:fs';
const file = new URL('./started', import.meta.url); const second = fs.existsSync(file); fs.writeFileSync(file, 'started');
process.once('message', message => {
 if (!second) { if (message.passwordHash) process.exit(2); process.send({type:'password_hash',passwordHash:{salt:'a'.repeat(64),hash:'b'.repeat(128)}}); process.send({type:'restart_server'}, () => process.disconnect()); }
 else { if (message.passwordHash?.hash !== 'b'.repeat(128)) process.exit(3); console.log('restarted'); process.disconnect(); }
}); process.send({type:'supervisor_ready'});`);
  const child = spawn(process.execPath, [path.join(root, 'supervisor.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); }); let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.resume();
  const [code] = await once(child, 'close'); assert.equal(code, 0); assert.equal(output.trim(), 'restarted');
});
