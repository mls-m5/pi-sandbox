import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectMessage } from '../src/pi-view.js';
import { ChatModel, cleanMessage } from '../web/public/view-model.js';
import { renderChat, renderTools, renderActivity } from '../web/public/render.js';
import { handlePromptKey } from '../web/public/keybindings.js';
import { startupText } from '../web/public/startup.js';

test('startup display describes the current step and elapsed wait without estimating completion or trusting raw errors', () => {
  const startup = { phase: 'preparing_image', startedAt: 1000, updatedAt: 10000 };
  assert.match(startupText(startup, 40000), /Förbereder sandbox-image.*39 s totalt.*30 s/);
  assert.match(startupText(startup, 40000), /inte en bekräftad låsning/);
  assert.equal(startupText({ phase: 'raw error with secret' }), '');
  assert.match(startupText({ ...startup, phase: 'project_busy' }, 40000), /Projektet används redan/);
  assert.match(startupText({ ...startup, phase: 'connected' }, 40000), /frånkopplad/);
});

test('plain Enter submits once; Shift+Enter/modifiers/IME keep default behavior and held repeats do not send', () => {
  let submitted = 0, prevented = 0;
  const event = extra => ({ key: 'Enter', preventDefault() { prevented++; }, ...extra });
  assert.equal(handlePromptKey(event(), () => submitted++), true);
  assert.equal(submitted, 1);
  assert.equal(prevented, 1);
  for (const extra of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { key: 'a' }, { defaultPrevented: true }]) {
    assert.equal(handlePromptKey(event(extra), () => submitted++), false);
  }
  assert.equal(submitted, 1);
  assert.equal(prevented, 1);
  assert.equal(handlePromptKey(event({ repeat: true }), () => submitted++), true);
  assert.equal(submitted, 1);
  assert.equal(prevented, 2);
});

const generation = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const message = (role, text) => ({ role, content: [{ type: 'text', text }] });
const frame = (seq, event, gen = generation) => ({ v: 1, generation: gen, seq, event });

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
const document = { createElement: tag => new Element(tag) };
const allText = element => element.textContent + element.children.map(allText).join('');
const descendants = element => [element, ...element.children.flatMap(descendants)];
const cards = root => descendants(root).filter(node => node.className?.startsWith('tool-card '));

test('chat reconciles streamed text/thinking with authoritative final messages without duplicating them', () => {
  const model = new ChatModel(); model.reset(generation, 0);
  model.frame(frame(1, { type: 'message_end', message: message('user', 'hello') }));
  model.frame(frame(2, { type: 'message_start', message: message('assistant', '') }));
  model.frame(frame(3, { type: 'message_update', update: { type: 'text_delta', contentIndex: 0, text: 'part' } }));
  model.frame(frame(4, { type: 'message_update', update: { type: 'thinking_delta', contentIndex: 1, text: 'visible only' } }));
  assert.equal(model.partial.content[0].text, 'part');
  assert.equal(model.partial.content[1].type, 'thinking');
  model.frame(frame(5, { type: 'message_end', message: message('assistant', 'authoritative') }));
  assert.equal(model.partial, null);
  assert.equal(model.messages.length, 2);
  assert.equal(model.messages[1].content[0].text, 'authoritative');
  model.frame(frame(6, { type: 'agent_end' }));
  assert.notEqual(model.status, 'idle');
  model.frame(frame(7, { type: 'agent_settled' }));
  assert.equal(model.status, 'idle');
});

test('snapshot races, missed sequences and old generations do not claim synchronized history', () => {
  const model = new ChatModel(); model.reset(generation, 10);
  model.frame(frame(11, { type: 'message_end', message: message('user', 'new') }));
  const result = { generation, stable: true, endSeq: 10, data: { history: { messages: [message('user', 'old')] } } };
  assert.equal(model.snapshot(result), false);
  assert.equal(model.messages[0].content[0].text, 'new');
  assert.equal(model.snapshot({ ...result, endSeq: 11, stable: false }), false);
  assert.equal(model.snapshot({ ...result, endSeq: 11 }), true);
  assert.equal(model.messages[0].content[0].text, 'old');
  model.frame(frame(13, { type: 'agent_start' }));
  assert.equal(model.synced, false);
  assert.equal(model.frame(frame(14, { type: 'agent_settled' }, 'different')), false);
  assert.equal(model.frame(frame(12, { type: 'agent_settled' })), false);
});

test('hostile model/tool content is rendered only as plain text, never HTML, links or event handlers', () => {
  const hostile = '<img src=x onerror=alert(1)><script>attack()</script>\u001b[31mhttps://evil.invalid';
  const model = new ChatModel(); model.messages = [cleanMessage(message('assistant', hostile))];
  const root = new Element('div'); renderChat(document, root, model);
  assert.ok(allText(root).includes(hostile));
  assert.equal(root.children[0].tag, 'article');
  assert.equal(root.children[0].children[1].tag, 'div');
  assert.equal(allText(root.children[0].children[1]), hostile);
  renderTools(document, root, [{ name: hostile, state: 'klar', text: hostile }]);
  assert.ok(allText(root).includes(hostile));
  const app = fs.readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  const render = fs.readFileSync(new URL('../web/public/render.js', import.meta.url), 'utf8');
  const markdown = fs.readFileSync(new URL('../web/public/markdown.js', import.meta.url), 'utf8');
  for (const source of [app, render, markdown]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|eval\(/);
});

test('browser-side models are bounded even with hostile DTOs, endless deltas and tool updates', () => {
  const model = new ChatModel(); model.reset(generation, 0);
  for (let i = 1; i <= 200; i++) model.frame(frame(i, { type: 'message_end', message: message('assistant', 'x'.repeat(10000)) }));
  assert.ok(model.messages.length <= 100);
  assert.ok(model.messages.reduce((sum, entry) => sum + entry.content[0].text.length, 0) <= 256 * 1024);
  for (let i = 201; i <= 300; i++) model.frame(frame(i, { type: 'message_update', update: { type: 'text_delta', contentIndex: i % 32, text: 'x'.repeat(10000) } }));
  assert.ok(model.partial.content.reduce((sum, block) => sum + block.text.length, 0) <= 16384);
  for (let i = 301; i <= 400; i++) model.frame(frame(i, { type: 'tool_execution_end', toolCallId: `tool-${i}`, toolName: 'fake', result: message('toolResult', 'y'.repeat(10000)) }));
  assert.equal(model.tools.length, 20);
  assert.ok(model.tools.every(tool => tool.text.length <= 2048 && tool.truncated));
  const clipped = new Element('div'); renderTools(document, clipped, model.tools);
  assert.ok(allText(clipped).includes('Resultatet är förkortat'));
  assert.equal(cleanMessage({ role: 'evil-role', content: [{ type: 'image', data: 'private-base64' }] }).role, 'unknown');
});

test('reply token usage projects only bounded numeric counts and renders without claiming remaining quota', () => {
  const projected = projectMessage({ ...message('assistant', 'reply'), usage: { input: 12, output: 34, cacheRead: 8, cacheWrite: 0, totalTokens: 54, cost: { total: 'secret' }, invalid: 'secret' } });
  const cleaned = cleanMessage(projected), root = new Element('div');
  renderChat(document, root, { messages: [cleaned], partial: null });
  assert.match(allText(root), /in 12.*ut 34.*totalt 54/); assert.match(allText(root), /inte återstående kvot/);
  assert.ok(!JSON.stringify(projected).includes('secret'));
  assert.equal(cleanMessage(projectMessage({ ...message('assistant', ''), usage: { input: -1, output: Infinity, totalTokens: 'bad' } })).usage, undefined);
});

test('activity has a spinner only during work/wait, text labels and reduced-motion styling', () => {
  const root = new Element('p');
  for (const status of ['working', 'waiting', 'idle', 'failed', 'unknown', 'offline']) {
    renderActivity(document, root, status, status);
    assert.equal(descendants(root).some(node => node.className === 'activity-spinner'), ['working', 'waiting'].includes(status));
    assert.ok(allText(root).includes(status));
  }
  renderActivity(document, root, 'working', 'first'); const spinner = root.children[0];
  renderActivity(document, root, 'working', 'next delta'); assert.equal(root.children[0], spinner, 'Agent spinner must not restart on every text delta.');
  const css = fs.readFileSync(new URL('../web/public/style.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /tool-succeeded\s*\{\s*border-style:\s*solid;\s*border-color:\s*#70b5ff/);
  assert.match(css, /tool-failed\s*\{\s*border-style:\s*solid;\s*border-color:\s*#ff8d95/);
});

test('tool call, live updates and final result share one card, including failed historical results', () => {
  const model = new ChatModel(); model.reset(generation, 0);
  const call = { role: 'assistant', content: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: 'NEVER_SHOW_ARGUMENTS' }] };
  model.frame(frame(1, { type: 'agent_start' }));
  model.frame(frame(2, { type: 'message_end', message: call }));
  model.frame(frame(3, { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' }));
  const root = new Element('div'); renderChat(document, root, model);
  assert.equal(cards(root).length, 1); assert.equal(cards(root)[0].className, 'tool-card tool-running');
  assert.ok(!allText(root).includes('NEVER_SHOW_ARGUMENTS'));
  model.frame(frame(4, { type: 'tool_execution_update', toolCallId: 'call-1', result: message('toolResult', 'partial') }));
  model.frame(frame(5, { type: 'tool_execution_update', toolCallId: 'call-1' }));
  assert.equal(model.tools[0].text, 'partial');
  const result = { ...message('toolResult', '<script>literal failure</script>'), toolCallId: 'call-1', toolName: 'read', isError: true };
  model.frame(frame(6, { type: 'tool_execution_end', toolCallId: 'call-1', result }));
  model.frame(frame(7, { type: 'message_end', message: result }));
  renderChat(document, root, model);
  assert.equal(cards(root).length, 1); assert.equal(cards(root)[0].className, 'tool-card tool-failed');
  assert.ok(allText(cards(root)[0]).includes('<script>literal failure</script>'));
  assert.ok(!descendants(root).some(node => node.tag === 'script' || node.className === 'activity-spinner'));
  model.snapshot({ generation, stable: true, endSeq: 7, data: { history: { messages: [call, result] } } }); model.tools = [];
  renderChat(document, root, model);
  assert.equal(cards(root).length, 1); assert.equal(cards(root)[0].className, 'tool-card tool-failed');
  result.isError = false; model.messages = [cleanMessage(result)]; renderChat(document, root, model);
  assert.equal(cards(root)[0].className, 'tool-card tool-succeeded');
});

test('subagent tool completion describes an acknowledged call, not completion of asynchronous children', () => {
  const model = new ChatModel(); model.reset(generation, 0); model.status = 'working'; model.stateKnown = true;
  model.frame(frame(1, { type: 'tool_execution_start', toolCallId: 'delegation', toolName: 'subagent' }));
  const root = new Element('div'); renderChat(document, root, model);
  assert.match(allText(root), /Subagenter/); assert.match(allText(root), /Delegeringsanrop pågår/);
  model.frame(frame(2, { type: 'tool_execution_end', toolCallId: 'delegation', result: message('toolResult', '<script>async run started</script>') }));
  renderChat(document, root, model);
  assert.match(allText(root), /underagentens arbetsstatus är inte bekräftad/);
  assert.match(allText(root), /Asynkront arbete kan fortsätta/);
  assert.ok(!descendants(root).some(node => node.tag === 'script'));
});

test('interrupted/missed tool completion stays unknown, never falsely successful or indefinitely spinning', () => {
  const model = new ChatModel(); model.reset(generation, 0);
  model.frame(frame(1, { type: 'agent_start' }));
  model.frame(frame(2, { type: 'tool_execution_start', toolCallId: 'pending', toolName: 'bash' }));
  const root = new Element('div');
  model.status = 'offline'; renderChat(document, root, model);
  assert.equal(cards(root)[0].className, 'tool-card tool-unknown');
  renderTools(document, root, model.tools, false); assert.equal(cards(root)[0].className, 'tool-card tool-unknown');
  model.frame(frame(3, { type: 'agent_settled', aborted: true }));
  assert.equal(model.tools[0].state, 'unknown');
  model.frame(frame(4, { type: 'tool_execution_start', toolCallId: 'another', toolName: 'read' }));
  model.frame(frame(6, { type: 'message_end', message: message('assistant', 'gap') }));
  assert.equal(model.tools[1].state, 'unknown');
});
