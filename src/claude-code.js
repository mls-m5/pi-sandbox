import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { assert, atomicWrite, run, withLock, within } from './util.js';
import { SecretRedactor } from './proxy.js';
import { readTerminalLine } from './terminal-input.js';

// Official npm package, which installs Anthropic's unmodified native binary.
export const CLAUDE_VERSION = '2.1.328';
export const CLAUDE_UPSTREAM = 'https://api.anthropic.com';
// Claude Code's own host-held-credential mode: model calls use this Unix socket and a
// fixed non-secret placeholder token; the host side supplies the real OAuth token.
export const CLAUDE_SOCKET = '/pis/proxy/claude.sock';
export const CLAUDE_PLACEHOLDER_TOKEN = 'ssh-placeholder';
export const CLAUDE_SANDBOX_BASE_URL = 'http://pis-claude-proxy.invalid';
const OAUTH_BETA = 'oauth-2025-04-20';
const MAX_PROFILE_BYTES = 64 * 1024;
const ROUTE = /^\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?$/;
const FORWARDED_REQUEST_HEADERS = new Set([
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'user-agent',
  'x-app',
  'x-claude-code-session-id',
  'x-client-request-id',
  'content-encoding',
  'accept',
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'request-id',
  'retry-after',
  'x-should-retry',
]);

function privateDirectory(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(dir);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(),
    'Claude state/auth directory must be owned by you and not a symlink.',
  );
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Per-project Claude home (sessions, settings, history). Never holds the host token. */
export function claudeState(store, id) {
  const project = store.projectDir(id);
  assert(fs.realpathSync(project) === project, 'Claude project storage must not contain symlinks.');
  const home = privateDirectory(path.join(project, 'claude-state'));
  const config = privateDirectory(path.join(home, '.claude'));
  return { home, config, legacyCredential: path.join(config, '.credentials.json') };
}

function authDirectory(store) {
  return privateDirectory(path.join(store.root, 'auth'));
}

function tokenPath(store) {
  return path.join(authDirectory(store), 'claude-oauth-token.json');
}

export function validateClaudeToken(token) {
  assert(
    typeof token === 'string' && /^[\x21-\x7e]{20,4096}$/.test(token),
    'Invalid Claude token: paste the complete single-line token printed by claude setup-token.',
  );
  // API keys would be billed per token. Only subscription OAuth tokens are accepted.
  assert(
    !token.startsWith('sk-ant-api'),
    'This is an Anthropic API key (billed per token), not a subscription token. Use the token printed by claude setup-token.',
  );
  assert(
    token.startsWith('sk-ant-oat'),
    'Expected a Claude subscription OAuth token (sk-ant-oat…) printed by claude setup-token.',
  );
  return token;
}

/** Returns the saved global token, or undefined. Never mounted or copied into sandboxes. */
export function readClaudeToken(store) {
  const file = tokenPath(store);
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Cannot read host Claude login (invalid or unsafe file).');
  }
  try {
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= MAX_PROFILE_BYTES,
      'Unsafe file.',
    );
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    assert(
      record &&
        record.version === 1 &&
        record.provider === 'claude' &&
        Object.keys(record).every((key) => ['version', 'provider', 'token'].includes(key)),
      'Invalid record.',
    );
    return validateClaudeToken(record.token);
  } catch {
    throw new Error(
      'Cannot read host Claude login (invalid or unsafe file). Run pis --login claude.',
    );
  } finally {
    fs.closeSync(fd);
  }
}

export async function saveClaudeToken(store, token) {
  validateClaudeToken(token);
  const file = tokenPath(store);
  await withLock(`${file}.lock`, async () => {
    readClaudeToken(store); // Reject unsafe existing files before replacement.
    atomicWrite(file, `${JSON.stringify({ version: 1, provider: 'claude', token })}\n`);
  });
}

export async function logoutClaudeToken(store) {
  const file = tokenPath(store);
  await withLock(`${file}.lock`, async () => {
    readClaudeToken(store);
    fs.rmSync(file, { force: true });
  });
}

/** Removes real-token copies left by the earlier per-project login design. */
export async function removeLegacyClaudeCredentials(store, id) {
  return store.projectLock(id, async () => {
    const state = claudeState(store, id);
    const removed = [state.legacyCredential, path.join(authDirectory(store), `claude-${id}.json`)]
      .filter((file) => fs.existsSync(file))
      .map((file) => (fs.rmSync(file, { force: true }), file));
    return removed.length;
  });
}

export function hasLegacyClaudeCredential(store, id) {
  try {
    fs.lstatSync(path.join(store.projectDir(id), 'claude-state', '.claude', '.credentials.json'));
    return true;
  } catch {
    return false;
  }
}

export function claudeLoginEnvironment(configDir, source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_|PIS_PROXY_)/.test(key) ||
      ['OPENAI_API_KEY', 'BERGET_API_KEY', 'MISTRAL_API_KEY', 'NODE_OPTIONS', 'NODE_PATH'].includes(
        key,
      )
    )
      delete env[key];
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, DISABLE_UPDATES: '1' };
}

function hostClaudeExecutable(store, binary) {
  assert(
    path.isAbsolute(binary),
    'PIS_CLAUDE_BIN must be an absolute path to the official host Claude Code executable.',
  );
  let executable;
  try {
    executable = fs.realpathSync(binary);
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    return undefined;
  }
  const shared = [
    store.projectsDir,
    ...store
      .all()
      .flatMap((project) => [project.root, ...project.mounts.map((mount) => mount.source)]),
  ];
  assert(
    !shared.some((dir) => within(dir, executable)),
    'Host Claude executable must not come from a sandbox-writable project, mount or state directory.',
  );
  return executable;
}

/**
 * Global host login. Optionally runs official `claude setup-token` in a fresh
 * host-only config directory (no repository settings/hooks, no existing login),
 * then reads the printed long-lived subscription token at a hidden prompt.
 */
export async function loginClaude(
  store,
  {
    execute = run,
    binary = process.env.PIS_CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude'),
    input = process.stdin,
    output = process.stdout,
  } = {},
) {
  assert(
    input.isTTY && output.isTTY && input.setRawMode,
    'Run pis --login claude interactively in a host terminal.',
  );
  const ask = (prompt, options) =>
    readTerminalLine({
      input,
      output,
      prompt,
      hidden: false,
      cancelError: 'Login cancelled.',
      ...options,
    });
  const executable = hostClaudeExecutable(store, binary);
  if (executable) {
    const answer = (
      await ask('Run official "claude setup-token" on this host now? [Y/n]: ')
    ).toLowerCase();
    if (answer !== 'n') {
      const auth = authDirectory(store);
      const temporary = fs.mkdtempSync(path.join(auth, 'claude-login-'));
      fs.chmodSync(temporary, 0o700);
      try {
        const code = await execute(executable, ['setup-token'], {
          cwd: temporary,
          env: claudeLoginEnvironment(temporary),
        });
        assert(code === 0, 'claude setup-token failed; the saved Claude login was not changed.');
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  } else {
    output.write(
      'Official host Claude Code was not found (~/.local/bin/claude or PIS_CLAUDE_BIN).\nRun "claude setup-token" wherever Claude Code is installed, then paste the token.\n',
    );
  }
  const token = (
    await ask('Paste the token printed by claude setup-token (hidden): ', {
      hidden: true,
      maxBytes: 4096,
    })
  ).trim();
  await saveClaudeToken(store, token);
}

export function claudeNeedsLogin(args = []) {
  return (
    !['auth', 'doctor', 'mcp', 'install', 'update'].includes(args[0]) &&
    !args.some((arg) => ['--help', '-h', '--version', '-v'].includes(arg))
  );
}

export function claudeCommand(args = []) {
  // Unlike Pi, start a new session by default. Forward explicit -c/-r unchanged.
  return ['claude', ...args];
}

function apiError(res, status, type, message, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
    ...headers,
  });
  res.end(JSON.stringify({ type: 'error', error: { type, message: `pis proxy: ${message}` } }));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0,
      chunks = [],
      failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !failed) {
        failed = true;
        chunks = [];
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
      }
      if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => reject(new Error('Request interrupted.')));
    req.on('aborted', () => reject(new Error('Request interrupted.')));
  });
}

function headerValue(value) {
  return typeof value === 'string' && /^[\x20-\x7e]{1,4096}$/.test(value) ? value : undefined;
}

export function upstreamRequestHeaders(incoming, token, length) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name) && !name.startsWith('x-stainless-')) continue;
    const valid = headerValue(value);
    if (valid !== undefined) headers[name] = valid;
  }
  const betas = (headers['anthropic-beta'] || '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  return {
    ...headers,
    'anthropic-version': headers['anthropic-version'] || '2023-06-01',
    'anthropic-beta': betas.join(','),
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    'content-length': length,
  };
}

/**
 * Host-only Claude model proxy. The sandbox reaches it only through a private
 * mounted Unix socket. It forwards Messages API calls to the fixed Anthropic
 * origin with the subscription token; there is never an API-key fallback.
 * No headers, payloads or credentials are logged. `upstream` is for local tests.
 */
export async function startClaudeProxy({
  socketPath,
  token,
  upstream,
  maxRequests = 20_000,
  maxConcurrent = 16,
  maxBodyBytes = 32 * 1024 * 1024,
  idleTimeoutMs = 600_000,
}) {
  validateClaudeToken(token);
  const origin = new URL(upstream || CLAUDE_UPSTREAM);
  assert(
    origin.pathname === '/' &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      (origin.protocol === 'https:' ||
        (upstream && origin.protocol === 'http:' && origin.hostname === '127.0.0.1')),
    'Claude upstream must be the fixed HTTPS origin.',
  );
  const request = origin.protocol === 'https:' ? https.request : http.request;
  const active = new Set(),
    sockets = new Set(),
    refused = new Set();
  let concurrent = 0,
    used = 0;

  async function handle(req, res) {
    if (req.method !== 'POST' || !ROUTE.test(req.url)) {
      if (refused.size < 32)
        refused.add(
          `${req.method} ${req.url
            .split('?')[0]
            .replace(/[^A-Za-z0-9/_.-]/g, '_')
            .slice(0, 80)}`,
        );
      return apiError(res, 404, 'not_found_error', 'Only Claude model calls are forwarded.');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
      return apiError(res, 415, 'invalid_request_error', 'JSON content type required.');
    if (concurrent >= maxConcurrent)
      return apiError(res, 429, 'rate_limit_error', 'Local concurrency limit reached.', {
        'retry-after': '1',
      });
    if (used >= maxRequests)
      return apiError(
        res,
        429,
        'rate_limit_error',
        'Local request budget for this launch is exhausted. Restart pis.',
        {
          'x-should-retry': 'false',
        },
      );
    concurrent++;
    let outgoing,
      finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      concurrent--;
      if (outgoing) {
        active.delete(outgoing);
        outgoing.destroy();
      }
    };
    res.once('close', finish);
    let payload;
    try {
      payload = await readBody(req, maxBodyBytes);
    } catch (error) {
      return apiError(
        res,
        error.status || 400,
        'invalid_request_error',
        error.status === 413 ? 'Request body too large.' : 'Interrupted request.',
      );
    }
    if (finished || res.destroyed) return;
    if (used >= maxRequests)
      return apiError(
        res,
        429,
        'rate_limit_error',
        'Local request budget for this launch is exhausted. Restart pis.',
        {
          'x-should-retry': 'false',
        },
      );
    used++;
    outgoing = request(
      new URL(req.url, origin.origin),
      // Never forwards client Host, credentials, cookies, proxy or forwarding headers.
      { method: 'POST', headers: upstreamRequestHeaders(req.headers, token, payload.length) },
      (upstreamResponse) => {
        const status = upstreamResponse.statusCode || 502;
        if (status >= 300 && status < 400) {
          upstreamResponse.destroy();
          return apiError(res, 502, 'api_error', 'Upstream redirect refused.');
        }
        const encoding = upstreamResponse.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          upstreamResponse.destroy();
          return apiError(res, 502, 'api_error', 'Unsupported upstream content encoding.');
        }
        const headers = { 'cache-control': 'no-store' };
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (!FORWARDED_RESPONSE_HEADERS.has(name) && !name.startsWith('anthropic-ratelimit-'))
            continue;
          const valid = headerValue(value);
          if (valid !== undefined) headers[name] = valid;
        }
        if (res.destroyed || res.writableEnded) return upstreamResponse.destroy();
        res.writeHead(status, headers);
        // Error bodies are forwarded too: Claude needs Anthropic's error types
        // (overload, rate limit, context length). The token is still redacted.
        pipeline(upstreamResponse, new SecretRedactor(token), res, () => finish());
      },
    );
    active.add(outgoing);
    outgoing.setTimeout(idleTimeoutMs, () => {
      apiError(res, 504, 'api_error', 'Upstream idle timeout.');
      outgoing.destroy();
    });
    outgoing.on('error', () => apiError(res, 502, 'api_error', 'Anthropic connection failed.'));
    outgoing.end(payload);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => apiError(res, 502, 'api_error', 'Proxy request failed.'));
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.maxHeadersCount = 100;
  server.maxConnections = 128;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  return {
    refused: () => [...refused],
    requests: () => used,
    async close() {
      for (const outgoing of active) outgoing.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    },
  };
}

/** Starts a per-launch Claude proxy in a private short runtime directory. */
export async function prepareClaudeProxy(store, { upstream } = {}) {
  const token = readClaudeToken(store);
  assert(token, 'No Claude login saved. Run pis --login claude on the host.');
  // Fixed short parent avoids AF_UNIX path-length limits.
  const directory = fs.mkdtempSync('/tmp/pis-claude-');
  fs.chmodSync(directory, 0o700);
  try {
    const proxy = await startClaudeProxy({
      socketPath: path.join(directory, path.basename(CLAUDE_SOCKET)),
      token,
      upstream,
    });
    return {
      provider: 'claude',
      directory,
      refused: proxy.refused,
      requests: proxy.requests,
      async close() {
        try {
          await proxy.close();
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
