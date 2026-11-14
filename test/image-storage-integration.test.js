import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { defaults } from '../src/config.js';
import { imagePlan, PI_VERSION } from '../src/container.js';
import { maintenanceEnvironment } from '../src/locks.js';
import { legacyStorageContainerfile } from './fixtures/legacy-storage-containerfile.mjs';

// Deliberately not included in PIS_INTEGRATION=1: four public apt/npm builds can
// consume substantial disk space. Uses no provider credentials or model prompt.
test('host storage benchmark: legacy versus shared prefix, clean/cached builds and runtime smoke', { skip: process.env.PIS_STORAGE_BENCHMARK !== '1', timeout: 1800000 }, async t => {
  assert.notEqual(process.getuid(), 0, 'Use a normal rootless host user.');
  const env = maintenanceEnvironment();
  const invoke = (args, timeout = 120000) => execFileSync('podman', args, { env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }).trim();
  const info = JSON.parse(invoke(['info', '--format', 'json']));
  assert.equal(info.host.security.rootless, true); assert.equal(info.host.serviceIsRemote, false);
  const graphRoot = info.store.graphRoot;
  const allocated = () => {
    try {
      const value = execFileSync('du', ['-s', '-B1', '--', graphRoot], { env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/)[0];
      return /^\d+$/.test(value) ? Number(value) : null;
    } catch { return null; } // Partial/unreadable graphs must not invent a measurement.
  };
  const space = fs.statfsSync(graphRoot);
  assert.ok(space.bavail * space.bsize >= 10 * 1024 ** 3, 'Leave >=10 GiB available for this benchmark (not a universal build guarantee).');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-storage-benchmark-')), tags = [], rows = [];
  const nonce = randomBytes(8).toString('hex');
  t.after(() => {
    for (const tag of tags) { try { invoke(['rmi', '--no-prune', tag]); } catch {} }
    fs.rmSync(base, { recursive: true, force: true });
    t.diagnostic('Benchmark tags/contexts removed without force/parent pruning. Build caches and the public base may remain; no automatic global/cache/Buildah cleanup was attempted.');
  });
  const before = allocated();
  for (const layout of ['legacy', 'shared']) {
    for (const [index, packages] of [['a', ['curl']], ['b', ['jq']]]) {
      const config = defaults('abc12', '/not-mounted'); config.image.packages.push(...packages);
      const plan = imagePlan(config), context = path.join(base, `${layout}-${index}`);
      fs.mkdirSync(context);
      for (const [name, contents] of Object.entries(plan.files)) fs.writeFileSync(path.join(context, name), contents);
      // A unique inert marker makes the uncached-prefix trial independent of
      // pre-existing production cache, while remaining identical for A and B.
      const content = (layout === 'legacy' ? legacyStorageContainerfile(config) : plan.content).replace('\nUSER root\n', `\nUSER root\nRUN printf '${nonce}-${layout}' > /opt/pis-storage-benchmark-marker\n`);
      fs.writeFileSync(path.join(context, 'Containerfile'), content);
      const tag = `localhost/pis-storage-benchmark-${nonce}:${layout}-${index}`; tags.push(tag);
      const build = () => invoke(['build', '--layers', '--http-proxy=false', '--tag', tag, '--file', path.join(context, 'Containerfile'), context], 1200000);
      const first = performance.now(); build(); const firstMs = performance.now() - first;
      const cached = performance.now(); build(); const cachedMs = performance.now() - cached;
      const image = JSON.parse(invoke(['image', 'inspect', tag]))[0];
      const smoke = performance.now();
      const output = invoke(['run', '--rm', '--network=none', '--unsetenv-all', '--cap-drop=all', '--security-opt=no-new-privileges', '--entrypoint', '/usr/local/bin/pi', tag, '--offline', '--no-extensions', '--no-mcp', '--no-context-files', '--version']);
      const startupMs = Math.round(performance.now() - smoke);
      assert.equal(output, PI_VERSION);
      if (layout === 'shared') {
        invoke(['run', '--rm', '--network=none', '--unsetenv-all', '--user', '0', '--entrypoint', '/bin/sh', tag, '-ec', 'test ! -d /root/.npm/_cacache; test ! -d /tmp/pis-npm-cache; test -r /opt/pis/extensions.json; test -d /opt/pis/agent/npm/node_modules/pi-web-access']);
      }
      // Export one image at a time to measure actual serialized layer payloads,
      // not infer byte savings by summing virtual sizes or layer counts.
      const exported = path.join(base, `export-${layout}-${index}`);
      let blobs;
      try {
        invoke(['save', '--format', 'oci-dir', '--output', exported, tag], 120000);
        const readBlob = digest => {
          assert.match(digest, /^sha256:[a-f0-9]{64}$/);
          return path.join(exported, 'blobs', 'sha256', digest.slice(7));
        };
        const indexData = JSON.parse(fs.readFileSync(path.join(exported, 'index.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(readBlob(indexData.manifests[0].digest), 'utf8'));
        blobs = Object.fromEntries(manifest.layers.map(layer => {
          const size = fs.statSync(readBlob(layer.digest)).size;
          assert.equal(size, layer.size); return [layer.digest, size];
        }));
      } finally { fs.rmSync(exported, { recursive: true, force: true }); }
      rows.push({ layout, project: index, firstMs: Math.round(firstMs), startupMs, cachedMs: Math.round(cachedMs), virtualBytes: image.Size, layers: image.RootFS.Layers, blobs, graphAllocatedBytes: allocated() });
    }
  }
  const summaries = ['legacy', 'shared'].map(layout => {
    const [a, b] = rows.filter(row => row.layout === layout), union = new Set([...a.layers, ...b.layers]);
    const shared = Object.keys(a.blobs).filter(digest => Object.hasOwn(b.blobs, digest));
    const allBlobs = { ...a.blobs, ...b.blobs };
    return { layout, sharedLayerCount: a.layers.filter(layer => b.layers.includes(layer)).length, uniqueLayerCount: union.size,
      sharedExportedBlobBytes: shared.reduce((sum, digest) => sum + a.blobs[digest], 0),
      uniqueExportedBlobBytes: Object.entries(allBlobs).filter(([digest]) => !shared.includes(digest)).reduce((sum, [, size]) => sum + size, 0) };
  });
  assert.ok(summaries[1].sharedLayerCount > summaries[0].sharedLayerCount, 'Different apt sets should share more runtime layers in the new layout.');
  t.diagnostic(JSON.stringify({ graphBeforeBytes: before, results: rows.map(({ layers, blobs, ...row }) => ({ ...row, layerCount: layers.length })), summaries, graphAfterBytes: allocated(), caveat: 'Virtual image bytes are not allocated disk usage. Graph deltas include caches/ID maps/concurrent host activity and are not isolated reclaimable savings. First A is an uncached-prefix trial; B intentionally reuses any shared prefix. Cached times are second builds. Do not sum virtual sizes.' }, null, 2));
});
