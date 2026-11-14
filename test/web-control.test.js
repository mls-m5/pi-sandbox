import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { hashPassword, verifyPassword, randomKey, digest, send, wsOptions } from '../web/common.js';

const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
const { startWebServer } = installed ? await import('../web/server.js') : {};
const { startDummyConnector } = installed ? await import('../web/connector.js') : {};
const { default: WebSocket } = installed ? await import('../web/node_modules/ws/wrapper.mjs') : {};
const password = 'offline-test-admin-password-only';
const passwordHash = await hashPassword(password);
const webTest = (name, fn) => test(name, { skip: !installed, timeout: 15_000 }, fn);

async function fixture(t, options = {}) {
  const keys = [randomKey(), randomKey()];
  const server = await startWebServer({ passwordHash, port: 0, agents: keys.map((key, index) => ({ id: `dummy-${index + 1}`, label: `Dummy ${index + 1}`, tokenHash: digest(key) })), ...options });
  t.after(() => server.close());
  return { server, keys, origin: server.origin };
}
function request(origin, path, { method = 'GET', headers = {}, value } = {}) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const req = http.request(`${origin}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Pis-Web': '1' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function login(origin) {
  const response = await request(origin, '/login', { method: 'POST', headers: { Origin: origin }, value: { password } });
  assert.equal(response.status, 200);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.json().csrf };
}
async function peer(t, origin, path, headers) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, { headers, perMessageDeflate: false });
  ws.on('error', () => {});
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return {
    ws, messages,
    send: value => ws.send(JSON.stringify(value)),
    wait: async (predicate, after = 0) => {
      for (let tries = 0; tries < 500; tries++) { const found = messages.slice(after).find(predicate); if (found) return found; await delay(10); }
      assert.fail('Web peer response deadline.');
    },
  };
}
async function browser(t, origin, credentials) { return peer(t, origin, '/browser', { Origin: origin, Cookie: credentials.cookie }); }
async function denied(origin, path, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, { headers });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected accepted connection.')); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
  });
}
async function eventually(predicate) {
  for (let tries = 0; tries < 500; tries++) { if (await predicate()) return; await delay(10); }
  assert.fail('Local web state deadline.');
}
async function select(client, id = 'dummy-1') {
  const requestId = randomUUID();
  client.send({ v: 1, type: 'select', id: requestId, agentId: id });
  return client.wait(value => value.type === 'selected' && value.id === requestId);
}
function command(client, selected, action, extra = {}, id = randomUUID()) {
  const after = client.messages.length;
  client.send({ v: 1, type: 'command', agentId: selected.agentId, command: { v: 1, generation: selected.generation, id, action, ...extra } });
  return { id, result: client.wait(value => value.type === 'result' && value.result.id === id, after).then(value => value.result) };
}
async function dummy(t, f, index = 0) {
  const connector = await startDummyConnector({ origin: f.origin, token: f.keys[index] });
  t.after(() => connector.close());
  await eventually(() => f.server.roster()[index]?.online);
  return connector;
}
async function manual(t, f, index) {
  const agent = await peer(t, f.origin, '/agent', { Authorization: `Bearer ${f.keys[index]}` });
  agent.generation = randomUUID();
  agent.send({ v: 1, type: 'hello', generation: agent.generation, seq: 0, status: 'idle' });
  await eventually(() => f.server.roster()[index]?.online);
  return agent;
}

test('web auth hashes use independent salts and scrypt; weak passwords and slow peers fail closed', async () => {
  const second = await hashPassword(password);
  assert.notEqual(second.salt, passwordHash.salt);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('wrong', passwordHash), false);
  await assert.rejects(hashPassword('short'));
  let terminated = false;
  assert.equal(send({ readyState: 1, bufferedAmount: 512 * 1024, terminate: () => { terminated = true; } }, { text: 'x' }), false);
  assert.equal(terminated, true);
  assert.equal(wsOptions.perMessageDeflate, false);
  assert.equal(wsOptions.maxPayload, 272 * 1024);
});

webTest('loopback HTTP enforces canonical Host/Origin, security headers and static path allowlist', async t => {
  const f = await fixture(t);
  const index = await request(f.origin, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-security-policy'], /default-src 'none'/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(f.origin, '/', { headers: { Host: 'evil.invalid' } })).status, 403);
  assert.equal((await request(f.origin, '/?token=bad')).status, 403);
  assert.equal((await request(f.origin, '/package.json')).status, 404);
  assert.equal((await request(f.origin, '/session')).status, 401);
  assert.equal((await request(f.origin, '/login', { method: 'POST', headers: { Origin: 'http://evil.invalid' }, value: { password } })).status, 403);
  assert.equal((await request(f.origin, '/login', { method: 'POST', headers: { Origin: f.origin }, value: { password, approved: true } })).status, 401);
});

webTest('host startup stages reach authenticated GUI roster before Pi connects; browser cannot set them', async t => {
  const f = await fixture(t);
  f.server.setStartup('dummy-1', 'preparing_image');
  const client = await browser(t, f.origin, await login(f.origin));
  const roster = await client.wait(value => value.type === 'roster');
  assert.equal(roster.agents[0].startup.phase, 'preparing_image');
  assert.equal(roster.agents[0].online, false);
  assert.ok(Number.isFinite(roster.agents[0].startup.startedAt));
  f.server.setStartup('dummy-1', 'starting_container');
  const updated = await client.wait(value => value.type === 'roster' && value.agents[0].startup.phase === 'starting_container');
  assert.equal(updated.agents[0].startup.startedAt, roster.agents[0].startup.startedAt);
  assert.throws(() => f.server.setStartup('dummy-1', 'raw secret diagnostic'), /Invalid host/);
  const closed = once(client.ws, 'close');
  client.send({ v: 1, type: 'startup', agentId: 'dummy-1', phase: 'connected' }); await closed;
});

webTest('login is bounded, generic on failure and globally throttled', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await request(f.origin, '/login', { method: 'POST', headers: { Origin: f.origin }, value: { password: 'wrong' } })).status, 401);
  assert.equal((await request(f.origin, '/login', { method: 'POST', headers: { Origin: f.origin }, value: { password } })).status, 429);
});

webTest('browser cookies, WebSocket Origin, connector role separation and logout CSRF are enforced', async t => {
  const f = await fixture(t), credentials = await login(f.origin);
  const response = await request(f.origin, '/login', { method: 'POST', headers: { Origin: f.origin }, value: { password } });
  assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal(await denied(f.origin, '/browser', { Origin: f.origin }), 403);
  assert.equal(await denied(f.origin, '/browser', { Origin: 'http://evil.invalid', Cookie: credentials.cookie }), 403);
  assert.equal(await denied(f.origin, '/agent', { Authorization: `Bearer ${randomKey()}` }), 403);
  assert.equal(await denied(f.origin, '/agent', { Authorization: `Bearer ${f.keys[0]}`, Origin: f.origin }), 403);
  assert.equal(await denied(f.origin, '/agent', { Cookie: credentials.cookie }), 403);
  const client = await browser(t, f.origin, credentials);
  assert.equal((await request(f.origin, '/logout', { method: 'POST', headers: { Origin: f.origin, Cookie: credentials.cookie }, value: {} })).status, 403);
  const closed = once(client.ws, 'close');
  assert.equal((await request(f.origin, '/logout', { method: 'POST', headers: { Origin: f.origin, Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrf }, value: {} })).status, 200);
  await closed;
  assert.equal((await request(f.origin, '/session', { headers: { Cookie: credentials.cookie } })).status, 401);
});

webTest('real dummy subprocesses connect outward; browser routes scoped state/history/prompt and live text', async t => {
  const f = await fixture(t); await dummy(t, f, 0); await dummy(t, f, 1);
  const client = await browser(t, f.origin, await login(f.origin));
  const roster = await client.wait(value => value.type === 'roster');
  assert.equal(roster.agents.filter(agent => agent.online).length, 2);
  assert.ok(roster.agents.every(agent => agent.kind === 'dummy'));
  const selected = await select(client);
  const state = await command(client, selected, 'state').result;
  assert.equal(state.data.state.isStreaming, false);
  assert.ok(!('sessionFile' in state.data.state));
  const prompt = command(client, selected, 'prompt', { message: '<img src=x onerror=alert(1)>' });
  assert.equal((await prompt.result).data.disposition, 'started');
  const final = await client.wait(value => value.type === 'frame' && value.frame.event.type === 'message_end' && value.frame.event.message.role === 'assistant');
  assert.match(final.frame.event.message.content[0].text, /Lorem ipsum/);
  await client.wait(value => value.type === 'frame' && value.frame.event.type === 'agent_settled');
  assert.ok(client.messages.some(value => value.type === 'frame' && value.frame.event.update?.type === 'text_delta'));
  const history = await command(client, selected, 'history').result;
  assert.equal(history.data.history.messages.length, 2);
  assert.equal(history.data.history.messages[0].content[0].text, '<img src=x onerror=alert(1)>');
});

webTest('outbound disconnect during quota waiting preserves the runtime/session and never replays the prompt', async t => {
  const f = await fixture(t), connector = await dummy(t, f);
  const client = await browser(t, f.origin, await login(f.origin));
  let selected = await select(client);
  const originalId = randomUUID();
  const request = command(client, selected, 'prompt', { message: '/dummy quota 1' }, originalId);
  assert.equal((await request.result).data.success, true);
  await client.wait(value => value.type === 'frame' && value.frame.event.type === 'dummy_status' && value.frame.event.state === 'waiting');
  const generation = selected.generation;
  const sessionId = (await connector.rpc.request('get_state')).data.sessionId;
  connector.network.disconnect();
  await eventually(async () => (await connector.rpc.request('get_state')).data.resumes === 1);
  await eventually(() => f.server.roster()[0].online);
  selected = await select(client);
  assert.equal(selected.generation, generation);
  assert.equal((await connector.rpc.request('get_state')).data.sessionId, sessionId);
  const duplicate = await command(client, selected, 'prompt', { message: '/dummy quota 1' }, originalId).result;
  assert.equal(duplicate.data.duplicate, true);
  const history = await command(client, selected, 'history').result;
  assert.equal(history.data.history.messages.filter(message => message.role === 'user').length, 2);
});

webTest('browser disconnect does not stop dummy work; reconnect retrieves current history', async t => {
  const f = await fixture(t), connector = await dummy(t, f), credentials = await login(f.origin);
  const first = await browser(t, f.origin, credentials), selected = await select(first);
  assert.equal((await command(first, selected, 'prompt', { message: 'continue without browser' }).result).data.success, true);
  first.ws.terminate();
  await eventually(async () => (await connector.rpc.request('get_messages')).data.messages.length === 2);
  const second = await browser(t, f.origin, credentials), current = await select(second);
  assert.equal(current.generation, selected.generation);
  const history = await command(second, current, 'history').result;
  assert.equal(history.data.history.messages.length, 2);
});

webTest('stop crosses the server/connector and cancels a held quota episode before refill', async t => {
  const f = await fixture(t), connector = await dummy(t, f);
  const client = await browser(t, f.origin, await login(f.origin)), selected = await select(client);
  await command(client, selected, 'prompt', { message: '/dummy quota hold' }).result;
  await client.wait(value => value.type === 'frame' && value.frame.event.type === 'dummy_status' && value.frame.event.state === 'waiting');
  assert.equal((await command(client, selected, 'stop').result).data.success, true);
  await command(client, selected, 'state').result;
  await command(client, selected, 'prompt', { message: '/dummy refill' }).result;
  await delay(350);
  assert.equal((await connector.rpc.request('get_state')).data.resumes, 0);
});

webTest('one connector cannot forge another connector result or registration identity', async t => {
  const f = await fixture(t), a = await manual(t, f, 0), b = await manual(t, f, 1);
  const client = await browser(t, f.origin, await login(f.origin)), selected = await select(client);
  const request = command(client, selected, 'history');
  const routed = await a.wait(value => value.type === 'command');
  const result = { v: 1, generation: a.generation, id: request.id, action: 'history', startSeq: 0, endSeq: 0, stable: true, data: { success: true, history: { messages: [] } } };
  const closed = once(b.ws, 'close');
  b.send({ v: 1, type: 'result', routeId: routed.routeId, result }); await closed;
  assert.ok(!client.messages.some(value => value.type === 'result' && value.result.id === request.id));
  a.send({ v: 1, type: 'result', routeId: routed.routeId, result });
  assert.equal((await request.result).data.success, true);
  assert.equal(await denied(f.origin, '/agent', { Authorization: `Bearer ${f.keys[0]}` }), 403);
});

webTest('browser cannot command an unselected agent, forward arbitrary native RPC or use stale generations', async t => {
  const f = await fixture(t); await manual(t, f, 0); await manual(t, f, 1);
  const credentials = await login(f.origin), client = await browser(t, f.origin, credentials), selected = await select(client);
  const stale = await command(client, { ...selected, generation: randomUUID() }, 'state').result;
  assert.equal(stale.data.error, 'control_stale_generation');
  let closed = once(client.ws, 'close');
  client.send({ v: 1, type: 'command', agentId: 'dummy-2', command: { v: 1, generation: selected.generation, id: 'bad-target', action: 'state' } }); await closed;
  const other = await browser(t, f.origin, credentials); await select(other);
  closed = once(other.ws, 'close');
  other.send({ v: 1, type: 'command', agentId: 'dummy-1', command: { v: 1, generation: selected.generation, id: 'bad-shell', action: 'bash', command: 'whoami' } }); await closed;
});

webTest('deadlines return an ambiguous outcome and late responses are not retained or replayed', async t => {
  const f = await fixture(t, { commandTimeoutMs: 100 }), agent = await manual(t, f, 0);
  const client = await browser(t, f.origin, await login(f.origin)), selected = await select(client);
  const request = command(client, selected, 'prompt', { message: 'acceptance uncertain' });
  const routed = await agent.wait(value => value.type === 'command');
  assert.equal((await request.result).data.error, 'outcome_unknown');
  agent.send({ v: 1, type: 'result', routeId: routed.routeId, result: { id: request.id } });
  await delay(50);
  assert.equal(client.messages.filter(value => value.type === 'result' && value.result.id === request.id).length, 1);
});

webTest('revoking a unique machine key closes its connection and prevents reauthentication', async t => {
  const f = await fixture(t), agent = await manual(t, f, 0);
  const closed = once(agent.ws, 'close'); f.server.revokeAgent('dummy-1'); await closed;
  assert.equal(await denied(f.origin, '/agent', { Authorization: `Bearer ${f.keys[0]}` }), 403);
  assert.equal(f.server.roster().length, 1);
});

webTest('expired sessions cannot submit commands even before a heartbeat sweep', async t => {
  const f = await fixture(t, { sessionMs: 500 });
  const client = await browser(t, f.origin, await login(f.origin));
  await delay(550);
  const closed = once(client.ws, 'close'); client.send({ v: 1, type: 'select', id: 'expired', agentId: 'dummy-1' }); await closed;
});

webTest('binary and oversized WebSocket payloads are rejected without application processing', async t => {
  const f = await fixture(t), credentials = await login(f.origin);
  for (const payload of [Buffer.from('binary'), 'x'.repeat(280 * 1024)]) {
    const client = await browser(t, f.origin, credentials), closed = once(client.ws, 'close');
    client.ws.send(payload); await closed;
  }
});
