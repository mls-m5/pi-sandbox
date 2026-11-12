import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, withLock, writeJson } from './util.js';
import { codexUsageSummary } from './codex-usage.js';

// Matches Pi 1.5's OpenAI Codex device authorization flow. No credentials are
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
    // A workspace/account ID can be shared by distinct users. Bind local identity
    // to the JWT subject too when available, without exposing that subject.
    const subject = claims[CLAIM]?.chatgpt_user_id ?? claims[CLAIM]?.user_id ?? claims.sub ?? null;
    assert(subject === null || (typeof subject === 'string' && subject.length > 0 && subject.length <= 512), 'Invalid subject.');
    const identity = createHash('sha256').update(JSON.stringify([accountId, subject])).digest('hex');
    // Decoding is not signature verification; the fixed upstream validates the token.
    return { accountId, expires: claims.exp * 1000, identity };
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

export function codexAccountName(name) {
  assert(typeof name === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(name), 'Codex account names must be 1–32 lowercase letters/digits/_/-, starting with a letter.');
  return name;
}
function credentialFile(store, account) {
  return path.join(authDir(store), account === 'default' ? 'openai-codex.json' : `openai-codex-account-${codexAccountName(account)}.json`);
}
function policyFile(store) { return path.join(authDir(store), 'openai-codex-accounts.json'); }
export function readCodexAccountsPolicy(store) {
  const file = policyFile(store);
  try { fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, active: 'default', pool: [], revision: '0'.repeat(32) }; throw error; }
  try {
    const record = readRecord(file, true);
    assert(Object.keys(record).every(key => ['version', 'active', 'pool', 'revision'].includes(key)) && record.version === 1 && typeof record.revision === 'string' && /^[a-f0-9]{32}$/.test(record.revision), 'Invalid account policy.');
    codexAccountName(record.active);
    assert(Array.isArray(record.pool) && (record.pool.length === 0 || (record.pool.length >= 2 && record.pool.length <= 16)) && new Set(record.pool).size === record.pool.length, 'Invalid auto-switch pool.');
    record.pool.forEach(codexAccountName);
    return record;
  } catch { throw new Error('Cannot read private Codex account settings; no account fallback was performed.'); }
}
function savePolicy(store, policy) {
  const next = { ...policy, revision: randomBytes(16).toString('hex') };
  writeJson(policyFile(store), next); return next;
}
function removeFromPool(policy, account) {
  const pool = policy.pool.filter(name => name !== account);
  return { ...policy, pool: pool.length >= 2 ? pool : [] };
}
export function codexAccountNames(store) {
  const names = fs.readdirSync(authDir(store)).flatMap(file => {
    if (file === 'openai-codex.json') return ['default'];
    const match = /^openai-codex-account-([a-z][a-z0-9_-]{0,31})\.json$/.exec(file);
    return match && match[1] !== 'default' ? [match[1]] : [];
  }).sort();
  assert(names.length <= 32, 'At most 32 Codex accounts are supported.'); return names;
}
export function readCodexCredential(store, account = readCodexAccountsPolicy(store).active) {
  return normalizeCodexCredential(readRecord(credentialFile(store, codexAccountName(account)), true));
}
export function hasCodexCredential(store, account = readCodexAccountsPolicy(store).active) {
  return codexAccountNames(store).includes(codexAccountName(account));
}
export function codexAccountsStatus(store) {
  const policy = readCodexAccountsPolicy(store);
  return { active: policy.active, activeCredentialPresent: hasCodexCredential(store, policy.active), autoSwitch: policy.pool.length > 0, routingAutomatic: policy.pool.includes(policy.active), pool: policy.pool, accounts: codexAccountNames(store).map(name => {
    let valid = false;
    try { readCodexCredential(store, name); valid = true; } catch { /* Never print stored contents. */ }
    return { name, active: name === policy.active, autoSwitch: policy.pool.includes(name), credentialValid: valid };
  }) };
}
export async function useCodexAccount(store, account, { expectedRevision, signal, expectedCredential } = {}) {
  codexAccountName(account);
  return authLock(store, async () => {
    signal?.throwIfAborted();
    const policy = readCodexAccountsPolicy(store);
    if (expectedRevision !== undefined && policy.revision !== expectedRevision) return false;
    const current = readCodexCredential(store, account);
    if (expectedCredential && (current.access !== expectedCredential.access || codexClaims(current.access).identity !== codexClaims(expectedCredential.access).identity)) return false;
    savePolicy(store, { ...policy, active: account }); return true;
  }, signal);
}
export async function renameCodexAccount(store, from, to) {
  codexAccountName(from); codexAccountName(to);
  assert(from !== to, 'Choose a different Codex account name.');
  return authLock(store, async () => {
    readCodexCredential(store, from);
    assert(!codexAccountNames(store).includes(to), 'The destination Codex profile already exists.');
    const policy = readCodexAccountsPolicy(store);
    // Same-directory rename never copies a rotating refresh token to two aliases.
    // A crash between file/policy writes fails closed; --codex-use NEW recovers.
    fs.renameSync(credentialFile(store, from), credentialFile(store, to));
    savePolicy(store, { ...policy, active: policy.active === from ? to : policy.active, pool: policy.pool.map(name => name === from ? to : name) });
    return codexAccountsStatus(store);
  });
}

export async function setCodexAutoSwitch(store, selection) {
  return authLock(store, async () => {
    const policy = readCodexAccountsPolicy(store);
    const pool = selection === 'off' ? [] : selection === 'on' ? codexAccountNames(store) : selection.split(',').map(codexAccountName);
    assert(pool.length === 0 || (pool.length >= 2 && pool.length <= 16 && new Set(pool).size === pool.length && pool.includes(policy.active)), 'Auto-switch needs 2–16 distinct saved profiles including the active account.');
    const ids = pool.map(name => codexClaims(readCodexCredential(store, name).access).identity);
    assert(new Set(ids).size === ids.length, 'Auto-switch profiles must represent different Codex accounts.');
    savePolicy(store, { ...policy, pool });
    return codexAccountsStatus(store);
  });
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

export async function saveCodexCredential(store, credential, signal, account = readCodexAccountsPolicy(store).active) {
  codexAccountName(account);
  const normalized = normalizeCodexCredential(credential);
  await authLock(store, async () => {
    signal?.throwIfAborted();
    const names = codexAccountNames(store);
    assert(names.includes(account) || names.length < 32, 'At most 32 Codex accounts are supported.');
    for (const name of names.filter(name => name !== account)) {
      let other; try { other = readCodexCredential(store, name); } catch { continue; }
      assert(codexClaims(other.access).identity !== codexClaims(normalized.access).identity, `That Codex account is already saved as ${name}; use that profile instead.`);
    }
    let policy = readCodexAccountsPolicy(store), old;
    try { old = readCodexCredential(store, account); } catch { /* First login or replacement. */ }
    if (!old || codexClaims(old.access).identity !== codexClaims(normalized.access).identity) policy = removeFromPool(policy, account);
    // Revoke stale automatic decisions before replacing a profile's identity.
    savePolicy(store, { ...policy, ...(names.length === 0 ? { active: account } : {}) });
    writeJson(credentialFile(store, account), normalized);
  }, signal);
  return normalized;
}

export async function importCodexCredential(store, file, { account = readCodexAccountsPolicy(store).active } = {}) {
  codexAccountName(account);
  const record = readRecord(path.resolve(file));
  const pi = record['openai-codex'] || (record.openai?.type === 'oauth' ? record.openai : undefined);
  const source = pi || (record.tokens ? { access: record.tokens.access_token, refresh: record.tokens.refresh_token, accountId: record.tokens.account_id || undefined } : record);
  assert(!pi || pi.type === 'oauth', 'Import requires ChatGPT OAuth credentials, not a stored API key.');
  return saveCodexCredential(store, source, undefined, account);
}

export async function logoutCodex(store, { account = readCodexAccountsPolicy(store).active } = {}) {
  codexAccountName(account);
  await authLock(store, async () => {
    savePolicy(store, removeFromPool(readCodexAccountsPolicy(store), account));
    fs.rmSync(credentialFile(store, account), { force: true });
  });
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

export async function getCodexCredential(store, { signal, fetchImpl, account = readCodexAccountsPolicy(store).active } = {}) {
  codexAccountName(account);
  signal?.throwIfAborted();
  const current = readCodexCredential(store, account);
  if (current.expires > Date.now() + 60_000) return current;
  return authLock(store, async () => {
    // Other projects may have refreshed while this request waited for the lock.
    const latest = readCodexCredential(store, account);
    if (latest.expires > Date.now() + 60_000) return latest;
    const refreshed = await refreshCodexCredential(latest, { signal, fetchImpl });
    signal?.throwIfAborted();
    assert(codexClaims(refreshed.access).identity === codexClaims(latest.access).identity, 'Codex refresh changed account identity; sign in explicitly again.');
    writeJson(credentialFile(store, account), refreshed);
    return refreshed;
  }, signal);
}

export async function getCodexUsage(store, { signal, fetchImpl = fetch, account } = {}) {
  const credential = await getCodexCredential(store, { signal, fetchImpl, account });
  return fetchCodexUsage(credential, { signal, fetchImpl });
}

export async function fetchCodexUsage(credential, { signal, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      headers: { authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId, originator: 'codex-cli', 'user-agent': 'codex-cli', accept: 'application/json' },
    });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.length; assert(bytes <= MAX_FILE_BYTES, 'Codex usage response too large.'); chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    assert(response.status === 200, `Codex usage request failed (status ${response.status}).`);
    return codexUsageSummary(JSON.parse(body));
  } catch (error) {
    if (signal?.aborted) throw new Error('Codex usage request cancelled.');
    if (error.message === 'Codex usage request failed (status 401).') throw new Error('Codex usage authentication failed. Sign in again.');
    throw new Error('Codex usage request failed.');
  }
}

export async function loginCodex(store, { notify = console.error, signal, fetchImpl, sleep = delay, account = readCodexAccountsPolicy(store).active } = {}) {
  codexAccountName(account);
  const options = { signal, fetchImpl };
  notify('Open this URL manually in your browser:\nhttps://auth.openai.com/codex/device\n\nRequesting your sign-in code...');
  const device = await post('/api/accounts/deviceauth/usercode', { client_id: CLIENT_ID }, options);
  assert(device.status === 200, `Codex device sign-in failed (status ${device.status}). Enable device-code login for your account or import an existing host sign-in.`);
  const { device_auth_id: deviceId, user_code: code } = device.json;
  assert(['string', 'number'].includes(typeof device.json.interval), 'Invalid Codex polling interval.');
  let interval = Number(device.json.interval);
  assert(typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length <= 4096, 'Invalid Codex device authorization response.');
  assert(typeof code === 'string' && /^[A-Za-z0-9 -]{1,64}$/.test(code) && Number.isFinite(interval) && interval >= 0 && interval <= 60, 'Invalid Codex device authorization response.');
  interval = Math.max(1, interval);
  notify(`\nSign-in code: ${code}\nEnter this code on the page above. Waiting for authorization (Ctrl-C to cancel)...`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(Math.min(interval * 1000, deadline - Date.now()), undefined, { signal });
    signal?.throwIfAborted();
    if (Date.now() >= deadline) break;
    const poll = await post('/api/accounts/deviceauth/token', { device_auth_id: deviceId, user_code: code }, options);
    const errorCode = typeof poll.json.error === 'object' ? poll.json.error?.code : poll.json.error;
    if ([403, 404].includes(poll.status) || errorCode === 'authorization_pending' || errorCode === 'deviceauth_authorization_pending') continue;
    if (poll.status === 429 || errorCode === 'slow_down') { interval = Math.min(60, interval + 5); continue; }
    assert(poll.status === 200, `Codex device sign-in failed (status ${poll.status}).`);
    const { authorization_code: authorizationCode, code_verifier: verifier } = poll.json;
    assert(typeof authorizationCode === 'string' && authorizationCode && typeof verifier === 'string' && verifier, 'Invalid Codex device token response.');
    const credential = tokenCredential(await post('/oauth/token', { grant_type: 'authorization_code', client_id: CLIENT_ID, code: authorizationCode, code_verifier: verifier, redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback` }, { ...options, form: true }));
    signal?.throwIfAborted();
    return saveCodexCredential(store, credential, signal, account);
  }
  throw new Error('Codex device sign-in timed out. Try pis --login-codex again.');
}
