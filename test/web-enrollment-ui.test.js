import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrollmentUI } from '../web/public/enrollment-ui.js';

class Element {
  constructor() {
    this.value = '';
    this.hidden = false;
    this.textContent = '';
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

function setup() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const state = { connected: true, session: 'session-one', selected: 'agent-one', active: true };
  const ui = createEnrollmentUI({
    document,
    isConnected: () => state.connected,
    isSessionActive: (session) => state.active && state.connected && state.session === session,
    getSession: () => state.session,
    getSelected: () => state.selected,
    draw() {},
  });
  ui.bind();
  return { document, elements, state, ui };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test('legacy enrollment secret clears at its exact expiry deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const { document } = setup();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ id: 'enrollment-one', token: 'legacy-secret', expiresAt: 1_025 }),
  }));
  const issuing = document.getElementById('register-agent').listeners.get('submit')({ preventDefault() {} });
  await issuing;
  t.mock.timers.tick(24);
  assert.equal(document.getElementById('registration-secret').value, 'legacy-secret');
  assert.equal(document.getElementById('registration-secret-label').hidden, false);
  t.mock.timers.tick(1);
  assert.equal(document.getElementById('registration-secret').value, '');
  assert.equal(document.getElementById('registration-secret-label').hidden, true);
  assert.equal(document.getElementById('clear-registration').hidden, true);
  assert.match(document.getElementById('register-note').textContent, /upphört att gälla/);
});

test('only the matching enrollment_cleared event clears the legacy enrollment secret', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { document, ui } = setup();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ id: 'enrollment-one', token: 'legacy-secret', expiresAt: Date.now() + 60_000 }),
  });
  await document.getElementById('register-agent').listeners.get('submit')({ preventDefault() {} });

  assert.equal(ui.receive({ type: 'enrollment_cleared', id: 'another-enrollment' }), true);
  assert.equal(document.getElementById('registration-secret').value, 'legacy-secret');
  assert.equal(document.getElementById('registration-secret-label').hidden, false);
  assert.equal(ui.receive({ type: 'enrollment_cleared', id: 'enrollment-one' }), true);
  assert.equal(document.getElementById('registration-secret').value, '');
  assert.equal(document.getElementById('registration-secret-label').hidden, true);
  assert.equal(document.getElementById('clear-registration').hidden, true);
  assert.match(document.getElementById('register-note').textContent, /använts eller upphört/);
});

test('late enrollment responses after clear, disconnect, or session change never display the secret', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const staleCause of ['clear', 'disconnect', 'session change']) {
    const { document, state, ui } = setup();
    const response = deferred();
    globalThis.fetch = () => response.promise;
    const issuing = document.getElementById('register-agent').listeners.get('submit')({
      preventDefault() {},
    });
    assert.equal(ui.isRegistering(), true, staleCause);
    if (staleCause === 'clear') ui.clear();
    if (staleCause === 'disconnect') state.connected = false;
    if (staleCause === 'session change') state.session = 'session-two';
    response.resolve({
      ok: true,
      json: async () => ({ id: 'ticket-one', token: 'secret-token', expiresAt: Date.now() + 60_000 }),
    });
    await issuing;
    assert.equal(document.getElementById('registration-secret').value, '', staleCause);
    assert.equal(document.getElementById('registration-secret-label').hidden, true, staleCause);
    assert.equal(ui.isRegistering(), false, staleCause);
  }
});
