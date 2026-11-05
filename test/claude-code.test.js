import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { completeConfig, defaults, validate } from '../src/config.js';
import { parse } from '../src/cli.js';
import { imagePlan, launchArgs, interactiveOutput, podmanEnvironment } from '../src/container.js';
import { CLAUDE_VERSION, claudeCommand, claudeNeedsLogin, claudeLoginEnvironment, claudeState, loginClaude, logoutClaude, requireClaudeLogin } from '../src/claude-code.js';

const record = { claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 1900000000000, scopes: ['user:inference'], subscriptionType: 'max' } };

async function fixture(t) {
  const base = fs.mkdtempSync('/tmp/pis-claude-test-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const binary = path.join(base, 'official-claude'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root);
  const execute = async (program, args, options) => {
    assert.equal(program, binary);
    assert.deepEqual(args, ['auth', 'login']);
    assert.notEqual(options.cwd, root);
    assert.equal(options.cwd, options.env.CLAUDE_CONFIG_DIR);
    fs.writeFileSync(path.join(options.cwd, '.credentials.json'), JSON.stringify({ ...record, apiKey: 'must-not-copy' }), { mode: 0o600 });
    fs.writeFileSync(path.join(options.cwd, 'settings.json'), '{"hooks":{"malicious":true}}');
    fs.writeFileSync(path.join(options.cwd, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fake-account' }, mcpServers: { untrusted: {} }, hasCompletedOnboarding: true }));
    return 0;
  };
  return { base, binary, store, config, execute };
}

test('Claude agent selection preserves Pi defaults and isolates image/state/proxy arguments', () => {
  const pi = defaults('abc12', '/work/project');
  assert.equal(pi.agent, 'pi');
  assert.equal(completeConfig({ credentials: { env: [] } }).agent, 'pi');
  const config = { ...pi, agent: 'claude' };
  validate(config, { paths: false });
  assert.throws(() => validate({ ...config, agent: 'other' }, { paths: false }), /agent must/);
  assert.equal(parse(['--agent', 'claude', '--', '-p', 'hello']).agent, 'claude');
  assert.equal(parse(['--agent=claude', '--build']).action, 'build');
  assert.equal(parse(['--project', 'abc12', '--login-claude']).action, 'login-claude');
  assert.throws(() => parse(['--agent', 'other']), /--agent must/);
  assert.throws(() => parse(['--agent', 'claude', '--login-claude']), /--agent is only/);
  assert.deepEqual(claudeCommand(), ['claude']);
  assert.deepEqual(claudeCommand(['--continue']), ['claude', '--continue']);
  assert.equal(claudeNeedsLogin(['--version']), false);
  assert.equal(claudeNeedsLogin(['auth', 'status']), false);
  assert.equal(claudeNeedsLogin(['-p', 'hello']), true);
  assert.equal(interactiveOutput(['claude', '-p', 'hello']), false);
  assert.equal(interactiveOutput(['claude', '--output-format', 'stream-json', '-p', 'hello']), false);
  assert.equal(interactiveOutput(['claude']), true);
  const image = imagePlan(config);
  assert.match(image.content, new RegExp(`@anthropic-ai/claude-code@${CLAUDE_VERSION.replaceAll('.', '\\.')}`));
  assert.match(image.content, /--ignore-scripts.*claude-code.*&& node .*install\.cjs/);
  assert.notEqual(image.image, imagePlan(pi).image);
  assert.doesNotMatch(imagePlan(pi).content, /@anthropic-ai\/claude-code/);
  const store = { projectDir: () => '/storage/projects/abc12' };
  const { args } = launchArgs(store, config, ['claude', '-p', 'hello'], { cwd: config.root, image: image.image, tty: false, stdinIsTTY: true });
  assert.ok(args.includes('/storage/projects/abc12/claude-state:/pis/home:rw'));
  assert.ok(!args.includes('/storage/projects/abc12/state:/pis/home:rw'));
  assert.ok(args.includes('CLAUDE_CONFIG_DIR=/pis/home/.claude'));
  assert.ok(args.includes('DISABLE_UPDATES=1'));
  assert.ok(!args.includes('--interactive'));
  assert.ok(!args.some(arg => /PIS_PROXY|PIS_APT|OPENAI_API_KEY|ANTHROPIC_API_KEY|\/auth\//.test(arg)));
  assert.throws(() => launchArgs(store, config, ['claude'], { cwd: config.root, proxy: {} }), /does not use Pi/);
});

test('host login copies only OAuth to writable project state; startup preserves refreshed tokens', async t => {
  const { store, config, binary, execute } = await fixture(t);
  await loginClaude(store, config, { binary, execute });
  const state = requireClaudeLogin(store, config.id);
  const snapshot = path.join(store.root, 'auth', `claude-${config.id}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.credential)), record);
  assert.deepEqual(fs.readdirSync(state.config).sort(), ['.claude.json', '.credentials.json']);
  const preferences = path.join(state.config, '.claude.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences)), { oauthAccount: { accountUuid: 'fake-account' } });
  fs.writeFileSync(preferences, JSON.stringify({ oauthAccount: { accountUuid: 'old-account' }, theme: 'dark' }));
  await loginClaude(store, config, { binary, execute });
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences)), { oauthAccount: { accountUuid: 'fake-account' }, theme: 'dark' });
  assert.equal(fs.statSync(state.config).mode & 0o777, 0o700);
  assert.equal(fs.statSync(state.credential).mode & 0o777, 0o600);
  const refreshed = { claudeAiOauth: { ...record.claudeAiOauth, accessToken: 'refreshed-in-sandbox' } };
  fs.writeFileSync(state.credential, JSON.stringify(refreshed));
  requireClaudeLogin(store, config.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.credential)), refreshed);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot)), record);
  assert.ok(!fs.readdirSync(path.dirname(snapshot)).some(name => name.startsWith('claude-login-')));
  fs.writeFileSync(path.join(state.config, 'history.jsonl'), 'keep history');
  await logoutClaude(store, config.id);
  assert.ok(!fs.existsSync(state.credential));
  assert.ok(!fs.existsSync(snapshot));
  assert.ok(fs.existsSync(path.join(state.config, 'history.jsonl')));
});

test('Claude login fails safely for malformed/private-file violations and sandbox-controlled destinations', async t => {
  const { base, store, config, binary, execute } = await fixture(t);
  await loginClaude(store, config, { binary, execute });
  const state = claudeState(store, config.id);
  const original = fs.readFileSync(state.credential, 'utf8');
  for (const content of ['{ secret-not-in-errors', '{}']) {
    await assert.rejects(loginClaude(store, config, { binary, execute: async (_program, _args, { cwd }) => {
      fs.writeFileSync(path.join(cwd, '.credentials.json'), content, { mode: 0o600 }); return 0;
    } }), error => /Cannot read Claude subscription/.test(error.message) && !error.message.includes('secret-not-in-errors'));
    assert.equal(fs.readFileSync(state.credential, 'utf8'), original);
  }
  await assert.rejects(loginClaude(store, config, { binary, execute: async () => 1 }), /sign-in failed/);
  for (const kind of ['public', 'symlink', 'hardlink']) {
    await assert.rejects(loginClaude(store, config, { binary, execute: async (_program, _args, { cwd }) => {
      const credential = path.join(cwd, '.credentials.json');
      if (kind === 'symlink') fs.symlinkSync(state.credential, credential);
      else if (kind === 'hardlink') fs.linkSync(state.credential, credential);
      else fs.writeFileSync(credential, JSON.stringify(record), { mode: 0o644 });
      return 0;
    } }), /Cannot read Claude subscription/);
  }
  const outside = path.join(base, 'outside'); fs.writeFileSync(outside, 'unchanged');
  fs.rmSync(state.credential); fs.symlinkSync(outside, state.credential);
  await assert.rejects(loginClaude(store, config, { binary, execute }), /not a symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  fs.rmSync(state.credential); fs.rmSync(state.config, { recursive: true }); fs.symlinkSync(base, state.config);
  await assert.rejects(loginClaude(store, config, { binary, execute }), /not a symlink/);
  const untrusted = path.join(config.root, 'claude'); fs.copyFileSync(binary, untrusted); fs.chmodSync(untrusted, 0o700);
  await assert.rejects(loginClaude(store, config, { binary: untrusted, execute }), /sandbox-writable/);
  await store.projectLock(config.id, () => assert.rejects(loginClaude(store, config, { binary, execute }), /Resource is busy/));
});

test('CLI Claude launch bypasses the configured Codex proxy without host credentials or approval sockets', async t => {
  const { base, store, config } = await fixture(t);
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
    else if (args[0] === 'run') console.log(JSON.stringify({ args, hostKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) }));
    else if (args[0] === 'container') process.exitCode = 1;
  `, { mode: 0o700 });
  const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: config.root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PIS_HOME: store.root, PIS_AUTO_PRUNE: '0', PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'test-only-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-only-token' },
  });
  const shown = invoke(['--agent', 'claude', '--show']);
  assert.equal(shown.status, 0, shown.stderr);
  const report = JSON.parse(shown.stdout);
  assert.equal(report.config.agent, 'claude');
  assert.equal(report.credentialSource.kind, 'sandbox-oauth-copy');
  assert.deepEqual(report.credentialVariables, []);
  const launched = invoke(['--agent', 'claude', '--', '--version']);
  assert.equal(launched.status, 0, launched.stderr);
  const result = JSON.parse(launched.stdout);
  assert.equal(result.hostKeyPresent, false);
  assert.deepEqual(result.args.slice(-3), ['/opt/pis/image-entry.mjs', 'claude', '--version']);
  assert.ok(result.args.some(arg => arg.endsWith('/claude-state:/pis/home:rw')));
  assert.ok(!result.args.some(arg => /PIS_PROXY|PIS_APT/.test(arg)));
  assert.equal(store.load(config.id).agent, 'pi'); // CLI override is not persisted.
  const missing = invoke(['--agent', 'claude', '--', '-p', 'not-a-real-request']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /pis --login-claude/);
  assert.ok(!missing.stdout);
});

test('Claude environment selection never inherits API keys or alternative auth modes', () => {
  const env = claudeLoginEnvironment('/host-only/config', {
    PATH: '/usr/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_OAUTH_TOKEN: 'fake-token',
    ANTHROPIC_BASE_URL: 'https://untrusted.example', CLAUDE_CONFIG_DIR: '/untrusted', PIS_PROXY_TOKEN: 'fake-proxy', NODE_OPTIONS: '--require untrusted.js',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/test', CLAUDE_CONFIG_DIR: '/host-only/config', DISABLE_UPDATES: '1' });
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-key';
  try { assert.equal(podmanEnvironment(defaults('abc12', '/work/project')).ANTHROPIC_API_KEY, undefined); }
  finally { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; }
});
