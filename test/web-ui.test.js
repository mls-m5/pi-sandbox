import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ChatModel, cleanMessage } from '../web/public/view-model.js';
import { renderChat, renderTools } from '../web/public/render.js';
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
  assert.equal(root.children[0].children[1].tag, 'pre');
  assert.equal(root.children[0].children[1].textContent, hostile);
  renderTools(document, root, [{ name: hostile, state: 'klar', text: hostile }]);
  assert.ok(allText(root).includes(hostile));
  const app = fs.readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  const render = fs.readFileSync(new URL('../web/public/render.js', import.meta.url), 'utf8');
  for (const source of [app, render]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|eval\(/);
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
  assert.ok(model.tools.every(tool => tool.text.length <= 2048));
  assert.equal(cleanMessage({ role: 'evil-role', content: [{ type: 'image', data: 'private-base64' }] }).role, 'unknown');
});
