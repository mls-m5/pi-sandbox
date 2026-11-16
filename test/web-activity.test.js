import test from 'node:test';
import assert from 'node:assert/strict';
import { describeActivity } from '../web/public/activity.js';

const model = patch => ({ status: 'idle', stateKnown: true, messages: [], quota: '', aborted: false, ...patch });

test('activity descriptions distinguish idle, work, failure and interrupted results without claiming success', () => {
  for (const [patch, state, label] of [
    [{}, 'idle', /inaktiv.*kontrollera/],
    [{ status: 'working' }, 'working', /arbetar/],
    [{ stateKnown: false }, 'unknown', /okänt/],
    [{ aborted: true }, 'unknown', /Avbruten/],
    [{ messages: [{ role: 'assistant', stopReason: 'aborted' }] }, 'unknown', /Avbruten/],
    [{ messages: [{ role: 'assistant', stopReason: 'error' }] }, 'failed', /fel/],
    [{ status: 'working', messages: [{ role: 'assistant', stopReason: 'error' }] }, 'working', /arbetar/],
    [{ messages: [{ role: 'assistant', stopReason: 'stop' }, { role: 'toolResult', stopReason: 'error' }] }, 'idle', /inaktiv/],
  ]) {
    const value = describeActivity(model(patch), { online: true }); assert.equal(value.state, state); assert.match(value.label, label);
  }
});

test('startup/offline/waiting priority and quota labels match existing activity policy without mutating the model', () => {
  const value = model({ quota: 'waiting', aborted: true });
  const before = structuredClone(value);
  assert.equal(describeActivity(value, { online: true }).state, 'waiting');
  const offline = describeActivity(value, { online: false }); assert.equal(offline.state, 'offline'); assert.match(offline.label, /offline.*dummy-kvot: waiting/);
  assert.deepEqual(describeActivity(value, { online: false, starting: 'Preparing' }), { state: 'working', label: 'Preparing · dummy-kvot: waiting' });
  assert.equal(describeActivity(value, { online: false, starting: 'Failed', startupFailed: true }).state, 'failed');
  assert.deepEqual(value, before);
});
