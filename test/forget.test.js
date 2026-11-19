import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { forgetProject } from '../src/forget.js';
import { parse } from '../src/cli.js';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-forget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = name => { const p = path.join(dir, name); fs.mkdirSync(p); return p; };
  const store = new Store(path.join(dir, 'store'));
  const keepRoot = make('keep'), goneRoot = make('gone');
  fs.writeFileSync(path.join(goneRoot, 'source.txt'), 'my code');
  const keep = await store.register(keepRoot, 'keep-app');
  const gone = await store.register(goneRoot, 'gone-app');
  fs.mkdirSync(path.join(store.projectDir(gone.id), 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.projectDir(gone.id), 'state', 'session.jsonl'), 'private');
  return { dir, store, keep, gone, goneRoot };
}
const yes = async () => true;
const none = () => [];
const noPodman = async () => { throw new Error('no podman'); };

test('forget removes only that project registration and state, never the source folder or other projects', async t => {
  const { store, keep, gone, goneRoot } = await setup(t);
  let summary;
  for (const selector of [gone.name]) {
    const result = await forgetProject(store, selector, { confirm: async s => { summary = s; return true; }, containers: none, runPodman: noPodman });
    assert.equal(result.id, gone.id);
  }
  assert.equal(summary.id, gone.id);
  assert.equal(summary.root, gone.root);
  assert.ok(!fs.existsSync(store.projectDir(gone.id)));
  assert.deepEqual(store.all().map(p => p.id), [keep.id]);
  assert.equal(fs.readFileSync(path.join(goneRoot, 'source.txt'), 'utf8'), 'my code');
  assert.ok(fs.existsSync(store.configPath(keep.id)));
  assert.deepEqual(fs.readdirSync(store.projectsDir).sort(), [keep.id]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.root, 'index.json'), 'utf8')).projects.map(p => p.id), [keep.id]);
  await assert.rejects(forgetProject(store, gone.id, { confirm: yes, containers: none, runPodman: noPodman }), /Unknown project/);
  // The same directory can be registered again afterwards.
  assert.ok(await store.register(goneRoot, 'again'));
});

test('forget refuses declined confirmation, running containers, update maintenance locks and unsafe storage', async t => {
  const { store, gone } = await setup(t);
  const stays = () => assert.ok(fs.existsSync(path.join(store.projectDir(gone.id), 'state', 'session.jsonl')));
  await assert.rejects(forgetProject(store, gone.id, { confirm: async () => false, containers: none, runPodman: noPodman }), /Cancelled/);
  stays();
  await assert.rejects(forgetProject(store, gone.id, { confirm: yes, containers: () => [`pis-${gone.id}-abc`], runPodman: noPodman }), /has containers/);
  stays();
  await assert.rejects(forgetProject(store, gone.id, { confirm: yes, containers: () => { throw new Error('Cannot verify local rootless Podman; project lock was kept.'); }, runPodman: noPodman }), /Cannot verify/);
  stays();
  fs.writeFileSync(path.join(store.projectDir(gone.id), 'updates.lock'), '{}');
  await assert.rejects(forgetProject(store, gone.id, { confirm: yes, containers: none, runPodman: noPodman }), /Update maintenance/);
  stays();
  fs.rmSync(path.join(store.projectDir(gone.id), 'updates.lock'));
  assert.ok(!fs.existsSync(path.join(store.projectDir(gone.id), 'project.lock'))); // locks are released after refusals
  await assert.rejects(forgetProject(store, ''), /required/);
});

test('forget untags only its own image tags without force, counting failures and tolerating missing Podman', async t => {
  const { store, gone, keep } = await setup(t);
  const hex = 'a'.repeat(20), other = 'b'.repeat(20), third = 'c'.repeat(20);
  const calls = [];
  const runPodman = async args => {
    calls.push(args);
    if (args[0] === 'images') return JSON.stringify([
      { Id: '1', Names: [`localhost/pis-${gone.id}:${hex}`, `localhost/pis-${keep.id}:${hex}`] },
      { Id: '2', Names: [`localhost/pis-${gone.id}:${other}`] },
      { Id: '3', Names: [`localhost/pis-${keep.id}:${third}`, 'docker.io/library/node:22'] },
      { Id: '4', Names: [`localhost/pis-${gone.id}:latest`, `localhost/pis-${gone.id}-update:${hex}`] },
    ]);
    if (args.at(-1) === `localhost/pis-${gone.id}:${other}`) throw new Error('in use');
  };
  const result = await forgetProject(store, gone.id, { confirm: yes, containers: none, runPodman });
  assert.deepEqual(result.images, { removed: [`localhost/pis-${gone.id}:${hex}`], failed: [`localhost/pis-${gone.id}:${other}`], checked: true });
  const removals = calls.filter(args => args[0] === 'rmi');
  assert.deepEqual(removals.map(args => args.slice(0, 2)), [['rmi', '--no-prune'], ['rmi', '--no-prune']]);
  assert.ok(!calls.flat().includes('--force') && !calls.flat().includes('-f'));
  assert.ok(!calls.flat().some(arg => arg.includes(keep.id) || arg.includes('node:22')));
  assert.equal(store.all().length, 1);
  const missing = await forgetProject(store, keep.id, { confirm: yes, containers: none, runPodman: noPodman });
  assert.equal(missing.images.checked, false);
  assert.equal(store.all().length, 0);
});

test('forget refuses symlinked project storage and --forget parses as an exclusive management action', async t => {
  const { dir, store, gone } = await setup(t);
  const real = path.join(dir, 'elsewhere'); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'precious'), 'x');
  const target = store.projectDir(gone.id);
  fs.cpSync(target, path.join(real, 'copy'), { recursive: true });
  fs.rmSync(target, { recursive: true });
  fs.symlinkSync(path.join(real, 'copy'), target);
  await assert.rejects(forgetProject(store, gone.id, { confirm: yes, containers: none, runPodman: noPodman }), /Unknown project|not an ordinary directory/);
  assert.ok(fs.existsSync(path.join(real, 'precious')) && fs.existsSync(path.join(real, 'copy')));
  assert.equal(parse(['--forget', 'abc12']).target, 'abc12');
  assert.throws(() => parse(['--forget', 'abc12', '--prune']), /only one management action/i);
  assert.throws(() => parse(['--forget']), /requires a value/);
});
