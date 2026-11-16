import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const sha = (value) => /^[a-f0-9]{40}$/.test(value);
export function publicGithubUrl(value) {
  return (
    typeof value === 'string' &&
    /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value) &&
    !value.endsWith('/..') &&
    !value.endsWith('/.')
  );
}
export function createServerUpdater({ root, restart, run, validateCandidate, enabled = false }) {
  let state = { phase: enabled ? 'idle' : 'unavailable' },
    active = false;
  const git =
    run ||
    (async (args) => {
      const { stdout } = await exec(
        '/usr/bin/git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'submodule.recurse=false',
          '-c',
          'credential.helper=',
          '-c',
          'http.followRedirects=false',
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          ...args,
        ],
        {
          cwd: root,
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/nonexistent-pis-update-home',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/bin/false',
            LC_ALL: 'C',
          },
        },
      );
      return stdout.trim();
    });
  async function inspect() {
    if (!enabled) throw new Error('update_unavailable');
    const top = await git(['rev-parse', '--show-toplevel']);
    if (
      fs.realpathSync(top) !== fs.realpathSync(root) ||
      !fs.lstatSync(path.join(root, '.git')).isDirectory()
    )
      throw new Error('update_checkout');
    // Includes and configured filters could execute host programs during checkout.
    const config = await git(['config', '--local', '--no-includes', '--list']);
    if (
      /^(include\.|includeif\.|filter\.|url\.|http\.|core\.worktree=|extensions\.)/im.test(config)
    )
      throw new Error('update_config');
    if (await git(['status', '--porcelain', '--untracked-files=all']))
      throw new Error('update_dirty');
    const branch = await git(['symbolic-ref', '--short', 'HEAD']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..'))
      throw new Error('update_branch');
    const remote = await git([
      'config',
      '--local',
      '--no-includes',
      '--get',
      `branch.${branch}.remote`,
    ]);
    const ref = await git([
      'config',
      '--local',
      '--no-includes',
      '--get',
      `branch.${branch}.merge`,
    ]);
    if (remote !== 'origin' || ref !== `refs/heads/${branch}`) throw new Error('update_branch');
    const url = await git(['config', '--local', '--no-includes', '--get-all', 'remote.origin.url']);
    if (!publicGithubUrl(url)) throw new Error('update_source');
    const head = await git(['rev-parse', 'HEAD']);
    if (!sha(head)) throw new Error('update_checkout');
    return { branch, url, head };
  }
  async function validate(target) {
    if (validateCandidate) return validateCandidate(target);
    const files = (await git(['ls-tree', '-r', '--name-only', target]))
      .split('\n')
      .filter((file) => /\.(?:js|mjs|sh)$/.test(file));
    if (files.length > 1000) throw new Error('update_validation_failed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-server-check-'));
    let bytes = 0;
    try {
      for (const [index, file] of files.entries()) {
        if (!/^[A-Za-z0-9_./-]+$/.test(file)) throw new Error('update_validation_failed');
        const source = await git(['show', `${target}:${file}`]);
        bytes += Buffer.byteLength(source);
        if (bytes > 16 * 1024 * 1024) throw new Error('update_validation_failed');
        const shell = file.endsWith('.sh'),
          destination = path.join(directory, `${index}.${shell ? 'sh' : 'mjs'}`);
        fs.writeFileSync(destination, source, { mode: 0o600 });
        await exec(
          shell ? '/bin/bash' : process.execPath,
          [shell ? '-n' : '--check', destination],
          { timeout: 10000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  async function perform() {
    let phase = 'checking',
      target;
    const fetchedRef = `refs/pis-server-updates/${randomUUID()}`;
    try {
      const before = await inspect();
      phase = 'fetching';
      state = { phase };
      await git([
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--',
        before.url,
        `refs/heads/${before.branch}:${fetchedRef}`,
      ]);
      target = await git(['rev-parse', fetchedRef]);
      if (!sha(target)) throw new Error('update_source');
      if (target === before.head) {
        state = { phase: 'current' };
        return;
      }
      await git(['merge-base', '--is-ancestor', before.head, target]);
      // Dependency changes require deliberate installation, never execute npm lifecycle scripts here.
      const changed = await git([
        'diff',
        '--name-only',
        before.head,
        target,
        '--',
        'package.json',
        'package-lock.json',
        'web/package.json',
        'web/package-lock.json',
        '.gitmodules',
        '.npmrc',
        'web/.npmrc',
        'web/supervisor.js',
      ]);
      if (changed) throw new Error('update_dependencies');
      phase = 'validating';
      state = { phase };
      await validate(target);
      const after = await inspect();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('update_changed');
      phase = 'activating';
      state = { phase };
      await git(['merge', '--ff-only', '--no-edit', '--no-stat', target]);
      // Existing server remains loaded until controlled supervisor restart; no model commands.
      state = { phase: 'restarting' };
      await restart();
    } catch (error) {
      const allowed = new Set([
        'update_unavailable',
        'update_checkout',
        'update_config',
        'update_dirty',
        'update_branch',
        'update_source',
        'update_dependencies',
        'update_changed',
      ]);
      state = {
        phase: 'failed',
        error: allowed.has(error.message) ? error.message : `update_${phase}_failed`,
      };
    } finally {
      if (sha(target)) {
        try {
          await git(['update-ref', '-d', fetchedRef, target]);
        } catch {}
      }
      active = false;
    }
  }
  return {
    status: () => ({ ...state }),
    start() {
      if (!enabled) return false;
      if (active || state.phase === 'restarting') return false;
      active = true;
      state = { phase: 'checking' };
      void perform();
      return true;
    },
  };
}
