import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { CLAUDE_VERSION, claudeState } from '../src/claude-code.js';
import { imagePlan, launch } from '../src/container.js';

test('real Podman Claude: native binary, separate writable login state and no host auth mount (no model requests)', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 500_000 }, async t => {
  const base = fs.mkdtempSync('/tmp/pis-claude-integration-');
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const original = await store.register(root);
  const config = { ...original, agent: 'claude', extensions: [] };
  await store.save(config, original);
  const image = imagePlan(config).image;
  t.after(() => {
    spawnSync('podman', ['rmi', image], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const state = claudeState(store, config.id);
  const fakeLogin = { claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 1900000000000 } };
  fs.writeFileSync(state.credential, JSON.stringify(fakeLogin), { mode: 0o600 });
  const options = { cwd: root, network: 'none', stdio: 'ignore', mode: 'exec' };
  // Only --version is run on the official binary, with container networking disabled.
  const script = `
    const fs = require('fs'), cp = require('child_process');
    const version = cp.spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) process.exit(2);
    const file = process.env.CLAUDE_CONFIG_DIR + '/.credentials.json';
    const login = JSON.parse(fs.readFileSync(file));
    login.claudeAiOauth.accessToken = 'refreshed-fake-access';
    fs.writeFileSync(file, JSON.stringify(login));
    fs.writeFileSync('claude-report.json', JSON.stringify({
      version: version.stdout, uid: process.getuid(), cwd: process.cwd(),
      proxy: process.env.PIS_PROXY_TOKEN, approval: process.env.PIS_APT_SOCKET,
      hostAuthVisible: fs.existsSync(${JSON.stringify(path.join(store.root, 'auth'))})
    }));
  `;
  assert.equal(await launch(store, config, { ...options, args: ['node', '-e', script] }), 0);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'claude-report.json')));
  assert.ok(report.version.includes(CLAUDE_VERSION));
  assert.equal(report.uid, process.getuid());
  assert.equal(report.cwd, root);
  assert.equal(report.proxy, undefined);
  assert.equal(report.approval, undefined);
  assert.equal(report.hostAuthVisible, false);
  assert.equal(JSON.parse(fs.readFileSync(state.credential)).claudeAiOauth.accessToken, 'refreshed-fake-access');
  assert.equal(await launch(store, config, { ...options, args: ['node', '-e', `if (JSON.parse(require('fs').readFileSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json')).claudeAiOauth.accessToken !== 'refreshed-fake-access') process.exit(1)`] }), 0);
});
