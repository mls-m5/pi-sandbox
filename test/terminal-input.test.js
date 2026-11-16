import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readTerminalLine, readPipedLine } from '../src/terminal-input.js';
import { readAdminPassword, readAgentKey } from '../web/secret-input.js';

function terminal(raw = false) {
  const input = new PassThrough(), output = new PassThrough(), modes = [];
  input.isTTY = output.isTTY = true; input.isRaw = raw;
  input.setRawMode = value => { modes.push(value); input.isRaw = value; };
  let text = ''; output.on('data', data => { text += data; });
  return { input, output, modes, text: () => text };
}
function listeners(input) {
  return { input: ['data', 'end', 'error'].map(name => input.listenerCount(name)), signals: ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => process.listenerCount(name)) };
}

test('shared terminal input hides secrets, decodes split UTF-8 and restores the previous terminal mode', async () => {
  const tty = terminal(true), before = listeners(tty.input);
  const pending = readTerminalLine({ ...tty, prompt: 'Secret: ' });
  const utf8 = Buffer.from('å💡');
  for (const byte of utf8) tty.input.write(Buffer.from([byte]));
  tty.input.write('\bsecret\r');
  assert.equal(await pending, 'åsecret'); assert.equal(tty.text(), 'Secret: \n');
  assert.deepEqual(tty.modes, [true, true]); assert.deepEqual(listeners(tty.input), before);
});

test('visible questions keep defaults, editing and echo separate from hidden secret policies', async () => {
  const tty = terminal();
  const visible = readTerminalLine({ ...tty, prompt: 'Name: ', hidden: false }); tty.input.write('ab\bc\n');
  assert.equal(await visible, 'ac'); assert.equal(tty.text(), 'Name: ab\b \bc\n');
  const next = readTerminalLine({ ...tty, prompt: 'Default: ', defaultValue: 'preset' }); tty.input.write('\r');
  assert.equal(await next, 'preset'); assert.deepEqual(tty.modes, [true, false, true, false]);
});

test('cancellation, EOF, stream errors and byte overflow always clean up without exposing typed content', async () => {
  const failures = [tty => tty.input.write('\x03'), tty => tty.input.write('\x04'), tty => tty.input.end(), tty => tty.input.emit('error', new Error('secret error')), () => process.emit('SIGTERM'), () => process.emit('SIGHUP'), () => process.emit('SIGINT'), tty => tty.input.write('x'.repeat(9))];
  for (const fail of failures) {
    const tty = terminal(), before = listeners(tty.input);
    const pending = readTerminalLine({ ...tty, prompt: 'Hidden: ', maxBytes: 8 });
    tty.input.write('secret'); fail(tty);
    await assert.rejects(pending);
    assert.equal(tty.text(), 'Hidden: \n'); assert.deepEqual(listeners(tty.input), before); assert.deepEqual(tty.modes, [true, false]);
  }
});

test('admin empty/EOF behavior and agent exact-key validation remain distinct', async () => {
  const tty = terminal(); const empty = readAdminPassword(tty); tty.input.write('\r'); assert.equal(await empty, '');
  const eof = new PassThrough(); eof.end(); assert.equal(await readAdminPassword({ piped: true, input: eof }), '');
  const multiple = new PassThrough(); multiple.end('first\nsecond\n'); await assert.rejects(readAdminPassword({ piped: true, input: multiple }), /one password line/);
  const agent = terminal(), missing = readAgentKey(agent); agent.input.write('\r'); await assert.rejects(missing, /43-character/);
  const controls = terminal(), invalid = readAgentKey(controls); controls.input.write('x'.repeat(42) + '\t\r'); await assert.rejects(invalid, /43-character/);
  const nonTTY = new PassThrough(); await assert.rejects(readAdminPassword({ input: nonTTY, output: nonTTY }), /terminal/);
});

test('piped line reader preserves split Unicode, bounds raw bytes and removes only one final newline', async () => {
  async function* chunks() { for (const byte of Buffer.from('å💡\r\n')) yield Buffer.from([byte]); }
  assert.equal(await readPipedLine({ input: chunks(), maxBytes: 8 }), 'å💡');
  await assert.rejects(readPipedLine({ input: chunks(), maxBytes: 5, limitError: 'bounded' }), /bounded/);
  const double = new PassThrough(); double.end('text\n\n'); await assert.rejects(readPipedLine({ input: double, maxBytes: 100, lineError: 'one line' }), /one line/);
});
