import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingCommands } from '../web/public/pending-commands.js';

function socket(send = () => {}) {
  return { bufferedAmount: 0, send };
}

test('pending browser commands match accepted traces and results to the originating agent', async () => {
  const commands = createPendingCommands();
  let sent;
  const promise = commands.send({ id: 'command-1', agentId: 'agent-1', payload: '{}', socket: socket((value) => (sent = value)) });
  assert.equal(sent, '{}');
  commands.accepted({ id: 'command-1', agentId: 'agent-2', trace: 'wrong-agent' });
  commands.accepted({ id: 'command-1', agentId: 'agent-1', trace: '0123456789ab' });
  commands.result({ agentId: 'agent-2', result: { id: 'command-1', data: { success: true } } });
  assert.equal(commands.size, 1);
  commands.result({ agentId: 'agent-1', trace: 'fedcba987654', result: { id: 'command-1', data: { success: true } } });
  const result = await promise;
  assert.equal(result.data.success, true);
  assert.equal(result.diagnosticTrace, 'fedcba987654');
  assert.equal(commands.size, 0);
  commands.result({ agentId: 'agent-1', result: { id: 'command-1', data: { success: false } } });
  assert.equal(commands.size, 0);
});

test('pending browser commands time out and clean up without replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = createPendingCommands();
  let sends = 0;
  const response = commands.send({ id: 'timeout', agentId: 'agent', payload: '{}', socket: socket(() => sends++) });
  commands.accepted({ id: 'timeout', agentId: 'agent', trace: '0123456789ab' });
  t.mock.timers.tick(39_999);
  assert.equal(commands.size, 1);
  t.mock.timers.tick(1);
  const result = await response;
  assert.equal(result.diagnosticTrace, '0123456789ab');
  assert.equal(result.data.error, 'outcome_unknown');
  assert.equal(commands.size, 0);
  commands.result({ agentId: 'agent', result: { id: 'timeout', data: { success: true } } });
  assert.equal(sends, 1);
  assert.equal(commands.size, 0);
});

test('pending browser commands enforce default pending and socket buffer boundaries', async () => {
  const commands = createPendingCommands();
  const transport = socket();
  transport.bufferedAmount = 128 * 1024;
  assert.equal(commands.isAvailable(transport), true);
  transport.bufferedAmount++;
  assert.equal(commands.isAvailable(transport), false);
  assert.equal((await commands.send({ id: 'busy', agentId: 'agent', payload: '{}', socket: transport })).data.error, 'not_connected_or_busy');
  assert.equal(commands.size, 0);
  transport.bufferedAmount = 0;
  const responses = [];
  for (let index = 0; index < 8; index++) {
    responses.push(commands.send({ id: `command-${index}`, agentId: 'agent', payload: '{}', socket: transport }));
  }
  assert.equal(commands.size, 8);
  assert.equal(commands.isAvailable(transport), false);
  commands.failAll();
  assert.equal(commands.isAvailable(transport), true);
  await Promise.all(responses);
});

test('pending browser commands handle admission, synchronous send failure and fail-all cleanup', async () => {
  const commands = createPendingCommands({ timeout: 10_000, maxPending: 1 });
  const first = commands.send({ id: 'first', agentId: 'agent', payload: '{}', socket: socket() });
  assert.deepEqual(await commands.send({ id: 'second', agentId: 'agent', payload: '{}', socket: socket() }), {
    data: { success: false, error: 'not_connected_or_busy' },
  });
  commands.accepted({ id: 'first', agentId: 'agent', trace: '0123456789ab' });
  commands.failAll();
  const interrupted = await first;
  assert.equal(interrupted.data.error, 'outcome_unknown');
  assert.equal(interrupted.diagnosticTrace, '0123456789ab');
  assert.equal(commands.size, 0);

  const sendFailure = createPendingCommands();
  const failure = await sendFailure.send({
    id: 'send-fail', agentId: 'agent', payload: '{}', socket: socket(() => { throw new Error('send'); }),
  });
  assert.equal(failure.data.error, 'outcome_unknown');
  assert.equal(sendFailure.size, 0);
});
