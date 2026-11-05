import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Store } from '../src/store.js';
import { applyAptProposal, startAptRequestServer, validateAptProposal, approveAptProposal, formatAptApproval } from '../src/apt-requests.js';
import { PassThrough, Writable } from 'node:stream';
import { launchArgs, restartOptions } from '../src/container.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-apt-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(dir, 'store'));
  const config = await store.register(root);
  return { store, config };
}

function send(file, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let response = '';
    socket.on('connect', () => socket.end(`${JSON.stringify(data)}\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(JSON.parse(response)));
    socket.on('error', reject);
  });
}

test('approval formatting provides full-width separators and optional terminal colors', () => {
  const proposal = { packages: ['curl', 'python3-venv'], reason: 'Run project tests' };
  const plain = formatAptApproval(proposal, '42', { columns: 32 });
  assert.ok(plain.text.includes('─'.repeat(32)));
  assert.ok(!plain.text.includes('─'.repeat(33)));
  assert.ok(!plain.text.includes('\x1b'));
  assert.match(plain.text, /Debian packages: curl, python3-venv/);
  assert.match(plain.prompt, /Type 42 to approve/);
  assert.match(plain.text, /uses model tokens/);
  const colored = formatAptApproval(proposal, '42', { columns: 120, color: true });
  assert.ok(colored.text.includes(`\x1b[31m${'─'.repeat(120)}\x1b[0m`));
  assert.ok(colored.text.includes('\x1b[1m'));
  assert.ok(colored.prompt.includes('\x1b[1;36m42\x1b[0m'));
  assert.equal(colored.text.replace(/\x1b\[[0-9;]*m/g, ''), formatAptApproval(proposal, '42', { columns: 120 }).text);
});

test('host approval requires the fresh challenge; Enter and ordinary yes decline', async () => {
  for (const response of ['challenge', '', 'yes', 'true', '000000']) {
    const input = new PassThrough();
    let transcript = '';
    const output = new Writable({ write(chunk, _encoding, done) {
      transcript += chunk.toString();
      const code = chunk.toString().match(/Type (\d{2}) to approve/);
      if (code) setImmediate(() => input.write(`${response === 'challenge' ? code[1] : response}\n`));
      done();
    } });
    const approved = await approveAptProposal({ packages: ['curl'], reason: 'test' }, { input, output });
    assert.equal(approved, response === 'challenge');
    assert.match(transcript, /Debian packages: curl/);
    assert.match(transcript, /untrusted/);
    input.destroy(); output.destroy();
  }
});

test('automatic restart resumes without replaying prompts or fresh/rebuild flags', () => {
  const original = { mode: 'pi', fresh: true, rebuild: true, cwd: '/project', args: ['--no-session', 'do this expensive task'] };
  const resumed = restartOptions(original);
  assert.deepEqual(resumed.args, ['--continue']);
  assert.equal(resumed.fresh, false);
  assert.equal(resumed.rebuild, false);
  assert.equal(resumed.buildOnly, false);
  assert.equal(resumed.cwd, original.cwd);
  assert.equal(original.fresh, true);
});

test('approved package restart sends one English user prompt without replaying the original task', () => {
  const original = { mode: 'pi', fresh: true, args: ['old prompt that must not be replayed'] };
  const resumed = restartOptions(original, ['curl', 'python3-venv']);
  assert.equal(resumed.args.length, 2);
  assert.equal(resumed.args[0], '--continue');
  assert.match(resumed.args[1], /\[pis\] The user approved the apt packages curl, python3-venv/);
  assert.match(resumed.args[1], /Continue the previous task/);
  assert.ok(!resumed.args.includes(original.args[0]));
  assert.deepEqual(resumed.installedPackages, ['curl', 'python3-venv']);
  const next = restartOptions(resumed, ['wget']);
  assert.match(next.args[1], /apt packages wget\./);
  assert.ok(!next.args[1].includes('curl'));
  assert.deepEqual(restartOptions(resumed).args, ['--continue']);
});

test('default packages, proposal validation and host save', async t => {
  const { store, config } = await fixture(t);
  assert.deepEqual(config.image.packages, ['build-essential', 'python3']);
  for (const proposal of [
    { packages: ['curl; rm -rf /'], reason: 'bad' },
    { packages: ['curl=1.0'], reason: 'version not allowed' },
    { packages: ['curl', 'curl'], reason: 'duplicate' },
    { packages: ['curl'], reason: 'bad\u001b[2J' },
    { packages: ['curl'], reason: 'bad\u202etext' },
    { packages: ['build-essential'], reason: 'already installed' },
    { packages: Array(11).fill('curl'), reason: 'too many' },
  ]) assert.throws(() => validateAptProposal({ type: 'apt-packages', ...proposal }, config, store));
  const proposed = validateAptProposal({ type: 'apt-packages', packages: ['python3', 'curl'], reason: 'network test' }, config, store);
  assert.deepEqual(proposed.packages, ['curl']);
  assert.throws(() => validateAptProposal({ type: 'git-push', packages: ['curl'], reason: 'wrong action' }, config, store), /Unsupported host action/);
  await applyAptProposal(store, config, proposed);
  assert.deepEqual(store.load(config.id).image.packages, ['build-essential', 'python3', 'curl']);
  await assert.rejects(applyAptProposal(store, config, { type: 'apt-packages', packages: ['git'], reason: 'stale' }), /changed/);
});

test('proposal socket accepts one bounded suggestion; cannot approve changes', async t => {
  const { store, config } = await fixture(t);
  const requests = await startAptRequestServer(config, store);
  t.after(() => requests.close());
  const socket = path.join(requests.directory, 'request.sock');
  assert.equal(fs.statSync(requests.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const args = launchArgs(store, { ...config, credentials: { env: [] } }, ['pi'], { cwd: config.root, image: 'test', aptRequests: requests }).args;
  assert.ok(args.includes(`${requests.directory}:/pis/apt:ro`));
  assert.ok(args.includes('PIS_APT_SOCKET=/pis/apt/request.sock'));
  assert.deepEqual(await send(socket, { type: 'git-push', remote: 'origin' }), { ok: false });
  assert.deepEqual(await send(socket, { type: 'apt-packages', packages: ['curl'], reason: 'task needs curl', approve: true }), { ok: false });
  assert.deepEqual(await send(socket, { type: 'apt-packages', packages: ['curl'], reason: 'task needs curl' }), { ok: true });
  assert.deepEqual(requests.proposal, { type: 'apt-packages', packages: ['curl'], reason: 'task needs curl' });
  assert.deepEqual(store.load(config.id).image.packages, ['build-essential', 'python3']);
  assert.deepEqual(await send(socket, { type: 'apt-packages', packages: ['vim'], reason: 'another request' }), { ok: false });
});

test('shared proposal service accepts a single allowlisted host Git command without executing it', async t => {
  const { store, config } = await fixture(t);
  const requests = await startAptRequestServer(config, store);
  t.after(() => requests.close());
  const socket = path.join(requests.directory, 'request.sock');
  const hash = 'a'.repeat(40);
  assert.deepEqual(await send(socket, { type: 'git-command', repo: '.', args: ['config', 'alias.x', '!evil'], reason: 'unsafe' }), { ok: false });
  assert.deepEqual(await send(socket, { type: 'git-command', repo: '.', args: ['push', 'origin', `${hash}:refs/heads/main`], reason: 'publish' }), { ok: true });
  assert.equal(requests.proposal.type, 'git-push');
  assert.equal(requests.proposal.commit, hash);
  assert.deepEqual(await send(socket, { type: 'apt-packages', packages: ['curl'], reason: 'second action' }), { ok: false });
  assert.deepEqual(store.load(config.id).image.packages, ['build-essential', 'python3']);
});

test('invalid proposals do not mutate host configuration or reserve the request slot', async t => {
  const { store, config } = await fixture(t);
  const requests = await startAptRequestServer(config, store);
  t.after(() => requests.close());
  const socket = path.join(requests.directory, 'request.sock');
  assert.deepEqual(await send(socket, { type: 'apt-packages', packages: ['bad;pkg'], reason: 'malicious' }), { ok: false });
  assert.equal(requests.proposal, undefined);
  assert.deepEqual(await send(socket, { type: 'apt-packages', packages: ['curl'], reason: 'legitimate' }), { ok: true });
  assert.deepEqual(store.load(config.id).image.packages, ['build-essential', 'python3']);
});
