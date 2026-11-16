import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import { randomKey, digest, hashPassword } from '../web/common.js';
import { waitFor } from './fixtures/transport.js';
import { createWebGitApproval } from '../src/web-git-approval.js';
import { createHostPushes, validateWebPush } from '../web/host-push.js';
import { createProjectHostPush } from '../web/project-host-push.js';
import { createHostPushUI } from '../web/public/host-push.js';
const proposal = () => ({ id: randomUUID(), code: '42', expiresAt: Date.now() + 60000, repo: 'deps/child', remote: 'origin', url: 'ssh://git@example.invalid/owner/child.git', commit: 'a'.repeat(40), ref: 'refs/heads/main', reason: 'Reviewed changes' });
class Channel extends EventEmitter { connected = true; sent = []; send(value, callback) { this.sent.push(value); callback?.(); } }
test('local approval IPC binds exact proposal ID, code and deadline and consumes the decision once', async () => {
  const channel = new Channel(), approvals = createWebGitApproval(channel);
  const result = approvals.approve(proposal()), request = channel.sent[0].proposal;
  channel.emit('message', { type: 'web_git_decision', id: randomUUID(), approved: true, code: request.code });
  channel.emit('message', { type: 'web_git_decision', id: request.id, approved: true, code: request.code }); assert.equal(await result, true);
  channel.emit('message', { type: 'web_git_decision', id: request.id, approved: true, code: request.code }); approvals.dispose();
  for (const mode of ['wrong', 'disconnect', 'timeout']) {
    const ch = new Channel(), a = createWebGitApproval(ch, { lifetimeMs: 15 }), pending = a.approve(proposal()), p = ch.sent[0].proposal;
    if (mode === 'wrong') ch.emit('message', { type: 'web_git_decision', id: p.id, approved: true, code: 'bad' });
    if (mode === 'disconnect') ch.emit('disconnect');
    assert.equal(await pending, false); a.dispose();
  }
});
test('proposal validation rejects force, extra fields, credentials and oversized/lapsed authority', () => {
  assert.equal(validateWebPush(proposal()).repo, 'deps/child');
  for (const change of [{ force: true }, { url: 'https://user:secret@example.invalid/repo' }, { repo: '../outside' }, { ref: '+refs/heads/main' }, { code: '123' }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 99999999 }]) assert.throws(() => validateWebPush({ ...proposal(), ...change }));
});
test('review nonce belongs to one browser, generation and proposal; wrong owner/replay cannot authorize', () => {
  const sent = [], broadcasts = [], peer = { agentId: 'agent', generation: randomUUID() }, a = {}, b = {};
  const manager = createHostPushes({ send: (target, value) => { sent.push({ target, value }); return true; }, broadcast: (_id, value) => broadcasts.push(value) });
  const p = proposal(); manager.announce(peer, p);
  manager.review(a, peer, { id: p.id, generation: peer.generation }); const reviewId = sent.at(-1).value.reviewId;
  const decision = { id: p.id, generation: peer.generation, reviewId, approved: true, code: '42' };
  manager.decide(b, peer, decision); assert.equal(sent.filter(x => x.target === peer).length, 0);
  manager.decide(a, { ...peer }, decision); assert.equal(sent.filter(x => x.target === peer).length, 0);
  manager.release(a); manager.decide(a, peer, decision); assert.equal(sent.filter(x => x.target === peer).length, 0);
  manager.review(b, peer, { id: p.id, generation: peer.generation }); decision.reviewId = sent.at(-1).value.reviewId;
  manager.decide(b, peer, decision); manager.decide(b, peer, decision); assert.equal(sent.filter(x => x.target === peer).length, 1);
  assert.equal(broadcasts.at(-1).push.phase, 'pushing'); manager.disconnect(peer); assert.equal(broadcasts.at(-1).push.phase, 'unknown');
});
test('runtime restart readiness requires correlated outcome plus a separate post-cleanup IPC marker', () => {
  for (const phase of ['succeeded', 'declined', 'unknown']) {
    const child = new Channel(), host = createProjectHostPush(child, { fault() {} }), p = proposal();
    child.emit('message', { type: 'web_git_restart_ready', id: p.id }); assert.equal(host.restartReady, false);
    child.emit('message', { type: 'web_git_proposal', proposal: p });
    child.emit('message', { type: 'web_git_restart_ready', id: p.id }); assert.equal(host.restartReady, false);
    child.emit('message', { type: 'web_git_outcome', id: p.id, phase }); assert.equal(host.restartReady, false);
    child.emit('message', { type: 'web_git_restart_ready', id: randomUUID() }); assert.equal(host.restartReady, false);
    child.emit('message', { type: 'web_git_restart_ready', id: p.id }); assert.equal(host.restartReady, true); host.close();
  }
});
test('generation replacement is permitted only once after a completed host push, not while pending or pushing', () => {
  const sent = [], peer = { agentId: 'agent', generation: randomUUID() }, owner = {};
  const manager = createHostPushes({ send: (_target, value) => { sent.push(value); return true; }, broadcast() {} });
  const p = proposal(); manager.announce(peer, p); assert.equal(manager.canReplace(peer), false);
  manager.review(owner, peer, { id: p.id, generation: peer.generation });
  manager.decide(owner, peer, { id: p.id, generation: peer.generation, reviewId: sent.at(-1).reviewId, approved: true, code: p.code }); assert.equal(manager.canReplace(peer), false);
  manager.outcome(peer, p.id, 'succeeded'); assert.equal(manager.canReplace(peer), true);
  peer.generation = randomUUID(); assert.equal(manager.canReplace(peer), false);
  manager.announce(peer, proposal()); assert.equal(manager.canReplace(peer), false);
});

test('connector rejects native control once host review begins and cancels pending proposals on transport loss', () => {
  const child = new Channel(), faults = [], host = createProjectHostPush(child, { fault: code => faults.push(code) }), p = proposal(); let seen;
  host.events.on('proposal', value => { seen = value; }); child.emit('message', { type: 'web_git_proposal', proposal: p });
  assert.equal(seen.id, p.id); assert.deepEqual(faults, ['host_approval_pending']);
  host.cancel(); host.decide({ id: p.id, approved: true, code: p.code });
  assert.deepEqual(child.sent, [{ type: 'web_git_decision', id: p.id, approved: false, code: '' }]); host.close();
});
const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
test('host Git trust opt-in is explicit per runtime and refused for dummy or preference-only actions', { skip: !installed }, async () => {
  const { parseAgentOptions } = await import('../web/agent-cli.js');
  assert.equal(parseAgentOptions(['--allow-web-git']).allowWebGit, true);
  assert.equal(parseAgentOptions(['run', 'saved', '--allow-web-git']).allowWebGit, true);
  assert.equal(parseAgentOptions([]).allowWebGit, undefined);
  assert.throws(() => parseAgentOptions(['--dummy', '--allow-web-git']));
  assert.throws(() => parseAgentOptions(['--set-server', 'http://127.0.0.1:43128', '--allow-web-git']));
});

test('real authenticated WebSockets route one reviewed decision and logout invalidates old review authority', { skip: !installed, timeout: 15000 }, async t => {
  const { startWebServer } = await import('../web/server.js'), { default: WebSocket } = await import('../web/node_modules/ws/wrapper.mjs');
  const token = randomKey(), password = randomKey(), generation = randomUUID();
  const server = await startWebServer({ port: 0, passwordHash: await hashPassword(password), agents: [{ id: 'pi-test', label: 'Test', kind: 'pi', tokenHash: digest(token) }] }); t.after(() => server.close());
  async function socket(route, headers) { const ws = new WebSocket(server.origin.replace('http:', 'ws:') + route, { headers }); ws.messages = []; ws.on('message', data => ws.messages.push(JSON.parse(data))); ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open'); return ws; }
  const send = (ws, value) => ws.send(JSON.stringify({ v: 1, ...value }));
  const until = predicate => waitFor(predicate, { attempts: 400, message: 'Host push transport deadline.' });
  const peer = await socket('/agent', { Authorization: `Bearer ${token}` }); send(peer, { type: 'hello', generation, seq: 0, status: 'idle' }); await until(() => peer.messages.some(x => x.type === 'registered'));
  async function login() { const res = await fetch(server.origin + '/login', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password }) }); return { cookie: res.headers.getSetCookie()[0].split(';')[0], csrf: (await res.json()).csrf }; }
  async function browser(credentials) { const ws = await socket('/browser', { Origin: server.origin, Cookie: credentials.cookie }); send(ws, { type: 'select', agentId: 'pi-test', id: randomUUID() }); await until(() => ws.messages.some(x => x.type === 'selected')); return ws; }
  const credentials = await login(), first = await browser(credentials), p = proposal();
  send(peer, { type: 'host_push', generation, proposal: p }); await until(() => first.messages.some(x => x.type === 'host_push'));
  send(first, { type: 'host_push_review', agentId: 'pi-test', generation, id: p.id }); await until(() => first.messages.some(x => x.type === 'host_push_review'));
  const oldReview = first.messages.find(x => x.type === 'host_push_review').reviewId;
  const closed = once(first, 'close');
  const logout = await fetch(server.origin + '/logout', { method: 'POST', headers: { Origin: server.origin, Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrf, 'X-Pis-Web': '1', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(logout.status, 200); await closed;
  const second = await browser(await login());
  send(second, { type: 'host_push_decision', agentId: 'pi-test', generation, id: p.id, reviewId: oldReview, approved: true, code: p.code });
  send(second, { type: 'host_push_review', agentId: 'pi-test', generation, id: p.id }); await until(() => second.messages.some(x => x.type === 'host_push_review'));
  assert.equal(peer.messages.filter(x => x.type === 'host_push_decision').length, 0);
  const reviewId = second.messages.find(x => x.type === 'host_push_review').reviewId;
  const decision = { type: 'host_push_decision', agentId: 'pi-test', generation, id: p.id, reviewId, approved: true, code: p.code };
  send(second, decision); send(second, decision); await until(() => peer.messages.some(x => x.type === 'host_push_decision'));
  assert.equal(peer.messages.filter(x => x.type === 'host_push_decision').length, 1);
  send(peer, { type: 'host_push_outcome', generation, id: p.id, phase: 'succeeded' }); await until(() => second.messages.some(x => x.push?.phase === 'succeeded'));
  const replacement = randomUUID(); send(peer, { type: 'runtime_replaced', previousGeneration: generation, generation: replacement, seq: 0, status: 'idle' });
  await until(() => server.roster()[0].generation === replacement); assert.equal(server.roster()[0].status, 'idle');
  const invalid = randomUUID(), disconnected = once(peer, 'close');
  send(peer, { type: 'runtime_replaced', previousGeneration: replacement, generation: invalid, seq: 0, status: 'idle' }); await disconnected;
  assert.ok(!peer.messages.some(x => x.type === 'registered' && x.generation === invalid), 'The old completion cannot authorize a second generation change.');
});

class Element { children = []; listeners = {}; value = ''; textContent = ''; append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } setAttribute(name, value) { this[name] = value; } addEventListener(type, fn) { this.listeners[type] = fn; } }
const all = node => [node, ...node.children.flatMap(all)];
test('previous-generation Git results remain read-only and cannot replace current-generation approval', () => {
  const root = new Element(), context = { agentId: 'agent', generation: randomUUID(), online: true }, messages = [];
  const ui = createHostPushUI({ document: { getElementById: () => root, createElement: tag => Object.assign(new Element(), { tag }) }, getContext: () => context, send: value => messages.push(value) });
  const old = { ...proposal(), phase: 'succeeded' }, oldGeneration = randomUUID();
  ui.receive({ type: 'host_push', agentId: 'agent', generation: oldGeneration, push: old });
  assert.ok(all(root).some(node => node.textContent.includes('Föregående körnings')));
  assert.equal(all(root).filter(node => node.tag === 'button' || node.tag === 'input').length, 0);
  ui.receive({ type: 'host_push', agentId: 'agent', generation: oldGeneration, push: { ...old, phase: 'pending' } });
  assert.equal(all(root).filter(node => node.tag === 'button').length, 0);
  const current = { ...proposal(), repo: 'newmodule', phase: 'pending' };
  ui.receive({ type: 'host_push', agentId: 'agent', generation: context.generation, push: current });
  ui.receive({ type: 'host_push', agentId: 'agent', generation: oldGeneration, push: old });
  assert.ok(all(root).some(node => node.textContent.includes('newmodule'))); assert.ok(all(root).some(node => node.textContent === 'Granska push')); assert.deepEqual(messages, []);
});

test('browser approval needs explicit review and a typed code, remains literal and clears on logout', () => {
  const root = new Element(), messages = [], context = { agentId: 'agent', generation: randomUUID(), online: true };
  const ui = createHostPushUI({ document: { getElementById: () => root, createElement: tag => Object.assign(new Element(), { tag }) }, getContext: () => context, send: value => { messages.push(value); return true; } });
  const p = { ...proposal(), reason: '<script>not executable</script>', phase: 'pending' };
  ui.receive({ type: 'host_push', agentId: 'agent', generation: context.generation, push: p });
  assert.ok(all(root).some(x => x.textContent.includes('<script>'))); assert.equal(all(root).filter(x => x.tag === 'input').length, 0);
  const reviewButton = all(root).find(x => x.textContent === 'Granska push'); reviewButton.listeners.click(); reviewButton.listeners.click(); assert.equal(messages[0].type, 'host_push_review'); assert.equal(messages.length, 1);
  const reviewId = randomUUID(); ui.receive({ type: 'host_push_review', agentId: 'agent', generation: context.generation, id: p.id, reviewId });
  const input = all(root).find(x => x.tag === 'input'); input.value = p.code; all(root).find(x => x.textContent === 'Godkänn push').listeners.click();
  assert.equal(input.value, ''); assert.deepEqual(messages[1], { type: 'host_push_decision', id: p.id, reviewId, approved: true, code: p.code });
  ui.clear(); assert.deepEqual(root.children, []); assert.ok(!all(root).some(x => x.tag === 'script'));
});
