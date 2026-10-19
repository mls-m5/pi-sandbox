import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaults } from '../src/config.js';
import { piCommand, interactiveOutput, imagePlan, launchArgs, CONTAINER_HOME } from '../src/container.js';

const config = { ...defaults('abc12', '/work/project', 'app'), credentials: { env: ['OPENAI_API_KEY'] } };
const store = { projectDir: id => `/storage/projects/${id}` };

test('Pi continues by default and respects explicit session selection/subcommands', () => {
  assert.deepEqual(piCommand(), ['pi', '--continue']);
  assert.deepEqual(piCommand(['--model', 'example']), ['pi', '--continue', '--model', 'example']);
  assert.deepEqual(piCommand(['-p', 'test'], true), ['pi', '-p', 'test']);
  for (const args of [['--resume'], ['-r'], ['--session', 'id'], ['--session=id'], ['--session-id', 'id'], ['--fork', 'id'], ['--no-session'], ['--continue'], ['-c']]) {
    assert.deepEqual(piCommand(args), ['pi', ...args]);
  }
  for (const command of ['auth', 'install', 'update', 'config', 'mcp', 'list']) assert.deepEqual(piCommand([command, '--help']), ['pi', command, '--help']);
  assert.deepEqual(piCommand(['--', '--resume']), ['pi', '--continue', '--', '--resume']);
});

test('noninteractive Pi modes never request a TTY that merges protocol streams', () => {
  for (const args of [['--mode', 'rpc'], ['--mode', 'json'], ['--mode=json'], ['-p', 'prompt'], ['--print'], ['--export', 'session'], ['--version']]) {
    assert.equal(interactiveOutput(piCommand(args)), false, args.join(' '));
  }
  assert.equal(interactiveOutput(piCommand()), true);
  assert.equal(interactiveOutput(piCommand(['--mode', 'text'])), true);
  assert.equal(interactiveOutput(piCommand(['--', '--mode', 'json'])), true);
  assert.equal(interactiveOutput(['bash', '-i']), true);
});

test('only image configuration affects image fingerprint', () => {
  const first = imagePlan(config);
  const changed = structuredClone(config);
  changed.mounts.push({ source: '/work/extra' }); changed.credentials.env = [];
  assert.equal(imagePlan(changed).image, first.image);
  changed.image.packages.push('python3');
  assert.notEqual(imagePlan(changed).image, first.image);
  assert.match(first.content, /npm install -g --ignore-scripts/);
  assert.match(first.content, /ENTRYPOINT \["pi"\]/);
  assert.doesNotMatch(first.content, /OPENAI_API_KEY|\/work\/project/);
});

test('launch preserves paths, identity, isolation flags, and literal arguments', () => {
  const invocation = launchArgs(store, config, ['bash', '-c', 'echo "$HOME"'], { cwd: '/work/project/sub directory', image: 'image', uid: 1234, gid: 5678, tty: false, name: 'test' });
  const { args } = invocation;
  assert.equal(invocation.workdir, '/work/project/sub directory');
  assert.ok(args.includes('--userns=keep-id'));
  assert.ok(args.includes('--init'));
  assert.equal(args[args.indexOf('--user') + 1], '1234:5678');
  assert.ok(args.includes('--cap-drop=all'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('--http-proxy=false'));
  assert.ok(!args.includes('--tty'));
  assert.ok(args.includes('/work/project:/work/project:rw'));
  assert.ok(args.includes(`/storage/projects/abc12/state:${CONTAINER_HOME}:rw`));
  assert.deepEqual(args.slice(-4), ['image', 'bash', '-c', 'echo "$HOME"']);
  assert.equal(launchArgs(store, config, ['pi'], { cwd: '/elsewhere', image: 'image' }).workdir, config.root);
});

test('extra mounts default read-only and use shared SELinux labels', () => {
  const changed = structuredClone(config);
  changed.mounts = [{ source: '/work/shared' }, { source: '/work/writable', access: 'read-write' }];
  const { args } = launchArgs(store, changed, ['pi'], { cwd: config.root, image: 'image', selinux: true, tty: true });
  assert.ok(args.includes('--tty'));
  assert.ok(args.includes('/work/project:/work/project:rw,z'));
  assert.ok(args.includes('/work/shared:/work/shared:ro,z'));
  assert.ok(args.includes('/work/writable:/work/writable:rw,z'));
  assert.ok(args.includes(`${path.join(store.projectDir(config.id), 'state')}:${CONTAINER_HOME}:rw,Z`));
});

test('only selected present credential names are forwarded, never values', () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-secret-must-not-appear';
  try {
    const { args } = launchArgs(store, config, ['pi'], { cwd: config.root, image: 'image' });
    assert.ok(args.includes('OPENAI_API_KEY'));
    assert.ok(!args.join(' ').includes(process.env.OPENAI_API_KEY));
    assert.ok(!args.includes('SSH_AUTH_SOCK'));
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  }
});
