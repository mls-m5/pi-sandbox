import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from '../src/cli.js';

const cli = fileURLToPath(new URL('../bin/pis.js', import.meta.url));
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-cli-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'app'); fs.mkdirSync(root);
  const env = { ...process.env, PIS_HOME: path.join(base, 'storage'), OPENAI_API_KEY: 'never-print-this-secret' };
  const invoke = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', ...options });
  return { base, root, env, invoke };
}

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

test('unknown options recommend explicit argument forwarding', t => {
  const { invoke } = fixture(t);
  const result = invoke(['--model', 'example']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass Pi arguments after --/);
});
