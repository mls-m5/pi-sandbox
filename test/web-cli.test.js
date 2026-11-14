import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomKey } from '../web/common.js';

const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
test('web demo CLI starts two fixed dummies, keeps secrets out of output and shuts down on SIGTERM', { skip: !installed, timeout: 15_000 }, async t => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const password = randomKey();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../web/cli.js', import.meta.url)), 'demo', '--password-stdin', '--port', String(port), '--agents', '2'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/nonexistent-pis-web-test-home', TERM: 'dumb' },
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
  assert.equal(child.exitCode, 0);
  assert.equal(stdout, '');
  assert.ok(!output.includes(password));
  assert.match(output, /2 utgående dummy-anslutningar/);
});
