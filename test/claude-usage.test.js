import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeUsageHeaders, readClaudeUsage, recordClaudeUsage, claudeUsagePath } from '../src/claude-usage.js';
import { startClaudeProxy } from '../src/claude-code.js';
import { claudeDisplay } from '../gnome-codex-usage/usage-display.js';

const now = 1_700_000_000_000;
const reset5 = now / 1000 + 3600;
const reset7 = now / 1000 + 3 * 86400;
const headers = {
  'anthropic-ratelimit-unified-5h-utilization': '0.25',
  'anthropic-ratelimit-unified-5h-reset': String(reset5),
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': String(reset7),
};
function store(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-cu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root };
}

test('header parsing keeps only valid numeric windows', () => {
  const parsed = parseClaudeUsageHeaders(headers, now);
  assert.equal(parsed.five_hour.used_percent, 25);
  assert.equal(parsed.seven_day.reset_at, reset7);
  assert.deepEqual(parseClaudeUsageHeaders({ ...headers, 'anthropic-ratelimit-unified-5h-utilization': '5' }, now).five_hour, undefined);
  assert.deepEqual(parseClaudeUsageHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.1' }, now), {});
  assert.deepEqual(parseClaudeUsageHeaders({ ...headers, 'anthropic-ratelimit-unified-7d-reset': 'x' }, now).seven_day, undefined);
  assert.deepEqual(parseClaudeUsageHeaders({}, now), {});
});

test('cache is private, merges windows, ignores unrelated headers and hides expired windows', t => {
  const s = store(t);
  assert.equal(recordClaudeUsage(s, { 'set-cookie': 'x' }, now), false);
  assert.equal(recordClaudeUsage(s, headers, now), true);
  assert.equal(recordClaudeUsage(s, headers, now + 1000), false);
  assert.equal(fs.statSync(claudeUsagePath(s)).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(claudeUsagePath(s), 'utf8'), /set-cookie|authorization/i);
  const view = readClaudeUsage(s, now);
  assert.equal(view.rate_limit.primary_window.used_percent, 25);
  assert.equal(view.rate_limit.secondary_window.limit_window_seconds, 604800);
  const expired = readClaudeUsage(s, (reset5 + 1) * 1000);
  assert.equal(expired.rate_limit.primary_window, undefined);
  assert.equal(expired.rate_limit.secondary_window.used_percent, 40);
  fs.writeFileSync(claudeUsagePath(s), '{broken');
  assert.deepEqual(readClaudeUsage(s, now), { rate_limit: {} });
});

test('GNOME Claude display shows both windows with staleness and explicit unknown slots', () => {
  const data = { rate_limit: {
    primary_window: { used_percent: 20, reset_at: reset5, limit_window_seconds: 18000, updated_at: now / 1000 - 600 },
    secondary_window: { used_percent: 40, reset_at: reset7, limit_window_seconds: 604800, updated_at: now / 1000 - 600 },
  } };
  const both = claudeDisplay(data, now, now);
  assert.equal(both.panel, '✻ 80% 1h00 · 60% 3d00');
  assert.equal(both.level, 60);
  assert.match(both.menu, /resets in 1h 0m/);
  const old = claudeDisplay({ rate_limit: { primary_window: { ...data.rate_limit.primary_window, updated_at: now / 1000 - 7200 }, secondary_window: data.rate_limit.secondary_window } }, now, now);
  assert.equal(old.panel, '✻ ~80% 1h00 · 60% 3d00');
  assert.match(both.menu, /seen 10m ago/);
  const none = claudeDisplay({ rate_limit: {} }, now, now);
  assert.equal(none.panel, '✻ — · —');
  assert.equal(none.level, null);
});

test('proxy records usage from forwarded responses without altering them, and survives a failing hook', async t => {
  const s = store(t);
  const live = Date.now() / 1000;
  const liveHeaders = { ...headers, 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(live + 3600)), 'anthropic-ratelimit-unified-7d-reset': String(Math.floor(live + 86400)) };
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close', ...liveHeaders }); res.end('{}'); }); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  let n = 0;
  const token = `sk-ant-oat01-${'x'.repeat(40)}`;
  for (const hook of [h => recordClaudeUsage(s, h), () => { throw new Error('boom'); }]) {
    const socketPath = path.join(s.root, `c${n++}.sock`);
    const proxy = await startClaudeProxy({ socketPath, token, upstream: `http://127.0.0.1:${upstream.address().port}`, onResponseHeaders: hook });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath, agent: false, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end('{"model":"m"}');
    });
    assert.equal(status, 200);
    await proxy.close();
  }
  assert.equal(readClaudeUsage(s, Date.now()).rate_limit.primary_window?.used_percent, 25);
});
