import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword, randomKey, digest } from '../web/common.js';

const installed = fs.existsSync(new URL('../web/node_modules/ws/package.json', import.meta.url));
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.hidden = false; this.disabled = true; this.value = ''; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  async dispatch(type, extra = {}) { await this.listeners.get(type)?.({ preventDefault() {}, ...extra }); }
}
const nodes = element => [element, ...element.children.flatMap(nodes)];
const content = element => element.textContent + element.children.map(content).join('');
async function until(check) {
  for (let i = 0; i < 600; i++) { if (check()) return; await delay(10); }
  assert.fail('App DOM-shim deadline.');
}

test('actual browser app module logs in, selects, chats, recovers dummy quota and logs out via real local HTTP/WS', { skip: !installed, timeout: 15_000 }, async t => {
  const { startWebServer } = await import('../web/server.js');
  const { startDummyConnector } = await import('../web/connector.js');
  const { default: WS } = await import('../web/node_modules/ws/wrapper.mjs');
  const password = 'browser-app-test-password-only', token = randomKey();
  const server = await startWebServer({ port: 0, passwordHash: await hashPassword(password), agents: [{ id: 'dummy-1', label: 'Dummy 1', tokenHash: digest(token) }, { id: 'dummy-2', label: 'Dummy 2', tokenHash: digest(randomKey()) }] });
  server.setStartup('dummy-1', 'preparing_image');
  let connector;
  const elements = new Map(), pageEvents = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('workspace').hidden = true;
  const keys = ['document', 'fetch', 'WebSocket', 'location', 'requestAnimationFrame', 'addEventListener', 'confirm'];
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const realFetch = globalThis.fetch;
  let cookie = '';
  t.after(async () => {
    pageEvents.get('pagehide')?.();
    await connector?.close(); await server.close(); await delay(100);
    for (const key of keys) { const descriptor = descriptors.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  globalThis.document = { getElementById: element, createElement: tag => new Element(tag) };
  globalThis.location = { origin: server.origin };
  globalThis.requestAnimationFrame = callback => setImmediate(callback);
  globalThis.addEventListener = (name, fn) => pageEvents.set(name, fn);
  globalThis.fetch = async (url, options = {}) => {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (options.method === 'POST') headers.set('Origin', server.origin);
    const result = await realFetch(new URL(url, server.origin), { ...options, headers });
    const setCookie = result.headers.getSetCookie()[0]; if (setCookie) cookie = setCookie.split(';')[0];
    return result;
  };
  let browser;
  const sent = [], historyReads = id => sent.filter(value => value.type === 'command' && value.agentId === id && value.command.action === 'history').length;
  globalThis.WebSocket = class extends WS {
    constructor(url) { super(url, { headers: { Origin: server.origin, Cookie: cookie } }); browser = this; }
    send(payload, ...args) { sent.push(JSON.parse(payload)); return super.send(payload, ...args); }
  };
  await import(`../web/public/app.js?test=${Date.now()}`);
  element('password').value = password; await element('login-form').dispatch('submit');
  await until(() => element('agents').children.length === 2);
  await until(() => content(element('state')).includes('Förbereder sandbox-image'));
  assert.equal(element('agent-title').textContent, 'Dummy 1', 'The first agent must open without a click, even while starting.');
  assert.equal(element('send').disabled, true);
  server.setStartup('dummy-1', 'engine_failed');
  await until(() => content(element('state')).includes('Podman-kontrollen misslyckades'));
  assert.ok(content(element('sync-note')).includes('Projektstarten misslyckades'));
  assert.equal(element('send').disabled, true);
  server.setStartup('dummy-1', 'starting_container');
  await until(() => content(element('state')).includes('Startar container'));
  connector = await startDummyConnector({ origin: server.origin, token });
  const native = connector.rpc.request.bind(connector.rpc), reads = [];
  connector.rpc.request = (type, ...args) => { reads.push(type); return native(type, ...args); };
  await until(() => !element('send').disabled);
  await until(() => !element('refresh').disabled);
  assert.equal(historyReads('dummy-1'), 1, 'Opening the now-online agent must automatically read history once.');
  await element('agents').children[1].dispatch('click');
  await until(() => element('agent-title').textContent === 'Dummy 2');
  assert.equal(element('send').disabled, true);
  assert.equal(historyReads('dummy-2'), 0, 'Offline agents must not receive history requests.');
  server.setStartup('dummy-2', 'preparing_image');
  await until(() => content(element('state')).includes('Förbereder sandbox-image'));
  assert.equal(element('agent-title').textContent, 'Dummy 2', 'Roster updates must preserve the manually selected agent.');
  await element('agents').children[0].dispatch('click');
  await until(() => !element('refresh').disabled && historyReads('dummy-1') === 2);
  browser.terminate();
  await until(() => !element('refresh').disabled && historyReads('dummy-1') === 3);
  assert.equal(sent.filter(value => value.command?.action === 'prompt').length, 0, 'Reconnection must never send prompts.');
  const originalRequest = connector.rpc.request.bind(connector.rpc);
  const refresh = async () => { await until(() => !element('refresh').disabled); await element('refresh').dispatch('click'); };
  connector.rpc.request = (type, ...args) => type === 'get_state' ? Promise.reject(Object.assign(new Error('RAW_SECRET_ERROR_NOT_FOR_UI'), { code: 'rpc_unavailable' })) : originalRequest(type, ...args);
  await refresh();
  await until(() => content(element('sync-note')).includes('kod=rpc_unavailable'));
  assert.ok(content(element('sync-note')).includes('ref='));
  assert.ok(content(element('diagnostics')).includes('state · kod=rpc_unavailable'));
  assert.ok(!content(element('diagnostics')).includes('RAW_SECRET_ERROR'));
  assert.equal(element('send').disabled, true);
  connector.rpc.request = type => Promise.resolve({ success: true, data: { isStreaming: false } });
  await refresh();
  await until(() => content(element('sync-note')).includes('invalid_state_reply'));
  assert.equal(element('send').disabled, true);
  connector.rpc.request = originalRequest;
  await refresh();
  await until(() => !element('send').disabled);
  let rejectHistory;
  connector.rpc.request = (type, ...args) => type === 'get_messages' ? new Promise((resolve, reject) => { rejectHistory = reject; }) : originalRequest(type, ...args);
  await element('agents').children[0].dispatch('click');
  await until(() => rejectHistory && !element('send').disabled);
  assert.equal(element('refresh').disabled, true, 'State/live controls must be ready while automatic history is still pending.');
  rejectHistory(Object.assign(new Error('too much history'), { code: 'rpc_history_limit' }));
  await until(() => content(element('sync-note')).includes('Historiken överskred läsgränsen'));
  await until(() => !element('send').disabled);
  assert.equal(connector.rpc.faulted, false);
  connector.rpc.request = originalRequest;
  const hostile = '<img src=x onerror=alert(1)>';
  element('prompt').value = hostile;
  let prevented = false;
  await element('prompt').dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault() { prevented = true; } });
  await element('prompt').dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal((await connector.rpc.request('get_messages')).data.messages.length, 0);
  const historyReadsBefore = reads.filter(type => type === 'get_messages').length;
  await element('prompt').dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await until(() => content(element('messages')).includes('Lorem ipsum'));
  assert.ok(content(element('messages')).includes(hostile));
  await until(() => !element('send').disabled);
  // Use a short timed episode through the actual input handler (button uses 5s).
  element('prompt').value = '/dummy quota 1'; await element('prompt-form').dispatch('submit');
  await until(() => content(element('state')).includes('waiting'));
  await until(() => content(element('messages')).includes('The host confirmed that Codex quota was exhausted'));
  await until(() => !element('send').disabled);
  assert.equal((await connector.rpc.request('get_state')).data.resumes, 1);
  assert.equal(reads.filter(type => type === 'get_messages').length, historyReadsBefore, 'Settlement/quota continuation must not auto-fetch old history.');
  await element('agents').children[1].dispatch('click');
  await until(() => element('agent-title').textContent === 'Dummy 2');
  assert.ok(!content(element('messages')).includes(hostile));
  const beforeReopen = historyReads('dummy-1');
  await element('agents').children[0].dispatch('click');
  await until(() => !element('refresh').disabled && historyReads('dummy-1') === beforeReopen + 1 && content(element('messages')).includes(hostile));
  assert.ok(content(element('messages')).includes('Lorem ipsum'), 'Reopening must restore actual saved messages without pressing refresh.');
  connector.rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '## Checklist\n- [x] Done\n- [ ] Pending\n\n| A | B |\n| --- | --- |\n| one | [Docs](https://example.org/) |' }] } });
  await until(() => nodes(element('messages')).some(node => node.tag === 'table'));
  const checkbox = nodes(element('messages')).find(node => node.tag === 'input' && node.type === 'checkbox');
  assert.equal(checkbox.checked, true); assert.equal(checkbox.disabled, true);
  const link = nodes(element('messages')).find(node => node.tag === 'a');
  assert.equal(link.href, 'https://example.org/'); assert.equal(link.rel, 'noopener noreferrer');
  connector.rpc.emit('event', { type: 'agent_start' });
  await until(() => element('state').className === 'activity activity-working');
  assert.ok(nodes(element('state')).some(node => node.className === 'activity-spinner'));
  connector.rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'fixture-call', name: 'fixture-tool' }] } });
  connector.rpc.emit('event', { type: 'tool_execution_start', toolCallId: 'fixture-call', toolName: 'fixture-tool' });
  const fixtureCards = () => nodes(element('messages')).filter(node => node.className?.startsWith('tool-card ') && content(node).includes('fixture-tool'));
  await until(() => fixtureCards()[0]?.className === 'tool-card tool-running');
  assert.equal(fixtureCards().length, 1);
  const failedTool = { role: 'toolResult', toolCallId: 'fixture-call', toolName: 'fixture-tool', isError: true, content: [{ type: 'text', text: '<b>Literal failure result</b>' }] };
  connector.rpc.emit('event', { type: 'tool_execution_end', toolCallId: 'fixture-call', toolName: 'fixture-tool', isError: true, result: failedTool });
  connector.rpc.emit('event', { type: 'message_end', message: failedTool });
  await until(() => fixtureCards()[0]?.className === 'tool-card tool-failed');
  assert.equal(fixtureCards().length, 1); assert.ok(content(fixtureCards()[0]).includes('<b>Literal failure result</b>'));
  connector.rpc.emit('event', { type: 'agent_end' });
  await delay(20); assert.equal(element('state').className, 'activity activity-working', 'agent_end is not settlement.');
  connector.rpc.emit('event', { type: 'agent_settled', aborted: true });
  await until(() => content(element('state')).includes('Avbruten'));
  assert.ok(!nodes(element('state')).some(node => node.className === 'activity-spinner'));
  await element('register-agent').dispatch('submit');
  const issuedKey = element('registration-secret').value;
  assert.match(issuedKey, /^[A-Za-z0-9_-]{43}$/); assert.equal(element('registration-secret-label').hidden, false);
  assert.equal(element('agents').children.length, 2, 'An unused enrollment key must not create an agent placeholder.');
  const { enrollAgent } = await import('../web/agent-profile.js');
  await enrollAgent(server.origin, issuedKey, { clientId: crypto.randomUUID(), label: '<b>New agent</b>', kind: 'dummy', previousToken: null }, { fetchImpl: realFetch });
  await until(() => element('agents').children.length === 3 && element('registration-secret').value === '');
  assert.equal(element('registration-secret-label').hidden, true, 'Key must clear after use.');
  assert.ok(content(element('agents')).includes('<b>New agent</b>'));
  assert.ok(!content(element('agents')).includes(issuedKey)); assert.ok(!content(element('diagnostics')).includes(issuedKey));
  await element('clear-registration').dispatch('click'); assert.equal(element('registration-secret').value, '');
  await element('agents').children[2].dispatch('click'); await until(() => element('agent-title').textContent === '<b>New agent</b>');
  globalThis.confirm = () => true; await element('revoke-agent').dispatch('click');
  await until(() => element('agents').children.length === 2); assert.match(element('registration-action').textContent, /återkallad/);
  await element('register-agent').dispatch('submit');
  assert.match(element('registration-secret').value, /^[A-Za-z0-9_-]{43}$/);
  await element('logout').dispatch('click');
  await until(() => element('workspace').hidden);
  assert.equal(element('login').hidden, false);
  assert.equal(element('registration-secret').value, ''); assert.equal(element('registration-secret-label').hidden, true);
});
