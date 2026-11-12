import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';
import { prepareProxy } from '../src/proxy-runtime.js';
import { waitForCodex } from '../src/codex-wait.js';
import { startCodexAutoServer } from '../src/codex-auto.js';
import { requestCodexWait } from '../src/runtime/codex-auto.mjs';
import { createCodexAccountRouter, getRoutedCodexUsage } from '../src/codex-accounts.js';
import { codexClaims, saveCodexCredential, readCodexCredential, getCodexCredential, getCodexUsage, loginCodex, logoutCodex, useCodexAccount, setCodexAutoSwitch, readCodexAccountsPolicy, codexAccountsStatus, renameCodexAccount } from '../src/codex-auth.js';
import { fakeCodexCredential, fakeCodexAccess } from './fixtures/codex.js';

const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const quota = used => ({ rate_limit: { allowed: true, limit_reached: used === 100, primary_window: { used_percent: used, reset_after_seconds: 60 } }, account: 'not-exposed', email: 'not-exposed' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, names = ['default', 'spare']) {
  const base = fs.mkdtempSync('/tmp/pis-codex-accounts-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage')), config = await store.register(root), credentials = {};
  for (const account of names) {
    credentials[account] = { ...fakeCodexCredential({ accountId: `private-${account}`, signature: `signature-${account}` }), refresh: `private-refresh-${account}` };
    await saveCodexCredential(store, credentials[account], undefined, account);
  }
  return { base, store, config, credentials };
}
function usageFetch(values) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.redirect, 'error');
    const id = codexClaims(options.headers.authorization.slice(7)).accountId;
    assert.equal(options.headers['chatgpt-account-id'], id); calls.push(id);
    const value = values[id];
    if (value instanceof Error) throw value;
    return response(typeof value === 'number' ? quota(value) : value);
  };
  return { calls, fetchImpl };
}
async function proxyFixture(t, store, config, fetchImpl, handler) {
  const upstream = http.createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await prepareProxy(store, config, { upstream: `http://127.0.0.1:${upstream.address().port}`, codexAuthFetch: fetchImpl });
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = (payload = { model: 'fake-model', input: 'local test' }) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(proxy.directory, 'api.sock'), path: '/backend-api/codex/responses', method: 'POST', headers: {
      authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json', 'chatgpt-account-id': 'client-cannot-select-an-account',
    } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, body, headers: res.headers })); res.once('error', reject);
    });
    req.once('error', reject); req.end(JSON.stringify(payload));
  });
  return { proxy, request };
}

test('Codex account CLI is host-global, bounded and never accepts a profile selector in agent launches', () => {
  for (const action of ['--login-codex', '--logout-codex', '--codex-usage']) assert.equal(parse([action, '--codex-account', 'spare']).codexAccount, 'spare');
  assert.equal(parse(['--import-codex', '/tmp/auth.json', '--codex-account=spare']).codexAccount, 'spare');
  assert.equal(parse(['--codex-use', 'spare']).action, 'codex-use');
  for (const args of [
    ['--codex-account', 'spare'], ['--codex-use', '../auth'], ['--login-codex', '--codex-account', 'Name'],
    ['--codex-use', 'spare', '--project', 'abc12'], ['--codex-accounts', '--fresh'], ['--codex-accounts', '--', 'task'],
    ['--codex-auto-switch', 'one'], ['--codex-auto-switch', 'one,one'], ['--codex-auto-switch', 'one,../two'],
  ]) assert.throws(() => parse(args));
});

test('legacy default and named profiles remain separate/private, first profile is selected, additions do not switch', async t => {
  const { store, credentials } = await fixture(t);
  assert.equal(readCodexAccountsPolicy(store).active, 'default');
  assert.deepEqual(readCodexAccountsPolicy(store).pool, []);
  assert.equal(readCodexCredential(store).access, credentials.default.access);
  await useCodexAccount(store, 'spare');
  assert.equal(readCodexCredential(store).access, credentials.spare.access);
  assert.equal(readCodexCredential(store, 'default').access, credentials.default.access);
  for (const name of fs.readdirSync(path.join(store.root, 'auth'))) assert.equal(fs.statSync(path.join(store.root, 'auth', name)).mode & 0o077, 0);
  const status = JSON.stringify(codexAccountsStatus(store));
  for (const credential of Object.values(credentials)) for (const secret of [credential.access, credential.refresh, credential.accountId]) assert.ok(!status.includes(secret));
  const other = await fixture(t, ['personal']); assert.equal(readCodexAccountsPolicy(other.store).active, 'personal');
});

test('auto pool is explicit, rejects duplicate identities, never grows on login, and loses replaced/removed identities', async t => {
  const { store, credentials } = await fixture(t);
  await assert.rejects(saveCodexCredential(store, credentials.default, undefined, 'duplicate'), /already saved/);
  await setCodexAutoSwitch(store, 'on');
  await saveCodexCredential(store, fakeCodexCredential({ accountId: 'third' }), undefined, 'third');
  assert.deepEqual(readCodexAccountsPolicy(store).pool, ['default', 'spare']);
  await saveCodexCredential(store, fakeCodexCredential({ accountId: 'replacement' }), undefined, 'spare');
  assert.deepEqual(readCodexAccountsPolicy(store).pool, []);
  await setCodexAutoSwitch(store, 'default,third');
  await logoutCodex(store, { account: 'third' });
  assert.deepEqual(readCodexAccountsPolicy(store).pool, []);
  assert.equal(readCodexCredential(store).access, credentials.default.access);
  await logoutCodex(store);
  assert.equal(readCodexAccountsPolicy(store).active, 'default'); // No implicit spending on another account.
  assert.throws(() => readCodexCredential(store), /Cannot read/);
  assert.equal(codexAccountsStatus(store).accounts.some(item => item.name === 'spare'), true);
});

test('identity includes the user subject as well as workspace, preventing accidental deduplication or identity replacement', async t => {
  const { store } = await fixture(t, []);
  const alice = fakeCodexCredential({ accountId: 'shared-workspace', userId: 'alice' });
  const bob = fakeCodexCredential({ accountId: 'shared-workspace', userId: 'bob' });
  await saveCodexCredential(store, alice, undefined, 'default');
  await saveCodexCredential(store, bob, undefined, 'work');
  await setCodexAutoSwitch(store, 'default,work');
  const router = createCodexAccountRouter(store, { notify: () => {}, fetchImpl: async (_url, options) => response(quota(options.headers.authorization === `Bearer ${alice.access}` ? 100 : 0)) });
  assert.equal((await router.credentials(undefined, { method: 'POST' })).apiKey, bob.access);
  await assert.rejects(saveCodexCredential(store, fakeCodexCredential({ accountId: 'shared-workspace', userId: 'alice', signature: 'another-session' }), undefined, 'duplicate'), /already saved/);
  await saveCodexCredential(store, fakeCodexCredential({ accountId: 'shared-workspace', userId: 'alice', expires: Math.floor(Date.now() / 1000) - 1 }), undefined, 'default');
  await assert.rejects(getCodexCredential(store, { account: 'default', fetchImpl: async () => response({ access_token: bob.access, refresh_token: 'wrong-user', expires_in: 3600 }) }), /changed account identity/);
  await saveCodexCredential(store, fakeCodexCredential({ accountId: 'shared-workspace', userId: 'carol' }), undefined, 'work');
  assert.deepEqual(readCodexAccountsPolicy(store).pool, []);
  for (const subject of ['alice', 'bob', 'carol']) assert.ok(!JSON.stringify(codexAccountsStatus(store)).includes(subject));
});

test('renaming the legacy profile preserves its rotating credential and explicit pool without another login', async t => {
  const { store, credentials } = await fixture(t); await setCodexAutoSwitch(store, 'on');
  await renameCodexAccount(store, 'default', 'primary');
  assert.equal(readCodexAccountsPolicy(store).active, 'primary');
  assert.deepEqual(readCodexAccountsPolicy(store).pool, ['primary', 'spare']);
  assert.equal(readCodexCredential(store).access, credentials.default.access);
  assert.equal(readCodexCredential(store).refresh, credentials.default.refresh);
  assert.equal(fs.existsSync(path.join(store.root, 'auth/openai-codex.json')), false);
  await assert.rejects(renameCodexAccount(store, 'primary', 'spare'), /already exists/);
});

test('device login targets a captured alias without replacing the currently selected account', async t => {
  const { store, credentials } = await fixture(t);
  const extra = fakeCodexCredential({ accountId: 'new-device-account' });
  const replies = [response({ device_auth_id: 'device', user_code: 'FAKE-CODE', interval: 1 }), response({ authorization_code: 'code', code_verifier: 'verifier' }), response({ access_token: extra.access, refresh_token: extra.refresh, expires_in: 3600 })];
  await loginCodex(store, { account: 'extra', notify: () => {}, sleep: async () => {}, fetchImpl: async () => replies.shift() });
  assert.equal(readCodexCredential(store, 'extra').access, extra.access);
  assert.equal(readCodexCredential(store).access, credentials.default.access);
});

test('refresh is bound to the requested alias and rejects an identity-changing token response', async t => {
  const { store } = await fixture(t);
  const old = fakeCodexCredential({ accountId: 'private-default', expires: Math.floor(Date.now() / 1000) - 1 });
  await saveCodexCredential(store, old, undefined, 'default');
  await useCodexAccount(store, 'spare');
  const access = fakeCodexAccess({ accountId: 'private-default', signature: 'fresh' });
  await getCodexCredential(store, { account: 'default', fetchImpl: async () => response({ access_token: access, refresh_token: 'new-refresh', expires_in: 3600 }) });
  assert.equal(readCodexCredential(store, 'default').access, access);
  assert.equal(readCodexAccountsPolicy(store).active, 'spare');
  await saveCodexCredential(store, old, undefined, 'default');
  await assert.rejects(getCodexCredential(store, { account: 'default', fetchImpl: async () => response({ access_token: fakeCodexAccess({ accountId: 'different' }), refresh_token: 'bad-new-refresh', expires_in: 3600 }) }), /changed account identity/);
  assert.equal(readCodexCredential(store, 'default').refresh, old.refresh);
});

test('an existing proxy switches future requests manually with the same dummy capability and unchanged overlays', async t => {
  const { store, config, credentials } = await fixture(t), received = [];
  const { proxy, request } = await proxyFixture(t, store, config, async () => assert.fail('Manual mode must not poll quotas'), (req, res) => {
    received.push(req.headers); res.end(JSON.stringify({ echo: req.headers.authorization }));
  });
  const token = proxy.token, before = fs.readFileSync(path.join(proxy.directory, 'auth.json'), 'utf8');
  const first = await request(); await useCodexAccount(store, 'spare'); const second = await request();
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(proxy.token, token);
  assert.equal(received[0]['chatgpt-account-id'], credentials.default.accountId);
  assert.equal(received[1]['chatgpt-account-id'], credentials.spare.accountId);
  assert.equal(received[1].authorization, `Bearer ${credentials.spare.access}`);
  assert.ok(!first.body.includes(credentials.default.access) && !second.body.includes(credentials.spare.access));
  assert.equal(fs.readFileSync(path.join(proxy.directory, 'auth.json'), 'utf8'), before);
  assert.ok(!before.includes(credentials.default.access) && !before.includes(credentials.spare.access));
});

test('confirmed exhaustion selects only an enrolled available account before forwarding; budget is shared across accounts', async t => {
  const { store, config } = await fixture(t);
  await setCodexAutoSwitch(store, 'default,spare'); config.credentials.proxy.maxRequests = 1;
  const usage = usageFetch({ 'private-default': 100, 'private-spare': 0 }), received = [];
  const { request } = await proxyFixture(t, store, config, usage.fetchImpl, (req, res) => { received.push(req.headers['chatgpt-account-id']); res.end('{}'); });
  assert.equal((await request()).status, 200);
  assert.deepEqual(received, ['private-spare']);
  assert.deepEqual(usage.calls, ['private-default', 'private-spare']);
  assert.equal(readCodexAccountsPolicy(store).active, 'spare');
  assert.equal((await request()).status, 429); assert.equal(received.length, 1);
});

test('usage errors, missing windows and a non-quota denial never authorize an account switch', async t => {
  for (const value of [new Error('private-do-not-expose'), { rate_limit: {} }, { rate_limit: { allowed: false, primary_window: { used_percent: 0, reset_after_seconds: 60 } } }]) {
    const { store } = await fixture(t); await setCodexAutoSwitch(store, 'on');
    const usage = usageFetch({ 'private-default': value, 'private-spare': 0 });
    const router = createCodexAccountRouter(store, { fetchImpl: usage.fetchImpl, notify: () => {} });
    await assert.rejects(router.credentials(undefined, { method: 'POST' }));
    assert.equal(readCodexAccountsPolicy(store).active, 'default');
    assert.deepEqual(usage.calls, ['private-default']);
  }
});

test('when the whole pool is exhausted, return a quota error without forwarding a model request', async t => {
  const { store, config } = await fixture(t); await setCodexAutoSwitch(store, 'on');
  const usage = usageFetch({ 'private-default': 100, 'private-spare': 100 });
  const { request } = await proxyFixture(t, store, config, usage.fetchImpl, () => assert.fail('No model upstream request authorized'));
  const result = await request(); assert.equal(result.status, 429);
  assert.ok(!result.body.includes('private-default') && !result.body.includes('private-spare'));
  assert.equal(readCodexAccountsPolicy(store).active, 'default');
  assert.equal((await getRoutedCodexUsage(store, { fetchImpl: usage.fetchImpl })).rate_limit.primary_window.used_percent, 100);
});

test('automatic switching refuses account-bound response/conversation references instead of rewriting history', async t => {
  const { store, config } = await fixture(t); await setCodexAutoSwitch(store, 'on');
  const usage = usageFetch({ 'private-default': 100, 'private-spare': 0 });
  const { request } = await proxyFixture(t, store, config, usage.fetchImpl, () => assert.fail('Stateful context must not be forwarded to another account'));
  for (const extra of [{ previous_response_id: 'resp_old' }, { conversation: 'conv_old' }, { conversation_id: 'conv_old' }]) {
    assert.equal((await request({ model: 'fake-model', ...extra })).status, 409);
  }
  assert.equal(readCodexAccountsPolicy(store).active, 'default');
  assert.deepEqual(usage.calls, ['private-default']);
});

test('upstream 429 only invalidates quota evidence: no blind replay and ordinary 429 stays on the account', async t => {
  for (const confirmed of [false, true]) {
    const { store, config } = await fixture(t); await setCodexAutoSwitch(store, 'on');
    const values = { 'private-default': 0, 'private-spare': 0 }, usage = usageFetch(values), received = [];
    const { request } = await proxyFixture(t, store, config, usage.fetchImpl, (req, res) => {
      received.push(req.headers['chatgpt-account-id']);
      if (received.length === 1) { if (confirmed) values['private-default'] = 100; res.writeHead(429); res.end('private upstream body'); }
      else res.end('{}');
    });
    const first = await request(); assert.equal(first.status, 429); assert.equal(received.length, 1);
    assert.ok(!first.body.includes('private upstream body'));
    assert.equal(readCodexAccountsPolicy(store).active, 'default');
    assert.equal((await request()).status, 200);
    assert.deepEqual(received, ['private-default', confirmed ? 'private-spare' : 'private-default']);
  }
});

test('in-flight streams retain their original account when the host manually changes the selected profile', async t => {
  const { store, config, credentials } = await fixture(t), started = deferred(), release = deferred(); let calls = 0;
  const { request } = await proxyFixture(t, store, config, undefined, async (req, res) => {
    const account = req.headers['chatgpt-account-id'];
    if (++calls === 1) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); started.resolve(); await release.promise; }
    res.end(`data: ${account}\n\n`);
  });
  const first = request(); await started.promise;
  await useCodexAccount(store, 'spare'); const second = await request(); release.resolve();
  assert.ok((await first).body.includes(credentials.default.accountId));
  assert.ok(second.body.includes(credentials.spare.accountId)); assert.equal(calls, 2);
});

test('manual selection, logout, pool withdrawal and cancellation win over an automatic decision awaiting quota', async t => {
  for (const action of ['manual', 'cancel', 'off', 'logout']) {
    const { store, credentials } = await fixture(t, ['default', 'spare', 'manual']);
    await setCodexAutoSwitch(store, 'default,spare');
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const router = createCodexAccountRouter(store, { notify: () => {}, fetchImpl: async (_url, options) => {
      const id = codexClaims(options.headers.authorization.slice(7)).accountId;
      if (id === 'private-spare') { entered.resolve(); await release.promise; return response(quota(0)); }
      return response(quota(100));
    } });
    const pending = router.credentials(controller.signal, { method: 'POST' });
    await entered.promise;
    if (action === 'cancel') controller.abort();
    else if (action === 'off') await setCodexAutoSwitch(store, 'off');
    else if (action === 'logout') await logoutCodex(store, { account: 'spare' });
    else await useCodexAccount(store, 'manual');
    release.resolve();
    if (action === 'cancel') await assert.rejects(pending);
    else assert.equal((await pending).apiKey, credentials[action === 'manual' ? 'manual' : 'default'].access);
    assert.equal(readCodexAccountsPolicy(store).active, action === 'manual' ? 'manual' : 'default');
  }
});

test('raw account usage does not switch, routed wait usage can switch, and manual accounts outside the pool stay manual', async t => {
  const { store, credentials } = await fixture(t, ['default', 'spare', 'manual']);
  await setCodexAutoSwitch(store, 'default,spare');
  const usage = usageFetch({ 'private-default': 100, 'private-spare': 0 });
  assert.equal((await getCodexUsage(store, { account: 'default', fetchImpl: usage.fetchImpl })).rate_limit.primary_window.used_percent, 100);
  assert.equal(readCodexAccountsPolicy(store).active, 'default');
  assert.equal((await getRoutedCodexUsage(store, { fetchImpl: usage.fetchImpl })).rate_limit.primary_window.used_percent, 0);
  assert.equal(readCodexAccountsPolicy(store).active, 'spare');
  await useCodexAccount(store, 'manual');
  const router = createCodexAccountRouter(store, { fetchImpl: async () => assert.fail(), notify: () => {} });
  assert.equal((await router.credentials(undefined, { method: 'POST' })).apiKey, credentials.manual.access);
});

test('quota checks are cached, but provider 429 forces fresh evidence before any automatic change', async t => {
  const { store, credentials } = await fixture(t); await setCodexAutoSwitch(store, 'on');
  const values = { 'private-default': 0, 'private-spare': 0 }, usage = usageFetch(values);
  const router = createCodexAccountRouter(store, { fetchImpl: usage.fetchImpl, notify: () => {} });
  await router.credentials(undefined, { method: 'POST' }); values['private-default'] = 100;
  assert.equal((await router.credentials(undefined, { method: 'POST' })).apiKey, credentials.default.access);
  assert.equal(usage.calls.length, 1);
  router.invalidate({ status: 429, credential: { apiKey: credentials.default.access } });
  assert.equal((await router.credentials(undefined, { method: 'POST' })).apiKey, credentials.spare.access);
  assert.deepEqual(usage.calls, ['private-default', 'private-default', 'private-spare']);
});

test('cancelling one quota preflight does not abort another client or poison its verified cache', async t => {
  const { store, credentials } = await fixture(t); await setCodexAutoSwitch(store, 'on');
  const entered = deferred(), first = new AbortController(), second = new AbortController(); let calls = 0;
  const router = createCodexAccountRouter(store, { notify: () => {}, fetchImpl: async (_url, options) => {
    if (++calls === 1) return new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); entered.resolve(); });
    return response(quota(0));
  } });
  const pending = router.credentials(first.signal, { method: 'POST' }); await entered.promise;
  assert.equal((await router.credentials(second.signal, { method: 'POST' })).apiKey, credentials.default.access);
  first.abort(); await assert.rejects(pending);
  assert.equal((await router.credentials(second.signal, { method: 'POST' })).apiKey, credentials.default.access);
  assert.equal(calls, 2);
});

test('startup and in-session quota waits can select a verified available pool account without a model call', async t => {
  const { store } = await fixture(t); await setCodexAutoSwitch(store, 'on');
  const usage = usageFetch({ 'private-default': 100, 'private-spare': 0 });
  const routed = (target, options) => getRoutedCodexUsage(target, { ...options, fetchImpl: usage.fetchImpl });
  await waitForCodex(store, { usage: routed, notify: () => {}, sleep: async () => assert.fail('Available pool should not sleep') });
  assert.equal(readCodexAccountsPolicy(store).active, 'spare');
  await useCodexAccount(store, 'default');
  const server = await startCodexAutoServer(store, {
    usage: (target, options) => getCodexUsage(target, { ...options, fetchImpl: usage.fetchImpl }),
    routeUsage: routed, sleep: async () => assert.fail('Available pool should resume without sleeping'),
  });
  t.after(() => server.close());
  assert.equal(await requestCodexWait(path.join(server.directory, 'wait.sock')), 'ready');
  assert.equal(readCodexAccountsPolicy(store).active, 'spare');
});

test('malformed/non-private/symlinked account settings or credentials fail closed without exposing contents', async t => {
  const { store, base } = await fixture(t);
  const file = path.join(store.root, 'auth/openai-codex-accounts.json'), original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ version: 1, active: '../secret', pool: [], revision: '0'.repeat(32), secret: 'do-not-print' }));
  assert.throws(() => readCodexAccountsPolicy(store), error => !error.message.includes('do-not-print'));
  fs.writeFileSync(file, original); fs.chmodSync(file, 0o644);
  assert.throws(() => readCodexAccountsPolicy(store), /Cannot read/); fs.chmodSync(file, 0o600);
  fs.unlinkSync(file); fs.symlinkSync(path.join(base, 'missing-private-auth'), file);
  assert.throws(() => readCodexAccountsPolicy(store), /Cannot read/);
  fs.unlinkSync(file); fs.writeFileSync(file, original, { mode: 0o600 });
  const credential = path.join(store.root, 'auth/openai-codex-account-spare.json');
  fs.unlinkSync(credential); fs.symlinkSync(path.join(store.root, 'auth/openai-codex.json'), credential);
  assert.throws(() => readCodexCredential(store, 'spare'), /Cannot read/);
});

test('account CLI lists/selects/logs out aliases without Podman, project selection, network or credential output', async t => {
  const { store, base, credentials } = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { cwd: base, encoding: 'utf8', timeout: 10000, env: { ...process.env, PIS_HOME: store.root } });
  for (const args of [['--codex-accounts'], ['--codex-auto-switch', 'default,spare'], ['--codex-use', 'spare'], ['--codex-rename', 'backup'], ['--logout-codex', '--codex-account', 'default']]) {
    const result = invoke(args); assert.equal(result.status, 0, result.stderr);
    for (const credential of Object.values(credentials)) for (const secret of [credential.access, credential.refresh, credential.accountId]) assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  assert.equal(readCodexAccountsPolicy(store).active, 'backup');
  assert.deepEqual(codexAccountsStatus(store).accounts.map(item => item.name), ['backup']);
});
