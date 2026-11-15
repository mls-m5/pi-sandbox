import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../web/diagnostics.js';
import { diagnosticLine, requestFailure, resultCode } from '../web/public/diagnostics.js';

test('diagnostics serialize only allowlisted metadata, never arbitrary errors, identities, payloads or credentials', () => {
  const secret = 'PRIVATE_MESSAGE_AND_CREDENTIAL';
  const output = [], log = createDiagnostics({ enabled: true, write: line => output.push(line), now: () => 123 });
  log({ component: 'server', event: 'command_result', action: 'state', trace: '12345678-1234-1234-1234-123456789abc', code: 'rpc_unavailable', durationMs: 42, stable: false,
    password: secret, token: secret, headers: { authorization: secret }, prompt: secret, history: secret, error: new Error(secret), agentId: secret, sessionId: secret });
  assert.equal(output.length, 1);
  const record = JSON.parse(output[0].slice('pis web diagnostic: '.length));
  assert.deepEqual(record, { at: 123, component: 'server', event: 'command_result', action: 'state', code: 'rpc_unavailable', trace: '123456781234', durationMs: 42, stable: false });
  log({ component: 'connector', event: 'rpc_fault', action: secret, code: secret, trace: secret });
  assert.ok(!output.join('').includes(secret));
  assert.match(output[1], /unknown_error/);
  log({ component: secret, event: 'command_result', code: secret });
  log({ component: 'server', event: secret });
  assert.equal(output.length, 2);
  assert.doesNotThrow(() => createDiagnostics({ enabled: true, write() { throw new Error('sink failed'); } })({ component: 'server', event: 'rpc_fault' }));
});

test('diagnostics are off by default and bounded to 120 records per minute plus one limit notice', () => {
  const output = []; let now = 1;
  createDiagnostics({ write: line => output.push(line) })({ component: 'server', event: 'command_result' });
  assert.deepEqual(output, []);
  const log = createDiagnostics({ enabled: true, write: line => output.push(line), now: () => now });
  for (let i = 0; i < 500; i++) log({ component: 'server', event: 'command_result' });
  assert.equal(output.length, 121);
  assert.equal(output.filter(line => line.includes('diagnostics_limited')).length, 1);
  now = 60_002; log({ component: 'server', event: 'command_result' });
  assert.equal(output.length, 122);
});

test('browser error details use fixed codes/references and never echo raw agent error text', () => {
  const result = { diagnosticTrace: '123456781234', data: { success: false, error: 'rpc_unavailable' } };
  assert.match(requestFailure('state', result), /kod=rpc_unavailable.*ref=123456781234/);
  assert.match(requestFailure('history', result), /historiken/);
  const hostile = { diagnosticTrace: 'RAW_PRIVATE_TOKEN', data: { success: false, error: 'RAW_PRIVATE_ERROR' } };
  assert.doesNotMatch(requestFailure('state', hostile), /RAW_PRIVATE/);
  assert.doesNotMatch(diagnosticLine('RAW_PRIVATE_ACTION', hostile), /RAW_PRIVATE/);
  assert.equal(resultCode({ data: { duplicate: true } }), 'duplicate');
});
