import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { SecretRedactor, startOpenAIProxy } from '../src/proxy.js';
import { zstdCompressSync } from 'node:zlib';
import { fakeCodexAccess } from './fixtures/codex.js';

const KEY = 'sk-real-host-key-never-expose-this';
async function fixture(t, handler, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-proxy-test-'));
  const upstream = http.createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const socketPath = path.join(dir, 'api.sock');
  const proxy = await startOpenAIProxy({ socketPath, apiKey: KEY, upstream: `http://127.0.0.1:${upstream.address().port}`, ...options });
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (url = '/v1/responses', payload = { model: 'allowed', input: 'hello' }, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method, headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : (typeof payload === 'string' || Buffer.isBuffer(payload)) ? payload : JSON.stringify(payload));
  });
  return { request, proxy, socketPath };
}

test('proxy injects host key, uses a private Unix socket, and rebuilds upstream headers', async t => {
  let received;
  const { request, proxy, socketPath } = await fixture(t, (req, res) => {
    received = { url: req.url, headers: req.headers };
    res.end('{"ok":true}');
  });
  assert.notEqual(proxy.token, KEY);
  assert.match(proxy.token, /^sk-pis-/);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const response = await request('/v1/responses', { model: 'allowed' }, { 'openai-organization': 'untrusted-org', cookie: 'secret', 'x-forwarded-host': 'attacker', host: 'attacker' });
  assert.equal(response.status, 200);
  assert.equal(received.headers.authorization, `Bearer ${KEY}`);
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers['openai-organization'], undefined);
  assert.equal(received.headers['x-forwarded-host'], undefined);
  assert.notEqual(received.headers.host, 'attacker');
  assert.equal(received.url, '/v1/responses');
  assert.ok(!JSON.stringify(response).includes(KEY));
});

test('proxy rejects wrong capabilities, endpoints, traversal, and unknown models before forwarding', async t => {
  let forwarded = 0;
  const { request } = await fixture(t, (_req, res) => { forwarded++; res.end('{}'); }, { models: ['allowed'] });
  assert.equal((await request('/v1/responses', {}, { authorization: 'Bearer wrong' })).status, 401);
  for (const url of ['/v1/files', '/v1/responses?url=http://attacker', '/v1/../responses', 'https://attacker/v1/responses', '//attacker/v1/responses', '/v1/%72esponses']) {
    assert.equal((await request(url)).status, 403, url);
  }
  assert.equal((await request('/v1/responses', { model: 'not-allowed' })).status, 403);
  assert.equal((await request('/v1/responses', '{bad')).status, 400);
  assert.equal((await request('/v1/responses', { model: 'allowed' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(forwarded, 0);
});

test('proxy does not follow redirects or expose upstream error bodies and headers', async t => {
  const { request } = await fixture(t, (req, res) => {
    const status = req.url === '/v1/responses' ? 307 : 401;
    res.writeHead(status, { location: `https://attacker/?key=${KEY}`, 'x-debug-secret': KEY });
    res.end(`echoed authorization: ${KEY}`);
  });
  for (const route of ['/v1/responses', '/v1/chat/completions']) {
    const response = await request(route);
    assert.ok([401, 502].includes(response.status));
    assert.ok(!JSON.stringify(response).includes(KEY));
    assert.equal(response.headers.location, undefined);
  }
});

test('unexpected response compression fails closed rather than bypassing redaction', async t => {
  const { request } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(KEY);
  });
  const response = await request();
  assert.equal(response.status, 502);
  assert.ok(!response.body.includes(KEY));
});

test('streaming response survives chunk boundaries and redacts a split key', async t => {
  const { request } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-secret': KEY });
    res.write('data: first\n\ndata: ' + KEY.slice(0, 12));
    setTimeout(() => res.end(KEY.slice(12) + '\n\ndata: [DONE]\n\n'), 10);
  });
  const response = await request();
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.match(response.body, /data: first/);
  assert.match(response.body, /\[REDACTED\]/);
  assert.match(response.body, /\[DONE\]/);
  assert.ok(!response.body.includes(KEY));
});

test('request budgets, body size, and concurrency are bounded', async t => {
  const { request } = await fixture(t, (_req, res) => res.end('{}'), { maxRequests: 1, maxBodyBytes: 128 });
  assert.equal((await request('/v1/responses', 'x'.repeat(129))).status, 413);
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 429);

  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const second = await fixture(t, (_req, res) => { release = () => res.end('{}'); entered(); }, { maxConcurrent: 1 });
  const running = second.request();
  await waiting;
  assert.equal((await second.request()).status, 429);
  release();
  assert.equal((await running).status, 200);
});

test('upstream timeout is generic and disconnect cancels upstream work', async t => {
  const { request } = await fixture(t, () => {}, { timeoutMs: 20 });
  const response = await request();
  assert.equal(response.status, 504);
  assert.ok(!response.body.includes(KEY));

  let entered, ended;
  const waiting = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { ended = resolve; });
  const second = await fixture(t, (_req, res) => { res.on('close', ended); entered(); });
  const client = http.request({ socketPath: second.socketPath, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${second.proxy.token}`, 'content-type': 'application/json' } });
  client.on('error', () => {});
  client.end('{"model":"allowed"}');
  await waiting;
  client.destroy();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream was not cancelled.')), 1000); timer.unref(); })]);
});

test('Codex injects host JWT/account headers, accepts bounded zstd, and forbids API routes', async t => {
  const access = fakeCodexAccess();
  let received;
  const { request, proxy } = await fixture(t, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { received = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) }; res.end('{}'); });
  }, { provider: 'openai-codex', apiKey: access });
  assert.notEqual(proxy.token, access);
  const compressed = zstdCompressSync(Buffer.from('{"model":"allowed","stream":true}'));
  assert.equal((await request('/backend-api/codex/responses', compressed, { 'content-encoding': 'zstd', 'chatgpt-account-id': 'attacker-account', originator: 'attacker', 'session-id': 'safe-session' })).status, 200);
  assert.equal(received.headers.authorization, `Bearer ${access}`);
  assert.equal(received.headers['chatgpt-account-id'], 'host-account-only');
  assert.equal(received.headers.originator, 'pi');
  assert.equal(received.headers['openai-beta'], 'responses=experimental');
  assert.equal(received.headers['session-id'], 'safe-session');
  assert.equal(received.headers['content-encoding'], undefined);
  assert.equal(received.body.model, 'allowed');
  assert.equal((await request('/v1/responses')).status, 403);
  assert.equal((await request('/backend-api/codex/responses?account=attacker')).status, 403);
});

test('Codex usage returns only quota windows, never identity or token metadata', async t => {
  const access = fakeCodexAccess();
  const { request } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/backend-api/wham/usage');
    assert.equal(req.headers.authorization, `Bearer ${access}`);
    assert.equal(req.headers['chatgpt-account-id'], 'host-account-only');
    res.end(JSON.stringify({ email: 'private@example.test', access_token: access, account_id: 'host-account-only', rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 120, private_field: access }, secondary_window: null } }));
  }, { provider: 'openai-codex', apiKey: access });
  const result = await request('/backend-api/wham/usage', '', {}, 'GET');
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 120 }, secondary_window: null } });
  assert.ok(!result.body.includes(access));
  assert.ok(!result.body.includes('private@example.test'));
  assert.ok(!result.body.includes('host-account-only'));
  assert.equal((await request('/backend-api/wham/usage?account=other', '', {}, 'GET')).status, 403);
});

test('Codex compressed size limits and failed host refresh never forward or expose credentials', async t => {
  let forwarded = 0;
  const { request } = await fixture(t, (_req, res) => { forwarded++; res.end('{}'); }, { provider: 'openai-codex', apiKey: fakeCodexAccess(), maxBodyBytes: 128, getCredentials: async () => { throw new Error('private-refresh-token'); } });
  const bomb = zstdCompressSync(Buffer.from(JSON.stringify({ model: 'allowed', data: 'x'.repeat(1000) })));
  assert.equal((await request('/backend-api/codex/responses', bomb, { 'content-encoding': 'zstd' })).status, 413);
  const failed = await request('/backend-api/codex/responses');
  assert.equal(failed.status, 503);
  assert.ok(!failed.body.includes('private-refresh-token'));
  assert.equal(forwarded, 0);
});

test('each Codex request uses the latest host credential and redacts that access token', async t => {
  const access = fakeCodexAccess({ signature: 'refreshed-signature' });
  const { request } = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${access}`);
    res.end(access);
  }, { provider: 'openai-codex', apiKey: fakeCodexAccess(), getCredentials: async () => ({ apiKey: access }) });
  const result = await request('/backend-api/codex/responses');
  assert.equal(result.status, 200);
  assert.equal(result.body, '[REDACTED]');
});

test('long JWT redaction does not buffer ordinary SSE frames until stream completion', () => {
  const secret = fakeCodexAccess({ signature: 'x'.repeat(4000) });
  const redactor = new SecretRedactor(secret);
  const frame = 'data: hello\\n\\n';
  redactor.write(frame);
  assert.equal(redactor.read().toString(), frame);
  redactor.end();
});

test('redactor preserves ordinary bytes and masks repeated credentials split at every boundary', async () => {
  for (let index = 0; index <= KEY.length; index++) {
    const stream = Readable.from([Buffer.from('π:' + KEY.slice(0, index)), Buffer.from(KEY.slice(index) + ':' + KEY + ':done')]).pipe(new SecretRedactor(KEY));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'π:[REDACTED]:[REDACTED]:done');
  }
});
