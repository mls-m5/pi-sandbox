import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  claudeLimitReset,
  cachedClaudeLimit,
  startLimitWatcher,
  waitForClaudeReset,
} from '../src/claude-wait.js';
import { recordClaudeUsage } from '../src/claude-usage.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const now = 1_700_000_000_000;
const sec = (ms) => String(Math.floor((now + ms) / 1000));

test('limit reset comes from exhausted windows, overall reset or retry-after; short/odd limits are ignored', () => {
  const both = {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': sec(3600_000),
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-reset': sec(86400_000),
  };
  assert.equal(claudeLimitReset(429, both, now), Math.floor((now + 3600_000) / 1000) * 1000);
  assert.equal(claudeLimitReset(200, both, now), null);
  assert.equal(
    claudeLimitReset(429, { 'anthropic-ratelimit-unified-reset': sec(7200_000) }, now),
    Math.floor((now + 7200_000) / 1000) * 1000,
  );
  assert.equal(claudeLimitReset(429, { 'retry-after': '7200' }, now), now + 7200_000);
  assert.equal(claudeLimitReset(429, { 'retry-after': '5' }, now), null);
  assert.equal(claudeLimitReset(429, {}, now), null);
  assert.equal(claudeLimitReset(429, { 'retry-after': String(30 * 86400) }, now), null);
});

test('cached exhausted window is reported until its reset', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-cw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = { root };
  recordClaudeUsage(
    store,
    {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': sec(3600_000),
    },
    now,
  );
  assert.equal(cachedClaudeLimit(store, now), Math.floor((now + 3600_000) / 1000) * 1000);
  assert.equal(cachedClaudeLimit(store, now + 7200_000), null);
});

test('watcher fires once after the grace period without success and not after a later success', async () => {
  let time = now,
    stops = 0,
    fired;
  const watcher = startLimitWatcher({
    stopContainer: async () => void stops++,
    onFire: (at) => (fired = at),
    graceMs: 1000,
    now: () => time,
  });
  try {
    watcher.observe(429, { 'retry-after': '7200' });
    assert.equal(await watcher.check(), false);
    watcher.observe(200, {});
    time += 2000;
    assert.equal(await watcher.check(), false, 'a success after the limit cancels');
    watcher.observe(429, { 'retry-after': '7200' });
    time += 2000;
    assert.equal(await watcher.check(), true);
    assert.equal(await watcher.check(), false);
    assert.equal(stops, 1);
    assert.equal(fired, time - 2000 + 7200_000);
    assert.equal(watcher.succeeded, 1);
  } finally {
    watcher.stop();
  }
});

test('waiting sleeps until reset plus margin and can be cancelled by a signal', async () => {
  let time = now;
  const messages = [];
  const result = await waitForClaudeReset(now + 600_000, {
    signalSource: new EventEmitter(),
    sleep: async (ms) => void (time += ms),
    now: () => time,
    notify: (m) => messages.push(m),
    marginMs: 300_000,
    chunkMs: 100_000,
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(time >= now + 900_000);
  assert.match(messages[0], /Waiting until/);

  const source = new EventEmitter();
  const cancelled = await waitForClaudeReset(now + 600_000, {
    signalSource: source,
    sleep: (ms, v, { signal }) =>
      new Promise((resolve, reject) => {
        source.emit('SIGINT');
        signal.aborted ? reject(new Error('aborted')) : resolve();
      }),
    now: () => now,
    notify: () => {},
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.exitCode, 130);
  assert.equal(source.listenerCount('SIGINT'), 0);
});

test('a Claude limit stops the agent, waits for the reset and restarts it with --continue', async t => {
  const http = (await import('node:http')).default;
  const { Store } = await import('../src/store.js');
  const { launch } = await import('../src/container.js');
  const { saveClaudeToken } = await import('../src/claude-code.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-cw-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'store'));
  const root = path.join(dir, 'proj'); fs.mkdirSync(root);
  const registered = await store.register(root, 'proj');
  await store.save({ ...store.load(registered.id), agent: 'claude' }, store.load(registered.id));
  await saveClaudeToken(store, `sk-ant-oat01-${'x'.repeat(40)}`);
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (++hits === 1) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7200' }); return res.end('{"error":{"type":"rate_limit_error","message":"limit"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'runs.log'), flag = path.join(dir, 'stopped');
  fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
    const fs = require('fs'), http = require('http');
    const args = process.argv.slice(2);
    const log = ${JSON.stringify(log)}, flag = ${JSON.stringify(flag)};
    if (args[0] === 'info') console.log(JSON.stringify({host:{security:{rootless:true,selinuxEnabled:false},serviceIsRemote:false}}));
    else if (args[0] === 'stop') fs.writeFileSync(flag, '');
    else if (args[0] === 'container') process.exitCode = 1;
    else if (args[0] === 'run') {
      const first = !fs.existsSync(log);
      fs.appendFileSync(log, JSON.stringify(args) + '\\n');
      const volume = args.find(arg => arg.includes(':/pis/proxy:ro'));
      const req = http.request({ socketPath: volume.split(':')[0] + '/claude.sock', method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json' } }, res => {
        res.resume();
        res.on('end', () => {
          if (!first) return;
          const started = Date.now();
          const wait = setInterval(() => { if (fs.existsSync(flag) || Date.now() - started > 20000) { clearInterval(wait); process.exit(0); } }, 25);
        });
      });
      req.end('{"model":"m"}');
    }
  `, { mode: 0o700 });
  const savedPath = process.env.PATH, savedHome = process.env.PIS_HOME;
  process.env.PATH = `${bin}:${savedPath}`; process.env.PIS_HOME = store.root; process.env.PIS_AUTO_PRUNE = '0';
  t.after(() => { process.env.PATH = savedPath; if (savedHome === undefined) delete process.env.PIS_HOME; else process.env.PIS_HOME = savedHome; delete process.env.PIS_AUTO_PRUNE; });
  let clock = Date.now();
  const waits = [];
  await launch(store, store.load(registered.id), {
    action: 'run', mode: 'pi', fresh: false, args: [], cwd: root, waitClaude: true,
    claudeUpstream: `http://127.0.0.1:${upstream.address().port}`,
    claudeWatchTiming: { graceMs: 100, intervalMs: 30 },
    claudeWait: { signalSource: new EventEmitter(), now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, notify: () => {} },
  });
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(runs.length, 2, 'started once, stopped on the limit, restarted once');
  assert.ok(runs[1].includes('--continue'));
  assert.ok(runs[1].some(arg => arg.includes('usage limit was reached')));
  assert.ok(!runs[0].some(arg => arg.includes('usage limit was reached')));
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 7200_000, 'waited for the reset');
});
