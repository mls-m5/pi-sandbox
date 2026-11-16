import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from '../web/public/message-queue.js';
class Element {
  children = [];
  listeners = new Map();
  value = '';
  textContent = '';
  disabled = false;
  append(...elements) {
    this.children.push(...elements);
  }
  replaceChildren(...elements) {
    this.children = elements;
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  dispatch(type) {
    return this.listeners.get(type)?.({ preventDefault() {} });
  }
}
function fixture(execute = async () => ({ data: { success: true } })) {
  const elements = new Map(),
    state = { agentId: 'one', generation: 'generation-one', status: 'working', ready: true };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() {
      return new Element();
    },
  };
  const ui = createMessageQueue({ document, getContext: () => state, execute });
  const cards = () => document.getElementById('queued-messages').children;
  const field = () => cards()[0].children[0].children[0];
  return { ui, state, document, cards, field };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));
test('queue holds editable literal drafts, sends only on explicit action and does not replay', async () => {
  const calls = [],
    f = fixture(async (...args) => {
      calls.push(args);
      return { data: { success: true } };
    });
  assert.equal(f.ui.add('steer', '<script>literal draft</script>'), true);
  assert.equal(calls.length, 0);
  assert.equal(f.field().value, '<script>literal draft</script>');
  f.field().value = 'edited instruction';
  f.field().dispatch('input');
  f.cards()[0].children[1].dispatch('click');
  await settled();
  assert.deepEqual(calls, [['steer', { message: 'edited instruction' }]]);
  assert.equal(f.cards().length, 0);
  f.ui.draw();
  assert.equal(calls.length, 1);
});
test('idle drafts send as new prompts; follow-up stays explicit while working', async () => {
  const calls = [],
    f = fixture(async (...args) => {
      calls.push(args);
      return { data: { success: true } };
    });
  f.state.status = 'idle';
  f.ui.add('follow_up', 'first');
  f.cards()[0].children[1].dispatch('click');
  await settled();
  f.state.status = 'working';
  f.ui.add('follow_up', 'later');
  f.cards()[0].children[1].dispatch('click');
  await settled();
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['prompt', 'follow_up'],
  );
});
test('drafts are generation/agent scoped and offline clicks do not deliver', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { data: { success: true } };
  });
  f.ui.add('steer', 'only one');
  const oldButton = f.cards()[0].children[1];
  f.state.agentId = 'two';
  f.ui.draw();
  assert.equal(f.cards().length, 0);
  oldButton.dispatch('click');
  await settled();
  assert.equal(calls, 0);
  f.state.agentId = 'one';
  f.state.generation = 'generation-two';
  f.ui.draw();
  assert.equal(f.cards().length, 0);
  f.state.generation = 'generation-one';
  f.state.ready = false;
  f.ui.draw();
  f.cards()[0].children[1].dispatch('click');
  await settled();
  assert.equal(calls, 0);
});
test('unknown outcomes lock drafts, and clearing while a request is pending never restores them', async () => {
  let resolve,
    calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.ui.add('steer', 'maybe delivered');
  f.cards()[0].children[1].dispatch('click');
  resolve({ data: { success: false, error: 'outcome_unknown' } });
  await settled();
  assert.equal(f.field().readOnly, true);
  assert.equal(f.cards()[0].children[1].disabled, true);
  f.cards()[0].children[1].dispatch('click');
  await settled();
  assert.equal(calls, 1);
  f.ui.clear();
  f.ui.add('steer', 'next');
  f.cards()[0].children[1].dispatch('click');
  f.ui.clear();
  resolve({ data: { success: false } });
  await settled();
  assert.equal(f.cards().length, 0);
});
test('duplicate success cannot claim delivery or discard the only draft copy', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { data: { success: true, duplicate: true } };
  });
  f.ui.add('steer', 'original outcome unknown');
  f.cards()[0].children[1].dispatch('click');
  await settled();
  assert.equal(f.cards().length, 1);
  assert.equal(f.field().value, 'original outcome unknown');
  assert.equal(f.field().readOnly, true);
  assert.equal(f.cards()[0].children[1].disabled, true);
  f.cards()[0].children[1].dispatch('click');
  await settled();
  assert.equal(calls, 1);
});

test('bounded drafts reject over-limit additions/edits without changing prior text', () => {
  const f = fixture();
  assert.equal(f.ui.add('steer', 'x'.repeat(65537)), false);
  assert.equal(f.ui.add('steer', '   '), false);
  assert.equal(f.ui.add('shell', 'bad'), false);
  for (let i = 0; i < 32; i++) assert.equal(f.ui.add('steer', `draft-${i}`), true);
  assert.equal(f.ui.add('steer', 'overflow'), false);
  f.field().value = '😀'.repeat(20000);
  f.field().dispatch('input');
  assert.equal(f.field().value, 'draft-0');
  f.ui.clear();
  assert.equal(f.ui.add('steer', '\\'.repeat(64000)), true);
  assert.equal(f.ui.add('steer', '\\'.repeat(64000)), false);
});
test('take-queue is confirmed, destructive exactly once and restores remaining text only as drafts', async (t) => {
  const original = globalThis.confirm;
  t.after(() => {
    globalThis.confirm = original;
  });
  const calls = [];
  const f = fixture(async (action) => {
    calls.push(action);
    return {
      data: {
        success: true,
        queue: [
          { kind: 'steer', message: 'from Pi' },
          { kind: 'follow_up', message: '<b>literal followup</b>' },
        ],
        omitted: 0,
      },
    };
  });
  globalThis.confirm = () => false;
  f.ui.draw();
  f.document.getElementById('take-queue').dispatch('click');
  await settled();
  assert.deepEqual(calls, []);
  globalThis.confirm = () => true;
  f.document.getElementById('take-queue').dispatch('click');
  await settled();
  assert.deepEqual(calls, ['take_queue']);
  assert.equal(f.cards().length, 2);
  assert.equal(f.field().value, 'from Pi');
  assert.equal(f.field().readOnly, false);
  f.ui.draw();
  assert.deepEqual(calls, ['take_queue']);
});
