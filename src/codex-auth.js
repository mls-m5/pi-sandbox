import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, withLock, writeJson } from './util.js';

// Matches Pi 1.2's OpenAI Codex device authorization flow. No credentials are
// resolved through a container, shell command, project extension, or host Pi.
const AUTH_ORIGIN = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CLAIM = 'https://api.openai.com/auth';
const MAX_FILE_BYTES = 128 * 1024;

export function codexClaims(access) {
  try {
    assert(typeof access === 'string' && access.length <= 32_768 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(access), 'Invalid token.');
    const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
    const accountId = claims?.[CLAIM]?.chatgpt_account_id;
    assert(typeof accountId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(accountId), 'Missing account.');
    assert(Number.isFinite(claims.exp) && claims.exp > 0, 'Missing expiry.');
    // Decoding is not signature verification; the fixed upstream validates the token.
    return { accountId, expires: claims.exp * 1000 };
  } catch { throw new Error('Invalid Codex access token (account and expiry claims required).'); }
}

export function dummyCodexToken() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 86400, [CLAIM]: { chatgpt_account_id: 'pis-proxy-account' } })}.${randomBytes(32).toString('base64url')}`;
}

export function normalizeCodexCredential(record) {
  try {
    assert(record && typeof record === 'object', 'Invalid credential.');
    const { accountId, expires: jwtExpiry } = codexClaims(record.access);
    assert(typeof record.refresh === 'string' && /^[!-~]{1,16384}$/.test(record.refresh), 'Missing refresh token.');
    const expires = record.expires === undefined ? jwtExpiry : Math.min(record.expires, jwtExpiry);
    assert(Number.isFinite(expires) && expires > 0, 'Invalid expiry.');
    if (record.accountId !== undefined) assert(record.accountId === accountId, 'Account mismatch.');
    return { version: 1, provider: 'openai-codex', type: 'oauth', access: record.access, refresh: record.refresh, expires, accountId };
  } catch { throw new Error('Invalid Codex OAuth credentials. Sign in again or import a ChatGPT OAuth credential, not an API key.'); }
}

function authDir(store) {
  const dir = path.join(store.root, 'auth');
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Host auth directory must be owned by you and must not be a symlink.');
  fs.chmodSync(dir, 0o700);
  return dir;
}

function readRecord(file, privateFile = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES, 'Invalid file.');
    if (privateFile) assert(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Credential file must be private.');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    assert(record && typeof record === 'object' && !Array.isArray(record), 'Invalid JSON.');
    return record;
  } catch { throw new Error('Cannot read Codex credentials. Use pis --login-codex or --import-codex; managed credentials must be private regular JSON files.'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readCodexCredential(store) {
  return normalizeCodexCredential(readRecord(path.join(authDir(store), 'openai-codex.json'), true));
}

export function hasCodexCredential(store) {
  return fs.existsSync(path.join(store.root, 'auth', 'openai-codex.json'));
}

async function authLock(store, action, signal) {
  const lock = path.join(authDir(store), 'openai-codex.lock');
  const deadline = Date.now() + 60_000;
  while (true) {
    signal?.throwIfAborted();
    try { return await withLock(lock, action); }
    catch (error) {
      if (error.code !== 'PIS_LOCKED' || Date.now() >= deadline) throw error;
      await delay(100, undefined, { signal });
    }
  }
}

export async function saveCodexCredential(store, credential, signal) {
  const normalized = normalizeCodexCredential(credential);
  await authLock(store, async () => writeJson(path.join(authDir(store), 'openai-codex.json'), normalized), signal);
  return normalized;
}

export async function importCodexCredential(store, file) {
  const record = readRecord(path.resolve(file));
  const pi = record['openai-codex'] || (record.openai?.type === 'oauth' ? record.openai : undefined);
  const source = pi || (record.tokens ? { access: record.tokens.access_token, refresh: record.tokens.refresh_token, accountId: record.tokens.account_id || undefined } : record);
  assert(!pi || pi.type === 'oauth', 'Import requires ChatGPT OAuth credentials, not a stored API key.');
  return saveCodexCredential(store, source);
}

export async function logoutCodex(store) {
  await authLock(store, async () => fs.rmSync(path.join(authDir(store), 'openai-codex.json'), { force: true }));
}

async function post(endpoint, data, { form = false, signal, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${AUTH_ORIGIN}${endpoint}`, {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(data).toString() : JSON.stringify(data),
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) throw new Error('Response too large.');
      chunks.push(Buffer.from(chunk));
    }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { json = {}; }
    return { status: response.status, json };
  } catch {
    throw new Error(signal?.aborted ? 'Codex authentication cancelled.' : 'Codex authentication request failed. No credentials were changed.');
  }
}

function tokenCredential(response) {
  assert(response.status === 200, `Codex token exchange/refresh failed (status ${response.status}). Run pis --login-codex if needed.`);
  const token = response.json;
  assert(typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 0, 'Invalid Codex token response.');
  return normalizeCodexCredential({ access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 });
}

export async function refreshCodexCredential(credential, options = {}) {
  return tokenCredential(await post('/oauth/token', { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: credential.refresh }, { ...options, form: true }));
}

export async function getCodexCredential(store, { signal, fetchImpl } = {}) {
  const current = readCodexCredential(store);
  if (current.expires > Date.now() + 60_000) return current;
  return authLock(store, async () => {
    // Other projects may have refreshed while this request waited for the lock.
    const latest = readCodexCredential(store);
    if (latest.expires > Date.now() + 60_000) return latest;
    const refreshed = await refreshCodexCredential(latest, { signal, fetchImpl });
    signal?.throwIfAborted();
    writeJson(path.join(authDir(store), 'openai-codex.json'), refreshed);
    return refreshed;
  }, signal);
}

export async function loginCodex(store, { notify = console.error, signal, fetchImpl, sleep = delay } = {}) {
  const options = { signal, fetchImpl };
  const device = await post('/api/accounts/deviceauth/usercode', { client_id: CLIENT_ID }, options);
  assert(device.status === 200, `Codex device sign-in failed (status ${device.status}). Enable device-code login for your account or import an existing host sign-in.`);
  const { device_auth_id: deviceId, user_code: code } = device.json;
  let interval = Number(device.json.interval);
  assert(typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length <= 4096, 'Invalid Codex device authorization response.');
  assert(typeof code === 'string' && /^[A-Za-z0-9 -]{1,64}$/.test(code) && Number.isFinite(interval) && interval >= 0 && interval <= 60, 'Invalid Codex device authorization response.');
  interval = Math.max(1, interval);
  notify(`Open https://auth.openai.com/codex/device in your browser and enter code: ${code}`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, undefined, { signal });
    signal?.throwIfAborted();
    const poll = await post('/api/accounts/deviceauth/token', { device_auth_id: deviceId, user_code: code }, options);
    if ([403, 404].includes(poll.status) || poll.json.error === 'authorization_pending' || poll.json.error === 'deviceauth_authorization_pending') continue;
    if (poll.status === 429 || poll.json.error === 'slow_down') { interval = Math.min(60, interval + 5); continue; }
    assert(poll.status === 200, `Codex device sign-in failed (status ${poll.status}).`);
    const { authorization_code: authorizationCode, code_verifier: verifier } = poll.json;
    assert(typeof authorizationCode === 'string' && authorizationCode && typeof verifier === 'string' && verifier, 'Invalid Codex device token response.');
    const credential = tokenCredential(await post('/oauth/token', { grant_type: 'authorization_code', client_id: CLIENT_ID, code: authorizationCode, code_verifier: verifier, redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback` }, { ...options, form: true }));
    signal?.throwIfAborted();
    return saveCodexCredential(store, credential, signal);
  }
  throw new Error('Codex device sign-in timed out. Try pis --login-codex again.');
}
