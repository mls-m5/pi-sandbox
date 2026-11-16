import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pairAgent } from '../web/pairing-client.js';
import { randomKey } from '../web/common.js';

const origin = 'http://127.0.0.1:1234';
const enrollment = () => ({
  clientId: randomUUID(),
  label: 'client',
  kind: 'dummy',
  previousToken: null,
});
const ticket = (overrides = {}) => ({
  id: randomUUID(),
  token: randomKey(),
  code: '07',
  expiresAt: Date.now() + 60_000,
  ...overrides,
});
const identity = (overrides = {}) => ({
  id: randomUUID(),
  token: randomKey(),
  kind: 'dummy',
  label: 'client',
  ...overrides,
});
const jsonResponse = (value, status = 201) => new Response(JSON.stringify(value), { status });
const redirectedResponse = (value) => ({
  status: 201,
  redirected: true,
  body: jsonResponse(value).body,
});

async function rejectsOnce(fetchImpl, options = {}) {
  let calls = 0,
    shown = [];
  await assert.rejects(
    pairAgent(origin, enrollment(), {
      ...options,
      fetchImpl: async (...args) => {
        calls++;
        return fetchImpl(...args);
      },
      onCode: (code) => shown.push(code),
    }),
  );
  return { calls, shown };
}

test('pairing client rejects malformed, oversized, invalid UTF-8 and unsafe create responses without showing a code', async () => {
  const malformed = new Response('{', { status: 201 });
  const invalidUtf8 = new Response(new Uint8Array([0xff, 0xfe]), { status: 201 });
  let oversizedCancelled = false;
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
      cancel() {
        oversizedCancelled = true;
      },
    }),
    { status: 201 },
  );
  const cases = [
    ['malformed JSON', malformed],
    ['invalid UTF-8', invalidUtf8],
    ['oversized response', oversized],
    ['unexpected status', jsonResponse(ticket(), 200)],
    ['redirected response', redirectedResponse(ticket())],
    ['invalid ticket identity', jsonResponse(ticket({ id: 'unsafe-id' }))],
  ];
  for (const [name, response] of cases) {
    const { calls, shown } = await rejectsOnce(() => response);
    assert.equal(calls, 1, `${name}: create is attempted once`);
    assert.deepEqual(shown, [], `${name}: no confirmation code is displayed`);
  }
  assert.equal(oversizedCancelled, true, 'oversized open response body is cancelled');
});

test('pairing client rejects unsafe approved identity without retrying collection', async () => {
  for (const bad of [
    identity({ id: 'unsafe/id' }),
    identity({ token: 'short' }),
    identity({ kind: 'pi' }),
    identity({ label: 'bad\u0000label' }),
    { ...identity(), extra: true },
  ]) {
    let calls = 0,
      shown = [];
    await assert.rejects(
      pairAgent(origin, enrollment(), {
        fetchImpl: async () => jsonResponse(calls++ === 0 ? ticket() : bad),
        onCode: (code) => shown.push(code),
      }),
    );
    assert.equal(calls, 2, 'an invalid collection result is never retried');
    assert.deepEqual(shown, ['07']);
  }
});

test('pairing client does not retry ambiguous framing, HTTP or network outcomes', async () => {
  const createFailures = [
    async () => {
      throw new Error('network unavailable');
    },
    async () => new Response('{', { status: 500 }),
    async () => redirectedResponse(ticket()),
  ];
  for (const fail of createFailures) {
    const { calls, shown } = await rejectsOnce(fail);
    assert.equal(calls, 1);
    assert.deepEqual(shown, []);
  }
});

test('pairing client makes one collection attempt after malformed claim framing', async () => {
  let calls = 0,
    shown = [];
  await assert.rejects(
    pairAgent(origin, enrollment(), {
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? jsonResponse(ticket()) : new Response('{', { status: 201 });
      },
      onCode: (code) => shown.push(code),
    }),
  );
  assert.equal(calls, 2, 'create once and collection once; no ambiguous outcome replay');
  assert.deepEqual(shown, ['07']);
});

test('pairing client cancellation during pending poll stops without another request', async () => {
  const controller = new AbortController();
  let calls = 0,
    shown = [];
  await assert.rejects(
    pairAgent(origin, enrollment(), {
      signal: controller.signal,
      intervalMs: 60_000,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(ticket());
        controller.abort();
        return jsonResponse({ pending: true }, 202);
      },
      onCode: (code) => shown.push(code),
    }),
  );
  assert.equal(calls, 2);
  assert.deepEqual(shown, ['07']);
});

test('pairing client cancels open HTTP failure bodies before rejecting without a retry', async () => {
  for (const status of [403, 409, 429, 500]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('synthetic failure'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status },
    );
    const { calls, shown } = await rejectsOnce(() => response);
    assert.equal(calls, 1);
    assert.deepEqual(shown, []);
    assert.equal(
      cancelled,
      true,
      `HTTP ${status} body must be cancelled even when status is rejected.`,
    );
  }
});

test('failed body cancellation releases its lock without exposing cleanup errors or losing conflict identity', async () => {
  for (const status of [409, 500]) {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          throw new Error('synthetic-secret-cleanup-detail');
        },
      }),
      { status },
    );
    let calls = 0;
    await assert.rejects(
      pairAgent(origin, enrollment(), {
        fetchImpl: async () => {
          calls++;
          return response;
        },
      }),
      (error) => {
        assert.ok(!error.message.includes('synthetic-secret-cleanup-detail'));
        if (status === 409) assert.equal(error.code, 'ENROLLMENT_CONFLICT');
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(response.body.locked, false);
  }
});

// The timer API keeps expiry validation deterministic without waiting on wall-clock time.
test('pairing client rejects already-expired and overlong TTLs at a fixed clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000 });
  for (const expiresAt of [50_000, 170_001]) {
    const { calls, shown } = await rejectsOnce(() => jsonResponse(ticket({ expiresAt })));
    assert.equal(calls, 1);
    assert.deepEqual(shown, []);
  }
});
