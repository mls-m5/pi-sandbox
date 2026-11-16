import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureProjectRuntime } from '../web/project-runtime-bundle.js';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-runtime-code-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'installation'), store = path.join(base, 'host-store');
  fs.mkdirSync(path.join(source, 'src', 'runtime'), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(source, 'bin'), { mode: 0o700 }); fs.mkdirSync(store, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'src', 'version.js'), 'export const version = 1;\n');
  fs.writeFileSync(path.join(source, 'src', 'runtime', 'pi-launcher'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(source, 'bin', 'pis-project-rpc.js'), 'import "../src/version.js";\n');
  return { base, source, store };
}
test('runtime bundle captures trusted code once, deduplicates and never rereads edited installation for replacement', t => {
  const { source, store } = fixture(t); fs.writeFileSync(path.join(source, 'auth.json'), 'DO_NOT_COPY'); fs.writeFileSync(path.join(source, 'src', 'auth.json'), 'DO_NOT_COPY');
  const first = captureProjectRuntime(store, source), root = path.dirname(path.dirname(first.entry));
  assert.equal(captureProjectRuntime(store, source).entry, first.entry); assert.ok(first.entry.startsWith(store + path.sep));
  assert.equal(fs.statSync(root).mode & 0o777, 0o700); assert.equal(fs.statSync(first.entry).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(root, 'auth.json')), false); assert.equal(fs.existsSync(path.join(root, 'src', 'auth.json')), false);
  fs.writeFileSync(path.join(source, 'src', 'version.js'), 'throw new Error("edited project code must not execute on idle restart");\n');
  first.verify(); assert.match(fs.readFileSync(path.join(root, 'src', 'version.js'), 'utf8'), /version = 1/);
  assert.notEqual(captureProjectRuntime(store, source).entry, first.entry, 'A later explicit connector launch can capture a new trusted installation.');
});
test('corrupt, public or linked cached code fails closed without overwriting or falling back to project source', t => {
  const { source, store } = fixture(t), bundle = captureProjectRuntime(store, source), file = path.join(path.dirname(path.dirname(bundle.entry)), 'src', 'version.js');
  fs.chmodSync(file, 0o644); assert.throws(() => bundle.verify()); fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, 'tampered'); assert.throws(() => bundle.verify()); assert.throws(() => captureProjectRuntime(store, source)); assert.equal(fs.readFileSync(file, 'utf8'), 'tampered');
  fs.unlinkSync(file); fs.symlinkSync(path.join(source, 'src', 'version.js'), file); assert.throws(() => bundle.verify());
});
test('source symlinks, hardlinked or oversized code and unsafe cache directories are refused', t => {
  const { base, source, store } = fixture(t), file = path.join(source, 'src', 'version.js'), outside = path.join(base, 'outside.js');
  fs.writeFileSync(outside, 'export const outside = true;'); fs.unlinkSync(file); fs.symlinkSync(outside, file); assert.throws(() => captureProjectRuntime(store, source));
  fs.unlinkSync(file); fs.linkSync(outside, file); assert.throws(() => captureProjectRuntime(store, source));
  fs.unlinkSync(file); fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1)); assert.throws(() => captureProjectRuntime(store, source));
  fs.writeFileSync(file, 'export const ok = true;'); fs.mkdirSync(path.join(store, 'web-runtime-code'), { mode: 0o755 }); assert.throws(() => captureProjectRuntime(store, source));
});
