import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { readAgentProfile, saveAgentProfile, forgetAgentProfile, localServerOrigin, validateAgentProfile, identifyAgent } from '../web/agent-profile.js';
import { readAgentKey } from '../web/secret-input.js';
import { randomKey } from '../web/common.js';

function fixture(t) {
  const root = fs.mkdtempSync('/tmp/pis-agent-profile-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, record: { version: 1, origin: 'http://127.0.0.1:43128', token: randomKey(), agentId: 'test-agent', kind: 'dummy', projectId: null } };
}
test('agent keys persist only in private host profiles, require explicit replacement and can be forgotten', async t => {
  const { root, record } = fixture(t);
  assert.equal(readAgentProfile(root, 'test'), undefined);
  await saveAgentProfile(root, 'test', record);
  const directory = path.join(root, 'web-agents'), file = path.join(directory, 'test.json');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readAgentProfile(root, 'test'), record);
  const replacement = { ...record, token: randomKey() };
  await assert.rejects(saveAgentProfile(root, 'test', replacement), /exists/);
  assert.equal(readAgentProfile(root, 'test').token, record.token);
  await saveAgentProfile(root, 'test', replacement, { replace: true });
  assert.equal(readAgentProfile(root, 'test').token, replacement.token);
  await forgetAgentProfile(root, 'test'); assert.equal(readAgentProfile(root, 'test'), undefined);
});
test('agent profiles reject symlinks, hardlinks, nonprivate files/directories, FIFOs and malformed or large records', async t => {
  const { root, record } = fixture(t);
  await saveAgentProfile(root, 'test', record);
  const directory = path.join(root, 'web-agents'), file = path.join(directory, 'test.json'), original = path.join(root, 'original');
  fs.renameSync(file, original); fs.symlinkSync(original, file);
  assert.throws(() => readAgentProfile(root, 'test')); await assert.rejects(saveAgentProfile(root, 'test', record, { replace: true }));
  fs.unlinkSync(file); fs.linkSync(original, file); assert.throws(() => readAgentProfile(root, 'test')); fs.unlinkSync(file);
  assert.equal(spawnSync('mkfifo', [file]).status, 0); assert.throws(() => readAgentProfile(root, 'test')); fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o644 }); assert.throws(() => readAgentProfile(root, 'test')); fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, 'x'.repeat(9000)); assert.throws(() => readAgentProfile(root, 'test'));
  fs.chmodSync(directory, 0o755); assert.throws(() => readAgentProfile(root, 'test')); fs.chmodSync(directory, 0o700);
  fs.rmSync(directory, { recursive: true }); fs.symlinkSync(root, directory); assert.throws(() => readAgentProfile(root, 'test'));
});
test('local profile validation cannot select remote URLs, arbitrary projects/executables or extra credentials', t => {
  const { record } = fixture(t);
  for (const origin of ['http://localhost:43128', 'https://127.0.0.1:43128', 'http://192.168.1.1:43128', 'http://user:secret@127.0.0.1:43128', 'http://127.0.0.1:43128?token=secret', 'http://127.0.0.1:43128/path']) assert.throws(() => localServerOrigin(origin));
  assert.equal(localServerOrigin('http://127.0.0.1:43128/'), record.origin);
  for (const patch of [{ token: 'invalid' }, { executable: 'bash' }, { kind: 'pi', projectId: '/tmp/work' }, { kind: 'claude' }, { projectId: 'abc12' }]) assert.throws(() => validateAgentProfile({ ...record, ...patch }));
  assert.doesNotThrow(() => validateAgentProfile({ ...record, kind: 'pi', projectId: 'abc12' }));
  assert.throws(() => readAgentProfile('/tmp', '../escape'));
});
test('agent identity preflight sends key only to fixed loopback endpoint with no redirect/cookies and bounds response', async () => {
  const token = randomKey();
  const value = await identifyAgent('http://127.0.0.1:43128', token, { fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:43128/agent/identity'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${token}` });
    return new Response(JSON.stringify({ id: 'agent-1', kind: 'pi' }));
  } });
  assert.deepEqual(value, { id: 'agent-1', kind: 'pi' });
  for (const response of [new Response('{}', { status: 403 }), new Response('x'.repeat(1025)), new Response(JSON.stringify({ id: 'agent-1', kind: 'pi', token }))]) await assert.rejects(identifyAgent('http://127.0.0.1:43128', token, { fetchImpl: async () => response }), /not accepted/);
});
test('agent key entry is bounded, hidden and cancellation saves nothing', async () => {
  const token = randomKey(), input = new PassThrough(); input.end(`${token}\n`);
  assert.equal(await readAgentKey({ piped: true, input }), token);
  const bad = new PassThrough(); bad.end('x'.repeat(100)); await assert.rejects(readAgentKey({ piped: true, input: bad }));
  const blankLine = new PassThrough(); blankLine.end(`${token}\n\n`); await assert.rejects(readAgentKey({ piped: true, input: blankLine }));
  const terminal = new PassThrough(), output = new PassThrough(); terminal.isTTY = output.isTTY = true;
  const raw = []; terminal.setRawMode = value => raw.push(value);
  let shown = ''; output.on('data', value => { shown += value; });
  const pending = readAgentKey({ input: terminal, output }); terminal.write(`${token}\r`);
  assert.equal(await pending, token); assert.ok(!shown.includes(token)); assert.deepEqual(raw, [true, false]);
  const aborted = readAgentKey({ input: terminal, output }); terminal.write('\x03'); await assert.rejects(aborted, /cancelled/);
});
