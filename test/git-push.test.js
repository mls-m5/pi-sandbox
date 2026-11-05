import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { validatePushUrl, validateHostGitRequest, prepareGitPush, approveGitPush } from '../src/git-push.js';
import { restartOptions } from '../src/container.js';

const commit = 'a'.repeat(40);
const request = { type: 'git-command', repo: '.', args: ['push', 'origin', `${commit}:refs/heads/main`], reason: 'Publish reviewed changes' };

test('one typed Git command is converted to an exact push; other operations and shell syntax fail closed', () => {
  assert.deepEqual(validateHostGitRequest(request), { type: 'git-push', repo: '.', remote: 'origin', commit, ref: 'refs/heads/main', reason: request.reason });
  for (const data of [
    { ...request, args: ['push', '--force', `${commit}:refs/heads/main`] },
    { ...request, args: ['push', 'origin', 'HEAD:main'] },
    { ...request, args: ['config', 'core.sshCommand', 'evil'] },
    { ...request, args: ['push', 'origin', `${commit}:refs/heads/main`, '&&', 'evil'] },
    { ...request, repo: '../outside' }, { ...request, repo: '/tmp/repo' },
    { ...request, args: ['push', 'origin', `${commit}:refs/heads/../bad`] },
    { ...request, args: ['push', 'origin', `${commit}:refs/heads/main.lock`] },
    { ...request, reason: '\x1b[2Jfake approval' }, { ...request, approve: true },
  ]) assert.throws(() => validateHostGitRequest(data));
});

test('remote URL policy excludes helpers, local destinations, embedded credentials and shell metacharacters', () => {
  assert.equal(validatePushUrl('git@github.com:owner/repo.git'), 'ssh://git@github.com/owner/repo.git');
  assert.equal(validatePushUrl('https://example.com/owner/repo.git'), 'https://example.com/owner/repo.git');
  for (const url of ['ext::evil', 'file:///tmp/repo', '/tmp/repo', '-oProxyCommand=evil',
    'https://user:token@example.com/repo', 'https://user@example.com/repo',
    'ssh://git@example.com/repo;evil', 'ssh://git@example.com/../repo',
    'ssh://git@example.com/%2e%2e/repo', 'git@host:repo && evil',
    'ssh://git@example.com:2222/repo', 'https://example.com/repo?arg=bad', 'ssh://-host/repo']) assert.throws(() => validatePushUrl(url), url);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-git-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const env = { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello\n');
  git(['add', 'hello.txt']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'test']);
  git(['remote', 'add', 'origin', 'git@example.com:owner/repo.git']);
  const hash = git(['rev-parse', 'HEAD']);
  return { dir, root, git, proposal: validateHostGitRequest({ ...request, args: ['push', 'origin', `${hash}:refs/heads/main`] }) };
}

test('push uses a verified private snapshot, not shared hooks, config, aliases or credentials', async t => {
  const { dir, root, git, proposal } = fixture(t);
  git(['gc']); // Exercise packed object snapshots too.
  const marker = path.join(dir, 'must-not-run');
  git(['config', 'core.sshCommand', `touch ${marker}`]);
  git(['config', 'credential.helper', `!touch ${marker}`]);
  git(['config', 'alias.push', `!touch ${marker}`]);
  git(['config', 'url.ext::evil.insteadOf', 'ssh://']);
  git(['config', 'include.path', path.join(dir, 'missing-include')]);
  fs.writeFileSync(path.join(root, '.git/hooks/pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  let invocation;
  const push = await prepareGitPush({ root }, proposal, { spawnImpl(program, args, options) {
    invocation = { program, args, options };
    const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
  } });
  const snapshot = [];
  t.after(() => push.close());
  assert.equal(push.url, 'ssh://git@example.com/owner/repo.git');
  // Source changes after preparation cannot change what is pushed.
  fs.writeFileSync(path.join(root, 'hello.txt'), 'changed\n');
  await push.push();
  await assert.rejects(push.push(), /already used/);
  assert.equal(invocation.program, '/usr/bin/git');
  assert.ok(!invocation.args.includes('--force'));
  assert.ok(invocation.args.includes('--no-verify'));
  assert.ok(invocation.args.includes('core.hooksPath=/dev/null'));
  assert.ok(invocation.args.includes('http.followRedirects=false'));
  assert.ok(invocation.args.includes(`${proposal.commit}:refs/heads/main`));
  assert.ok(!invocation.options.cwd.startsWith(root));
  assert.equal(invocation.options.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(invocation.options.env.GIT_ALLOW_PROTOCOL, 'https:ssh');
  assert.match(invocation.options.env.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
  assert.match(invocation.options.env.GIT_SSH_COMMAND, /-F \/dev\/null/);
  assert.ok(!fs.existsSync(marker));
  snapshot.push(invocation.options.cwd);
  push.close();
  assert.ok(!fs.existsSync(snapshot[0]));
  const resume = restartOptions({}, [], '[pis] Host Git push succeeded. Continue the previous task.');
  assert.match(resume.args[1], /Host Git push succeeded/);
});

test('real offline Git transfer pushes the exact snapshot commit without repository hooks', async t => {
  const { dir, root, proposal } = fixture(t);
  const destination = path.join(dir, 'destination.git');
  execFileSync('/usr/bin/git', ['init', '--bare', '--template=', destination], { env: { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore' });
  const marker = path.join(dir, 'hook-must-not-run');
  fs.writeFileSync(path.join(root, '.git/hooks/pre-push'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const push = await prepareGitPush({ root }, proposal, { spawnImpl(program, args, options) {
    // Test-only transport replacement: exercise real Git against an isolated
    // local bare destination, never network/authentication or a real remote.
    const localArgs = [...args];
    localArgs[localArgs.indexOf('--') + 1] = destination;
    return spawn(program, localArgs, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' }, stdio: 'ignore' });
  } });
  t.after(() => push.close());
  await push.push();
  const actual = execFileSync('/usr/bin/git', ['--git-dir', destination, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
  assert.equal(actual, proposal.commit);
  assert.ok(!fs.existsSync(marker));
});

test('preparation rejects symlinks, missing commits and unsafe remotes without running a push', async t => {
  const { dir, root, git, proposal } = fixture(t);
  await assert.rejects(prepareGitPush({ root }, { ...proposal, commit }), /Cannot prepare safe/);
  git(['remote', 'set-url', 'origin', 'ext::evil']);
  await assert.rejects(prepareGitPush({ root }, proposal), /Cannot prepare safe/);
  git(['remote', 'set-url', 'origin', 'git@example.com:owner/repo.git']);
  fs.symlinkSync(root, path.join(dir, 'alias'));
  await assert.rejects(prepareGitPush({ root }, { ...proposal, repo: '../alias' }));
  const objects = path.join(root, '.git/objects');
  fs.renameSync(objects, `${objects}-real`);
  fs.symlinkSync(`${objects}-real`, objects);
  await assert.rejects(prepareGitPush({ root }, proposal), /Cannot prepare safe/);
});

test('host push approval shows full destination, commit and branch; decline never pushes', async () => {
  for (const answer of ['code', '', 'yes']) {
    const input = new PassThrough(); let transcript = '';
    const output = new Writable({ write(chunk, _encoding, done) {
      transcript += chunk;
      const match = chunk.toString().match(/Type (\d{2}) to approve/);
      if (match) setImmediate(() => input.write(`${answer === 'code' ? match[1] : answer}\n`));
      done();
    } });
    assert.equal(await approveGitPush({ ...validateHostGitRequest(request), url: 'ssh://git@example.com/owner/repo.git' }, { input, output }), answer === 'code');
    assert.ok(transcript.includes(commit));
    assert.match(transcript, /Destination: ssh:\/\/git@example.com\/owner\/repo.git/);
    assert.match(transcript, /Branch: refs\/heads\/main/);
    input.destroy(); output.destroy();
  }
});
