import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverSyntaxChecks } from '../scripts/check-syntax.mjs';

test('syntax discovery includes new nested sources and launchers without scanning dependencies, generated files or symlinks', t => {
  const root = fs.mkdtempSync('/tmp/pis-syntax-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['src/nested/new.js', 'web/public/ui.mjs', 'test/fixtures/sample.cjs', 'scripts/check.mjs', 'src/runtime/pi-launcher', 'env.sh', 'gnome-codex-usage/install.sh', 'web/node_modules/pkg/ignored.js', 'web/dist/generated.js', 'src/.private/ignored.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), '');
  }
  fs.symlinkSync(path.join(root, 'src/nested/new.js'), path.join(root, 'src/link.js'));
  assert.deepEqual(discoverSyntaxChecks(root), {
    javascript: ['scripts/check.mjs', 'src/nested/new.js', 'test/fixtures/sample.cjs', 'web/public/ui.mjs'],
    shell: ['env.sh', 'gnome-codex-usage/install.sh', 'src/runtime/pi-launcher'],
  });
});

test('syntax checks parse JavaScript and shell without executing either file and reject invalid syntax', t => {
  const root = fs.mkdtempSync('/tmp/pis-syntax-execution-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  const marker = path.join(root, 'should-not-exist');
  fs.writeFileSync(path.join(root, 'src/module.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  fs.writeFileSync(path.join(root, 'sample.sh'), `touch '${marker}'\n`);
  const url = new URL('../scripts/check-syntax.mjs', import.meta.url).href;
  const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { checkSyntax } from ${JSON.stringify(url)}; checkSyntax(${JSON.stringify(root)});`], { encoding: 'utf8' });
  assert.equal(invoke().status, 0); assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(root, 'src/module.cjs'), 'const = broken'); assert.notEqual(invoke().status, 0);
  fs.writeFileSync(path.join(root, 'src/module.cjs'), ''); fs.writeFileSync(path.join(root, 'sample.sh'), 'if then'); assert.notEqual(invoke().status, 0);
});

test('real syntax inventory includes GNOME, runtime probes and fixed CLI entry points', () => {
  const files = discoverSyntaxChecks(fileURLToPath(new URL('..', import.meta.url)));
  for (const file of ['bin/pis.js', 'src/runtime/request-apt.mjs', 'src/runtime/verified-install.mjs', 'web/enrollment.js', 'web/public/app.js', 'gnome-codex-usage/extension.js', 'scripts/check-syntax.mjs']) assert.ok(files.javascript.includes(file), file);
  for (const file of ['env.sh', 'start_server.sh', 'gnome-codex-usage/install.sh', 'src/runtime/pi-launcher']) assert.ok(files.shell.includes(file), file);
});
