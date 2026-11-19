import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { completeConfig, defaults, validate } from '../src/config.js';
import { imagePlan, PI_VERSION } from '../src/container.js';
import { parse } from '../src/cli.js';
import { writeJson, withLock } from '../src/util.js';
import { pruneCandidates } from '../src/prune.js';
import { compareVersions, registryMetadata, resolveUpdateRelease, prepareUpdates, readUpdateState, selectUpdateImage, updatesAction, scheduleUpdates, protectedUpdateImages } from '../src/updates.js';
import { verifyPackedArtifact, installRelease } from '../src/runtime/verified-install.mjs';
import { runUpdateProbe } from '../src/runtime/update-probe.mjs';
import { backupPiState } from '../src/update-backup.js';

const DAY = 86400000, now = 1800000000000;
const piName = '@earendil-works/pi-coding-agent';
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
function packument(name, versions, latest = versions.at(-1), young = []) {
  return {
    'dist-tags': { latest }, time: Object.fromEntries(versions.map(version => [version, new Date(now - (young.includes(version) ? 6 * DAY : 9 * DAY)).toISOString()])),
    versions: Object.fromEntries(versions.map(version => [version, { name, version, dist: { integrity, tarball: 'https://untrusted.invalid/do-not-follow', secret: 'do-not-persist' } }])),
  };
}
const metadata = async name => name === piName
  ? packument(name, ['1.5.0', '1.5.1', '1.5.2', '1.6.0', '2.0.0'], '2.0.0', ['1.5.2'])
  : packument(name, ['0.40.0', '0.40.1', '0.41.0']);

async function fixture(t, all = false) {
  const base = fs.mkdtempSync('/tmp/pis-updates-test-'); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage')), original = await store.register(root);
  const config = structuredClone(original);
  config.extensions = ['npm:pi-web-access@0.40.0'];
  config.updates = { enabled: true, includePinnedExtensions: all };
  await store.save(config, original);
  return { base, store, config };
}
function fakeEngine(config) {
  const images = new Map([[imagePlan(config).image, 'b'.repeat(64)]]), plans = new Map(), calls = [];
  let fail, hook;
  const run = async args => {
    calls.push(args);
    if (hook) await hook(args);
    if (fail === args[0]) throw new Error('private-error-must-not-be-stored');
    if (args[0] === 'build') {
      const tag = args[args.indexOf('--tag') + 1], context = args.at(-1);
      plans.set(tag, JSON.parse(fs.readFileSync(path.join(context, 'probe-policy.json')))); images.set(tag, 'a'.repeat(64));
      return '';
    }
    if (args[0] === 'image') { if (!images.has(args.at(-1))) throw new Error('Missing'); return images.get(args.at(-1)); }
    if (args[0] === 'run') {
      const plan = plans.get(args.at(-2));
      return JSON.stringify({ ok: true, piVersion: plan.piVersion, extensions: plan.extensions });
    }
    if (args[0] === 'tag') { images.set(args[2], images.get(args[1])); return ''; }
    if (args[0] === 'rmi') images.delete(args.at(-1));
    return '';
  };
  return { run, calls, images, setFail: value => { fail = value; }, setHook: value => { hook = value; } };
}

const setup = (engine, extra = {}) => ({ metadata, now, inspect: () => ({ host: { security: { rootless: true } } }), runPodman: engine.run, ...extra });

test('updates policy is opt-in and CLI rejects arbitrary actions/mixed session operations', () => {
  const config = defaults('abc12', '/work/project');
  assert.deepEqual(config.updates, { enabled: false, includePinnedExtensions: false });
  assert.deepEqual(completeConfig({}).updates, config.updates);
  for (const action of ['on', 'all', 'off', 'status', 'check', 'rollback']) assert.equal(parse(['--updates', action]).target, action);
  for (const args of [['--updates', 'rm'], ['--updates'], ['--updates', 'on', '--fresh'], ['--updates', 'on', '--bash'], ['--updates', 'on', '--', 'task'], ['--updates', 'on', '--dry-run']]) assert.throws(() => parse(args));
  for (const updates of [null, { enabled: 'yes' }, { enabled: true, includePinnedExtensions: false, command: 'rm' }]) assert.throws(() => validate(completeConfig({ ...config, updates }), { paths: false }));
  assert.equal(compareVersions('1.5.10', '1.5.2'), 1);
  assert.throws(() => compareVersions('1.5.0-beta', '1.5.0'));
});

test('registry reader uses fixed public HTTPS, bounds payloads and never accepts a custom URL', async () => {
  const data = await registryMetadata(piName, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return new Response('{"versions":{}}');
  } });
  assert.deepEqual(data, { versions: {} });
  await assert.rejects(registryMetadata('https://secret.invalid'), /Invalid extension/);
});

test('resolution keeps exact pins unless opted in, ages releases, blocks Pi minor/major and 0.x minor upgrades', async t => {
  const { store, config } = await fixture(t);
  const state = { active: { piVersion: PI_VERSION, extensions: config.extensions } };
  const pinned = await resolveUpdateRelease(config, state, { metadata, now });
  assert.equal(pinned.piVersion, '1.5.1');
  assert.deepEqual(pinned.extensions, ['npm:pi-web-access@0.40.0']);
  const all = await resolveUpdateRelease({ ...config, updates: { enabled: true, includePinnedExtensions: true } }, state, { metadata, now });
  assert.deepEqual(all.extensions, ['npm:pi-web-access@0.40.1']);
  assert.deepEqual(store.load(config.id).extensions, ['npm:pi-web-access@0.40.0']);
  assert.ok(!JSON.stringify(all).includes('untrusted.invalid'));
  assert.ok(!JSON.stringify(all).includes('do-not-persist'));
  await assert.rejects(resolveUpdateRelease(config, state, { metadata: async name => packument(name, name === piName ? ['1.5.0'] : ['0.40.0'], undefined, ['1.5.0']), now }), /No mature/);
  const moving = { ...config, extensions: ['npm:pi-web-access'] };
  const resolved = await resolveUpdateRelease(moving, { active: { piVersion: PI_VERSION, extensions: moving.extensions } }, { metadata, now });
  assert.deepEqual(resolved.extensions, ['npm:pi-web-access@0.41.0']);
});

test('candidate installation uses verified top-level tarballs, immutable versions and no scripts', async t => {
  const { base, config } = await fixture(t, true);
  const release = await resolveUpdateRelease(config, { active: { piVersion: PI_VERSION, extensions: config.extensions } }, { metadata, now });
  const plan = imagePlan({ ...config, extensions: release.extensions }, { piVersion: release.piVersion, releaseLock: release.lock, releaseId: release.releaseId });
  const another = await resolveUpdateRelease(config, { active: { piVersion: PI_VERSION, extensions: config.extensions } }, { metadata, now });
  assert.deepEqual(another.lock, release.lock);
  assert.notEqual(another.image, release.image, 'A new build cannot overwrite a retained image tag even with identical top-level pins.');
  assert.match(plan.content, /COPY update-lock.json verified-install.mjs/);
  assert.match(plan.content, /RUN mkdir -p \/opt\/pis\/agent && node \/opt\/pis\/verified-install.mjs/);
  assert.ok(!plan.content.includes('@latest'));
  assert.equal(JSON.parse(plan.files['probe-policy.json']).piVersion, '1.5.1');
  assert.ok(plan.files['verified-install.mjs'].includes('--ignore-scripts'));
  assert.ok(plan.files['probe-lib/proxy.js'].includes('startOpenAIProxy'));
  const artifact = path.join(base, 'package.tgz'); fs.writeFileSync(artifact, 'known bytes');
  const expected = `sha512-${createHash('sha512').update('known bytes').digest('base64')}`;
  verifyPackedArtifact(artifact, expected);
  assert.throws(() => verifyPackedArtifact(artifact, integrity), /integrity mismatch/);
});

test('verified installer seals colliding npm tarball names before installing (fake npm only)', async t => {
  const { base } = await fixture(t), root = path.join(base, 'install'); fs.mkdirSync(root);
  const packages = [piName, 'earendil-works-pi-coding-agent'].map((name, index) => ({ name, version: PI_VERSION, integrity: `sha512-${createHash('sha512').update(`package-${index}`).digest('base64')}` }));
  writeJson(path.join(root, 'update-lock.json'), { packages });
  const installed = []; let packed = 0;
  installRelease({ root, runNpm: (args, options) => {
    assert.ok(args.includes('--ignore-scripts'));
    if (args[0] === 'pack') {
      const pkg = packages[packed], filename = `earendil-works-pi-coding-agent-${PI_VERSION}.tgz`;
      fs.writeFileSync(path.join(options.cwd, filename), `package-${packed++}`);
      return JSON.stringify([{ name: pkg.name, version: pkg.version, filename }]);
    }
    installed.push(fs.readFileSync(args.at(-1), 'utf8')); return '';
  } });
  assert.deepEqual(installed, ['package-0', 'package-1']);
});

test('background preparation cannot activate a release; a later locked launch activates and keeps rollback leases', async t => {
  const { store, config } = await fixture(t, true), engine = fakeEngine(config);
  const result = await store.projectLock(config.id, () => prepareUpdates(store, config.id, setup(engine)));
  assert.equal(result.prepared, true);
  assert.ok(engine.calls.find(args => args[0] === 'build').includes('--layers'));
  let state = readUpdateState(store, config.id);
  assert.equal(state.active.baseline, true);
  assert.equal(state.candidate.piVersion, '1.5.1');
  assert.equal(engine.calls.filter(args => args[0] === 'tag').length, 0);
  const probe = engine.calls.find(args => args[0] === 'run');
  assert.ok(probe.includes('--network=none') && probe.includes('--read-only') && probe.includes('--unsetenv-all'));
  assert.ok(probe.includes('--cap-drop=all') && probe.includes('--memory=1g'));
  assert.ok(!probe.includes('--volume') && !probe.some(arg => /PIS_PROXY_TOKEN|OPENAI_API_KEY|SSH_AUTH_SOCK/.test(arg)));
  const messages = [];
  const plan = await store.projectLock(config.id, () => selectUpdateImage(store, config, { runPodman: engine.run, notify: text => messages.push(text) }));
  assert.equal(plan.piVersion, '1.5.1');
  state = readUpdateState(store, config.id);
  assert.equal(state.candidate, null);
  assert.equal(state.previous.baseline, true);
  assert.ok(protectedUpdateImages(store, config.id).includes(state.active.image));
  assert.ok(protectedUpdateImages(store, config.id).includes(state.previous.image));
  assert.equal(messages.length, 1);
  assert.deepEqual(store.load(config.id).extensions, config.extensions);
  assert.equal((await prepareUpdates(store, config.id, setup(engine, { now: now + 100 }))).throttled, true);
});

test('busy maintenance never delays a launch, failures retain old image, off freezes and rollback disables updates', async t => {
  const { store, config } = await fixture(t, true), engine = fakeEngine(config);
  await prepareUpdates(store, config.id, setup(engine));
  const lock = path.join(store.projectDir(config.id), 'updates.lock');
  await withLock(lock, async () => {
    assert.equal(await selectUpdateImage(store, config, { runPodman: engine.run, notify: () => {} }), undefined); // Baseline still active.
  });
  await selectUpdateImage(store, config, { runPodman: engine.run, notify: () => {} });
  const active = readUpdateState(store, config.id).active;
  await store.projectLock(config.id, () => updatesAction(store, store.load(config.id), 'off'));
  const frozen = store.load(config.id);
  assert.equal((await selectUpdateImage(store, frozen, { runPodman: engine.run, notify: () => {} })).image, active.image);
  const result = await updatesAction(store, frozen, 'rollback', { runPodman: engine.run });
  assert.equal(result.rolledBack, true);
  assert.equal(store.load(config.id).updates.enabled, false);
  assert.equal(readUpdateState(store, config.id).active.baseline, true);
});

test('failed build/probe or configuration changes never publish a new active/candidate image or print untrusted errors', async t => {
  for (const phase of ['build', 'run', 'changed']) {
    const { store, config } = await fixture(t, true), engine = fakeEngine(config);
    if (phase === 'changed') engine.setHook(async args => {
      if (args[0] === 'build') {
        const original = store.load(config.id), edited = structuredClone(original); edited.image.packages.push('curl'); await store.save(edited, original);
      }
    });
    else engine.setFail(phase);
    const result = await prepareUpdates(store, config.id, setup(engine));
    assert.equal(result.failed, phase === 'run' ? 'probe' : phase === 'changed' ? 'configuration-changed' : 'build');
    const state = readUpdateState(store, config.id);
    assert.equal(state.active.baseline, true); assert.equal(state.candidate, null);
    assert.ok(!JSON.stringify(state).includes('private-error'));
    assert.equal(fs.readdirSync(store.projectDir(config.id)).some(name => name.startsWith('update-build-')), false);
  }
});

test('stale policy/configuration and changed image identities are not activated; unsafe state is rejected', async t => {
  const { store, config } = await fixture(t, true), engine = fakeEngine(config);
  await prepareUpdates(store, config.id, setup(engine));
  const original = store.load(config.id), edited = structuredClone(original); edited.updates.includePinnedExtensions = false; await store.save(edited, original);
  assert.equal(await selectUpdateImage(store, edited, { runPodman: engine.run, notify: () => {} }), undefined);
  assert.equal(readUpdateState(store, config.id).active.baseline, true);
  await store.save(config, edited);
  const state = readUpdateState(store, config.id); engine.images.set(state.candidate.stagingImage, 'f'.repeat(64));
  assert.equal(await selectUpdateImage(store, config, { runPodman: engine.run, notify: () => {} }), undefined);
  assert.equal(readUpdateState(store, config.id).candidate, null);
  const file = path.join(store.projectDir(config.id), 'updates.json');
  fs.unlinkSync(file); fs.symlinkSync('/not/readable/auth.json', file);
  assert.throws(() => readUpdateState(store, config.id), /Cannot read private/);
  assert.equal(await selectUpdateImage(store, config, { runPodman: engine.run, notify: () => {} }), undefined);
});

test('turning updates off during activation prevents the release-pointer commit without interrupting Pi', async t => {
  const { store, config } = await fixture(t, true), engine = fakeEngine(config);
  await prepareUpdates(store, config.id, setup(engine));
  engine.setHook(async args => { if (args[0] === 'tag') await updatesAction(store, store.load(config.id), 'off'); });
  const plan = await store.projectLock(config.id, () => selectUpdateImage(store, config, { runPodman: engine.run, notify: () => {} }));
  assert.equal(plan, undefined);
  assert.equal(readUpdateState(store, config.id).active.baseline, true);
  assert.ok(readUpdateState(store, config.id).candidate);
  assert.equal(store.load(config.id).updates.enabled, false);
});

test('activation makes a bounded private Pi-only backup, never follows links and preserves the previous backup on failure', async t => {
  const { store, config, base } = await fixture(t);
  const agent = path.join(store.projectDir(config.id), 'state/.pi/agent'); fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'settings.json'), '{"model":"chosen"}');
  const outside = path.join(base, 'not-mounted-secret'); fs.writeFileSync(outside, 'must-not-copy');
  fs.symlinkSync(outside, path.join(agent, 'external'));
  const result = backupPiState(store, config, { from: 'old', to: 'new' });
  assert.equal(result.scope, 'state/.pi');
  const backup = path.join(store.projectDir(config.id), 'update-backup');
  assert.equal(fs.statSync(backup).mode & 0o077, 0);
  assert.equal(fs.readFileSync(path.join(backup, 'pi/agent/settings.json'), 'utf8'), '{"model":"chosen"}');
  assert.equal(fs.existsSync(path.join(backup, 'pi/agent/external')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'symlinks.json')))[0].target, outside);
  assert.throws(() => backupPiState(store, config, { maxBytes: 1 }), /limit exceeded/);
  assert.equal(fs.readFileSync(path.join(backup, 'pi/agent/settings.json'), 'utf8'), '{"model":"chosen"}');
  assert.equal(fs.readdirSync(store.projectDir(config.id)).some(name => name.startsWith('update-backup-pending-')), false);
  const engine = fakeEngine(config); await prepareUpdates(store, config.id, setup(engine));
  const messages = [];
  assert.equal(await selectUpdateImage(store, config, { runPodman: engine.run, backup: () => { throw new Error('secret'); }, notify: text => messages.push(text) }), undefined);
  assert.equal(readUpdateState(store, config.id).lastError, 'state-backup');
  assert.ok(readUpdateState(store, config.id).candidate);
  assert.equal(engine.calls.some(args => args[0] === 'tag'), false);
  assert.ok(!messages.join('').includes('secret'));
});

test('managed active/previous images are excluded from pruning even when old and unused', () => {
  const image = (index, age) => ({ Names: [`localhost/pis-abc12:${String(index).repeat(20)}`], Id: `id-${index}`, Created: (now - age * DAY) / 1000, Containers: 0 });
  const images = [image(1, 1), image(2, 2), image(3, 3), image(4, 4)];
  const leases = [images[2].Names[0], images[3].Names[0]];
  const candidates = pruneCandidates(images, 'abc12', images[0].Names[0], now, leases);
  assert.deepEqual(candidates.map(entry => entry.id), ['id-2']);
});

test('scheduler uses a detached credential-free worker and opt-out is effective', async t => {
  const { store, config } = await fixture(t);
  const old = process.env.PIS_AUTO_UPDATE; t.after(() => { if (old === undefined) delete process.env.PIS_AUTO_UPDATE; else process.env.PIS_AUTO_UPDATE = old; });
  delete process.env.PIS_AUTO_UPDATE;
  let called = 0;
  const spawnImpl = (_node, args, options) => {
    called++; assert.equal(args.at(-1), config.id);
    assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.PIS_PROXY_TOKEN, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
    return { on() {}, unref() {} };
  };
  scheduleUpdates(store, config, { spawnImpl }); assert.equal(called, 1);
  process.env.PIS_AUTO_UPDATE = '0'; scheduleUpdates(store, config, { spawnImpl }); assert.equal(called, 1);
});

test('CLI enables policy without rewriting packages; status/check are explicit and no worker runs when suppressed', async t => {
  const { store, config } = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: config.root, env: { ...process.env, PIS_HOME: store.root, PIS_AUTO_UPDATE: '0' }, encoding: 'utf8', timeout: 10000 });
  const all = run(['--updates', 'all']); assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout).policy, { enabled: true, includePinnedExtensions: true });
  assert.deepEqual(store.load(config.id).extensions, config.extensions);
  const status = run(['--updates', 'status']); assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).release, null);
  const off = run(['--updates', 'off']); assert.equal(off.status, 0, off.stderr);
  assert.equal(store.load(config.id).updates.enabled, false);
});

test('actual installed candidate probe uses only local fake model/proposal services', { skip: !process.env.PIS_PI_PACKAGE, timeout: 60000 }, async t => {
  const { base } = await fixture(t);
  const pkg = path.resolve(process.env.PIS_PI_PACKAGE), manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json')));
  assert.equal(manifest.version, PI_VERSION);
  const root = path.join(base, 'probe'); fs.mkdirSync(root);
  const sources = process.env.PIS_PI_WEB_ACCESS ? ['npm:pi-web-access@0.40.0'] : [];
  const entries = sources.map(source => ({ source, name: 'pi-web-access', version: '0.40.0', path: process.env.PIS_PI_WEB_ACCESS }));
  writeJson(path.join(root, 'probe-policy.json'), { piVersion: PI_VERSION, extensions: sources });
  writeJson(path.join(root, 'extensions.json'), entries);
  const lib = path.join(root, 'probe-lib'); fs.mkdirSync(lib);
  writeJson(path.join(lib, 'package.json'), { type: 'module' });
  for (const file of ['proxy.js', 'codex-auth.js', 'codex-usage.js', 'util.js']) fs.copyFileSync(new URL(`../src/${file}`, import.meta.url), path.join(lib, file));
  for (const file of ['request-apt.mjs', 'claude-host-mcp.mjs', 'codex-auto.mjs']) fs.copyFileSync(new URL(`../src/runtime/${file}`, import.meta.url), path.join(root, file));
  const cli = path.join(pkg, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
  assert.deepEqual(await runUpdateProbe({ root, cli }), { ok: true, piVersion: PI_VERSION, extensions: sources });
});
