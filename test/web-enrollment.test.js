import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from './fixtures/transport.js';
import { hashPassword, randomKey, digest } from '../web/common.js';

const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
const { startWebServer } = installed ? await import('../web/server.js') : {};
const { default: WebSocket } = installed ? await import('../web/node_modules/ws/wrapper.mjs') : {};
const { parseAgentOptions } = installed ? await import('../web/agent-cli.js') : {};
const password = 'enrollment-test-password-only', passwordHash = await hashPassword(password);
const webTest = (name, fn) => test(name, { skip: !installed, timeout: 25000 }, fn);
async function until(predicate) {
  return waitFor(predicate, { attempts: 600, message: 'Enrollment test deadline.' });
}
async function api(server, route, { value, cookie, csrf, token, origin = server.origin } = {}) {
  return fetch(`${server.origin}${route}`, { method: value ? 'POST' : 'GET', headers: { Connection: 'close',
    ...(value ? { 'Content-Type': 'application/json', 'X-Pis-Web': '1', Origin: origin } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, ...(value ? { body: JSON.stringify(value) } : {}), redirect: 'error' });
}
async function login(server) {
  const response = await api(server, '/login', { value: { password } }); assert.equal(response.status, 200);
  return { cookie: response.headers.getSetCookie()[0].split(';')[0], csrf: (await response.json()).csrf };
}
async function create(server, credentials, label, kind = 'dummy') {
  const response = await api(server, '/agents', { ...credentials, value: { label, kind } }); assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
function child(t, args, root, input = '') {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('../bin/pis.js', import.meta.url)), '--connect', ...args], { env: { PATH: `${path.dirname(globalThis.process.execPath)}:${globalThis.process.env.PATH}`, HOME: root, PIS_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [process.stdout, process.stderr]) stream.on('data', data => { output = (output + data).slice(-128 * 1024); });
  process.stdin.end(input);
  const exited = once(process, 'exit').then(([code]) => code);
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) { process.kill('SIGTERM'); await exited; } });
  return { process, exited, output: () => output };
}
webTest('agent registration/revocation require admin session, exact Origin and CSRF; keys are shown only at creation', async t => {
  const server = await startWebServer({ port: 0, passwordHash }); t.after(() => server.close());
  const credentials = await login(server), value = { label: 'Laptop agent', kind: 'dummy' };
  for (const options of [{ value }, { value, cookie: credentials.cookie }, { value, ...credentials, origin: 'http://evil.invalid' }]) {
    const response = await api(server, '/agents', options); assert.equal(response.status, 403); await response.text();
  }
  for (const bad of [{ ...value, token: randomKey() }, { ...value, id: 'chosen-id' }, { ...value, label: '\u001b[31mattack' }, { ...value, kind: 'shell' }]) {
    const response = await api(server, '/agents', { ...credentials, value: bad }); assert.equal(response.status, 400); await response.text();
  }
  const registration = await create(server, credentials, '<b>Literal label</b>');
  assert.match(registration.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(server.roster()).includes(registration.token));
  assert.deepEqual(server.roster().map(agent => agent.id), [registration.id]);
  const identity = await api(server, '/agent/identity', { token: registration.token });
  assert.deepEqual(await identity.json(), { id: registration.id, kind: 'dummy' });
  const machineAdmin = await api(server, '/agents', { value, token: registration.token }); assert.equal(machineAdmin.status, 403); await machineAdmin.text();
  const browserIdentity = await api(server, '/agent/identity', { token: registration.token, cookie: credentials.cookie }); assert.equal(browserIdentity.status, 403); await browserIdentity.text();
  const absent = await api(server, '/agents', credentials); assert.equal(absent.status, 404); await absent.text();
  const forged = await api(server, '/agents/revoke', { cookie: credentials.cookie, value: { id: registration.id } }); assert.equal(forged.status, 403); await forged.text();
  const revoke = await api(server, '/agents/revoke', { ...credentials, value: { id: registration.id } }); assert.equal(revoke.status, 200); await revoke.text();
  assert.equal(server.roster().length, 0);
  const expired = await api(server, '/agent/identity', { token: registration.token }); assert.equal(expired.status, 403); await expired.text();
});
webTest('registration capacity is bounded and cannot be expanded by a browser-supplied ID', async t => {
  const agents = Array.from({ length: 32 }, (_, index) => ({ id: `agent-${index}`, label: 'Test', tokenHash: digest(randomKey()) }));
  const server = await startWebServer({ port: 0, passwordHash, agents }); t.after(() => server.close());
  const credentials = await login(server), response = await api(server, '/agents', { ...credentials, value: { label: 'one too many', kind: 'pi' } });
  assert.equal(response.status, 429); await response.text(); assert.equal(server.roster().length, 32);
});
webTest('separate registered dummy processes share one standalone server; history is read from clients and restart invalidates credentials', async t => {
  let server = await startWebServer({ port: 0, passwordHash }); t.after(() => server.close());
  const root = fs.mkdtempSync('/tmp/pis-enrollment-cli-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = await login(server), registrations = [];
  for (let index = 0; index < 2; index++) {
    const registration = await create(server, credentials, `Agent ${index}`); registrations.push(registration);
    const saved = child(t, ['register', `agent-${index}`, '--server', server.origin, '--dummy', '--key-stdin'], root, `${registration.token}\n`);
    assert.equal(await saved.exited, 0); assert.ok(!saved.output().includes(registration.token));
    const profile = path.join(root, 'web-agents', `agent-${index}.json`);
    assert.equal(fs.statSync(profile).mode & 0o777, 0o600); assert.equal(JSON.parse(fs.readFileSync(profile)).token, registration.token);
  }
  const runners = [0, 1].map(index => child(t, ['run', `agent-${index}`], root));
  await until(() => server.roster().filter(agent => agent.online).length === 2);
  const ws = new WebSocket(`${server.origin.replace('http:', 'ws:')}/browser`, { headers: { Origin: server.origin, Cookie: credentials.cookie } });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  const messages = []; ws.on('message', data => messages.push(JSON.parse(data))); await once(ws, 'open');
  async function command(agentId, generation, action, extra = {}) {
    const id = randomUUID(); ws.send(JSON.stringify({ v: 1, type: 'command', agentId, command: { v: 1, id, generation, action, ...extra } }));
    await until(() => messages.some(message => message.type === 'result' && message.result.id === id));
    return messages.find(message => message.type === 'result' && message.result.id === id).result;
  }
  const agent = server.roster()[0], select = randomUUID();
  ws.send(JSON.stringify({ v: 1, type: 'select', agentId: agent.id, id: select })); await until(() => messages.some(message => message.type === 'selected' && message.id === select));
  assert.equal((await command(agent.id, agent.generation, 'prompt', { message: 'Distinct client-owned history' })).data.success, true);
  await until(() => messages.some(message => message.frame?.event?.type === 'agent_settled'));
  const history = await command(agent.id, agent.generation, 'history');
  assert.ok(JSON.stringify(history).includes('Distinct client-owned history'));
  assert.ok(!JSON.stringify(server.roster()).includes('Distinct client-owned history'));
  // Revocation disconnects only that client's transport; it does not kill its runtime.
  await (await api(server, '/agents/revoke', { ...credentials, value: { id: registrations[1].id } })).text();
  await until(() => runners[1].output().includes('registreringen nekades'));
  assert.equal(runners[1].process.exitCode, null); assert.equal(server.roster().filter(value => value.online).length, 1);
  const origin = server.origin, port = Number(new URL(origin).port);
  await server.close(); server = await startWebServer({ port, passwordHash });
  assert.equal(server.roster().length, 0);
  const session = await api(server, '/session', credentials); assert.equal(session.status, 401); await session.text();
  const oldIdentity = await api(server, '/agent/identity', { token: registrations[0].token }); assert.equal(oldIdentity.status, 403); await oldIdentity.text();
  await until(() => runners[0].output().includes('registreringen nekades')); assert.equal(runners[0].process.exitCode, null);
  const stale = child(t, ['run', 'agent-0'], root); assert.equal(await stale.exited, 1);
  const newCredentials = await login(server), replacement = await create(server, newCredentials, 'Agent again');
  const noReplace = child(t, ['register', 'agent-0', '--server', origin, '--dummy', '--key-stdin'], root, `${replacement.token}\n`); assert.equal(await noReplace.exited, 1);
  runners[0].process.kill('SIGTERM'); assert.equal(await runners[0].exited, 143);
  const replaced = child(t, ['register', 'agent-0', '--server', origin, '--dummy', '--key-stdin', '--replace'], root, `${replacement.token}\n`); assert.equal(await replaced.exited, 0);
  const resumed = child(t, ['run', 'agent-0'], root); await until(() => server.roster()[0]?.online);
  for (const runner of [...runners, resumed]) assert.ok(!registrations.some(registration => runner.output().includes(registration.token)));
});
async function ticket(server, credentials) {
  const result = await api(server, '/enrollment-keys', { ...credentials, value: {} }); assert.equal(result.status, 201); return result.json();
}
async function redeem(server, key, value) {
  return fetch(`${server.origin}/agent/enroll`, { method: 'POST', headers: { Connection: 'close', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify(value), redirect: 'error' });
}
webTest('one-use tickets create no placeholders, cannot authenticate as agents, bind IDs and names safely', async t => {
  const server = await startWebServer({ port: 0, passwordHash }); t.after(() => server.close());
  const credentials = await login(server), first = await ticket(server, credentials);
  assert.equal(server.roster().length, 0);
  const denied = await api(server, '/agent/identity', { token: first.token }); assert.equal(denied.status, 403); await denied.text();
  const body = { clientId: randomUUID(), label: 'same-name', kind: 'dummy', previousToken: null };
  const invalid = await redeem(server, first.token, { ...body, agentId: 'chosen-id' }); assert.equal(invalid.status, 400); await invalid.text();
  const result = await redeem(server, first.token, body); assert.equal(result.status, 201); const registered = await result.json();
  assert.notEqual(registered.token, first.token); assert.equal(registered.label, 'same-name'); assert.equal(server.roster().length, 1);
  const reused = await redeem(server, first.token, body); assert.equal(reused.status, 403); await reused.text();
  const second = await ticket(server, credentials);
  const another = await redeem(server, second.token, { ...body, clientId: randomUUID() }); assert.equal(another.status, 201); assert.equal((await another.json()).label, 'same-name-2');
  const rotation = await ticket(server, credentials);
  const takeover = await redeem(server, rotation.token, body); assert.equal(takeover.status, 409); await takeover.text();
  const wrongProof = await redeem(server, rotation.token, { ...body, previousToken: randomKey() }); assert.equal(wrongProof.status, 409); await wrongProof.text();
  const changed = await redeem(server, rotation.token, { ...body, previousToken: registered.token }); assert.equal(changed.status, 201);
  const current = await changed.json(); assert.equal(current.id, registered.id); assert.equal(current.label, 'same-name'); assert.equal(server.roster().length, 2);
  assert.notEqual(current.token, registered.token);
  const old = await api(server, '/agent/identity', { token: registered.token }); assert.equal(old.status, 403); await old.text();
  const raceKey = await ticket(server, credentials), raceBody = { ...body, clientId: randomUUID() };
  const race = await Promise.all([redeem(server, raceKey.token, raceBody), redeem(server, raceKey.token, raceBody)]);
  assert.deepEqual(race.map(response => response.status).sort(), [201, 403]); await Promise.all(race.map(response => response.text()));
  const legacy = await create(server, credentials, 'legacy-client'), before = server.roster().length;
  const adoptionTicket = await ticket(server, credentials);
  const adoption = await redeem(server, adoptionTicket.token, { ...body, clientId: randomUUID(), previousToken: legacy.token });
  assert.equal(adoption.status, 201); assert.equal((await adoption.json()).id, legacy.id); assert.equal(server.roster().length, before, 'Existing direct-key clients can migrate without a duplicate post.');
});
webTest('simultaneous browser sessions own independent enrollment tickets', async t => {
  const server = await startWebServer({ port: 0, passwordHash }); t.after(() => server.close());
  const ownerA = await login(server), ownerB = await login(server);
  const ticketA = await ticket(server, ownerA), ticketB = await ticket(server, ownerB);
  const bodyA = { clientId: randomUUID(), label: 'owner-a', kind: 'dummy', previousToken: null };
  const bodyB = { clientId: randomUUID(), label: 'owner-b', kind: 'pi', previousToken: null };

  const logoutA = await api(server, '/logout', { ...ownerA, value: {} });
  assert.equal(logoutA.status, 200); await logoutA.text();
  const deniedA = await redeem(server, ticketA.token, bodyA); assert.equal(deniedA.status, 403); await deniedA.text();
  const registeredB = await redeem(server, ticketB.token, bodyB); assert.equal(registeredB.status, 201);
  const agentB = await registeredB.json();
  assert.equal(server.roster().length, 1); assert.equal(server.roster()[0].label, 'owner-b');
  const identity = await api(server, '/agent/identity', { token: agentB.token });
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { id: agentB.id, kind: 'pi' });
});

webTest('ticket replacement/expiry/logout and browser roles prevent unauthorized redemption', async t => {
  const server = await startWebServer({ port: 0, passwordHash, enrollmentMs: 150 }); t.after(() => server.close());
  const credentials = await login(server), first = await ticket(server, credentials), second = await ticket(server, credentials);
  const body = { clientId: randomUUID(), label: 'name', kind: 'pi', previousToken: null };
  const old = await redeem(server, first.token, body); assert.equal(old.status, 403); await old.text();
  const browserAttempt = await api(server, '/agent/enroll', { value: body, ...credentials, token: second.token }); assert.equal(browserAttempt.status, 403); await browserAttempt.text();
  const forgedAdmin = await api(server, '/enrollment-keys', { value: {}, token: second.token }); assert.equal(forgedAdmin.status, 403); await forgedAdmin.text();
  await delay(160); const expired = await redeem(server, second.token, body); assert.equal(expired.status, 403); await expired.text();
  const next = await ticket(server, credentials);
  await (await api(server, '/logout', { ...credentials, value: {} })).text();
  const loggedOut = await redeem(server, next.token, body); assert.equal(loggedOut.status, 403); await loggedOut.text();
  assert.equal(server.roster().length, 0);
});
webTest('shortcut consumes ticket, replaces profile safely, starts immediately and reuses its own offline agent', async t => {
  const server = await startWebServer({ port: 0, passwordHash }); t.after(() => server.close());
  const root = fs.mkdtempSync('/tmp/pis-shortcut-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = await login(server), first = await ticket(server, credentials);
  const start = key => child(t, ['my-agent', '--server', server.origin, '--dummy', '--key-stdin'], root, `${key}\n`);
  const runner = start(first.token); await until(() => server.roster()[0]?.online);
  const file = path.join(root, 'web-agents', 'my-agent.json'), saved = JSON.parse(fs.readFileSync(file));
  assert.notEqual(saved.token, first.token); assert.ok(saved.clientId); assert.equal(server.roster()[0].label, 'my-agent');
  const whileRunningKey = await ticket(server, credentials), blocked = start(whileRunningKey.token);
  assert.equal(await blocked.exited, 1); assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(saved) + '\n');
  assert.equal(runner.process.exitCode, null); assert.equal(server.roster().length, 1);
  runner.process.kill('SIGTERM'); assert.equal(await runner.exited, 143); await until(() => !server.roster()[0]?.online);
  const failed = start(randomKey()); assert.equal(await failed.exited, 1); assert.deepEqual(JSON.parse(fs.readFileSync(file)), saved);
  const second = await ticket(server, credentials), replacement = start(second.token);
  await until(() => server.roster()[0]?.online); const replaced = JSON.parse(fs.readFileSync(file));
  assert.equal(replaced.clientId, saved.clientId); assert.equal(replaced.agentId, saved.agentId); assert.notEqual(replaced.token, saved.token);
  assert.equal(server.roster().length, 1);
  for (const value of [runner, blocked, failed, replacement]) assert.ok(![first.token, second.token, saved.token, replaced.token].some(secret => value.output().includes(secret)));
});

webTest('agent CLI supports one-command connect and advanced commands, never keys on argv', () => {
  assert.equal(parseAgentOptions(['register', 'test', '--server', 'http://127.0.0.1:43128', '--dummy']).dummy, true);
  assert.equal(parseAgentOptions(['run', 'test', '--diagnostics']).diagnostics, true);
  assert.deepEqual(parseAgentOptions(['my-project', '--server', 'http://127.0.0.1:43128']), { action: 'connect', name: 'my-project', server: 'http://127.0.0.1:43128', project: 'my-project', replace: true });
  assert.equal(parseAgentOptions(['alias', '--server', 'http://127.0.0.1:43128', '--project', 'real']).project, 'real');
  assert.equal(parseAgentOptions(['dummy', '--server', 'http://127.0.0.1:43128', '--dummy']).replace, true);
  for (const args of [[], ['run', '../path'], ['run', 'test', '--key', randomKey()], ['register', 'test', '--server', 'http://10.0.0.1', '--dummy'], ['register', 'test', '--server', 'http://127.0.0.1:43128', '--dummy', '--project', 'app'], ['forget', 'test', '--replace']]) assert.throws(() => parseAgentOptions(args));
});
