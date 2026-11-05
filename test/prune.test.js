import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneCandidates, pruneImages, schedulePrune } from '../src/prune.js';
import { Store } from '../src/store.js';
import { imagePlan } from '../src/container.js';
import { parse } from '../src/cli.js';

const DAY = 86400000;
const now = 20 * DAY;
const tag = (n, id = 'abc12') => `localhost/pis-${id}:${String(n).padStart(20, '0')}`;
const image = (n, days, extra = {}) => ({ Id: `id-${n}`, Names: [tag(n)], Created: (now - days * DAY) / 1000, Containers: 0, ...extra });

test('prune CLI accepts dry run only with prune and without a project', () => {
  assert.equal(parse(['--prune']).action, 'prune');
  assert.equal(parse(['--dry-run', '--prune']).dryRun, true);
  for (const args of [['--dry-run'], ['--prune', '--project', 'abc12'], ['--prune', '--fresh'], ['--prune', '--dry-run', '--dry-run']]) assert.throws(() => parse(args));
});

test('automatic scheduling can be disabled explicitly', () => {
  const previous = process.env.PIS_AUTO_PRUNE;
  process.env.PIS_AUTO_PRUNE = '0';
  try { assert.doesNotThrow(() => schedulePrune(undefined)); }
  finally { if (previous === undefined) delete process.env.PIS_AUTO_PRUNE; else process.env.PIS_AUTO_PRUNE = previous; }
});

test('image selection preserves current, previous, recent, used, shared and foreign images', () => {
  const images = [image(1, 8), image(2, 7), image(3, 6), image(4, 5, { Containers: 1 }),
    image(5, 4, { Names: [tag(5), 'localhost/other:latest'] }), image(6, 0.5), image(7, 2),
    image(8, 9, { Names: [] }), image(9, 9, { Names: ['localhost/pis-abc12:latest'] }),
    image(10, 9, { Names: [tag(10, 'other')] }), image(11, 9, { Containers: undefined }),
    image(12, 9, { Created: NaN })];
  assert.deepEqual(pruneCandidates(images, 'abc12', tag(3), now).map(x => x.tag).sort(), [tag(1), tag(2), tag(7)].sort());
  // Configured image is not built yet: retain the two most recent existing versions.
  assert.deepEqual(pruneCandidates([image(1, 8), image(2, 7), image(3, 6)], 'abc12', tag(99), now).map(x => x.tag), [tag(1)]);
  assert.deepEqual(pruneCandidates([image(1, 8, { Names: [tag(1), tag(1, 'other')] })], 'abc12', tag(2), now), []);
  // Multiple tags for the same image do not count as two rollback versions.
  assert.deepEqual(pruneCandidates([image(1, 1, { Names: [tag(1), tag(2)] }), image(3, 3), image(4, 4)], 'abc12', tag(1), now).map(x => x.tag), [tag(4)]);
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-prune-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(dir, 'store'));
  const config = await store.register(root);
  const current = imagePlan(config).image;
  const prefix = `localhost/pis-${config.id}:`;
  const older = n => `${prefix}${String(n).padStart(20, '0')}`;
  const images = [
    { Id: 'current', Names: [current], Created: now / 1000, Containers: 0 },
    { Id: 'previous', Names: [older(2)], Created: (now - 2 * DAY) / 1000, Containers: 0 },
    { Id: 'old', Names: [older(1)], Created: (now - 5 * DAY) / 1000, Containers: 0 },
  ];
  return { store, config, images, oldTag: older(1) };
}

test('dry run never removes images; removal uses only explicit tags without force or parent pruning', async t => {
  const { store, images, oldTag } = await fixture(t);
  const calls = [];
  const runPodman = async args => { calls.push(args); return args[0] === 'images' ? JSON.stringify(images) : ''; };
  const draft = await pruneImages(store, { dryRun: true, runPodman, now });
  assert.deepEqual(draft.candidates, [oldTag]);
  assert.deepEqual(draft.removed, []);
  assert.ok(calls.every(args => args[0] === 'images'));
  const result = await pruneImages(store, { runPodman, now });
  assert.deepEqual(result.removed, [oldTag]);
  assert.deepEqual(calls.filter(args => args[0] === 'rmi'), [['rmi', '--no-prune', oldTag]]);
});

test('busy projects are skipped and automatic cleanup is throttled only after a complete pass', async t => {
  const { store, config, images } = await fixture(t);
  const runPodman = async args => args[0] === 'images' ? JSON.stringify(images) : '';
  await store.projectLock(config.id, async () => {
    const result = await pruneImages(store, { automatic: true, runPodman, now });
    assert.deepEqual(result.skipped, [config.id]);
    assert.ok(!fs.existsSync(path.join(store.root, 'prune-last-run.json')));
  });
  await pruneImages(store, { automatic: true, runPodman, now });
  const result = await pruneImages(store, { automatic: true, runPodman: () => { throw new Error('must not execute'); }, now: now + 1000 });
  assert.equal(result.throttled, true);
});

test('images newly used or retagged since planning are skipped', async t => {
  const { store, images, oldTag } = await fixture(t);
  let reads = 0;
  const runPodman = async args => {
    assert.equal(args[0], 'images');
    reads++;
    return JSON.stringify(reads === 1 ? images : images.map(x => x.Id === 'old' ? { ...x, Containers: 1 } : x));
  };
  const result = await pruneImages(store, { runPodman, now });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, [oldTag]);
});

test('Podman failures do not trigger forced deletion or record successful automatic cleanup', async t => {
  const { store, images, oldTag } = await fixture(t);
  const result = await pruneImages(store, { automatic: true, now, runPodman: async args => {
    if (args[0] === 'images') return JSON.stringify(images);
    assert.deepEqual(args, ['rmi', '--no-prune', oldTag]);
    throw new Error('image in use');
  } });
  assert.deepEqual(result.failed, [oldTag]);
  assert.deepEqual(result.removed, []);
  assert.ok(!fs.existsSync(path.join(store.root, 'prune-last-run.json')));
});
