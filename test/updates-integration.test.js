import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { prepareUpdates, readUpdateState, selectUpdateImage, updatePodman } from '../src/updates.js';

// Opt-in: downloads public npm metadata/artifacts, builds a credential-free image
// and runs the real candidate with local fake upstreams in --network=none.
// Never mounts project/state/auth and never performs a live model request.
test('real rootless Podman: verified npm candidate, isolated probe and next-launch activation', {
  skip: process.env.PIS_INTEGRATION !== '1', timeout: 1_400_000,
}, async t => {
  const base = fs.mkdtempSync('/tmp/pis-updates-integration-');
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const original = await store.register(root), config = structuredClone(original);
  config.credentials = { env: [] };
  config.updates = { enabled: true, includePinnedExtensions: false };
  config.image.packages = [];
  await store.save(config, original);
  t.after(() => {
    const state = readUpdateState(store, config.id);
    const tags = new Set([state?.candidate?.stagingImage, state?.candidate?.image, state?.active?.image, state?.previous?.image].filter(Boolean));
    for (const tag of tags) spawnSync('podman', ['rmi', '--no-prune', tag], { stdio: 'ignore', timeout: 30000 });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const result = await prepareUpdates(store, config.id, { force: true });
  assert.equal(result.prepared, true, `Candidate failed in phase: ${result.failed}`);
  const ready = readUpdateState(store, config.id);
  assert.equal(ready.active.baseline, true);
  assert.ok(ready.candidate.stagingImage);
  const plan = await store.projectLock(config.id, () => selectUpdateImage(store, config, { notify: () => {} }));
  assert.equal(plan.image, ready.candidate.image);
  assert.equal(await updatePodman(['image', 'inspect', '--format', '{{.Id}}', plan.image]), ready.candidate.imageId);
  assert.equal(readUpdateState(store, config.id).candidate, null);
  assert.equal(fs.existsSync(path.join(store.projectDir(config.id), 'update-backup/backup.json')), true);
});
