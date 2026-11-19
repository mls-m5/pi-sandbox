import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = name => { const p = path.join(dir, name); fs.mkdirSync(p); return p; };
  return { store: new Store(path.join(dir, 'store')), make, dir };
}

test('--new --from copies reusable settings only, by id or name, and leaves the source untouched', async t => {
  const { store, make, dir } = setup(t);
  const shared = make('shared');
  const old = await store.register(make('old'), 'old-app');
  await store.save({ ...store.load(old.id), agent: 'claude', image: { packages: ['jq', 'python3'], extraInstructions: ['RUN echo hi'] }, mounts: [{ source: shared, access: 'read-only' }], updates: { enabled: true, includePinnedExtensions: false } }, store.load(old.id));
  fs.mkdirSync(path.join(store.projectDir(old.id), 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.projectDir(old.id), 'state', 'session.jsonl'), 'private');
  const before = fs.readFileSync(store.configPath(old.id), 'utf8');

  for (const selector of [old.id, 'old-app']) {
    const copy = await store.register(make(`new-${selector}`), `copy-${selector}`, selector);
    const config = store.load(copy.id);
    assert.notEqual(copy.id, old.id);
    assert.equal(config.name, `copy-${selector}`);
    assert.equal(config.root, fs.realpathSync(path.join(dir, `new-${selector}`)));
    assert.equal(config.agent, 'claude');
    assert.deepEqual(config.image, { packages: ['jq', 'python3'], extraInstructions: ['RUN echo hi'] });
    assert.deepEqual(config.mounts, [{ source: shared, access: 'read-only' }]);
    assert.equal(config.updates.enabled, true);
    assert.ok(!fs.existsSync(path.join(store.projectDir(copy.id), 'state', 'session.jsonl')));
  }
  assert.equal(fs.readFileSync(store.configPath(old.id), 'utf8'), before);
});

test('--new --from rejects unknown templates without registering, and only parses with --new', async t => {
  const { store, make } = setup(t);
  const target = make('target');
  await assert.rejects(store.register(target, 'x', 'nope'), /Unknown template/);
  assert.equal(store.all().length, 0);
  assert.equal(parse(['--new', '--from', 'old', '--name', 'n']).from, 'old');
  assert.throws(() => parse(['--from', 'old']), /only valid with --new/);
  assert.throws(() => parse(['--new', '--from']), /requires a value/);
});
