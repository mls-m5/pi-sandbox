import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpc, PiControl } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { DUMMY_TEXT } from '../src/dummy-agent.js';
import { AUTO_RESUME_NOTICE } from '../src/runtime/codex-auto.mjs';

async function fixture(t, auto = true) {
  const child = spawn(process.execPath, ['--import', './test/fixtures/dummy-network-guard.mjs', 'bin/pis-dummy.js', ...(auto ? ['--auto-resume'] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/nonexistent-pis-dummy-home', TERM: 'dumb' },
  });
  const rpc = new PiRpc(child, { timeoutMs: 3000 });
  const control = new PiControl(rpc), view = new PiView(rpc, control);
  let id = 0;
  t.after(async () => { view.detach(); try { await rpc.shutdown({ graceMs: 500, killMs: 500 }); } finally { if (child.exitCode === null) child.kill('SIGKILL'); } });
  assert.equal((await rpc.request('get_state')).success, true);
  const events = [];
  rpc.on('event', event => events.push(event));
  const until = predicate => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const listener = event => { if (predicate(event)) { clearTimeout(timer); rpc.off('event', listener); resolve(event); } };
      const timer = setTimeout(() => { rpc.off('event', listener); reject(new Error('Dummy event deadline.')); }, 3000);
      rpc.on('event', listener);
    });
  };
  return { rpc, view, events, until, prompt: message => view.execute({ v: 1, generation: control.generation, id: `c${++id}`, action: 'prompt', message }) };
}
const waiting = event => event.type === 'dummy_status' && event.state === 'waiting';
const reply = event => event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'stop';

test('dummy runs real subprocess/RPC/view with lorem ipsum and fake tools, requiring no credentials', { timeout: 5000 }, async t => {
  const f = await fixture(t, false);
  const frames = [];
  f.view.on('frame', frame => frames.push(frame));
  const accepted = await f.prompt('hello');
  assert.equal(accepted.data.disposition, 'started');
  assert.equal((await f.until(reply)).message.content[0].text, DUMMY_TEXT);
  await f.until(event => event.type === 'agent_settled');
  assert.equal(f.rpc.status, 'idle');
  assert.ok(frames.some(frame => frame.event.type === 'tool_execution_end'));
  assert.ok(frames.some(frame => frame.event.update?.type === 'text_delta'));
  const history = await f.rpc.request('get_messages');
  assert.equal(history.data.messages.length, 2);
  assert.equal(history.data.messages[0].content, 'hello');
});

test('quota then timed refill crosses real host wait socket and resumes exactly once in the same session', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const session = (await f.rpc.request('get_state')).data.sessionId;
  const frames = [];
  f.view.on('frame', frame => frames.push(frame));
  assert.equal((await f.prompt('/dummy quota 1')).data.success, true);
  await f.until(waiting);
  await f.until(reply);
  await delay(100);
  const state = (await f.rpc.request('get_state')).data;
  assert.equal(state.sessionId, session);
  assert.equal(state.resumes, 1);
  const messages = (await f.rpc.request('get_messages')).data.messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[1].stopReason, 'error');
  assert.match(messages[1].errorMessage, /429 usage_limit_reached/);
  assert.equal(messages[2].content, AUTO_RESUME_NOTICE);
  assert.equal(messages[3].content[0].text, DUMMY_TEXT);
  assert.ok(frames.some(frame => frame.event.type === 'dummy_status' && frame.event.state === 'waiting'));
});

test('manual refill is an out-of-band dummy control and later quota cycles can resume again', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    f.events.length = 0;
    await f.rpc.request('get_state');
    await f.prompt('/dummy quota hold');
    await f.until(waiting);
    assert.equal((await f.prompt('/dummy refill')).data.disposition, 'handled');
    await f.until(reply);
    await f.until(event => event.type === 'agent_settled' && event.aborted === false);
    assert.equal((await f.rpc.request('get_state')).data.resumes, index + 1);
  }
});

test('stop cancels pending continuation and a later refill does not replay it', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.prompt('/dummy quota hold'); await f.until(waiting);
  await f.rpc.request('clear_queue'); await f.rpc.request('abort');
  assert.equal((await f.rpc.request('prompt', { message: '/dummy refill' })).success, true);
  await delay(400);
  assert.equal((await f.rpc.request('get_state')).data.resumes, 0);
  assert.ok(!f.events.some(reply));
});

test('auto-resume is off by default and quota controls cannot enable normal host approvals or arbitrary RPC', { timeout: 5000 }, async t => {
  const f = await fixture(t, false);
  await f.prompt('/dummy quota hold'); await f.until(event => event.type === 'agent_settled');
  await delay(100);
  assert.ok(!f.events.some(waiting));
  assert.equal((await f.rpc.request('prompt', { message: '/dummy refill' })).success, true);
  assert.equal((await f.rpc.request('get_state')).data.resumes, 0);
  assert.equal((await f.rpc.request('prompt', { message: '/dummy quota 999' })).success, false);
  assert.equal((await f.rpc.request('prompt', { message: '/dummy unknown' })).success, false);
  assert.equal((await f.rpc.request('prompt', { message: 'x', approved: true })).success, false);
});

test('transient 429 with available usage and ordinary errors never cause automatic continuation', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.prompt('/dummy transient');
  await f.until(event => event.type === 'dummy_status' && event.state === 'not_quota');
  assert.equal((await f.rpc.request('get_state')).data.resumes, 0);
  f.events.length = 0;
  await f.prompt('/dummy error'); await f.until(event => event.type === 'agent_settled');
  await delay(150);
  assert.equal((await f.rpc.request('get_state')).data.resumes, 0);
  assert.ok(!f.events.some(waiting));
});

test('disabling auto while waiting prevents a stale refill from resuming; re-enable needs a new failure', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.prompt('/dummy quota hold'); await f.until(waiting);
  await f.prompt('/dummy auto off');
  await f.rpc.request('prompt', { message: '/dummy refill' });
  await f.rpc.request('prompt', { message: '/dummy auto on' });
  await delay(350);
  assert.equal((await f.rpc.request('get_state')).data.resumes, 0);
});

test('abort interrupts streamed dummy output without starting any replacement turn', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.prompt('hello');
  await f.rpc.request('abort');
  await f.until(event => event.type === 'agent_settled' && event.aborted === true);
  assert.equal((await f.rpc.request('get_state')).data.isStreaming, false);
  assert.ok(!f.events.some(reply));
});
