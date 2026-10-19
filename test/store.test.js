import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { validate } from '../src/config.js';
import { splitCommand, withLock } from '../src/util.js';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project with spaces');
  fs.mkdirSync(root);
  return { base, root, store: new Store(path.join(base, 'storage')) };
}

test('explicit registration, ancestor discovery, names, and nested projects', async t => {
  const { base, root, store } = fixture(t);
  assert.throws(() => store.select(root), /pis --new/);
  const p = await store.register(root, 'my-app');
  assert.match(p.id, /^[a-z0-9]{5}$/);
  const sub = path.join(root, 'src'); fs.mkdirSync(sub);
  assert.equal(store.select(sub).id, p.id);
  assert.equal(store.select(base, 'my-app').id, p.id);
  assert.equal(store.select(base, p.id).id, p.id);
  const sibling = `${root}-other`; fs.mkdirSync(sibling);
  assert.throws(() => store.select(sibling), /No pis project/);
  const nested = await store.register(sub);
  assert.equal(store.select(sub).id, nested.id);
  assert.equal(store.select(root).id, p.id);
  await assert.rejects(store.register(root), /already registered/);
  await assert.rejects(store.register(sibling, 'my-app'), /conflicts/);
  await assert.rejects(store.register(sibling, p.id), /conflicts/);
  fs.unlinkSync(path.join(store.root, 'index.json'));
  assert.equal(store.select(root).id, p.id);
});

test('canonical registration, validation and protected identity', async t => {
  const { base, root, store } = fixture(t);
  const link = path.join(base, 'link'); fs.symlinkSync(root, link);
  const p = await store.register(link);
  assert.equal(p.root, root);
  await assert.rejects(store.register(root), /already registered/);
  const bad = structuredClone(p); bad.id = 'abcde';
  await assert.rejects(store.save(bad, p), /Do not edit/);
  bad.id = p.id; bad.unknown = true;
  assert.throws(() => validate(bad), /Unknown field/);
  assert.deepEqual(store.load(p.id), p);
  assert.equal(fs.statSync(store.projectDir(p.id)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.configPath(p.id)).mode & 0o777, 0o600);
});

test('extra mounts are explicit, canonical, disjoint, and narrow', async t => {
  const { base, root, store } = fixture(t);
  const p = await store.register(root);
  const shared = path.join(base, 'shared'); fs.mkdirSync(shared);
  p.mounts.push({ source: shared });
  validate(p, { storage: store.root });
  p.mounts.push({ source: shared });
  assert.throws(() => validate(p, { storage: store.root }), /overlap/);
  p.mounts = [{ source: root }];
  assert.throws(() => validate(p, { storage: store.root }), /overlap/);
  for (const source of [os.homedir(), '/', '/etc', store.root, '/usr/bin']) {
    p.mounts = [{ source }];
    assert.throws(() => validate(p, { storage: store.root }));
  }
  p.mounts = [{ source: shared, access: 'everything' }];
  assert.throws(() => validate(p), /access/);
});

test('package/build/env validation rejects injection and examples stay inert', async t => {
  const { root, store } = fixture(t);
  const p = await store.register(root);
  validate(p, { storage: store.root }); // Nonexistent example paths are fine.
  for (const pkg of ['python3; touch /tmp/pwn', '--help', 'foo\nRUN evil']) {
    p.image.packages = [pkg];
    assert.throws(() => validate(p), /Invalid apt package/);
  }
  p.image.packages = ['python3', 'g++', 'make=4.3-1'];
  for (const instruction of ['FROM evil', 'RUN true\nRUN false', 'RUN echo x \\', 'RUN --mount=type=bind true']) {
    p.image.extraInstructions = [instruction];
    assert.throws(() => validate(p), /extraInstructions/);
  }
  p.image.extraInstructions = ['RUN npm install -g typescript'];
  p.credentials.env = ['HOME'];
  assert.throws(() => validate(p), /Reserved environment/);
});

test('relocation retains identity/state and checks conflicts', async t => {
  const { base, root, store } = fixture(t);
  const p = await store.register(root);
  const state = path.join(store.projectDir(p.id), 'state', 'marker'); fs.writeFileSync(state, 'keep');
  const moved = path.join(base, 'moved'); fs.renameSync(root, moved);
  const updated = await store.relocate(p.id, moved);
  assert.equal(updated.id, p.id);
  assert.equal(updated.root, moved);
  assert.equal(fs.readFileSync(state, 'utf8'), 'keep');
  const other = path.join(base, 'other'); fs.mkdirSync(other);
  await store.register(other);
  await assert.rejects(store.relocate(p.id, other), /Duplicate registered root/);
});

test('locks exclude competitors and release after failure; edits detect conflicts', async t => {
  const { root, store } = fixture(t);
  await store.lock(async () => {
    await assert.rejects(store.lock(async () => {}), /busy/);
  });
  await assert.rejects(store.lock(async () => { throw new Error('failure'); }), /failure/);
  await store.lock(async () => {});
  const p = await store.register(root);
  await store.save({ ...p, name: 'updated' }, p);
  await assert.rejects(store.save({ ...p, name: 'stale' }, p), /changed while editing/);
  assert.equal(store.load(p.id).name, 'updated');
  const file = path.join(store.root, 'lock-test');
  await withLock(file, async () => assert.ok(fs.existsSync(file)));
  assert.ok(!fs.existsSync(file));
});

test('editor command parsing supports quotes without executing shell syntax', () => {
  assert.deepEqual(splitCommand('vim -f'), ['vim', '-f']);
  assert.deepEqual(splitCommand('"/path with spaces/vim" -f'), ['/path with spaces/vim', '-f']);
  assert.deepEqual(splitCommand('vim "$(touch bad)"'), ['vim', '$(touch bad)']);
  assert.throws(() => splitCommand('vim "'), /quoting/);
});
