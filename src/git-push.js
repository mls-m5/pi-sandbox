import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { assert, within } from './util.js';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const exec = promisify(execFile);
const GIT = '/usr/bin/git';
const SSH = '/usr/bin/ssh';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function validateHostGitRequest(data) {
  assert(data && data.type === 'git-command' && Object.keys(data).every(key => ['type', 'repo', 'args', 'reason'].includes(key)), 'Invalid host Git request.');
  assert(Array.isArray(data.args) && data.args.length === 3 && data.args.every(arg => typeof arg === 'string') && data.args[0] === 'push', 'Only git push REMOTE COMMIT:refs/heads/BRANCH is supported on the host for now.');
  const refspec = data.args[2].match(/^([a-f0-9]{40}):(refs\/heads\/.+)$/);
  assert(refspec, 'An exact commit and destination branch are required.');
  return validateGitPushProposal({ type: 'git-push', repo: data.repo, remote: data.args[1], commit: refspec[1], ref: refspec[2], reason: data.reason });
}

export async function approveGitPush(push, { input = process.stdin, output = process.stderr } = {}) {
  const color = Boolean(output.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const style = (text, code) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const width = Number.isFinite(output.columns) ? Math.max(1, Math.min(500, output.columns)) : 80;
  const rule = style('─'.repeat(width), '31');
  const code = String(randomInt(10, 100));
  output.write(`\n${rule}\n${style('pis · Host Git push approval', '1')}\n\nRepository: ${push.repo}\nRemote: ${push.remote}\n${style('Destination:', '1')} ${push.url}\n${style('Commit:', '1')} ${push.commit}\nBranch: ${push.ref}\n\n${style('Reason supplied by the sandbox (untrusted):', '2')}\n  ${push.reason}\n\nPush runs on the host, without force or repository hooks.\nAfter success Pi restarts and the agent continues (uses model tokens).\n${rule}\n`);
  const prompt = createInterface({ input, output });
  try { return (await prompt.question(`Type ${style(code, '1;36')} to approve (Enter or any other answer declines): `)).trim() === code; }
  finally { prompt.close(); }
}

export function validateGitPushProposal(data) {
  assert(data && data.type === 'git-push' && Object.keys(data).every(key => ['type', 'repo', 'remote', 'commit', 'ref', 'reason'].includes(key)), 'Invalid git push proposal.');
  assert(typeof data.repo === 'string' && (data.repo === '.' || /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,255}$/.test(data.repo)) && data.repo.split('/').every(part => part !== '..' && part !== ''), 'Repository must be a relative project path.');
  assert(typeof data.remote === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.remote), 'Invalid remote name.');
  assert(typeof data.commit === 'string' && /^[a-f0-9]{40}$/.test(data.commit), 'An exact full SHA-1 commit is required.');
  assert(typeof data.ref === 'string' && /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(data.ref) && !data.ref.includes('..') && data.ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'An explicit destination branch ref is required.');
  assert(typeof data.reason === 'string' && data.reason.trim().length > 0 && data.reason.length <= 500 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(data.reason), 'Invalid reason.');
  return { type: 'git-push', repo: data.repo, remote: data.remote, commit: data.commit, ref: data.ref, reason: data.reason.trim() };
}

export function validatePushUrl(input) {
  assert(typeof input === 'string' && input.length <= 2048 && !/[\s\x00-\x1f\x7f-\x9f]/.test(input), 'Invalid remote URL.');
  // Normalize scp-style SSH into an unambiguous URL. No local/file/ext helpers.
  const scp = input.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*)@([A-Za-z0-9.-]+):([A-Za-z0-9_][A-Za-z0-9._/-]*)$/);
  const raw = scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : input;
  assert(!/%|\\|[?#]/.test(raw), 'Encoded or ambiguous remote URLs are not supported.');
  const match = raw.match(/^(https|ssh):\/\/(?:([A-Za-z0-9_][A-Za-z0-9_-]*)@)?([A-Za-z0-9.-]+)(\/.*)$/);
  assert(match, 'Only HTTPS and SSH remotes on standard ports are supported.');
  const [, protocol, user, host, repoPath] = match;
  assert(protocol === 'ssh' || !user, 'HTTPS URLs must not contain credentials.');
  assert(host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)), 'Invalid remote hostname.');
  assert(/^\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(repoPath) && repoPath.split('/').slice(1).every(part => part && part !== '.' && part !== '..'), 'Unsafe repository URL path.');
  return `${protocol}://${user ? `${user}@` : ''}${host.toLowerCase()}${repoPath}`;
}

function regular(file, maxSize) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxSize, 'Unsafe Git object/config file.');
  return stat;
}

function directory(dir) {
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Git directories must not be symlinks.');
}

function gitEnvironment(home, hostHome = os.homedir()) {
  // Deliberately do not inherit GIT_*, NODE_*, LD_*, proxy settings or config.
  const knownHosts = path.join(hostHome, '.ssh', 'known_hosts');
  const env = {
    PATH: '/usr/bin:/bin', HOME: hostHome, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: home,
    GIT_TERMINAL_PROMPT: '1', GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_SSH_VARIANT: 'ssh',
    GIT_SSH_COMMAND: `${SSH} -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none -o ProxyJump=none -o ${quote(`UserKnownHostsFile=${knownHosts}`)}`,
  };
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  return env;
}

// Snapshot object data into a fresh bare repo. Never execute Git in the shared
// working tree, and never copy its config, hooks, refs, alternates or helpers.
export async function prepareGitPush(config, proposal, { spawnImpl = spawn } = {}) {
  proposal = validateGitPushProposal(proposal);
  const root = fs.realpathSync(config.root);
  const repo = path.resolve(root, proposal.repo);
  assert(within(root, repo) && fs.realpathSync(repo) === repo, 'Repository must remain inside the registered project, without symlinks.');
  const gitDir = path.join(repo, '.git');
  directory(gitDir); // Worktrees/submodules using .git files are not supported yet.
  const sourceConfig = path.join(gitDir, 'config');
  regular(sourceConfig, 128 * 1024);
  const temp = fs.mkdtempSync('/tmp/pis-push-');
  fs.chmodSync(temp, 0o700);
  const env = gitEnvironment(temp);
  const git = async args => (await exec(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], {
    cwd: temp, env, timeout: 120_000, maxBuffer: 1024 * 1024,
  })).stdout.trim();
  try {
    const readRemote = async key => {
      try { return (await git(['config', '--no-includes', '--file', sourceConfig, '--get-all', key])).split('\n'); }
      catch (error) { if (error.code === 1) return []; throw new Error('Cannot read Git remote.'); }
    };
    const pushUrls = await readRemote(`remote.${proposal.remote}.pushurl`);
    const urls = pushUrls.length ? pushUrls : await readRemote(`remote.${proposal.remote}.url`);
    assert(urls.length === 1, 'Remote must have exactly one push destination.');
    const url = validatePushUrl(urls[0]);
    const bare = path.join(temp, 'repo.git');
    await git(['init', '--bare', '--template=', bare]);
    await git(['--git-dir', bare, 'check-ref-format', proposal.ref]);
    const objects = path.join(gitDir, 'objects');
    directory(objects);
    let bytes = 0, files = 0;
    const copy = (source, destination) => {
      const stat = regular(source, 2 * 1024 ** 3);
      bytes += stat.size; files++;
      assert(bytes <= 2 * 1024 ** 3 && files <= 100000, 'Repository snapshot exceeds the 2 GiB / 100000 object-file limit.');
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
    };
    for (const entry of fs.readdirSync(objects)) {
      if (!/^[a-f0-9]{2}$/.test(entry) && entry !== 'pack') continue;
      const source = path.join(objects, entry);
      directory(source);
      const destination = path.join(bare, 'objects', entry);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(source)) {
        if (entry === 'pack' ? !/^pack-[a-f0-9]{40}\.(pack|idx)$/.test(name) : !/^[a-f0-9]{38}$/.test(name)) continue;
        copy(path.join(source, name), path.join(destination, name));
      }
    }
    assert(await git(['--git-dir', bare, 'cat-file', '-t', proposal.commit]) === 'commit', 'Requested object is not a commit.');
    await git(['--git-dir', bare, 'update-ref', 'refs/heads/pis-approved', proposal.commit]);
    await git(['--git-dir', bare, 'fsck', '--full', '--strict', '--no-reflogs']);
    let closed = false, used = false;
    return {
      ...proposal, url,
      async push() {
        assert(!closed && !used, 'Push snapshot has been closed or already used.');
        used = true;
        // Exact commit and explicit ref, no force, no repository hooks/config.
        const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '--git-dir', bare,
          'push', '--porcelain', '--no-verify', '--recurse-submodules=no', '--', url, `${proposal.commit}:${proposal.ref}`];
        return new Promise((resolve, reject) => {
          const child = spawnImpl(GIT, args, { cwd: temp, env, stdio: 'inherit' });
          child.once('error', () => reject(new Error('Cannot start host Git push.')));
          child.once('exit', code => code === 0 ? resolve() : reject(new Error('Git push failed; no automatic retry was made.')));
        });
      },
      close() { if (!closed) { closed = true; fs.rmSync(temp, { recursive: true, force: true }); } },
    };
  } catch {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error('Cannot prepare safe host Git push. Check the remote URL, commit, repository layout and object integrity. Only ordinary SHA-1 .git directories and SSH/HTTPS remotes are supported.');
  }
}
