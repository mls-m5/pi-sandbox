import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from '../src/cli.js';
import { fakeCodexCredential } from './fixtures/codex.js';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-cli-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'app'); fs.mkdirSync(root);
  const env = { ...process.env, PIS_HOME: path.join(base, 'storage'), OPENAI_API_KEY: 'never-print-this-secret' };
  const invoke = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', ...options });
  return { base, root, env, invoke };
}

test('unsupported Node versions fail before loading modern built-ins or initializing storage', t => {
  const { env } = fixture(t);
  for (const version of ['18.17.1', '20.19.0', '22.18.0']) {
    const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, 'node', { value: '${version}' });`)}`;
    const rejected = spawnSync(process.execPath, ['--import', preload, cli, '--help'], { env, encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Node.js 22.19 or newer is required/);
    assert.ok(rejected.stderr.includes(version));
    assert.doesNotMatch(rejected.stderr, /SyntaxError|ModuleJob|zstdDecompressSync/);
  }
  assert.ok(!fs.existsSync(env.PIS_HOME));
});

test('CLI parsing forwards arguments and rejects ambiguous combinations', () => {
  assert.deepEqual(parse(['--fresh', '--', '-p', 'hello']), { action: 'run', mode: 'pi', fresh: true, args: ['-p', 'hello'] });
  assert.equal(parse(['--project=abc12', '--bash']).project, 'abc12');
  assert.equal(parse(['--exec', '--', 'printf', '%s', 'hello']).mode, 'exec');
  for (const args of [['--wat'], ['--name', 'app'], ['--exec'], ['--bash', '--fresh'], ['--bash', '--', 'args'], ['--new', '--list'], ['--new', '--project', 'x'], ['--project'], ['--fresh', '--build'], ['--bash', '--exec'], ['--edit', '--', '-p']]) {
    assert.throws(() => parse(args), undefined, args.join(' '));
  }
});

test('help does not initialize storage and registration/show/list/check work', t => {
  const { env, invoke } = fixture(t);
  const help = invoke(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /pi --continue/);
  assert.ok(!fs.existsSync(env.PIS_HOME));
  assert.equal(invoke([]).status, 1);
  const created = invoke(['--new', '--name', 'example']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Registered [a-z0-9]{5} \(example\)/);
  const show = invoke(['--show']);
  assert.equal(show.status, 0, show.stderr);
  const effective = JSON.parse(show.stdout);
  assert.equal(effective.config.name, 'example');
  assert.deepEqual(effective.piCommand, ['pi', '--continue']);
  assert.equal(effective.mounts.length, 1);
  assert.equal(effective.credentialVariables[0].present, true);
  assert.ok(!show.stdout.includes(env.OPENAI_API_KEY));
  assert.match(invoke(['--list']).stdout, /example/);
  assert.equal(invoke(['--check']).status, 0);
  assert.match(invoke(['--extensions-list']).stdout, /npm:pi-web-access@0\.40\.0/);
});

test('editor saves valid changes and retains invalid drafts without damaging config', t => {
  const { base, env, invoke } = fixture(t);
  assert.equal(invoke(['--new']).status, 0);
  const before = JSON.parse(invoke(['--show']).stdout);
  const editor = path.join(base, 'editor.mjs');
  fs.writeFileSync(editor, `import fs from 'node:fs';\nconst file = process.argv.at(-1);\nconst c = JSON.parse(fs.readFileSync(file));\nc.image.packages.push('python3');\nfs.writeFileSync(file, JSON.stringify(c));\n`);
  env.VISUAL = `"${process.execPath}" "${editor}"`;
  let edited = invoke(['--edit']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(JSON.parse(invoke(['--show']).stdout).config.image.packages, ['python3']);
  const valid = fs.readFileSync(before.configurationFile, 'utf8');
  fs.writeFileSync(editor, `import fs from 'node:fs'; fs.writeFileSync(process.argv.at(-1), '{invalid');`);
  edited = invoke(['--edit']);
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /Draft retained/);
  assert.equal(fs.readFileSync(before.configurationFile, 'utf8'), valid);
  assert.ok(fs.readdirSync(path.dirname(before.configurationFile)).some(file => file.startsWith('edit-')));
});

test('Codex import/logout work without a project and show never displays host credentials', t => {
  const { base, invoke } = fixture(t);
  const credential = fakeCodexCredential();
  const source = path.join(base, 'host-pi.json');
  fs.writeFileSync(source, JSON.stringify({ 'openai-codex': credential }));
  assert.equal(parse(['--login-codex']).action, 'login-codex');
  assert.throws(() => parse(['--login-codex', '--project', 'example']));
  assert.throws(() => parse(['--import-codex']));
  const imported = invoke(['--import-codex', source]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.ok(!imported.stdout.includes(credential.access));
  assert.ok(!imported.stdout.includes(credential.refresh));
  assert.equal(invoke(['--new']).status, 0);
  let shown = JSON.parse(invoke(['--show']).stdout);
  shown.config.credentials = { env: [], proxy: { provider: 'openai-codex' } };
  fs.writeFileSync(shown.configurationFile, JSON.stringify(shown.config));
  shown = JSON.parse(invoke(['--show']).stdout);
  assert.deepEqual(shown.credentialVariables, []);
  assert.deepEqual(shown.credentialSource, { kind: 'host-oauth', provider: 'openai-codex', present: true });
  assert.ok(!JSON.stringify(shown).includes(credential.access));
  assert.equal(invoke(['--logout-codex']).status, 0);
  assert.equal(JSON.parse(invoke(['--show']).stdout).credentialSource.present, false);
});

test('unknown options recommend explicit argument forwarding', t => {
  const { invoke } = fixture(t);
  const result = invoke(['--model', 'example']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass Pi arguments after --/);
});
