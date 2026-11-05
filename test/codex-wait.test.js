import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';
import { launch, restartOptions } from '../src/container.js';
import { getCodexUsage, saveCodexCredential } from '../src/codex-auth.js';
import { codexUsageSummary } from '../src/codex-usage.js';
import { CODEX_RESUME_NOTICE, codexAvailability, requireSavedPiSession, validateCodexWait, waitForCodex, waitForCodexOnHost } from '../src/codex-wait.js';
import { fakeCodexCredential } from './fixtures/codex.js';

const quota = (primary, secondary = 20, flags = {}) => ({ rate_limit: {
  ...flags, primary_window: { used_percent: primary, reset_after_seconds: 120 },
  secondary_window: secondary === null ? null : { used_percent: secondary, reset_after_seconds: 86400 },
} });

async function fixture(t) {
  const base = fs.mkdtempSync('/tmp/pis-wait-test-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root);
  const sessions = path.join(store.projectDir(config.id), 'state/.pi/agent/sessions');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sessions, 'saved.jsonl'), '{"type":"session","version":3}\n');
  return { base, store, config, sessions };
}

test('Codex wait flag is opt-in and cannot replay a prompt, select another agent or enter protocol modes', () => {
  assert.equal(parse(['--wait-codex']).waitCodex, true);
  assert.equal(parse(['--project', 'abc12', '--agent', 'pi', '--wait-codex']).waitCodex, true);
  assert.equal(parse([]).waitCodex, undefined);
  for (const args of [['--wait-codex', '--fresh'], ['--wait-codex', '--wait-codex'], ['--wait-codex', '--build'], ['--wait-codex', '--codex-usage'], ['--wait-codex', '--bash'], ['--wait-codex', '--exec', '--', 'true'], ['--wait-codex', '--agent', 'claude'], ['--wait-codex', '--', '-p', 'task'], ['--wait-codex', '--', '--session', 'id']]) {
    assert.throws(() => parse(args), /wait-codex/);
  }
  const config = { agent: 'pi', credentials: { proxy: { provider: 'openai-codex' } } };
  validateCodexWait(config, parse(['--wait-codex']));
  for (const bad of [{ ...config, agent: 'claude' }, { ...config, credentials: {} }, { ...config, credentials: { proxy: { provider: 'openai' } } }]) assert.throws(() => validateCodexWait(bad, parse(['--wait-codex'])), /host proxy/);
  assert.throws(() => validateCodexWait(config, { mode: 'pi', stdio: 'pipe' }), /custom stdio/);
  assert.equal(restartOptions({ waitCodex: true }).waitCodex, false);
});

test('both quota windows and upstream denial flags gate availability; reset time never grants quota', () => {
  assert.equal(codexAvailability(quota(99, 99)).available, true);
  assert.equal(codexAvailability(quota(0, 100)).available, false);
  assert.equal(codexAvailability(quota(100, 0)).delayMs, 125000);
  assert.equal(codexAvailability(quota(100, 100)).delayMs, 300000);
  assert.equal(codexAvailability(quota(0, null, { allowed: false })).available, false);
  assert.equal(codexAvailability(quota(0, 0, { limit_reached: true })).available, false);
  const expired = quota(100, 0);
  expired.rate_limit.primary_window.reset_at = 1;
  assert.deepEqual(codexAvailability(expired, 100000), { available: false, delayMs: 60000 });
  assert.throws(() => codexAvailability({ rate_limit: {} }), /no quota windows/);
  assert.throws(() => codexAvailability(quota(101)), /Invalid Codex/);
  assert.throws(() => codexAvailability(quota(0, 0, { allowed: 'yes' })), /Invalid Codex/);
});

test('host and proxy usage summaries share a strict numeric/boolean allowlist', async t => {
  const { store } = await fixture(t);
  await saveCodexCredential(store, fakeCodexCredential());
  const data = { ...quota(100, 10, { allowed: false, limit_reached: true, private_token: 'do-not-copy' }), email: 'private@example.invalid', access_token: 'do-not-copy' };
  const expected = quota(100, 10, { allowed: false, limit_reached: true });
  assert.deepEqual(codexUsageSummary(data), expected);
  const result = await getCodexUsage(store, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify(data));
  } });
  assert.deepEqual(result, expected);
  assert.ok(!JSON.stringify(result).includes('do-not-copy'));
});

test('polling waits for fresh positive usage rather than an elapsed reset, without model calls', async () => {
  const replies = [quota(100, 100), quota(100, 20), quota(0, 100), quota(3, 4)];
  const sleeps = [], notices = [];
  let calls = 0;
  await waitForCodex({}, {
    usage: async () => replies[calls++],
    now: () => 1700000000000,
    sleep: async ms => { sleeps.push(ms); },
    notify: text => notices.push(text),
  });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [300000, 125000, 300000]);
  assert.equal(notices.filter(text => text.includes('Resuming')).length, 1);
  let slept = false;
  await waitForCodex({}, { usage: async () => quota(0), sleep: async () => { slept = true; }, notify: () => {} });
  assert.equal(slept, false);
  await assert.rejects(waitForCodex({}, { usage: async () => { throw new Error('secret error'); }, notify: () => {} }), error => /Cannot check Codex/.test(error.message) && !error.message.includes('secret error'));
});

test('Ctrl-C/termination cancel pending usage or sleep and remove signal listeners', async () => {
  for (const phase of ['fetch', 'sleep']) {
    const source = new EventEmitter();
    const cancelled = async (_value, _unused, { signal }) => {
      source.emit('SIGTERM');
      signal.throwIfAborted();
    };
    const status = await waitForCodexOnHost({}, {
      signalSource: source, notify: () => {},
      usage: phase === 'fetch' ? async (_store, { signal }) => cancelled(null, null, { signal }) : async () => quota(100),
      sleep: cancelled,
    });
    assert.equal(status, 143);
    assert.equal(source.eventNames().length, 0);
  }
  const source = new EventEmitter();
  assert.equal(await waitForCodexOnHost({}, { signalSource: source, usage: async () => quota(0), notify: () => {} }), 0);
  assert.equal(source.eventNames().length, 0);
});

test('wait requires saved sessions and rejects symlinked state; encoded-cwd layout is accepted', async t => {
  const { base, store, config, sessions } = await fixture(t);
  requireSavedPiSession(store, config.id);
  fs.rmSync(path.join(sessions, 'saved.jsonl'));
  assert.throws(() => requireSavedPiSession(store, config.id), /existing saved Pi session/);
  const nested = path.join(sessions, '--encoded-cwd--'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'saved.jsonl'), '{}\n');
  requireSavedPiSession(store, config.id);
  fs.rmSync(sessions, { recursive: true });
  fs.symlinkSync(base, sessions);
  assert.throws(() => requireSavedPiSession(store, config.id), /Symlinked/);
});

test('launch waits under project lock before any Podman process, then sends exactly one saved-session continuation', async t => {
  const { base, store, config } = await fixture(t);
  await saveCodexCredential(store, fakeCodexCredential());
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  const trace = path.join(base, 'podman-trace.jsonl');
  fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
    const fs = require('fs'), args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
    if (args[0] === 'container') process.exitCode = 1;
  `, { mode: 0o700 });
  const oldPath = process.env.PATH, oldPrune = process.env.PIS_AUTO_PRUNE;
  process.env.PATH = `${bin}:${oldPath}`; process.env.PIS_AUTO_PRUNE = '0';
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldPrune === undefined) delete process.env.PIS_AUTO_PRUNE; else process.env.PIS_AUTO_PRUNE = oldPrune;
  });
  let checks = 0;
  const codexWait = {
    usage: async () => {
      assert.ok(!fs.existsSync(trace));
      assert.ok(fs.existsSync(path.join(store.projectDir(config.id), 'project.lock')));
      return quota(checks++ === 0 ? 100 : 0);
    },
    sleep: async () => {}, notify: () => {},
  };
  assert.equal(await launch(store, config, { ...parse(['--wait-codex']), cwd: config.root, codexWait }), 0);
  assert.equal(checks, 2);
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const runs = calls.filter(args => args[0] === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(-5), ['pi', '--tui-mode', 'regular', '--continue', CODEX_RESUME_NOTICE]);
  assert.equal(runs[0].filter(arg => arg === CODEX_RESUME_NOTICE).length, 1);
  assert.equal(fs.existsSync(path.join(store.projectDir(config.id), 'project.lock')), false);
  fs.rmSync(trace);
  const source = new EventEmitter();
  const cancelled = await launch(store, config, { ...parse(['--wait-codex']), cwd: config.root, codexWait: {
    signalSource: source, notify: () => {}, usage: async (_store, { signal }) => { source.emit('SIGINT'); signal.throwIfAborted(); },
  } });
  assert.equal(cancelled, 130);
  assert.equal(fs.existsSync(trace), false);
  assert.equal(fs.existsSync(path.join(store.projectDir(config.id), 'project.lock')), false);
  await assert.rejects(launch(store, config, { ...parse(['--wait-codex']), cwd: config.root, codexWait: {
    notify: () => {}, usage: async () => {
      const original = store.load(config.id), edited = structuredClone(original);
      edited.image.packages.push('curl');
      await store.save(edited, original);
      return quota(0);
    },
  } }), /configuration changed while waiting/);
  assert.equal(fs.existsSync(trace), false);
  assert.equal(fs.existsSync(path.join(store.projectDir(config.id), 'project.lock')), false);
});
