import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { PiRpc, PiControl } from '../src/pi-rpc.js';

function childFixture(t, write, options = {}) {
  const child = new EventEmitter();
  child.stdin = new Writable({ write });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const rpc = new PiRpc(child, options);
  t.after(() => { child.emit('close', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return { child, rpc };
}

test('timed-out queued commands are removed before a stalled writer resumes', async t => {
  const writes = [], callbacks = [];
  const { rpc } = childFixture(t, (chunk, _, done) => { writes.push(JSON.parse(chunk)); callbacks.push(done); }, { timeoutMs: 20 });
  const a = assert.rejects(rpc.request('get_state'), /timeout_ambiguous/);
  const b = assert.rejects(rpc.request('prompt', { message: 'must not send later' }), /timeout_ambiguous/);
  await Promise.all([a, b]);
  callbacks[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(rpc.writeBytes, 0);
});

test('ambiguous prompt remains deduplicated after timeout and state resynchronization', async t => {
  const writes = [];
  const { rpc, child } = childFixture(t, (chunk, _, done) => { writes.push(JSON.parse(chunk)); done(); }, { timeoutMs: 20 });
  const control = new PiControl(rpc);
  const command = { v: 1, generation: control.generation, id: 'prompt', action: 'prompt', message: 'do once' };
  rpc.setStatus('idle');
  await assert.rejects(control.execute(command), /timeout_ambiguous/);
  assert.equal(rpc.status, 'unknown');
  const state = control.execute({ v: 1, generation: control.generation, id: 'state', action: 'state' });
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ type: 'response', command: 'get_state', id: writes[1].id, success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } })}\n`);
  await state;
  assert.equal(rpc.status, 'idle');
  assert.deepEqual(await control.execute(command), { duplicate: true });
  assert.equal(writes.filter(value => value.type === 'prompt').length, 1);
});

test('stdin errors and process startup failures reject without leaking diagnostics', async t => {
  const a = childFixture(t, (_chunk, _, done) => done(new Error('private diagnostic')));
  await assert.rejects(a.rpc.request('get_state'), /rpc_write_failed/);
  assert.equal(a.rpc.faulted, true);
  const b = childFixture(t, () => {});
  const pending = b.rpc.request('get_state');
  b.child.emit('error', new Error('sensitive executable path'));
  await assert.rejects(pending, /rpc_process_error/);
  assert.equal(b.rpc.status, 'offline');
});

test('oversized history fails explicitly and leaves the output stream draining', async t => {
  const { rpc, child } = childFixture(t, (_chunk, _, done) => done(), { maxRecordBytes: 64 });
  const pending = rpc.request('get_messages');
  child.stdout.write(`${JSON.stringify({ type: 'response', data: { messages: ['x'.repeat(200)] } })}\n`);
  await assert.rejects(pending, /rpc_record_too_large/);
  child.stdout.write('ignored but drained\n');
  assert.equal(child.stdout.readableLength, 0);
  assert.equal(rpc.status, 'unknown');
});
