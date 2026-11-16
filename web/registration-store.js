import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exact, idValid, generationValid } from './common.js';
import { labelValid } from './enrollment.js';

function check(stat, directory = false) {
  if (
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    (!directory && stat.nlink !== 1)
  )
    throw new Error('Unsafe registration storage.');
}
function validate(agents) {
  if (!Array.isArray(agents) || agents.length > 32) throw new Error('Invalid registrations.');
  const ids = new Set(),
    hashes = new Set(),
    clients = new Set();
  for (const a of agents) {
    if (
      !exact(a, [
        'id',
        'label',
        'kind',
        'tokenHash',
        ...(Object.hasOwn(a || {}, 'clientId') ? ['clientId'] : []),
      ]) ||
      !idValid(a.id) ||
      !labelValid(a.label) ||
      !['pi', 'dummy'].includes(a.kind) ||
      !/^[a-f0-9]{64}$/.test(a.tokenHash) ||
      (a.clientId !== undefined && !generationValid(a.clientId)) ||
      ids.has(a.id) ||
      hashes.has(a.tokenHash) ||
      (a.clientId && clients.has(a.clientId))
    )
      throw new Error('Invalid registrations.');
    ids.add(a.id);
    hashes.add(a.tokenHash);
    if (a.clientId) clients.add(a.clientId);
  }
  return agents;
}

// Host-only, lifetime exclusive ownership. Never automatically steal a stale lock.
export function openRegistrationStore(root, port) {
  const directory = path.join(root, 'web-server');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  check(fs.lstatSync(directory), true);
  const file = path.join(directory, `registrations-${port}.json`),
    lock = `${file}.lock`;
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  };
  function read() {
    let fd;
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    try {
      const stat = fs.fstatSync(fd);
      check(stat);
      if (stat.size > 65536) throw new Error('Registration storage limit.');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!exact(value, ['version', 'agents']) || value.version !== 1)
        throw new Error('Invalid registration storage.');
      return validate(value.agents);
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    fs.writeFileSync(lockFd, `${process.pid}\n`);
    const agents = read();
    let initialized = fs.existsSync(file);
    return {
      agents,
      close,
      save(next) {
        if (closed) throw new Error('Registration storage closed.');
        validate(next);
        if (initialized && !fs.existsSync(file))
          throw new Error('Registration storage disappeared.');
        read(); // Refuse changed permissions/symlinks/corruption, never silently repair.
        const temp = `${file}.${randomUUID()}.tmp`;
        let fd;
        try {
          fd = fs.openSync(temp, 'wx', 0o600);
          fs.writeFileSync(fd, `${JSON.stringify({ version: 1, agents: next })}\n`);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
          fs.renameSync(temp, file);
          initialized = true;
          const dirFd = fs.openSync(directory, 'r');
          try {
            fs.fsyncSync(dirFd);
          } finally {
            fs.closeSync(dirFd);
          }
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          fs.rmSync(temp, { force: true });
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
