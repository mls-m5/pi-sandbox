import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readDefaultServer,
  saveDefaultServer,
  readAgentProfile,
  saveAgentProfile,
} from '../web/agent-profile.js';
import { randomKey } from '../web/common.js';

function privateRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-client-preference-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const origin = 'http://127.0.0.1:43128';
const preference = (root) => path.join(root, 'web-client.json');

test('default server preference accepts exactly 8192 bytes and rejects 8193 bytes', (t) => {
  const root = privateRoot(t),
    file = preference(root);
  const json = JSON.stringify({ origin });
  const exact = `${json}${' '.repeat(8192 - Buffer.byteLength(json))}`;
  assert.equal(Buffer.byteLength(exact), 8192);
  fs.writeFileSync(file, exact, { mode: 0o600 });
  assert.equal(readDefaultServer(root), origin);
  fs.writeFileSync(file, `${exact} `, { mode: 0o600 });
  assert.equal(fs.statSync(file).size, 8193);
  assert.throws(() => readDefaultServer(root), /Invalid or unsafe client preference/);
});

test('default server preference reports invalid schemas and origins without echoing values', (t) => {
  const root = privateRoot(t),
    file = preference(root);
  const cases = [
    ['malformed JSON', '{"origin":', 'Invalid or unsafe client preference'],
    [
      'unknown schema',
      JSON.stringify({ origin, token: 'synthetic-secret-value' }),
      'Invalid default server preference',
    ],
    [
      'credential-bearing origin',
      JSON.stringify({ origin: 'http://synthetic-user:synthetic-password@127.0.0.1:43128' }),
      'Invalid server address',
    ],
  ];
  for (const [label, contents, expected] of cases) {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    assert.throws(
      () => readDefaultServer(root),
      (error) => {
        assert.match(error.message, new RegExp(expected));
        assert.ok(!error.message.includes('synthetic-secret-value'));
        assert.ok(!error.message.includes('synthetic-user'));
        assert.ok(!error.message.includes('synthetic-password'));
        return true;
      },
      label,
    );
  }
});

test('default server preference refuses symlink and nonprivate root directories for reads and writes', async (t) => {
  const base = privateRoot(t),
    target = path.join(base, 'target'),
    linked = path.join(base, 'linked');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, linked);
  assert.throws(() => readDefaultServer(linked));
  await assert.rejects(saveDefaultServer(linked, origin));

  const publicRoot = path.join(base, 'public');
  fs.mkdirSync(publicRoot, { mode: 0o755 });
  fs.chmodSync(publicRoot, 0o755);
  assert.throws(() => readDefaultServer(publicRoot));
  await assert.rejects(saveDefaultServer(publicRoot, origin));
  assert.deepEqual(fs.readdirSync(publicRoot), []);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('directory-valued preference is rejected without modifying its contents', async (t) => {
  const root = privateRoot(t),
    file = preference(root),
    child = path.join(file, 'keep');
  fs.mkdirSync(file, { mode: 0o700 });
  fs.writeFileSync(child, 'synthetic fixture');
  assert.throws(() => readDefaultServer(root));
  await assert.rejects(saveDefaultServer(root, origin));
  assert.equal(fs.readFileSync(child, 'utf8'), 'synthetic fixture');
  assert.deepEqual(fs.readdirSync(root), ['web-client.json']);
});

test('concurrent explicit saves fail fast on contention and leave one complete private preference', async (t) => {
  const root = privateRoot(t);
  const origins = Array.from({ length: 12 }, (_, index) => `http://127.0.0.1:${43128 + index}`);
  const results = await Promise.allSettled(origins.map((value) => saveDefaultServer(root, value)));
  const winners = origins.filter((_value, index) => results[index].status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const result of results)
    if (result.status === 'rejected') assert.equal(result.reason.code, 'PIS_LOCKED');
  assert.equal(readDefaultServer(root), winners[0]);
  assert.deepEqual(fs.readdirSync(root), ['web-client.json']);
  assert.equal(fs.statSync(preference(root)).mode & 0o777, 0o600);
  await saveDefaultServer(root, origin);
  assert.equal(
    readDefaultServer(root),
    origin,
    'The winner releases its own lock for later explicit saves.',
  );
});

test('saving the preference has no registration side effect or collision with an agent profile name', async (t) => {
  const root = privateRoot(t);
  await saveDefaultServer(root, origin);
  const profile = {
    version: 1,
    origin,
    token: randomKey(),
    agentId: 'synthetic-agent',
    kind: 'dummy',
    projectId: null,
  };
  await saveAgentProfile(root, 'web-client', profile);
  assert.equal(readDefaultServer(root), origin);
  assert.deepEqual(readAgentProfile(root, 'web-client'), profile);
  assert.deepEqual(fs.readdirSync(root).sort(), ['web-agents', 'web-client.json']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'web-agents')), ['web-client.json']);
});
