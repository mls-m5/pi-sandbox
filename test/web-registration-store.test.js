import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { openRegistrationStore } from '../web/registration-store.js';
import { createAgentRegistry } from '../web/server-registration.js';
import { digest, randomKey, hashPassword } from '../web/common.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'web-server', 'registrations-43128.json');
  return { root, file };
}
const record = () => ({ id: randomUUID(), label: 'Laptop', kind: 'pi', clientId: randomUUID(), tokenHash: digest(randomKey()) });
test('private registry survives restart, locks ownership and durably removes revoked identities', t => {
  const { root, file } = fixture(t); let store = openRegistrationStore(root, 43128);
  assert.deepEqual(store.agents, []); assert.throws(() => openRegistrationStore(root, 43128));
  const a = record(); store.save([a]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  store.close(); store = openRegistrationStore(root, 43128); assert.deepEqual(store.agents, [a]);
  store.save([]); store.close(); store = openRegistrationStore(root, 43128); assert.deepEqual(store.agents, []); store.close();
});
test('unsafe permissions, links, malformed/oversized/duplicate records and stale locks fail closed', t => {
  const { root, file } = fixture(t); const store = openRegistrationStore(root, 43128); store.save([]); store.close();
  for (const text of ['broken', JSON.stringify({ version: 2, agents: [] }), ' '.repeat(65537)]) {
    fs.writeFileSync(file, text); assert.throws(() => openRegistrationStore(root, 43128));
  }
  const a = record(); fs.writeFileSync(file, JSON.stringify({ version: 1, agents: [a, a] })); assert.throws(() => openRegistrationStore(root, 43128));
  fs.writeFileSync(file, JSON.stringify({ version: 1, agents: [] })); fs.chmodSync(file, 0o644); assert.throws(() => openRegistrationStore(root, 43128)); fs.chmodSync(file, 0o600);
  const target = `${file}.target`; fs.renameSync(file, target); fs.symlinkSync(target, file); assert.throws(() => openRegistrationStore(root, 43128)); fs.unlinkSync(file); fs.renameSync(target, file);
  fs.writeFileSync(`${file}.lock`, '999999999\n', { mode: 0o600 }); assert.throws(() => openRegistrationStore(root, 43128)); fs.unlinkSync(`${file}.lock`);
  const reopened = openRegistrationStore(root, 43128); assert.throws(() => reopened.save([{ ...a, token: randomKey() }])); reopened.close();
});
test('enrollment persists before rotating identity and leaves old proof intact on write failure', () => {
  const a = record(), registrations = new Map([[a.id, a]]);
  const registry = createAgentRegistry({ registrations, isConnected: () => false, saveRegistrations: () => { throw new Error('disk failure'); } });
  assert.throws(() => registry.enrollProof({ clientId: a.clientId, kind: a.kind, label: a.label }, a.tokenHash));
  assert.equal(registrations.get(a.id).tokenHash, a.tokenHash);
});
const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
test('server restart retains machine authentication and revocation but invalidates browser login', { skip: !installed }, async t => {
  const { startWebServer } = await import('../web/server.js');
  let store, server;
  t.after(async () => { await server?.close(); store?.close(); });
  const { root, file } = fixture(t);
  const password = randomKey(), passwordHash = await hashPassword(password);
  async function start() { store = openRegistrationStore(root, 43128); server = await startWebServer({ port: 0, passwordHash, agents: store.agents, saveRegistrations: next => store.save(next) }); }
  async function request(route, value, credentials = {}) {
    return fetch(`${server.origin}${route}`, { method: value ? 'POST' : 'GET', headers: { Connection: 'close', ...(value ? { Origin: server.origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' } : {}), ...credentials }, ...(value ? { body: JSON.stringify(value) } : {}) });
  }
  async function login() { const res = await request('/login', { password }); const data = await res.json(); return { Cookie: res.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': data.csrf }; }
  await start(); const oldLogin = await login();
  const created = await request('/agents', { label: 'Persistent laptop', kind: 'dummy' }, oldLogin); assert.equal(created.status, 201); const a = await created.json();
  assert.ok(!fs.readFileSync(file, 'utf8').includes(a.token));
  await server.close(); store.close(); await start();
  assert.equal(server.roster()[0].online, false);
  assert.equal((await request('/agent/identity', null, { Authorization: `Bearer ${a.token}` })).status, 200);
  assert.equal((await request('/agents/revoke', { id: a.id }, oldLogin)).status, 403);
  assert.equal((await request('/agents/revoke', { id: a.id }, await login())).status, 200);
  await server.close(); store.close(); await start();
  assert.deepEqual(server.roster(), []);
  assert.equal((await request('/agent/identity', null, { Authorization: `Bearer ${a.token}` })).status, 403);
  const credentials = await login();
  fs.chmodSync(file, 0o644);
  const failed = await request('/agents', { label: 'Must not be acknowledged', kind: 'dummy' }, credentials);
  assert.notEqual(failed.status, 201);
  assert.deepEqual(server.roster(), []);
  assert.equal((await request('/agent/identity', null, { Authorization: `Bearer ${a.token}` })).status, 503);
  fs.chmodSync(file, 0o600);
});
