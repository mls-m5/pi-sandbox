import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomKey } from '../web/common.js';

const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
test('empty password input generates a fresh one-time displayed password that actually authenticates', { skip: !installed, timeout: 15000 }, async t => {
  const passwords = [];
  for (let run = 0; run < 2; run++) {
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../web/cli.js', import.meta.url)), 'demo', '--password-stdin', '--port', String(port), '--agents', '1'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: '/nonexistent-pis-web-test-home', TERM: 'dumb' },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stdin.end(run === 0 ? '\n' : ''); // Explicit empty line or EOF with explicit --password-stdin.
    for (let i = 0; i < 500 && !stderr.includes('Lokal dummy-webb:') && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const match = /Genererat tillfälligt adminlösenord \(visas en gång\):\n([A-Za-z0-9_-]{43})\n/.exec(stderr);
    assert.ok(match, 'A 256-bit base64url password must be printed once for empty input.');
    const password = match[1]; passwords.push(password);
    assert.equal(stderr.split(password).length - 1, 1); assert.ok(stderr.includes('omdirigerad stderr')); assert.equal(stdout, '');
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password }) });
    assert.equal(response.status, 200);
    const empty = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password: '' }) });
    assert.equal(empty.status, 401, 'Empty browser login must never bypass authentication.');
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; assert.equal(child.exitCode, 0);
  }
  assert.ok(passwords[0] !== passwords[1], 'Restarting with empty input must rotate the generated password.');
});

test('pis --server --standalone starts a private empty registry with no local runtimes', { skip: !installed, timeout: 15000 }, async t => {
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-standalone-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--server', '--standalone', '--password-stdin', '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: root, PIS_HOME: root } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stderr.on('data', data => { output += data; }); child.stdout.resume();
  const password = randomKey(); child.stdin.end(`${password}\n`);
  for (let index = 0; index < 500 && !output.includes('Fristående lokal webbserver:') && child.exitCode === null; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(output, /Fristående lokal webbserver:/); assert.ok(!output.includes(password)); assert.ok(!output.includes('utgående dummy'));
  const origin = `http://127.0.0.1:${port}`, response = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  const { default: WebSocket } = await import('../web/node_modules/ws/wrapper.mjs');
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/browser`, { headers: { Origin: origin, Cookie: response.headers.getSetCookie()[0].split(';')[0] } });
  t.after(() => ws.terminate()); const [message] = await once(ws, 'message'); assert.deepEqual(JSON.parse(message).agents, []); ws.terminate();
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; assert.equal(child.exitCode, 143);
});

test('pis --server starts two fixed dummies, keeps secrets out of output and shuts down on SIGTERM', { skip: !installed, timeout: 15_000 }, async t => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const password = randomKey();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--server', '--diagnostics', '--password-stdin', '--port', String(port), '--agents', '2'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: '/nonexistent-pis-web-test-home', TERM: 'dumb' },
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local web CLI startup deadline.')), 5000);
    child.stderr.on('data', chunk => {
      output += chunk;
      if (output.includes('Lokal dummy-webb:')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Local web CLI spawn failed.')); });
    child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Local web CLI exited before readiness.')); });
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.end(`${password}\n`);
  await ready;
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password }) })).status, 200);
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  assert.equal(child.exitCode, 143); // Top-level launcher preserves termination status after cleanup.
  assert.equal(stdout, '');
  assert.ok(!output.includes(password));
  assert.match(output, /2 utgående dummy-anslutningar/);
  assert.match(output, /pis web diagnostic:/);
});
