import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaults } from '../src/config.js';
import { containerfile, imagePlan, PI_VERSION } from '../src/container.js';
import { installRelease } from '../src/runtime/verified-install.mjs';

const boundary = '# Project customization starts here; runtime layers above are shared.';
const prefix = config => containerfile(config).split(boundary)[0];

test('different projects/tools/custom instructions share an identical runtime prefix without mutable base tags', () => {
  const a = defaults('abc12', '/work/a'), b = defaults('def34', '/work/b');
  a.image.packages = ['curl']; b.image.packages = ['jq', 'python3'];
  b.image.extraInstructions = ['RUN echo project-specific > /opt/project-marker'];
  const beforeA = structuredClone(a), beforeB = structuredClone(b);
  assert.equal(prefix(a), prefix(b));
  assert.notEqual(imagePlan(a).fingerprint, imagePlan(b).fingerprint);
  assert.deepEqual(a, beforeA); assert.deepEqual(b, beforeB);
  const text = containerfile(b);
  assert.ok(text.indexOf('pi install ') < text.indexOf("'jq'"));
  assert.ok(text.indexOf("'jq'") < text.indexOf('RUN echo project-specific'));
  assert.ok(text.indexOf('RUN echo project-specific') < text.indexOf('COPY extensions.json'));
  assert.match(text, /FROM docker.io\/library\/node:/);
  assert.doesNotMatch(text, /FROM localhost\/pis-/);
});

test('explicit empty apt/extension lists remain empty above the common baseline; sources and variants affect sharing', () => {
  const a = defaults('abc12', '/work/a'); a.image.packages = []; a.extensions = [];
  const text = containerfile(a);
  assert.equal(text.match(/apt-get install/g).length, 1);
  assert.doesNotMatch(text, /'build-essential'|'python3'|pi install /);
  const dupes = structuredClone(a); dupes.image.packages = ['git', 'curl', 'curl'];
  assert.equal(containerfile(dupes).match(/'git'/g).length, 1);
  assert.equal(containerfile(dupes).match(/'curl'/g).length, 1);
  const literal = { ...a, image: { ...a.image, packages: ['curl=1.2.3', "literal'quote"] } };
  assert.ok(containerfile(literal).includes("'curl=1.2.3'"));
  assert.ok(containerfile(literal).includes("'literal'\\''quote'"));
  const extension = { ...a, extensions: ['npm:pi-web-access@0.40.0'] };
  assert.notEqual(prefix(a), prefix(extension));
  assert.notEqual(prefix(extension), prefix({ ...extension, extensions: ['npm:pi-web-access@0.41.0'] }));
  const claude = { ...a, agent: 'claude' };
  assert.match(containerfile(claude), /@anthropic-ai\/claude-code@/);
  assert.doesNotMatch(text, /@anthropic-ai/);
  assert.equal(prefix(claude).split('RUN npm_config_cache=/tmp/pis-npm-cache npm install -g --ignore-scripts @anthropic-ai')[0], prefix(a).split('RUN mkdir -p /opt/pis/agent')[0]);
});

test('declared default toolchains share their own apt layer without forcing them on empty configs or hiding version pins', () => {
  const a = defaults('abc12', '/work/a'), b = defaults('def34', '/work/b');
  a.image.packages.push('curl'); b.image.packages.push('jq');
  const lines = config => containerfile(config).split('\n').filter(line => line.includes('apt-get install'));
  assert.equal(lines(a)[1], lines(b)[1]);
  assert.match(lines(a)[1], /'build-essential' 'python3'/);
  assert.match(lines(a)[2], /'curl'/); assert.match(lines(b)[2], /'jq'/);
  assert.doesNotMatch(containerfile(a), /--allow-downgrades/);
  const pinned = { ...a, image: { ...a.image, packages: ['python3', 'python3=3.11.0', 'git=1:2.30.0'] } };
  const steps = lines(pinned);
  assert.equal(steps.length, 2, 'Pinned default tool stays in the final project apt solve, not a prior unpinned toolchain step.');
  assert.match(steps[1], /--allow-downgrades 'python3' 'python3=3.11.0' 'git=1:2.30.0'/);
});

test('every baseline npm/extension install cleans caches in its creating layer, permissions never recursively copy up the runtime late', () => {
  for (const agent of ['pi', 'claude']) {
    const config = defaults('abc12', '/work/a'); config.agent = agent;
    const text = containerfile(config);
    for (const line of text.split('\n').filter(line => line.startsWith('RUN ') && (line.includes('npm install') || line.includes('pi install')))) {
      assert.match(line, /[Cc][Aa][Cc][Hh][Ee]=\/tmp\/pis-npm-cache/);
      assert.match(line, /&& rm -rf \/tmp\/pis-npm-cache \/root\/\.npm$/);
      assert.match(line, /ignore-scripts|IGNORE_SCRIPTS=true/);
    }
    assert.doesNotMatch(text, /chmod -R a\+rX \/opt\/pis(?:\s|&&)/);
    assert.doesNotMatch(text.split(boundary)[1], /chmod -R a\+rX \/opt\/pis\/agent/);
    assert.match(text, /chmod a\+r \/opt\/pis\/extensions.json/);
  }
});

test('managed release IDs and probe helper code are late; verified package set is a stable shared prefix', () => {
  const config = defaults('abc12', '/work/a'), lock = { packages: [{ name: '@earendil-works/pi-coding-agent', version: PI_VERSION, integrity: 'fake-integrity-for-recipe-only' }] };
  const a = imagePlan(config, { releaseLock: lock, releaseId: 'a'.repeat(32) });
  const b = imagePlan({ ...config, image: { ...config.image, packages: ['jq'] } }, { releaseLock: lock, releaseId: 'b'.repeat(32) });
  assert.equal(a.content.split(boundary)[0], b.content.split(boundary)[0]);
  assert.equal(a.files['update-lock.json'], b.files['update-lock.json']);
  assert.notEqual(a.files['managed-release.json'], b.files['managed-release.json']);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.ok(a.content.indexOf('COPY probe-lib') > a.content.indexOf(boundary));
  assert.ok(a.content.indexOf('managed-release.json') > a.content.indexOf(boundary));
  assert.ok(a.content.indexOf('verified-install.mjs && chmod -R') < a.content.indexOf(boundary));
});

test('verified installer uses private temporary npm cache and removes it on success and failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-install-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = { name: '@earendil-works/pi-coding-agent', version: PI_VERSION, integrity: `sha512-${createHash('sha512').update('artifact').digest('base64')}` };
  fs.writeFileSync(path.join(root, 'update-lock.json'), JSON.stringify({ packages: [pkg] }));
  for (const fail of [false, true]) {
    let temp, cache;
    const execute = () => installRelease({ root, runNpm: (args, options) => {
      temp = options.cwd; cache = options.env.npm_config_cache;
      assert.equal(cache, path.join(temp, 'npm-cache'));
      fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'cache-byte'), 'cache');
      assert.ok(args.includes('--ignore-scripts'));
      if (fail) throw new Error('Fake registry failure');
      if (args[0] === 'pack') {
        fs.writeFileSync(path.join(temp, 'package.tgz'), 'artifact');
        return JSON.stringify([{ ...pkg, filename: 'package.tgz' }]);
      }
      return '';
    } });
    if (fail) assert.throws(execute, /Fake registry/); else execute();
    assert.equal(fs.existsSync(cache), false); assert.equal(fs.existsSync(temp), false);
  }
});
