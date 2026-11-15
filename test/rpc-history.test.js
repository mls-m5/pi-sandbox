import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { PiRpc } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { RpcHistoryDecoder } from '../src/rpc-history.js';

function fixture(t, options = {}) {
  const child = new EventEmitter(), sent = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { sent.push(JSON.parse(chunk)); done(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const rpc = new PiRpc(child, options);
  t.after(() => { child.emit('close', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const output = record => child.stdout.write(`${JSON.stringify(record)}\n`);
  return { child, rpc, sent, output };
}
const history = (id, messages) => ({ id, type: 'response', command: 'get_messages', success: true, data: { messages } });
const state = command => ({ id: command.id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });

test('native history above 4 MiB keeps bounded newest messages and ordinary state/stop remain usable', async t => {
  const f = fixture(t), view = new PiView(f.rpc);
  t.after(() => view.detach());
  const pending = view.execute({ v: 1, generation: view.control.generation, id: 'history', action: 'history' });
  const messages = Array.from({ length: 200 }, (_, index) => ({ role: 'user', content: `message-${index} ${'x'.repeat(30000)}` }));
  const line = Buffer.from(`${JSON.stringify(history(f.sent[0].id, messages))}\r\n`);
  assert.ok(line.length > 4 * 1024 * 1024);
  for (let index = 0; index < line.length; index += 32767) f.child.stdout.write(line.subarray(index, index + 32767));
  const result = await pending;
  assert.equal(result.data.success, true); assert.equal(result.data.history.totalMessages, 200);
  assert.ok(result.data.history.omittedMessages > 0); assert.equal(result.data.history.truncated, true);
  assert.equal(result.data.history.messages.at(-1).index, 199);
  assert.ok(JSON.stringify(result.data.history.messages.at(-1)).includes('message-199'));
  assert.equal(f.rpc.faulted, false);
  const next = f.rpc.request('get_state');
  await new Promise(resolve => setImmediate(resolve)); f.output(state(f.sent.at(-1))); await next;
  assert.equal(f.rpc.status, 'idle');
  const stop = f.rpc.request('abort'); await new Promise(resolve => setImmediate(resolve));
  f.output({ id: f.sent.at(-1).id, type: 'response', command: 'abort', success: true }); await stop;
});

test('history body/count/record limits discard only that read through LF, then resume coalesced state records', async t => {
  for (const options of [{ maxRecordBytes: 256 }, { historyLimits: { recordBytes: 300 } }, { historyLimits: { depth: 1 } }]) {
    const f = fixture(t, options), read = f.rpc.request('get_messages');
    const rejected = assert.rejects(read, /rpc_history_limit/);
    const next = f.rpc.request('get_state'); await new Promise(resolve => setImmediate(resolve));
    const line = `${JSON.stringify(history(f.sent[0].id, [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1000) }] }]))}\n${JSON.stringify(state(f.sent[1]))}\n`;
    f.child.stdout.write(line); await rejected; await next;
    assert.equal(f.rpc.faulted, false); assert.equal(f.rpc.status, 'idle');
    assert.equal(f.rpc.decoder.history, null);
  }
});

test('bounded history reader handles every UTF-8 byte split, CRLF, escaped nesting and Unicode line separators', () => {
  const messages = [{ role: 'user', content: 'å🙂\u2028\u2029 [ \\" ] }, text' }, { role: 'assistant', content: [{ type: 'text', text: 'nested\\"}]' }] }];
  const records = [], faults = [];
  const decoder = new RpcHistoryDecoder({ onRecord: value => records.push(value), onFault: code => faults.push(code), onHistoryLimit: () => assert.fail(), isHistoryRequest: id => id === 'read' });
  const buffer = Buffer.from(`${JSON.stringify(history('read', messages))}\r\n{"type":"agent_settled"}\n`);
  for (const byte of buffer) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(faults, []);
  assert.deepEqual(records, [history('read', messages), { type: 'agent_settled' }]);
});

test('malformed bounded history, trailing comma, invalid UTF-8 and incomplete EOF still fault closed', () => {
  const prefix = '{"id":"read","type":"response","command":"get_messages","success":true,"data":{"messages":[';
  for (const line of [`${prefix}{bad}]}}\n`, `${prefix}{},]}}\n`, `${prefix}{"x":"bad\\q"}]}}\n`, `${prefix}{"x":1]}}\n`, `${prefix}{}]} garbage\n`, `${prefix}{"x":`]) {
    const faults = [];
    const decoder = new RpcHistoryDecoder({ onRecord: () => assert.fail(), onFault: code => faults.push(code), onHistoryLimit: () => assert.fail(), isHistoryRequest: () => true });
    decoder.push(Buffer.from(line)); decoder.end(); assert.equal(faults.length, 1);
  }
});

test('strict UTF-8 validation rejects malformed message strings even in the specialized history path', () => {
  const faults = [];
  const decoder = new RpcHistoryDecoder({ onRecord: () => assert.fail(), onFault: code => faults.push(code), onHistoryLimit: () => assert.fail(), isHistoryRequest: () => true });
  decoder.push(Buffer.concat([Buffer.from('{"id":"read","type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"user","content":"'), Buffer.from([255]), Buffer.from('"}]}}\n')]));
  assert.deepEqual(faults, ['rpc_invalid_record']);
});

test('a large but bounded single message is explicitly omitted without losing newer usable messages', async t => {
  const f = fixture(t, { maxRecordBytes: 4096, historyLimits: { retainedBytes: 1024, messages: 3 } });
  const pending = f.rpc.request('get_messages');
  f.output(history(f.sent[0].id, [{ role: 'user', content: 'x'.repeat(2000) }, { role: 'user', content: 'recent' }]));
  const result = await pending;
  assert.equal(result.data.historyWindow.omittedMessageBodies, 1);
  assert.equal(result.data.messages[1].content, 'recent');
  assert.match(result.data.messages[0].content, /omitted/);
  assert.equal(f.rpc.faulted, false);
});

test('late known history replies can be drained after timeout without poisoning state', async t => {
  const f = fixture(t, { maxRecordBytes: 256, timeoutMs: 25 });
  await assert.rejects(f.rpc.request('get_messages'), /rpc_timeout_ambiguous/);
  const next = f.rpc.request('get_state'); await new Promise(resolve => setImmediate(resolve));
  f.child.stdout.write(`${JSON.stringify(history(f.sent[0].id, [{ role: 'user', content: 'x'.repeat(3000) }]))}\n${JSON.stringify(state(f.sent[1]))}\n`);
  await next; assert.equal(f.rpc.faulted, false);
});

test('unrequested or unrecognized oversized records retain the ordinary 4-MiB-style safety cap', async t => {
  const f = fixture(t, { maxRecordBytes: 256 });
  const pending = f.rpc.request('get_state');
  f.output(history('unrequested', [{ content: 'x'.repeat(1000) }]));
  await assert.rejects(pending, /rpc_record_too_large/); assert.equal(f.rpc.faulted, true);
});
