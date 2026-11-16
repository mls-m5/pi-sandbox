import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { parse } from '../src/cli.js';
import { DEFAULT_EXTENSIONS, withDefaultExtensions } from '../src/extensions.js';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
async function fixture(t, extensions = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-rebuild-defaults-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'),
    bin = path.join(base, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const store = new Store(path.join(base, 'storage')),
    config = await store.register(root, 'test-project');
  config.extensions = extensions;
  store.write(config);
  const log = path.join(base, 'engine.jsonl'),
    manifest = path.join(base, 'manifest.json');
  fs.writeFileSync(
    path.join(bin, 'podman'),
    `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.REBUILD_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'info') {
  if (process.env.REBUILD_INFO_FAIL) process.exit(125);
  if (process.env.REBUILD_EDIT_CONFIG) {
    const file = process.env.REBUILD_CONFIG;
    const config = JSON.parse(fs.readFileSync(file)); config.image.packages.push('jq');
    fs.writeFileSync(file, JSON.stringify(config));
  }
  console.log(JSON.stringify({ host: { security: { rootless: true }, serviceIsRemote: false } }));
} else if (args[0] === 'image' && args[1] === 'exists') process.exit(0);
else if (args[0] === 'build') {
  fs.copyFileSync(path.join(args.at(-1), 'extensions.json'), process.env.REBUILD_MANIFEST);
  process.exit(Number(process.env.REBUILD_BUILD_EXIT || 0));
} else process.exit(99);
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: base,
    PIS_HOME: store.root,
    PIS_AUTO_UPDATE: '0',
    PIS_AUTO_PRUNE: '0',
    REBUILD_LOG: log,
    REBUILD_MANIFEST: manifest,
    REBUILD_CONFIG: store.configPath(config.id),
  };
  const invoke = (args, extra = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { base, store, config, invoke, calls, manifest, log };
}

test('rebuild-defaults parsing is explicit build-only action with normal project selection', () => {
  assert.equal(parse(['--rebuild-defaults']).action, 'rebuild-defaults');
  assert.equal(parse(['--project', 'abc12', '--rebuild-defaults']).project, 'abc12');
  for (const args of [
    ['--rebuild-defaults', '--rebuild'],
    ['--rebuild-defaults', '--fresh'],
    ['--rebuild-defaults', '--agent', 'pi'],
    ['--rebuild-defaults', '--', '-p', 'hello'],
    ['--rebuild-defaults', '--bash'],
    ['--rebuild-defaults', '--dry-run'],
  ])
    assert.throws(() => parse(args));
});

test('adding defaults retains source order, custom packages and explicit pins', () => {
  const sources = ['npm:custom-plugin@2.0.0', 'npm:pi-web-access@0.1.0'];
  assert.deepEqual(withDefaultExtensions(sources), [...sources, 'npm:pi-subagents@0.88.1']);
  assert.deepEqual(sources, ['npm:custom-plugin@2.0.0', 'npm:pi-web-access@0.1.0']);
  assert.deepEqual(withDefaultExtensions([]), DEFAULT_EXTENSIONS);
  assert.deepEqual(withDefaultExtensions(DEFAULT_EXTENSIONS), DEFAULT_EXTENSIONS);
  assert.throws(
    () => withDefaultExtensions(['npm:pi-subagents@1', 'npm:pi-subagents@2']),
    /Duplicate/,
  );
});

test('explicit default rebuild adds missing extensions, preserves the rest and forces no-cache build without running an agent', async (t) => {
  const f = await fixture(t, ['npm:custom-plugin@2.0.0', 'npm:pi-web-access@0.1.0']);
  const original = f.store.load(f.config.id);
  const result = f.invoke(['--project', f.config.id, '--rebuild-defaults']);
  assert.equal(result.status, 0, result.stderr);
  const expected = [...original.extensions, 'npm:pi-subagents@0.88.1'];
  assert.deepEqual(f.store.load(f.config.id), { ...original, extensions: expected });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(f.manifest)).map((entry) => entry.source),
    expected,
  );
  const builds = f.calls().filter((args) => args[0] === 'build');
  assert.equal(builds.length, 1);
  assert.ok(builds[0].includes('--no-cache'));
  assert.equal(
    f.calls().some((args) => args[0] === 'run'),
    false,
  );
});

test('ordinary rebuild preserves explicit empty list, new action opts in and is idempotent', async (t) => {
  const f = await fixture(t);
  assert.equal(f.invoke(['--rebuild']).status, 0);
  assert.deepEqual(f.store.load(f.config.id).extensions, []);
  assert.equal(f.invoke(['--rebuild-defaults']).status, 0);
  assert.deepEqual(f.store.load(f.config.id).extensions, DEFAULT_EXTENSIONS);
  assert.equal(f.invoke(['--rebuild-defaults']).status, 0);
  assert.deepEqual(f.store.load(f.config.id).extensions, DEFAULT_EXTENSIONS);
  assert.equal(
    f.calls().filter((args) => args[0] === 'build' && args.includes('--no-cache')).length,
    3,
  );
});

test('engine failure, busy project and Claude configuration cannot mutate defaults', async (t) => {
  const f = await fixture(t),
    original = f.store.load(f.config.id);
  assert.equal(f.invoke(['--rebuild-defaults'], { REBUILD_INFO_FAIL: '1' }).status, 1);
  assert.deepEqual(f.store.load(f.config.id), original);
  fs.writeFileSync(f.log, '');
  const lock = path.join(f.store.projectDir(f.config.id), 'project.lock');
  fs.writeFileSync(lock, 'owned fixture lock', { mode: 0o600 });
  assert.equal(f.invoke(['--rebuild-defaults']).status, 1);
  assert.deepEqual(f.store.load(f.config.id), original);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'owned fixture lock');
  assert.deepEqual(f.calls(), []);
  fs.unlinkSync(lock);
  f.store.write({ ...original, agent: 'claude' });
  assert.equal(f.invoke(['--rebuild-defaults']).status, 1);
  assert.deepEqual(f.store.load(f.config.id).extensions, []);
  assert.deepEqual(f.calls(), []);
});

test('concurrent config edits are retained instead of overwritten', async (t) => {
  const f = await fixture(t),
    original = f.store.load(f.config.id);
  const result = f.invoke(['--rebuild-defaults'], { REBUILD_EDIT_CONFIG: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Configuration changed/);
  assert.deepEqual(f.store.load(f.config.id), {
    ...original,
    image: { ...original.image, packages: [...original.image.packages, 'jq'] },
  });
  assert.equal(
    f.calls().some((args) => args[0] === 'build'),
    false,
  );
});

test('failed build retains explicitly added defaults for retry and releases project lock', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(['--rebuild-defaults'], { REBUILD_BUILD_EXIT: '9' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Image build failed/);
  assert.deepEqual(f.store.load(f.config.id).extensions, DEFAULT_EXTENSIONS);
  assert.equal(fs.existsSync(path.join(f.store.projectDir(f.config.id), 'project.lock')), false);
  assert.equal(f.invoke(['--rebuild-defaults']).status, 0);
});
