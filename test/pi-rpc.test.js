import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { JsonlDecoder, PiRpc, PiControl, validateControlCommand } from '../src/pi-rpc.js';

function fixture(t, options = {}, write) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const sent = [];
  child.stdin = new Writable({ write: write ?? ((chunk, encoding, done) => { sent.push(JSON.parse(chunk)); done(); }) });
  child.kill = () => { child.emit('close', 0); return true; };
  const rpc = new PiRpc(child, options);
  t.after(() => { child.emit('close', 0); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); });
  const receive = record => child.stdout.write(`${JSON.stringify(record)}\n`);
  const reply = (command, data, success = true) => receive({ type: 'response', id: command.id, command: command.type, success, data });
  return { child, rpc, sent, receive, reply };
}
const command = (control, id, action, fields = {}) => ({ v: 1, generation: control.generation, id, action, ...fields });

test('JSONL accepts LF/CRLF, coalesced records and byte-split UTF-8 including Unicode separators', () => {
  const records = [], faults = [];
  const decoder = new JsonlDecoder(value => records.push(value), code => faults.push(code));
  const value = { type: 'event', text: 'åäö🙂\u2028\u2029' };
  const bytes = Buffer.from(`${JSON.stringify(value)}\r\n${JSON.stringify(value)}\n`);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(records, [value, value]);
  assert.deepEqual(faults, []);
});

test('JSONL fails closed on malformed, oversized, incomplete, nonobject and invalid UTF-8 records', () => {
  for (const bytes of [Buffer.from('{bad}\n'), Buffer.from('[]\n'), Buffer.from('null\n'), Buffer.from('{}\n'), Buffer.from('{"type":"a"}'), Buffer.from(`{"type":"${'x'.repeat(100)}"}\n`), Buffer.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 255, 34, 125, 10])]) {
    const records = [], faults = [];
    const decoder = new JsonlDecoder(value => records.push(value), code => faults.push(code), 64);
    decoder.push(bytes); decoder.end();
    decoder.push(Buffer.from('{"type":"ignored"}\n'));
    assert.equal(faults.length, 1);
    assert.deepEqual(records, []);
    assert.equal(decoder.bytes, 0);
  }
});

test('responses correlate by ID out of order; unsolicited responses cannot resolve a request', async t => {
  const { rpc, sent, reply, receive } = fixture(t);
  const first = rpc.request('get_state'), second = rpc.request('get_messages');
  receive({ type: 'response', id: 'unknown', command: 'get_state', success: true });
  await new Promise(resolve => setImmediate(resolve));
  reply(sent[1], { messages: [] }); reply(sent[0], { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  assert.deepEqual((await second).data, { messages: [] });
  assert.equal((await first).command, 'get_state');
  assert.equal(rpc.status, 'idle');
  await assert.rejects(rpc.request('bash'), /forbidden/);
});

test('lifecycle does not confuse agent_end, retries or stale snapshots with settled', async t => {
  const { rpc, receive, sent, reply } = fixture(t);
  const state = rpc.request('get_state');
  receive({ type: 'agent_start' });
  reply(sent[0], { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  await state;
  assert.equal(rpc.status, 'working');
  receive({ type: 'agent_end', willRetry: true });
  assert.equal(rpc.status, 'working');
  receive({ type: 'auto_retry_start' });
  receive({ type: 'agent_settled' });
  assert.equal(rpc.status, 'idle');
});

test('dialog policy explicitly cancels all blocking extension dialogs, never approves', t => {
  const { rpc, receive, sent } = fixture(t);
  const cancelled = [], events = [];
  rpc.on('dialog_cancelled', value => cancelled.push(value));
  rpc.on('event', value => events.push(value));
  for (const method of ['select', 'confirm', 'input', 'editor']) receive({ type: 'extension_ui_request', method, id: method, title: 'untrusted host approval!' });
  receive({ type: 'extension_ui_request', method: 'notify', id: 'notice', message: 'untrusted' });
  assert.equal(cancelled.length, 4);
  // Write callbacks are async; remaining writes are checked after a turn.
  return new Promise(resolve => setImmediate(() => {
    assert.deepEqual(sent, ['select', 'confirm', 'input', 'editor'].map(id => ({ type: 'extension_ui_response', id, cancelled: true })));
    assert.equal(events.length, 1);
    resolve();
  }));
});

test('write backpressure is serialized and byte bounded, while stdout keeps draining', async t => {
  const writes = [], callbacks = [];
  const { rpc, receive, reply } = fixture(t, { maxWriteBytes: 180 }, (chunk, encoding, done) => { writes.push(JSON.parse(chunk)); callbacks.push(done); });
  const first = rpc.request('get_state'), second = rpc.request('get_state');
  assert.equal(writes.length, 1);
  await assert.rejects(rpc.request('prompt', { message: 'x'.repeat(200) }), /write_limit/);
  receive({ type: 'agent_start' });
  assert.equal(rpc.status, 'working');
  reply(writes[0], {}); await first;
  callbacks.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  reply(writes[1], {}); await second;
  callbacks.shift()();
});

test('pending limits, timeout ambiguity and late responses do not replay commands', async t => {
  const { rpc, sent, reply } = fixture(t, { maxPending: 1, timeoutMs: 20 });
  const pending = rpc.request('prompt', { message: 'work' });
  await assert.rejects(rpc.request('get_state'), /pending_limit/);
  await assert.rejects(pending, /timeout_ambiguous/);
  reply(sent[0], { disposition: 'started' });
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.status, 'unknown');
  assert.equal(sent.length, 1);
});

test('protocol fault rejects pending requests but drains output without logging contents', async t => {
  const { rpc, child } = fixture(t, { maxRecordBytes: 50 });
  const faults = [];
  rpc.on('fault', code => faults.push(code));
  const pending = rpc.request('get_messages');
  child.stdout.write('private invalid record\n');
  await assert.rejects(pending, /rpc_invalid_record/);
  for (let i = 0; i < 100; i++) child.stdout.write(Buffer.alloc(1024));
  assert.equal(child.stdout.readableLength, 0);
  assert.deepEqual(faults, ['rpc_invalid_record']);
  await assert.rejects(rpc.request('get_state'), /unavailable/);
});

test('mismatched response and unexpected process exit reject outstanding requests', async t => {
  const f = fixture(t);
  const pending = f.rpc.request('get_state');
  f.receive({ type: 'response', id: f.sent[0].id, command: 'prompt', success: true });
  await assert.rejects(pending, /response_mismatch/);
  const g = fixture(t);
  const other = g.rpc.request('get_state');
  g.child.emit('close', 1);
  await assert.rejects(other, /process_closed/);
  assert.equal(g.rpc.status, 'offline');
});

test('strict versioned commands reject extra fields, images, arbitrary RPC and oversized prompts', () => {
  const base = { v: 1, generation: 'runtime', id: 'id', action: 'state' };
  assert.deepEqual(validateControlCommand(base), base);
  for (const value of [null, [], { ...base, v: 2 }, { ...base, action: 'bash' }, { ...base, id: '../bad' }, { ...base, action: 'prompt', message: '' }, { ...base, action: 'prompt', message: 'å'.repeat(40000) }, { ...base, path: '/host' }, { ...base, action: 'prompt', message: 'ok', images: [] }]) assert.throws(() => validateControlCommand(value), /control_invalid/);
});

test('generation binding, bounded duplicate tombstones and payload conflicts prevent replay', async t => {
  const { rpc, sent, reply } = fixture(t);
  const control = new PiControl(rpc, { maxCommands: 2 });
  const state = command(control, 'one', 'state');
  const pending = control.execute(state);
  assert.deepEqual(await control.execute(state), { duplicate: true });
  await assert.rejects(control.execute({ ...state, action: 'stop' }), /id_conflict/);
  await assert.rejects(control.execute({ ...state, generation: 'old' }), /stale_generation/);
  reply(sent[0], {}); await pending;
  assert.deepEqual(await control.execute(state), { duplicate: true });
  const history = control.execute(command(control, 'two', 'history'));
  await new Promise(resolve => setImmediate(resolve));
  reply(sent[1], { messages: [] }); await history;
  await assert.rejects(control.execute(command(control, 'three', 'state')), /id_limit/);
  assert.equal(sent.length, 2);
});

test('prompts reject busy time, reserve idle before acceptance and do not imply completion', async t => {
  const { rpc, sent, reply, receive } = fixture(t);
  const control = new PiControl(rpc);
  await assert.rejects(control.execute(command(control, 'unknown', 'prompt', { message: 'work' })), /not_idle/);
  rpc.setStatus('idle');
  const prompt = control.execute(command(control, 'one', 'prompt', { message: 'work' }));
  await assert.rejects(control.execute(command(control, 'two', 'prompt', { message: 'duplicate work' })), /mutation_pending/);
  reply(sent[0], { disposition: 'started' }); await prompt;
  assert.equal(rpc.status, 'working');
  receive({ type: 'agent_end' });
  await assert.rejects(control.execute(command(control, 'three', 'prompt', { message: 'work' })), /not_idle/);
  receive({ type: 'agent_settled' });
  assert.equal(rpc.status, 'idle');
});

test('stop clears queue before abort and never aborts if clearing failed', async t => {
  for (const success of [true, false]) {
    const { rpc, sent, reply } = fixture(t);
    const control = new PiControl(rpc);
    const stopped = control.execute(command(control, 'stop', 'stop'));
    assert.equal(sent[0].type, 'clear_queue');
    reply(sent[0], {}, success);
    await new Promise(resolve => setImmediate(resolve));
    if (success) { assert.equal(sent[1].type, 'abort'); reply(sent[1], {}); }
    else assert.equal(sent.length, 1);
    await stopped;
  }
});

test('fake subprocess streams messages/tools and shuts down on EOF without model calls', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['test/fixtures/pi-rpc-child.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const rpc = new PiRpc(child);
  const events = [];
  rpc.on('event', event => events.push(event));
  assert.equal((await rpc.request('get_state')).success, true);
  assert.equal(rpc.status, 'idle');
  const settled = new Promise(resolve => rpc.on('event', event => { if (event.type === 'agent_settled') resolve(); }));
  const control = new PiControl(rpc);
  assert.equal((await control.execute(command(control, 'prompt', 'prompt', { message: 'offline' }))).success, true);
  await settled;
  assert.equal(rpc.status, 'idle');
  assert.ok(events.some(event => event.assistantMessageEvent?.delta === 'Hej åäö\u2028värld'));
  assert.ok(events.some(event => event.type === 'tool_execution_end'));
  await rpc.shutdown();
  assert.equal(rpc.status, 'offline');
  assert.equal(child.exitCode, 0);
});

test('EOF alone is not confirmation of process exit; local shutdown escalates', async t => {
  const { rpc, child } = fixture(t);
  const signals = [];
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') child.emit('close', null, signal); return true; };
  child.stdout.end();
  await once(child.stdout, 'end');
  assert.equal(rpc.closed, false);
  await rpc.shutdown({ graceMs: 5, killMs: 5 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(rpc.status, 'offline');
});
