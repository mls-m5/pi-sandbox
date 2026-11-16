import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPairingUI } from '../web/public/pairing-ui.js';
class Element {
  children = []; value = ''; textContent = ''; disabled = false; listeners = new Map();
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners.set(name, fn); }
}
function fixture() {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } };
  const state = { session: 'one', active: true };
  const ui = createPairingUI({ document, getSession: () => state.session, isSessionActive: session => state.active && state.session === session });
  ui.receive({ type: 'pending_clients', requests: [{ id: randomUUID(), label: '<script>literal</script>', kind: 'pi', expiresAt: Date.now() + 1000 }] });
  const form = document.getElementById('pending-clients').children[0], input = form.children[0].children[0], button = form.children[1];
  return { ui, state, document, form, input, button, submit: () => form.listeners.get('submit')({ preventDefault() {} }) };
}
test('pairing UI clears code on submit and suppresses stale responses after session change/clear', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const cause of ['clear', 'session', 'disconnect']) {
    const f = fixture(); let finish, calls = 0;
    globalThis.fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    f.input.value = '07'; const response = f.submit();
    assert.equal(f.input.value, ''); assert.equal(f.button.disabled, true);
    if (cause === 'clear') f.ui.clear();
    if (cause === 'session') f.state.session = 'two';
    if (cause === 'disconnect') f.state.active = false;
    finish({ ok: true, status: 200 }); await response;
    assert.equal(f.document.getElementById('pairing-note').textContent, ''); assert.equal(calls, 1);
    f.ui.clear(); assert.equal(f.document.getElementById('pending-clients').children.length, 0);
  }
});
test('pairing UI permits manual retry only after definite rejection, never after ambiguous response', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const f = fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 403 }; };
  f.input.value = '12'; await f.submit(); assert.equal(f.button.disabled, false);
  globalThis.fetch = async () => { calls++; throw new Error('lost'); };
  f.input.value = '13'; await f.submit(); assert.equal(f.button.disabled, true);
  f.input.value = '14'; await f.submit(); assert.equal(calls, 2); assert.equal(f.input.value, '');
});
test('pairing UI clears unsubmitted code fields when hidden or replaced', () => {
  const f = fixture(); f.input.value = '99'; f.ui.clear(); assert.equal(f.input.value, '');
  assert.equal(f.document.getElementById('pending-clients').children.length, 0);
});
