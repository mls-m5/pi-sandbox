import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';
import { codexClaims, dummyCodexToken } from './codex-auth.js';
import { assert } from './util.js';

export const OPENAI_UPSTREAM = 'https://api.openai.com';
export const CODEX_UPSTREAM = 'https://chatgpt.com';
export const DEFAULT_PROXY = { provider: 'openai', keyEnv: 'OPENAI_API_KEY', models: [], maxRequests: 1000, maxConcurrent: 4 };
const API_ROUTES = new Set(['POST /v1/responses', 'POST /v1/chat/completions', 'GET /v1/models']);
const CODEX_ROUTES = new Set(['POST /backend-api/codex/responses']);

function credentialFor(provider, apiKey) {
  if (provider === 'openai-codex') return { apiKey, ...codexClaims(apiKey) };
  assert(typeof apiKey === 'string' && /^[A-Za-z0-9_-]+$/.test(apiKey), 'Missing or invalid host OpenAI API key.');
  return { apiKey };
}

// Holds a short suffix between chunks so even a split credential is never emitted.
export class SecretRedactor extends Transform {
  constructor(secret, maxBytes = 64 * 1024 * 1024) {
    super();
    this.secret = Buffer.from(secret);
    this.pending = Buffer.alloc(0);
    this.bytes = 0;
    this.maxBytes = maxBytes;
    this.prefix = new Uint32Array(this.secret.length);
    for (let i = 1, matched = 0; i < this.secret.length; i++) {
      while (matched && this.secret[i] !== this.secret[matched]) matched = this.prefix[matched - 1];
      if (this.secret[i] === this.secret[matched]) matched++;
      this.prefix[i] = matched;
    }
  }
  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) return callback(new Error('Response limit exceeded.'));
    this.pending = Buffer.concat([this.pending, chunk]);
    let index;
    while ((index = this.pending.indexOf(this.secret)) !== -1) {
      this.push(this.pending.subarray(0, index));
      this.push('[REDACTED]');
      this.pending = this.pending.subarray(index + this.secret.length);
    }
    // Retain only a suffix matching a secret prefix, not an entire JWT's worth
    // of normal SSE bytes. KMP bounds the work and preserves first-token latency.
    let keep = 0;
    const tail = this.pending.subarray(Math.max(0, this.pending.length - this.secret.length + 1));
    for (const byte of tail) {
      while (keep && byte !== this.secret[keep]) keep = this.prefix[keep - 1];
      if (byte === this.secret[keep]) keep++;
    }
    const safeLength = this.pending.length - keep;
    if (safeLength > 0) {
      this.push(this.pending.subarray(0, safeLength));
      this.pending = this.pending.subarray(safeLength);
    }
    callback();
  }
  _flush(callback) { this.push(this.pending); callback(); }
}

function reply(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  res.end(JSON.stringify({ error: { message, type: 'pis_proxy_error' } }));
}

function body(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes && !failed) {
        failed = true; chunks = [];
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
      }
      if (!failed) chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', () => reject(new Error('Request interrupted.')));
    req.on('aborted', () => reject(new Error('Request interrupted.')));
  });
}

/** Host-only service. Production callers always use the fixed OpenAI upstream.
 * The upstream parameter and limit overrides exist for local fake-server tests.
 * No headers, URLs, payloads, or credentials are logged or included in errors.
 */
export async function startOpenAIProxy({ socketPath, apiKey, provider = 'openai', getCredentials, token, models = [], maxRequests = 1000, maxConcurrent = 4, upstream, maxBodyBytes = 16 * 1024 * 1024, timeoutMs = 300_000 }) {
  assert(['openai', 'openai-codex'].includes(provider), 'Unsupported proxy provider.');
  const initialCredential = credentialFor(provider, apiKey);
  token ??= provider === 'openai-codex' ? dummyCodexToken() : `sk-pis-${randomBytes(32).toString('hex')}`;
  assert(typeof token === 'string' && token.length >= 16 && token !== apiKey, 'Invalid proxy capability.');
  const routes = provider === 'openai-codex' ? CODEX_ROUTES : API_ROUTES;
  const origin = new URL(upstream || (provider === 'openai-codex' ? CODEX_UPSTREAM : OPENAI_UPSTREAM));
  assert(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'Upstream must be an origin.');
  assert(origin.protocol === 'https:' || (origin.protocol === 'http:' && origin.hostname === '127.0.0.1'), 'Upstream requires HTTPS (loopback HTTP is test-only).');
  const expected = Buffer.from(`Bearer ${token}`);
  const active = new Set(), sockets = new Set();
  let concurrent = 0, used = 0;

  async function handle(req, res) {
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(res, 401, 'Invalid proxy capability.');
    // Exact raw path matching rejects queries, absolute URLs, traversal, and alternate destinations.
    if (!routes.has(`${req.method} ${req.url}`)) return reply(res, 403, 'Endpoint not allowed.');
    if (concurrent >= maxConcurrent) return reply(res, 429, 'Proxy concurrency limit reached.');
    if (used >= maxRequests) return reply(res, 429, 'Proxy request budget exhausted.');
    concurrent++;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      reply(res, 504, 'Upstream request timed out.');
      outgoing?.destroy();
    }, timeoutMs);
    timeout.unref();
    let outgoing;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timeout); concurrent--; controller.abort();
      if (outgoing) { active.delete(outgoing); outgoing.destroy(); }
    };
    res.once('close', finish);
    try {
      let payload;
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(res, 415, 'JSON content type required.');
        payload = await body(req, maxBodyBytes);
        const encoding = req.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          if (provider !== 'openai-codex' || encoding !== 'zstd') return reply(res, 415, 'Unsupported request encoding.');
          try { payload = zstdDecompressSync(payload, { maxOutputLength: maxBodyBytes }); }
          catch { return reply(res, 413, 'Invalid or oversized compressed request.'); }
        }
        let parsed;
        try { parsed = JSON.parse(payload.toString('utf8')); } catch { return reply(res, 400, 'Invalid JSON request.'); }
        if (!parsed || typeof parsed.model !== 'string' || !parsed.model) return reply(res, 400, 'A model is required.');
        if (models.length && !models.includes(parsed.model)) return reply(res, 403, 'Model not allowed.');
      }
      if (finished || res.destroyed || res.writableEnded) return;
      // Recheck after asynchronous body collection so parallel uploads cannot overspend the request count.
      if (used >= maxRequests) return reply(res, 429, 'Proxy request budget exhausted.');
      used++;
      let credential = initialCredential;
      if (getCredentials) {
        try { credential = credentialFor(provider, (await getCredentials(controller.signal)).apiKey); }
        catch { return reply(res, 503, 'Host credentials unavailable. For Codex, run pis --login-codex on the host.'); }
      }
      if (finished || res.destroyed || res.writableEnded) return;
      const sessionHeaders = {};
      if (provider === 'openai-codex') {
        for (const name of ['session-id', 'x-client-request-id']) {
          if (typeof req.headers[name] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(req.headers[name])) sessionHeaders[name] = req.headers[name];
        }
      }
      const request = origin.protocol === 'https:' ? https.request : http.request;
      outgoing = request(new URL(req.url, origin), {
        method: req.method,
        headers: {
          authorization: `Bearer ${credential.apiKey}`,
          ...(provider === 'openai-codex' ? { 'chatgpt-account-id': credential.accountId, originator: 'pi', 'openai-beta': 'responses=experimental', ...sessionHeaders } : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'accept-encoding': 'identity',
          'user-agent': 'pis-credential-proxy/0.1',
          ...(payload ? { 'content-length': payload.length } : {}),
        },
        // No client-supplied Host, organization, project, cookies, proxy, or forwarding headers.
      }, upstreamResponse => {
        const status = upstreamResponse.statusCode || 502;
        if (status < 200 || status >= 300) {
          upstreamResponse.destroy();
          // In particular, never follow redirects or expose upstream error bodies/headers.
          return reply(res, status >= 400 && status <= 599 ? status : 502, `OpenAI upstream returned status ${status}.`);
        }
        if (upstreamResponse.headers['content-encoding'] && upstreamResponse.headers['content-encoding'] !== 'identity') {
          upstreamResponse.destroy();
          return reply(res, 502, 'Unsupported upstream content encoding.');
        }
        res.writeHead(status, { 'content-type': String(upstreamResponse.headers['content-type']).startsWith('text/event-stream') ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' });
        pipeline(upstreamResponse, new SecretRedactor(credential.apiKey), res, () => finish());
      });
      active.add(outgoing);
      outgoing.on('error', () => reply(res, 502, 'OpenAI upstream connection failed.'));
      outgoing.end(payload);
    } catch (error) {
      reply(res, error.status || 400, error.status === 413 ? 'Request body too large.' : 'Invalid or interrupted request.');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 502, 'Proxy request failed.'));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;
  server.maxConnections = 128;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  fs.chmodSync(socketPath, 0o600);
  return {
    token,
    async close() {
      for (const outgoing of active) outgoing.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    },
  };
}
