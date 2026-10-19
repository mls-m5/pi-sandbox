import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { SecretRedactor, startOpenAIProxy } from '../src/proxy.js';

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
    req.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload));
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

test('redactor preserves ordinary bytes and masks repeated credentials split at every boundary', async () => {
  for (let index = 0; index <= KEY.length; index++) {
    const stream = Readable.from([Buffer.from('π:' + KEY.slice(0, index)), Buffer.from(KEY.slice(index) + ':' + KEY + ':done')]).pipe(new SecretRedactor(KEY));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'π:[REDACTED]:[REDACTED]:done');
  }
});
