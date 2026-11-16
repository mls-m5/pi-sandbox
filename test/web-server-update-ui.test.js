import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerUpdateUI } from '../web/public/server-update.js';
function fixture(fetchImpl, confirm = () => true) {
  const elements = new Map(); let session = 'csrf';
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, addEventListener(_name, listener) { this.click = listener; } }); return elements.get(id); } };
  const ui = createServerUpdateUI({ document, getSession: () => session, fetchImpl, confirm });
  return { ui, button: document.getElementById('server-update'), note: document.getElementById('server-update-note'), logout: () => { session = null; ui.clear(); } };
}
test('update button requires explicit confirmation, sends once, and displays only fixed phases/codes', async () => {
  let calls = 0;
  const cancelled = fixture(async () => { calls++; }, () => false); await cancelled.button.click(); assert.equal(calls, 0);
  const f = fixture(async (_url, options) => {
    calls++;
    if (options.method === 'POST') { assert.equal(options.headers['X-CSRF-Token'], 'csrf'); assert.equal(options.body, '{"confirm":true}'); return { status: 202 }; }
    return { ok: true, json: async () => ({ phase: 'current', stderr: 'SECRET', error: 'SECRET' }) };
  });
  await f.button.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.match(f.note.textContent, /redan aktuell/); assert.ok(!f.note.textContent.includes('SECRET')); assert.equal(f.button.disabled, false);
});
test('ambiguous update acceptance locks retry; logout clears and invalidates late responses', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('SECRET'); }); await f.button.click(); await f.button.click();
  assert.equal(calls, 1); assert.equal(f.button.disabled, true); assert.match(f.note.textContent, /Okänt utfall/); assert.ok(!f.note.textContent.includes('SECRET'));
  let resolve; const delayed = fixture(() => new Promise(done => { resolve = done; })); const task = delayed.button.click(); delayed.logout(); resolve({ status: 202 }); await task;
  assert.equal(delayed.note.textContent, ''); assert.equal(delayed.button.disabled, true);
});
