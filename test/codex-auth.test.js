import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { codexClaims, dummyCodexToken, importCodexCredential, saveCodexCredential, readCodexCredential, getCodexCredential, logoutCodex, loginCodex } from '../src/codex-auth.js';
import { fakeCodexAccess, fakeCodexCredential } from './fixtures/codex.js';

function fixture(t) {
  const dir = fs.mkdtempSync('/tmp/pis-codex-auth-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(path.join(dir, 'storage')) };
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('Codex dummy tokens satisfy parser requirements without disclosing account or credentials', () => {
  const dummy = dummyCodexToken();
  assert.equal(codexClaims(dummy).accountId, 'pis-proxy-account');
  assert.notEqual(dummy, dummyCodexToken());
  for (const invalid of ['sk-api-key', 'bad.jwt.token', fakeCodexAccess({ accountId: 'bad\r\nheader' })]) assert.throws(() => codexClaims(invalid), /Invalid Codex/);
});

test('host-only imports accept Pi and Codex OAuth files, copy only selected fields, and stay private', async t => {
  const { dir, store } = fixture(t);
  const credential = fakeCodexCredential();
  const pi = path.join(dir, 'pi.json');
  fs.writeFileSync(pi, JSON.stringify({ 'openai-codex': credential, other: { key: 'do-not-copy' } }));
  await importCodexCredential(store, pi);
  const file = path.join(store.root, 'auth/openai-codex.json');
  assert.equal(readCodexCredential(store).access, credential.access);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('do-not-copy'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const codex = path.join(dir, 'codex.json');
  fs.writeFileSync(codex, JSON.stringify({ tokens: { access_token: credential.access, refresh_token: credential.refresh, account_id: null, id_token: 'unused-id-token' } }));
  await importCodexCredential(store, codex);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('unused-id-token'));
  await logoutCodex(store);
  assert.ok(!fs.existsSync(file));
});

test('imports refuse API keys, malformed JSON, symlinks, and non-private managed files without echoing secrets', async t => {
  const { dir, store } = fixture(t);
  const file = path.join(dir, 'source.json');
  for (const text of ['{"openai-codex":{"type":"api_key","key":"sk-secret"}}', 'invalid-secret-json']) {
    fs.writeFileSync(file, text);
    await assert.rejects(importCodexCredential(store, file), error => !error.message.includes('sk-secret') && !error.message.includes('invalid-secret-json'));
  }
  fs.writeFileSync(file, JSON.stringify(fakeCodexCredential()));
  const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
  await assert.rejects(importCodexCredential(store, link), /Cannot read/);
  await importCodexCredential(store, file);
  fs.chmodSync(path.join(store.root, 'auth/openai-codex.json'), 0o644);
  assert.throws(() => readCodexCredential(store), /private/);
});

test('refresh rotates host tokens, serializes concurrent requests, and never returns the refresh token upstream', async t => {
  const { store } = fixture(t);
  await saveCodexCredential(store, fakeCodexCredential({ expires: Math.floor(Date.now() / 1000) - 10 }));
  let refreshes = 0;
  const access = fakeCodexAccess({ signature: 'rotated-access-token' });
  const fetchImpl = async (url, options) => {
    refreshes++;
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    assert.equal(options.redirect, 'error');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'fake-private-refresh-token');
    return response({ access_token: access, refresh_token: 'rotated-private-refresh', expires_in: 3600 });
  };
  const results = await Promise.all([getCodexCredential(store, { fetchImpl }), getCodexCredential(store, { fetchImpl })]);
  assert.equal(refreshes, 1);
  assert.ok(results.every(result => result.access === access));
  assert.equal(readCodexCredential(store).refresh, 'rotated-private-refresh');
});

test('failed or cancelled refresh preserves existing credentials and releases the host lock', async t => {
  const { store } = fixture(t);
  const expired = fakeCodexCredential({ expires: Math.floor(Date.now() / 1000) - 1 });
  await saveCodexCredential(store, expired);
  await assert.rejects(getCodexCredential(store, { fetchImpl: async () => response({ secret: expired.refresh }, 401) }), error => !error.message.includes(expired.refresh));
  assert.equal(readCodexCredential(store).refresh, expired.refresh);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(getCodexCredential(store, { signal: controller.signal }));
  assert.ok(!fs.existsSync(path.join(store.root, 'auth/openai-codex.lock')));
});

test('cancelling an in-flight host refresh releases its lock and preserves the stored refresh token', async t => {
  const { store } = fixture(t);
  await saveCodexCredential(store, fakeCodexCredential({ expires: Math.floor(Date.now() / 1000) - 1 }));
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = getCodexCredential(store, {
    signal: controller.signal,
    fetchImpl: async (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private-network-details')), { once: true });
      entered();
    }),
  });
  await started;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(readCodexCredential(store).refresh, 'fake-private-refresh-token');
  assert.ok(!fs.existsSync(path.join(store.root, 'auth/openai-codex.lock')));
});

test('device login runs entirely on the host, polls pending states, and saves private OAuth credentials', async t => {
  const { store } = fixture(t);
  const notices = [], waits = [], calls = [];
  const credential = fakeCodexCredential();
  const replies = [
    response({ device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: '1' }),
    response({}, 403),
    response({ authorization_code: 'one-time-code', code_verifier: 'one-time-verifier' }),
    response({ access_token: credential.access, refresh_token: credential.refresh, expires_in: 3600 }),
  ];
  await loginCodex(store, {
    notify: text => notices.push(text), sleep: async ms => waits.push(ms),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return replies.shift(); },
  });
  assert.match(notices[0], /https:\/\/auth.openai.com\/codex\/device/);
  assert.match(notices[0], /ABCD-EFGH/);
  assert.ok(!notices.join('').includes(credential.access));
  assert.ok(!notices.join('').includes(credential.refresh));
  assert.deepEqual(waits, [1000, 1000]);
  const form = new URLSearchParams(calls.at(-1).options.body);
  assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  assert.equal(form.get('code_verifier'), 'one-time-verifier');
  assert.equal(readCodexCredential(store).access, credential.access);
});
