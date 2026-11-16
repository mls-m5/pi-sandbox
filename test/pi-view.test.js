import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PiRpc, PiControl } from '../src/pi-rpc.js';
import { VIEW_LIMITS, viewText, projectMessage, projectHistory, projectState, projectContextUsage, projectDelegationsWidget, projectEvent, PiView } from '../src/pi-view.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const secret = 'SECRET_NOT_FOR_VIEW';
function fixture(handler) {
  const rpc = new EventEmitter();
  rpc.status = 'idle'; rpc.closed = false;
  rpc.setStatus = status => { rpc.status = status; rpc.emit('status', status); };
  rpc.request = handler;
  const control = new PiControl(rpc);
  const view = new PiView(rpc, control);
  const command = (id, action, extra = {}) => ({ v: 1, generation: control.generation, id, action, ...extra });
  return { rpc, control, view, command };
}

test('text budgets count JSON escaping and UTF-8, preserving surrogate pairs and Unicode separators', () => {
  for (const source of ['åäö🙂\u2028\u2029'.repeat(5000), '\0\n\r\t\\"'.repeat(20000), 'a'.repeat(100000), '\ud800'.repeat(20000)]) {
    for (const limit of [16, 64, 8192]) {
      const projected = viewText(source, limit);
      assert.ok(bytes(projected.text) <= limit);
      assert.ok(source.startsWith(projected.text));
      assert.equal(projected.truncated, true);
    }
  }
  assert.equal(viewText('🙂🙂', 7).text, '🙂');
  assert.deepEqual(viewText('hello'), { text: 'hello', truncated: false });
});

test('message projection omits attachment payloads, signatures, provider metadata and tool arguments', () => {
  const source = { role: 'assistant', timestamp: 123, stopReason: 'toolUse', api: secret, provider: secret, responseId: secret, diagnostics: { secret }, content: [
    { type: 'text', text: 'Visible', textSignature: secret },
    { type: 'thinking', thinking: 'Visible reasoning', thinkingSignature: secret },
    { type: 'thinking', thinking: secret, thinkingSignature: secret, redacted: true },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { private: secret }, thoughtSignature: secret },
    { type: 'image', mimeType: 'image/png', data: secret },
    { type: 'future-private-block', data: secret },
  ] };
  const message = projectMessage(source);
  assert.equal(message.role, 'assistant');
  assert.equal(message.omittedBlocks, 3);
  assert.equal(message.content[3].argumentsOmitted, true);
  assert.ok(JSON.stringify(message).includes('Visible reasoning'));
  assert.ok(!JSON.stringify(message).includes(secret));
  assert.ok(bytes(message) <= VIEW_LIMITS.messageBytes);
  const tool = projectMessage({ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: true, content: [{ type: 'text', text: 'output' }], details: { secret }, nestedCalls: { secret } });
  assert.equal(tool.toolCallId, 'call-1');
  assert.ok(!JSON.stringify(tool).includes(secret));
});

test('system, unknown and hidden custom messages are explicit omissions, never raw objects', () => {
  for (const role of ['system', 'future-role', 'custom']) {
    const result = projectMessage({ role, content: secret, display: false, details: { secret } });
    assert.equal(result.omittedBlocks, 1);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(projectMessage(null).role, 'unknown');
  assert.equal(projectMessage({ role: 'user', content: null }).omittedBlocks, 1);
  assert.equal(projectMessage({ role: 'branchSummary', summary: 'summary' }).content[0].text, 'summary');
  const bash = projectMessage({ role: 'bashExecution', command: 'pwd', output: '/sandbox', truncated: true });
  assert.equal(bash.content.length, 2);
  assert.equal(bash.truncated, true);
});

test('message block and total serialized byte limits remain bounded for hostile text and metadata', () => {
  const message = projectMessage({ role: 'toolResult', toolName: '\0'.repeat(100000), toolCallId: '\0'.repeat(100000), content: Array.from({ length: 1000 }, () => ({ type: 'text', text: '\0'.repeat(100000) })) });
  assert.ok(bytes(message) <= VIEW_LIMITS.messageBytes);
  assert.ok(message.content.length <= VIEW_LIMITS.blocks);
  assert.equal(message.truncated, true);
  assert.ok(message.omittedBlocks > 0);
  const small = projectMessage({ role: 'user', content: Array.from({ length: 100 }, () => ({ type: 'image', data: secret })) });
  assert.equal(small.content.length, VIEW_LIMITS.blocks);
  assert.equal(small.omittedBlocks, 100);
});

test('bounded history keeps the newest contiguous suffix with explicit omission/truncation counts', () => {
  const messages = Array.from({ length: 1000 }, (_, index) => ({ role: 'user', content: `message ${index}` }));
  const history = projectHistory(messages);
  assert.equal(history.messages.length, 100);
  assert.equal(history.messages[0].index, 900);
  assert.equal(history.messages.at(-1).index, 999);
  assert.equal(history.omittedMessages, 900);
  assert.equal(history.truncated, true);
  const huge = projectHistory(Array.from({ length: 1000 }, () => ({ role: 'user', content: '🙂'.repeat(30000) })));
  assert.ok(bytes(huge) < VIEW_LIMITS.historyBytes);
  assert.equal(huge.messages.at(-1).index, 999);
  assert.ok(huge.messages.length < 100);
  assert.equal(huge.omittedMessages, 1000 - huge.messages.length);
  assert.equal(projectHistory(null).truncated, true);
  assert.deepEqual(projectHistory([]), { messages: [], totalMessages: 0, omittedMessages: 0, truncated: false });
});

test('context projection keeps only current window estimates and preserves unknown after compaction', () => {
  assert.deepEqual(projectContextUsage({ contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30, apiKey: 'secret' }, cost: 999, sessionFile: 'secret' }), { tokens: 60000, contextWindow: 200000, percent: 30 });
  assert.deepEqual(projectContextUsage({ contextUsage: { tokens: null, contextWindow: 200000, percent: 0 } }), { tokens: null, contextWindow: 200000, percent: null });
  for (const value of [undefined, {}, { contextUsage: { contextWindow: -1 } }, { contextUsage: { contextWindow: Infinity } }]) assert.equal(projectContextUsage(value), null);
  assert.equal(projectContextUsage({ contextUsage: { tokens: 123, contextWindow: 200, percent: NaN } }).percent, null);
});

test('known subagent widget becomes a bounded status tree, never generic extension payload or child secrets', async () => {
  const node = { id: 'child-1', kind: 'subagent', label: '<script>literal</script>', state: 'running', model: 'openai-codex/gpt-6-luna', activity: { currentTool: 'read', currentPath: secret }, task: secret, sessionFile: secret, auth: secret };
  const widget = runs => ({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async', widgetLines: ['PI_SUBAGENT_ASYNC_JSON:' + JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs })] });
  const projected = projectDelegationsWidget(widget([node])); assert.equal(projected.runs[0].state, 'running'); assert.ok(!JSON.stringify(projected).includes(secret));
  assert.equal(projectDelegationsWidget({ ...widget([node]), widgetKey: 'other' }), null);
  assert.equal(projectDelegationsWidget({ ...widget([node]), widgetLines: ['PI_SUBAGENT_ASYNC_JSON:broken'] }), null);
  assert.equal(projectDelegationsWidget({ ...widget([node]), widgetLines: ['PI_SUBAGENT_ASYNC_JSON:' + ' '.repeat(65536)] }), null);
  // The raw 64KiB admission cap is separate from the output/tree caps.
  const boundedInput = Array(8).fill({ ...node, children: Array(8).fill({ ...node, label: '\\u0000'.repeat(30) }) });
  const bounded = projectDelegationsWidget(widget(boundedInput)); assert.ok(bounded.omitted); assert.ok(bytes(bounded) < 24 * 1024);
  let requests = 0; const f = fixture(async () => { requests++; return { success: true }; });
  f.rpc.emit('event', widget([node])); const snapshot = await f.view.execute(f.command('roster1', 'delegations'));
  assert.equal(snapshot.data.snapshot.runs[0].id, 'child-1'); assert.equal(requests, 0); assert.ok(snapshot.data.snapshot.observedAt > 0);
  assert.equal((await f.view.execute(f.command('roster1', 'delegations'))).data.duplicate, true);
  f.view.detach();
});

test('state projection excludes host/session paths and raw model connection configuration', () => {
  const state = projectState({ sessionId: 'session-1', sessionName: 'name', sessionFile: secret, model: { id: 'model-1', name: 'Model', provider: 'provider', baseUrl: secret, headers: { authorization: secret }, apiKey: secret }, isStreaming: false, isCompacting: true, messageCount: 5, pendingMessageCount: -1, thinkingLevel: 'high', auth: secret });
  assert.equal(state.model.id, 'model-1');
  assert.equal(state.isCompacting, true);
  assert.equal(state.messageCount, 5);
  assert.ok(!('pendingMessageCount' in state));
  assert.ok(!JSON.stringify(state).includes(secret));
});

test('live projection carries text/thinking/final messages and correlated tool results, omitting arbitrary fields', () => {
  const delta = projectEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'visible', contentIndex: 0, partial: { secret } }, usage: { secret } });
  assert.deepEqual(delta, { type: 'message_update', update: { type: 'thinking_delta', contentIndex: 0, text: 'visible', truncated: false } });
  const final = projectEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'authoritative' }], responseId: secret } });
  assert.equal(final.message.content[0].text, 'authoritative');
  for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    const event = projectEvent({ type, toolCallId: 'tool-1', toolName: 'read', args: { secret }, partialResult: { content: [{ type: 'text', text: 'partial' }], details: secret }, result: { content: [{ type: 'text', text: 'final' }, { type: 'image', data: secret }], details: secret } });
    assert.equal(event.toolCallId, 'tool-1');
    assert.ok(!JSON.stringify(event).includes(secret));
    assert.ok(bytes(event) < VIEW_LIMITS.eventBytes);
  }
  assert.deepEqual(projectEvent({ type: 'agent_end', messages: [secret], willRetry: true }), { type: 'agent_end', willRetry: true });
  assert.deepEqual(projectEvent({ type: 'queue_update', steering: [secret], followUp: [] }), { type: 'queue_update', steeringCount: 1, followUpCount: 0 });
});

test('unknown events, extension UI and tool argument deltas are dropped, not passed through', () => {
  for (const event of [null, { type: 'extension_ui_request', method: 'notify', message: secret }, { type: 'extension_error', error: secret }, { type: 'bash_execution_update', delta: secret }, { type: 'future', value: secret }, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: secret } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: Number.MAX_SAFE_INTEGER, delta: secret } }]) assert.equal(projectEvent(event), null);
});

test('hostile HTML and terminal escapes stay untrusted plain text, not interpreted or turned into links', () => {
  const text = '<img src=x onerror=alert(1)>\u001b[31m https://example.invalid/';
  const message = projectMessage({ role: 'user', content: text });
  assert.equal(message.content[0].text, text);
  assert.deepEqual(Object.keys(message.content[0]), ['type', 'text', 'truncated']);
  // A later UI MUST use textContent, never innerHTML/Markdown/terminal rendering.
});

test('take_queue projects only bounded exact text and marks every omitted entry', async () => {
  const large = '🙂'.repeat(17000);
  const { view, command } = fixture(async type => type === 'clear_queue'
    ? { success: true, data: { steering: ['exact\\ntext', large, 7, ' '.repeat(2)], followUp: ['later'], arbitrary: secret } }
    : { success: true, data: {} });
  const result = await view.execute(command('take', 'take_queue'));
  assert.deepEqual(result.data, { success: true, queue: [
    { kind: 'steer', message: 'exact\\ntext' }, { kind: 'follow_up', message: 'later' },
  ], omitted: 3 });
  assert.ok(bytes(result) <= VIEW_LIMITS.historyBytes);
  assert.ok(!JSON.stringify(result).includes(secret));
  view.detach();
});

test('take_queue never truncates resendable text and bounds count and JSON escaping', async () => {
  for (const source of [
    { steering: Array.from({ length: 100 }, (_, index) => `item-${index}`), followUp: ['last'] },
    { steering: Array(4).fill('\\'.repeat(64000)), followUp: ['final'] },
  ]) {
    const { view, command } = fixture(async () => ({ success: true, data: source }));
    const result = await view.execute(command('bounded-take', 'take_queue'));
    assert.equal(result.data.success, true); assert.ok(result.data.queue.length <= 32);
    assert.ok(Buffer.byteLength(JSON.stringify(result.data.queue)) <= 128 * 1024);
    assert.equal(result.data.queue.length + result.data.omitted, source.steering.length + source.followUp.length);
    for (const entry of result.data.queue) assert.ok([...source.steering, ...source.followUp].includes(entry.message));
    assert.ok(bytes(result) <= VIEW_LIMITS.historyBytes); view.detach();
  }
  const { view, command } = fixture(async () => ({ success: true, data: { steering: 'not-an-array', arbitrary: secret } }));
  assert.deepEqual((await view.execute(command('invalid-take', 'take_queue'))).data, { success: false, error: 'queue_invalid_reply' });
  view.detach();
});

test('view sanitizes command results and errors, binds generation and does not echo prompts or raw failures', async () => {
  const { view, command, rpc } = fixture(async type => type === 'get_state' ? { success: true, data: { isStreaming: false, sessionFile: secret } } : { success: false, error: secret });
  const state = await view.execute(command('state', 'state'));
  assert.equal(state.data.state.isStreaming, false);
  assert.ok(!JSON.stringify(state).includes(secret));
  const error = await view.execute(command('prompt', 'prompt', { message: secret }));
  assert.deepEqual(error.data, { success: false, error: 'pi_command_rejected' });
  assert.ok(!JSON.stringify(error).includes(secret));
  const invalid = await view.execute({ ...command('bad', 'prompt', { message: secret }), arbitrary: secret });
  assert.deepEqual(invalid.data, { success: false, error: 'control_invalid_command' });
  assert.ok(!('id' in invalid));
  const stale = await view.execute({ ...command('stale', 'state'), generation: 'old' });
  assert.equal(stale.data.error, 'control_stale_generation');
  rpc.request = () => { throw new Error(secret); };
  const unknown = await view.execute(command('unknown', 'state'));
  assert.deepEqual(unknown.data, { success: false, error: 'control_failed' });
  view.detach();
});

test('snapshot sequence ranges flag concurrent live updates instead of claiming an atomic snapshot', async () => {
  let finish;
  const { view, command, rpc } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const frames = [];
  view.on('frame', frame => frames.push(frame));
  const pending = view.execute(command('history', 'history'));
  rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'new' }] } });
  finish({ success: true, data: { messages: [{ role: 'user', content: 'old' }] } });
  const snapshot = await pending;
  assert.equal(snapshot.stable, false);
  assert.equal(snapshot.startSeq, 0);
  assert.equal(snapshot.endSeq, 1);
  assert.equal(frames[0].generation, snapshot.generation);
  assert.equal(snapshot.data.history.messages[0].content[0].text, 'old');
  view.detach();
});

test('a disconnected consumer does not queue events, restart Pi, reset sequence or replay commands', async () => {
  let calls = 0;
  const { view, command, rpc } = fixture(async () => { calls++; return { success: true, data: { messages: [] } }; });
  const history = command('once', 'history');
  await view.execute(history);
  for (let index = 0; index < 1000; index++) rpc.emit('event', { type: 'agent_start' });
  assert.equal(view.sequence, 1000);
  const frames = [];
  view.on('frame', frame => frames.push(frame));
  rpc.emit('event', { type: 'agent_settled' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].seq, 1001);
  const duplicate = await view.execute(history);
  assert.deepEqual(duplicate.data, { duplicate: true });
  assert.equal(calls, 1);
  const fresh = await view.execute(command('fresh', 'history'));
  assert.equal(fresh.stable, true);
  assert.equal(fresh.endSeq, 1001);
  view.detach();
  assert.equal(rpc.listenerCount('event'), 0);
  assert.equal(rpc.closed, false);
  assert.equal((await view.execute(command('after-detach', 'state'))).data.error, 'view_detached');
  assert.equal(calls, 2);
});

test('projected response and event envelopes fit their serialized byte ceilings', async () => {
  const messages = Array.from({ length: 1000 }, () => ({ role: 'toolResult', content: [{ type: 'text', text: '\0'.repeat(100000) }] }));
  const { view, command, rpc } = fixture(async () => ({ success: true, data: { messages } }));
  const response = await view.execute(command('id'.repeat(32), 'history'));
  assert.ok(bytes(response) <= VIEW_LIMITS.historyBytes);
  let frame;
  view.on('frame', value => { frame = value; });
  rpc.emit('event', { type: 'message_end', message: messages[0] });
  assert.ok(bytes(frame) <= VIEW_LIMITS.eventBytes);
  view.detach();
});

test('view integrates with the offline subprocess, retaining no raw response metadata', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['test/fixtures/pi-rpc-child.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const rpc = new PiRpc(child), view = new PiView(rpc);
  const command = (id, action, extra = {}) => ({ v: 1, generation: view.control.generation, id, action, ...extra });
  const state = await view.execute(command('state', 'state'));
  assert.equal(state.data.state.isStreaming, false);
  const frames = [];
  view.on('frame', frame => frames.push(frame));
  const settled = new Promise(resolve => view.on('frame', frame => { if (frame.event.type === 'agent_settled') resolve(); }));
  const accepted = await view.execute(command('prompt', 'prompt', { message: 'offline' }));
  assert.equal(accepted.data.disposition, 'started');
  await settled;
  assert.ok(frames.some(frame => frame.event.update?.text === 'Hej åäö\u2028värld'));
  assert.ok(frames.some(frame => frame.event.type === 'tool_execution_end'));
  assert.ok(frames.every(frame => bytes(frame) < VIEW_LIMITS.eventBytes));
  await rpc.shutdown();
  view.detach();
});
