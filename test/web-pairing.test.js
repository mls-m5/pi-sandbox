import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createPairing } from '../web/pairing.js';
import { createAgentRegistry } from '../web/server-registration.js';
import { pairAgent } from '../web/pairing-client.js';
import { readDefaultServer, saveDefaultServer, readAgentProfile } from '../web/agent-profile.js';
import { digest, randomKey, hashPassword } from '../web/common.js';
import { waitFor } from './fixtures/transport.js';
import { Store } from '../src/store.js';
import { resolveConnectProject } from '../src/project-rpc.js';

const enrollment = (overrides = {}) => ({ clientId: randomUUID(), label: 'client', kind: 'dummy', previousToken: null, ...overrides });
function fixture() {
  const sessions = new Map([['owner', Infinity], ['other', Infinity]]), registrations = new Map(), connected = new Set(), notifications = [];
  const registry = createAgentRegistry({ registrations, sessionExpires: key => sessions.get(key), isConnected: id => connected.has(id), onTicketCleared() {} });
  const pairing = createPairing({ sessionExpires: key => sessions.get(key), enroll: registry.enrollProof, onChange: value => notifications.push(value) });
  return { sessions, registrations, connected, pairing, notifications };
}
test('pairing exposes no secrets or placeholders and atomically consumes the exact approved request', () => {
  const f = fixture(), request = f.pairing.create(enrollment());
  assert.equal(f.registrations.size, 0);
  assert.deepEqual(f.pairing.snapshot(), [{ id: request.id, label: 'client', kind: 'dummy', expiresAt: request.expiresAt }]);
  assert.deepEqual(f.pairing.claim(request.id, request.token), { status: 202, pending: true });
  assert.equal(f.pairing.claim(randomUUID(), request.token).status, 403);
  assert.equal(f.pairing.claim(request.id, randomKey()).status, 403);
  assert.equal(f.pairing.approve(request.id, request.code, 'owner').ok, true);
  assert.deepEqual(f.pairing.snapshot(), []);
  const identity = f.pairing.claim(request.id, request.token);
  assert.equal(identity.kind, 'dummy'); assert.notEqual(identity.token, request.token);
  assert.equal(f.registrations.size, 1);
  assert.equal(f.pairing.claim(request.id, request.token).status, 403);
  assert.ok(!JSON.stringify(f.notifications).includes(request.token));
});
test('pairing bounds guesses per request, session and server including nonexistent IDs', () => {
  const f = fixture(), request = f.pairing.create(enrollment());
  const wrong = request.code === '00' ? '01' : '00';
  for (let i = 0; i < 3; i++) assert.equal(f.pairing.approve(request.id, wrong, 'owner').status, 403);
  assert.equal(f.pairing.approve(request.id, request.code, 'owner').status, 403);
  for (let i = 0; i < 5; i++) assert.equal(f.pairing.allowApproval('owner'), true);
  assert.equal(f.pairing.allowApproval('owner'), false);
  for (let i = 0; i < 4; i++) assert.equal(f.pairing.allowApproval('other'), true);
  assert.equal(f.pairing.allowApproval('other'), false);
  const capacity = fixture();
  const codes = new Set();
  for (let i = 0; i < 32; i++) codes.add(capacity.pairing.create(enrollment()).code);
  assert.equal(codes.size, 32, 'Active requests must not share a confirmation code.');
  assert.equal(capacity.pairing.create(enrollment()).status, 429);
  assert.equal(capacity.pairing.allowCreate(), false);
});
test('pairing expiry, logout and expired owner invalidate approvals without affecting another owner', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture(), a = f.pairing.create(enrollment()), b = f.pairing.create(enrollment());
  f.pairing.approve(a.id, a.code, 'owner'); f.pairing.approve(b.id, b.code, 'other');
  f.pairing.clearOwner('owner');
  assert.equal(f.pairing.claim(a.id, a.token).status, 403);
  f.sessions.set('other', 1001); t.mock.timers.tick(1);
  assert.equal(f.pairing.claim(b.id, b.token).status, 403);
  const c = f.pairing.create(enrollment()); t.mock.timers.tick(120000);
  assert.equal(f.pairing.claim(c.id, c.token).status, 403);
  assert.deepEqual(f.pairing.snapshot(), []); assert.equal(f.registrations.size, 0);
});
test('pairing preserves offline proof reuse and refuses wrong proof or live identity at claim', () => {
  const f = fixture(), body = enrollment();
  function enroll(value) { const r = f.pairing.create(value); f.pairing.approve(r.id, r.code, 'owner'); return { r, result: f.pairing.claim(r.id, r.token) }; }
  const first = enroll(body).result;
  assert.equal(enroll(body).result.status, 409);
  const second = enroll({ ...body, previousToken: first.token }).result;
  assert.equal(second.id, first.id); assert.notEqual(second.token, first.token);
  const waiting = f.pairing.create({ ...body, previousToken: second.token });
  f.pairing.approve(waiting.id, waiting.code, 'owner'); f.connected.add(second.id);
  assert.equal(f.pairing.claim(waiting.id, waiting.token).status, 409);
  assert.equal(f.registrations.size, 1);
});
test('default origin file rejects unsafe reads and writes and has no profile-name collision', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-pair-pref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'web-client.json'), link = path.join(root, 'linked');
  await saveDefaultServer(root, 'http://127.0.0.1:1234');
  assert.equal(readDefaultServer(root), 'http://127.0.0.1:1234');
  for (const mode of ['hardlink', 'mode', 'json', 'fifo']) {
    if (mode === 'hardlink') fs.linkSync(file, link);
    if (mode === 'mode') fs.chmodSync(file, 0o644);
    if (mode === 'json') fs.writeFileSync(file, '{');
    if (mode === 'fifo') { fs.unlinkSync(file); const { spawnSync } = await import('node:child_process'); assert.equal(spawnSync('mkfifo', [file]).status, 0); }
    assert.throws(() => readDefaultServer(root));
    await assert.rejects(saveDefaultServer(root, 'http://127.0.0.1:9999'));
    fs.rmSync(file); fs.rmSync(link, { force: true });
    await saveDefaultServer(root, 'http://127.0.0.1:1234');
  }
  await assert.rejects(saveDefaultServer(root, 'https://example.test'));
});

test('bare project selection uses canonical current directory and nearest registration', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-pair-project-')), previous = process.cwd();
  t.after(() => { process.chdir(previous); fs.rmSync(base, { recursive: true, force: true }); });
  const root = path.join(base, 'project'), nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const store = new Store(path.join(base, 'store'));
  const outer = await store.register(root, 'outer'), inner = await store.register(nested, 'inner');
  process.chdir(nested); assert.equal(resolveConnectProject(undefined, store).id, inner.id);
  assert.equal(resolveConnectProject('outer', store).id, outer.id);
  const alias = path.join(base, 'alias'); fs.symlinkSync(nested, alias);
  process.chdir(alias); assert.equal(resolveConnectProject(undefined, store).id, inner.id);
  process.chdir(base); assert.throws(() => resolveConnectProject(undefined, store), /No pis project/);
});

test('client repeats only explicit pending results, and cancellation before create sends nothing', async () => {
  const ticket = { id: randomUUID(), token: randomKey(), code: '07', expiresAt: Date.now() + 10000 };
  const identity = { id: randomUUID(), token: randomKey(), kind: 'dummy', label: 'client' };
  let calls = 0, displayed;
  const result = await pairAgent('http://127.0.0.1:1234', enrollment(), { intervalMs: 1, onCode: code => { displayed = code; }, fetchImpl: async () => {
    calls++;
    const status = calls === 1 || calls === 4 ? 201 : 202;
    return new Response(JSON.stringify(calls === 1 ? ticket : calls === 4 ? identity : { pending: true }), { status });
  } });
  assert.deepEqual(result, identity); assert.equal(displayed, '07'); assert.equal(calls, 4);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pairAgent('http://127.0.0.1:1234', enrollment(), { signal: controller.signal, fetchImpl: () => { calls++; } }));
  assert.equal(calls, 4);
});

const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
const password = 'pairing-password-test-only';
const webTest = (name, fn) => test(name, { skip: !installed, timeout: 20000 }, fn);
async function serverFixture(t, options = {}) {
  const { startWebServer } = await import('../web/server.js');
  const server = await startWebServer({ port: 0, passwordHash: await hashPassword(password), ...options });
  t.after(() => server.close());
  async function post(route, value, headers = {}) {
    const response = await fetch(`${server.origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pis-Web': '1', ...headers }, body: JSON.stringify(value) });
    const data = await response.json(); return { status: response.status, data, headers: response.headers };
  }
  async function login() {
    const result = await post('/login', { password }, { Origin: server.origin });
    return { Origin: server.origin, Cookie: result.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': result.data.csrf };
  }
  return { server, post, login };
}
webTest('HTTP pairing role gates, exact-request claims, atomic races, logout and expiry', async t => {
  const { server, post, login } = await serverFixture(t);
  const admin = await login(), body = enrollment();
  assert.equal((await post('/agent/requests', body, { Origin: server.origin })).status, 403);
  assert.equal((await post('/agent/requests', body, { Cookie: admin.Cookie })).status, 403);
  assert.equal((await post('/agent/requests', { ...body, extra: true })).status, 400);
  const request = (await post('/agent/requests', body)).data;
  const auth = { Authorization: `Bearer ${request.token}` };
  assert.equal(server.roster().length, 0);
  assert.equal((await post('/pending-clients/approve', { id: request.id, code: request.code })).status, 403);
  assert.equal((await post('/agent/requests/result', { id: request.id }, { ...auth, ...admin })).status, 403);
  assert.equal((await post('/agent/requests/result', { id: randomUUID() }, auth)).status, 403);
  assert.equal((await post('/agent/requests/result', { id: request.id }, auth)).status, 202);
  assert.equal((await post('/pending-clients/approve', { id: request.id, code: request.code }, admin)).status, 200);
  const claims = await Promise.all([post('/agent/requests/result', { id: request.id }, auth), post('/agent/requests/result', { id: request.id }, auth)]);
  assert.deepEqual(claims.map(r => r.status).sort(), [201, 403]); assert.equal(server.roster().length, 1);
  const next = (await post('/agent/requests', enrollment())).data;
  await post('/pending-clients/approve', { id: next.id, code: next.code }, admin);
  assert.equal((await post('/logout', {}, admin)).status, 200);
  assert.equal((await post('/agent/requests/result', { id: next.id }, { Authorization: `Bearer ${next.token}` })).status, 403);
});
webTest('HTTP approval revalidates the session after an asynchronous body read', async t => {
  const { server, post, login } = await serverFixture(t);
  const admin = await login(), request = (await post('/agent/requests', enrollment())).data;
  const payload = JSON.stringify({ id: request.id, code: request.code });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(`${server.origin}/pending-clients/approve`, { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json', 'X-Pis-Web': '1', 'Content-Length': Buffer.byteLength(payload) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(payload.slice(0, 1), ready);
  });
  await started; await post('/logout', {}, admin); req.end(payload.slice(1));
  assert.equal(await response, 403); assert.equal(server.roster().length, 0);
});
webTest('HTTP approval attempts are bounded across nonexistent requests and sessions', async t => {
  const { post, login } = await serverFixture(t), a = await login(), b = await login();
  for (let i = 0; i < 5; i++) assert.equal((await post('/pending-clients/approve', { id: randomUUID(), code: '00' }, a)).status, 403);
  assert.equal((await post('/pending-clients/approve', { id: randomUUID(), code: '00' }, a)).status, 429);
  for (let i = 0; i < 4; i++) assert.equal((await post('/pending-clients/approve', { id: randomUUID(), code: '00' }, b)).status, 403);
  assert.equal((await post('/pending-clients/approve', { id: randomUUID(), code: '00' }, b)).status, 429);
});
webTest('HTTP request creation is bounded and rejects oversized bodies', async t => {
  const { post, server } = await serverFixture(t);
  assert.equal((await post('/agent/requests', { ...enrollment(), label: 'x'.repeat(9000) })).status, 400);
  for (let i = 0; i < 9; i++) assert.equal((await post('/agent/requests', enrollment())).status, 201);
  assert.equal((await post('/agent/requests', enrollment())).status, 429);
  assert.equal(server.roster().length, 0);
});
webTest('HTTP claim rechecks approval ownership after body parsing and cannot swap capabilities', async t => {
  const { server, post, login } = await serverFixture(t), admin = await login();
  const a = (await post('/agent/requests', enrollment())).data, b = (await post('/agent/requests', enrollment())).data;
  assert.equal((await post('/agent/requests/result', { id: a.id }, { Authorization: `Bearer ${b.token}` })).status, 403);
  await post('/pending-clients/approve', { id: a.id, code: a.code }, admin);
  const payload = JSON.stringify({ id: a.id }); let ready, req;
  const started = new Promise(resolve => { ready = resolve; });
  const response = new Promise((resolve, reject) => {
    req = http.request(`${server.origin}/agent/requests/result`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json', 'X-Pis-Web': '1', 'Content-Length': Buffer.byteLength(payload) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(payload.slice(0, 1), ready);
  });
  await started; await post('/logout', {}, admin); req.end(payload.slice(1));
  assert.equal(await response, 403); assert.equal(server.roster().length, 0);
});
webTest('client stops on ambiguous create or claim and only repeats explicit pending results', async t => {
  const { server, post, login } = await serverFixture(t), admin = await login();
  let calls = 0;
  await assert.rejects(pairAgent(server.origin, enrollment(), { fetchImpl: async () => { calls++; throw new Error('lost'); } }));
  assert.equal(calls, 1);
  let created;
  const identity = await pairAgent(server.origin, enrollment(), { intervalMs: 1, onCode: async () => {}, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/agent/requests')) { created = await response.clone().json(); await post('/pending-clients/approve', { id: created.id, code: created.code }, admin); }
    return response;
  }});
  assert.equal(identity.kind, 'dummy');
  let resultCalls = 0, lost;
  await assert.rejects(pairAgent(server.origin, enrollment(), { intervalMs: 1, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/agent/requests')) { lost = await response.clone().json(); await post('/pending-clients/approve', { id: lost.id, code: lost.code }, admin); }
    else { resultCalls++; await response.text(); throw new Error('lost success'); }
    return response;
  }}));
  assert.equal(resultCalls, 1); assert.equal(server.roster().length, 2);
});
webTest('bare CLI selects the current registered Pi project and cancellation starts no runtime', async t => {
  const { server, login } = await serverFixture(t), admin = await login();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-pair-bare-')), folder = path.join(base, 'my-project');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  const store = new Store(path.join(base, 'store')), config = await store.register(folder, 'other-registered-name');
  await saveDefaultServer(store.root, server.origin);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { default: WS } = await import('../web/node_modules/ws/wrapper.mjs');
  const ws = new WS(`${server.origin.replace('http:', 'ws:')}/browser`, { headers: { Origin: server.origin, Cookie: admin.Cookie } });
  t.after(() => ws.terminate());
  let requests = []; ws.on('message', b => { const value = JSON.parse(b); if (value.type === 'pending_clients') requests = value.requests; });
  let output = '';
  const cli = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--connect'], { cwd: path.join(folder, 'sub'), env: { PATH: process.env.PATH, HOME: base, PIS_HOME: store.root }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (cli.exitCode === null) cli.kill('SIGTERM'); });
  cli.stdout.on('data', b => output += b); cli.stderr.on('data', b => output += b);
  await waitFor(() => /kod ([0-9]{2})/.test(output) && requests.length === 1);
  assert.equal(requests[0].label, 'my-project'); assert.equal(requests[0].kind, 'pi');
  assert.equal(server.roster().length, 0); assert.equal(readAgentProfile(store.root, `p-${config.id}`), undefined);
  const stopped = once(cli, 'exit'); cli.kill('SIGINT'); assert.equal((await stopped)[0], 1);
  assert.equal(readAgentProfile(store.root, `p-${config.id}`), undefined); assert.equal(server.roster().length, 0);
});
webTest('CLI saved origin and unnamed dummy connect display code then save and start only after approval', async t => {
  const { server, post, login } = await serverFixture(t), admin = await login();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-pair-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await saveDefaultServer(root, 'http://127.0.0.1:1');
  const cli = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--connect', '--dummy', '--server', server.origin], { env: { PATH: process.env.PATH, HOME: root, PIS_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; cli.stdout.on('data', b => output += b); cli.stderr.on('data', b => output += b);
  t.after(async () => { if (cli.exitCode === null) { cli.kill('SIGTERM'); await once(cli, 'exit'); } });
  const { default: WS } = await import('../web/node_modules/ws/wrapper.mjs');
  const ws = new WS(`${server.origin.replace('http:', 'ws:')}/browser`, { headers: { Origin: server.origin, Cookie: admin.Cookie } });
  t.after(() => ws.terminate());
  let requests = []; ws.on('message', b => { const value = JSON.parse(b); if (value.type === 'pending_clients') requests = value.requests; });
  await waitFor(() => /kod ([0-9]{2})/.test(output) && requests.length === 1);
  assert.equal(readAgentProfile(root, 'dummy'), undefined); assert.equal(server.roster().length, 0);
  const code = /kod ([0-9]{2})/.exec(output)[1];
  assert.equal((await post('/pending-clients/approve', { id: requests[0].id, code }, admin)).status, 200);
  await waitFor(() => output.includes('ansluten och registrerad'));
  const profile = readAgentProfile(root, 'dummy'); assert.equal(profile.origin, server.origin);
  assert.ok(!output.includes(profile.token)); assert.equal(server.roster().length, 1);
  assert.equal(readDefaultServer(root), 'http://127.0.0.1:1', 'Explicit --server overrides for one invocation, without overwriting the global preference.');
  await saveDefaultServer(root, server.origin);
  let blockedOutput = '';
  const blocked = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--connect', '--dummy'], { env: { PATH: process.env.PATH, HOME: root, PIS_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (blocked.exitCode === null) blocked.kill('SIGTERM'); });
  blocked.stdout.on('data', b => blockedOutput += b); blocked.stderr.on('data', b => blockedOutput += b);
  const stopped = once(blocked, 'exit');
  await waitFor(() => /kod ([0-9]{2})/.test(blockedOutput) && requests.length === 1);
  assert.equal((await post('/pending-clients/approve', { id: requests[0].id, code: /kod ([0-9]{2})/.exec(blockedOutput)[1] }, admin)).status, 200);
  assert.equal((await stopped)[0], 1, 'Live identity cannot be displaced by a newly approved connection.');
  assert.equal(readAgentProfile(root, 'dummy').token, profile.token, 'Failure must not overwrite the usable profile.');
  assert.equal(server.roster().length, 1); assert.ok(!blockedOutput.includes(profile.token));
});
