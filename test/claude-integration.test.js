import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { CLAUDE_VERSION, saveClaudeToken } from '../src/claude-code.js';
import { imagePlan, launch } from '../src/container.js';

test('real Podman Claude: native binary and host-held token through the private socket (fake upstream, no model requests)', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 500_000 }, async t => {
  const base = fs.mkdtempSync('/tmp/pis-claude-integration-');
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const original = await store.register(root);
  const config = { ...original, agent: 'claude', extensions: [] };
  await store.save(config, original);
  const token = `sk-ant-oat01-${'f'.repeat(40)}`;
  await saveClaudeToken(store, token);
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[]}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const image = imagePlan(config).image;
  t.after(() => {
    upstream.close();
    spawnSync('podman', ['rmi', image], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  });
  // Container networking is disabled: the only route out is the mounted host socket.
  const options = { cwd: root, network: 'none', stdio: 'ignore', mode: 'exec', claudeUpstream: `http://127.0.0.1:${upstream.address().port}` };
  const script = `
    const fs = require('fs'), cp = require('child_process'), http = require('http');
    const version = cp.spawnSync('claude', ['--version'], { encoding: 'utf8' });
    const req = http.request({ socketPath: process.env.ANTHROPIC_UNIX_SOCKET, method: 'POST', path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.CLAUDE_CODE_OAUTH_TOKEN } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
        fs.writeFileSync('claude-report.json', JSON.stringify({
          version: version.stdout, status: res.statusCode, body, uid: process.getuid(), cwd: process.cwd(),
          env: JSON.stringify(process.env), credentialFile: fs.existsSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json'),
          hostAuthVisible: fs.existsSync(${JSON.stringify(path.join(store.root, 'auth'))}),
        }));
      });
    });
    req.end('{"model":"fake"}');
  `;
  assert.equal(await launch(store, config, { ...options, args: ['node', '-e', script] }), 0);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'claude-report.json')));
  assert.ok(report.version.includes(CLAUDE_VERSION));
  assert.equal(report.status, 200);
  assert.equal(report.uid, process.getuid());
  assert.equal(report.cwd, root);
  assert.equal(report.credentialFile, false);
  assert.equal(report.hostAuthVisible, false);
  assert.ok(!report.env.includes(token));
  assert.deepEqual(seen, [{ url: '/v1/messages?beta=true', authorization: `Bearer ${token}` }]);
});
