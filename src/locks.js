import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assert, lockOwnerState, run } from './util.js';

export function maintenanceEnvironment(source = process.env) {
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
    'CONTAINERS_CONF',
    'CONTAINERS_STORAGE_CONF',
    'CONTAINERS_REGISTRIES_CONF',
    'CONTAINER_HOST',
    'CONTAINER_CONNECTION',
  ];
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

function readLock(file, keepOpen = false) {
  let fd,
    success = false;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        stat.size > 0 &&
        stat.size <= 4096,
      'unsafe',
    );
    const buffer = Buffer.alloc(4097);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    assert(length <= 4096, 'unsafe');
    const text = buffer.subarray(0, length).toString('utf8');
    const owner = JSON.parse(text);
    assert(
      owner &&
        !Array.isArray(owner) &&
        Object.keys(owner).every((key) =>
          ['pid', 'version', 'nonce', 'bootId', 'startTime'].includes(key),
        ),
      'unsafe',
    );
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid <= 2147483647, 'unsafe');
    assert(owner.version === undefined || owner.version === 1, 'unsafe');
    assert(
      owner.nonce === undefined ||
        (typeof owner.nonce === 'string' && /^[a-f0-9]{32}$/.test(owner.nonce)),
      'unsafe',
    );
    assert(
      owner.bootId === undefined ||
        (typeof owner.bootId === 'string' &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.bootId)),
      'unsafe',
    );
    assert(
      owner.startTime === undefined ||
        (typeof owner.startTime === 'string' && /^\d{1,32}$/.test(owner.startTime)),
      'unsafe',
    );
    success = true;
    return { stat, text, owner, ...(keepOpen ? { fd } : {}) };
  } finally {
    if (fd !== undefined && (!keepOpen || !success)) fs.closeSync(fd);
  }
}

export function inspectLock(file) {
  try {
    const { owner } = readLock(file);
    const state = lockOwnerState(owner);
    return {
      status: state === 'dead' ? 'stale' : state === 'alive' ? 'locked' : 'unknown-owner',
      pid: owner.pid,
    };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'absent' : 'unsafe' };
  }
}

export function projectContainers(id, { execute = spawnSync } = {}) {
  const invoke = (args) => {
    const result = execute('podman', args, {
      env: maintenanceEnvironment(),
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert(
      !result.error && result.status === 0,
      'Cannot verify local rootless Podman; project lock was kept.',
    );
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('Cannot verify local rootless Podman; project lock was kept.');
    }
  };
  const info = invoke(['info', '--format', 'json']);
  assert(
    info.host?.security?.rootless === true && info.host.serviceIsRemote === false,
    'Cannot verify local rootless Podman; project lock was kept.',
  );
  const containers = invoke(['ps', '--all', '--format', 'json']);
  assert(Array.isArray(containers), 'Invalid container inventory; project lock was kept.');
  return containers.flatMap((container) => {
    const names = typeof container.Names === 'string' ? [container.Names] : container.Names;
    assert(
      Array.isArray(names) && names.every((name) => typeof name === 'string'),
      'Invalid container inventory; project lock was kept.',
    );
    return names.filter((name) => name.startsWith(`pis-${id}-`));
  });
}

// Called only while the recovery worker owns the kernel flock. Normal lock
// acquisition cannot replace an existing stale file; competing recoveries serialize.
export function recoverLock(
  file,
  scope,
  {
    dryRun = false,
    ownerState = lockOwnerState,
    containers = projectContainers,
    projectId,
    beforeRemove = () => {},
  } = {},
) {
  const result = { scope, file };
  let original;
  try {
    original = readLock(file, true);
  } catch (error) {
    if (error.code === 'ENOENT') return { ...result, status: 'absent' };
    return {
      ...result,
      status: 'blocked',
      reason:
        'Lock must be private, owned, regular, singly linked and contain valid bounded owner metadata. No contents were printed.',
    };
  }
  try {
    result.pid = original.owner.pid;
    if (ownerState(original.owner) !== 'dead')
      return {
        ...result,
        status: 'blocked',
        reason: 'Owner is alive or cannot be verified as dead.',
      };
    if (projectId) {
      try {
        if (containers(projectId).length)
          return {
            ...result,
            status: 'blocked',
            reason:
              'A project container still exists (including stopped/paused containers). No container was stopped or deleted.',
          };
      } catch {
        return {
          ...result,
          status: 'blocked',
          reason: 'Cannot verify local rootless Podman/container inventory; project lock was kept.',
        };
      }
    }
    beforeRemove();
    try {
      const current = readLock(file);
      assert(
        current.stat.dev === original.stat.dev &&
          current.stat.ino === original.stat.ino &&
          current.text === original.text &&
          current.stat.ctimeMs === original.stat.ctimeMs &&
          ownerState(current.owner) === 'dead',
        'changed',
      );
      if (!dryRun) fs.unlinkSync(file);
      return { ...result, status: dryRun ? 'would-remove' : 'removed' };
    } catch {
      return {
        ...result,
        status: 'blocked',
        reason: 'Lock changed during recovery; nothing further was removed.',
      };
    }
  } finally {
    fs.closeSync(original.fd);
  }
}

export function recoverProjectLocks(store, { cwd, project, dryRun = false, ...dependencies } = {}) {
  const locks = [
    recoverLock(path.join(store.root, 'registry.lock'), 'registry', { dryRun, ...dependencies }),
  ];
  // Host-only prune worker mutex; it grants no container/state mutation itself.
  // Recover only an existing, independently proven-dead private lock using the
  // same inode/owner rechecks and kernel-flock guard as other recoveries.
  const prune = path.join(store.root, 'prune.lock');
  try {
    fs.lstatSync(prune);
    locks.push(recoverLock(prune, 'prune', { dryRun, ...dependencies }));
  } catch (error) {
    if (error.code !== 'ENOENT')
      locks.push({
        scope: 'prune',
        status: 'blocked',
        reason: 'Cannot inspect prune worker lock.',
      });
  }
  const auth = path.join(store.root, 'auth'),
    codex = path.join(auth, 'openai-codex.lock');
  try {
    fs.lstatSync(codex);
    const stat = fs.lstatSync(auth);
    assert(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        fs.realpathSync(auth) === auth,
      'unsafe',
    );
    // Host-only refresh/account metadata: no container inventory is needed and
    // no credential is read, changed, revoked or recovered by unlocking.
    locks.push(recoverLock(codex, 'codex-auth', { dryRun, ...dependencies }));
  } catch (error) {
    if (error.code !== 'ENOENT')
      locks.push({
        scope: 'codex-auth',
        status: 'blocked',
        reason: 'Cannot safely inspect private canonical Codex auth storage; lock kept.',
      });
  }
  // Registry recovery does not require Podman or a selected project and may
  // proceed while unrelated containers run. It only protects registry writes.
  let selected;
  try {
    selected = store.select(cwd, project);
  } catch (error) {
    if (!project && error.message.startsWith('No pis project found')) return { locks };
    locks.push({
      scope: 'project',
      status: 'blocked',
      reason:
        'Cannot select project from its configuration; registry recovery result is shown separately.',
    });
    return { locks };
  }
  const dir = store.projectDir(selected.id);
  try {
    assert(fs.realpathSync(dir) === dir && fs.lstatSync(dir).uid === process.getuid(), 'unsafe');
  } catch {
    locks.push({
      scope: 'project',
      status: 'blocked',
      reason: 'Project storage must be canonical and owned by you.',
    });
    return { locks };
  }
  locks.push(
    recoverLock(path.join(dir, 'project.lock'), 'project', {
      dryRun,
      projectId: selected.id,
      ...dependencies,
    }),
  );
  const updates = path.join(dir, 'updates.lock');
  try {
    fs.lstatSync(updates);
    locks.push(
      recoverLock(updates, 'updates', { dryRun, projectId: selected.id, ...dependencies }),
    );
  } catch (error) {
    if (error.code !== 'ENOENT')
      locks.push({ scope: 'updates', status: 'blocked', reason: 'Cannot inspect update lock.' });
  }
  return { locks };
}

export async function unlockLocks(store, { cwd, project, dryRun = false } = {}) {
  try {
    fs.accessSync('/usr/bin/flock', fs.constants.X_OK);
  } catch {
    throw new Error('Safe lock recovery requires /usr/bin/flock (util-linux) on the host.');
  }
  const guard = path.join(store.root, 'lock-recovery.flock');
  const fd = fs.openSync(
    guard,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
      'Recovery guard must be a private regular file owned by you.',
    );
    const code = await run(
      '/usr/bin/flock',
      [
        '--exclusive',
        '--nonblock',
        '--no-fork',
        '--conflict-exit-code',
        '75',
        '/proc/self/fd/3',
        process.execPath,
        fileURLToPath(new URL('./unlock-worker.js', import.meta.url)),
        store.root,
        cwd,
        project || '',
        dryRun ? '1' : '0',
      ],
      {
        env: maintenanceEnvironment(),
        stdio: ['inherit', 'inherit', 'inherit', fd],
      },
    );
    assert(code !== 75, 'Another lock recovery is already running. Try again after it finishes.');
    return code;
  } finally {
    fs.closeSync(fd);
  }
}
