import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function overlap(a, b) {
  return within(a, b) || within(b, a);
}

export function directory(input) {
  assert(
    typeof input === 'string' && path.isAbsolute(input),
    `Expected an absolute directory: ${input}`,
  );
  const resolved = fs.realpathSync(input);
  assert(fs.statSync(resolved).isDirectory(), `Not a directory: ${input}`);
  return resolved;
}

export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function atomicWrite(file, data) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function stripJsonComments(text) {
  let output = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i],
      next = text[i + 1];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      if (i < text.length) output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated comment.');
      const comment = text.slice(i, end + 2);
      output += comment.replace(/[^\r\n]/g, ' ');
      i = end + 1;
      continue;
    }
    output += char;
  }
  return output;
}

export function readJson(file) {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`Cannot read JSON at ${file}: ${error.message}`);
  }
}

export function processIdentity(pid = process.pid) {
  const result = {};
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (/^[a-f0-9-]{36}$/.test(bootId)) result.bootId = bootId;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTime = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    if (/^\d{1,32}$/.test(startTime)) result.startTime = startTime;
  } catch {
    /* Legacy/PID-only locks remain conservatively recoverable. */
  }
  return result;
}

export function lockOwnerState(record, { kill = process.kill, identity = processIdentity } = {}) {
  const current = identity(record.pid);
  if (record.bootId && current.bootId && record.bootId !== current.bootId) return 'dead';
  if (
    record.bootId &&
    record.bootId === current.bootId &&
    record.startTime &&
    current.startTime &&
    record.startTime !== current.startTime
  )
    return 'dead';
  try {
    kill(record.pid, 0);
    return 'alive';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function removeOwnLock(file, snapshot) {
  try {
    const current = fs.lstatSync(file);
    if (current.dev === snapshot.dev && current.ino === snapshot.ino) fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function withLock(file, action, { retainOnError = () => false } = {}) {
  // Recovery is explicit and serialized by a kernel flock, never based on age.
  let fd, snapshot;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    snapshot = fs.fstatSync(fd);
    fs.writeFileSync(
      fd,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        nonce: randomBytes(16).toString('hex'),
        ...processIdentity(),
      }),
    );
  } catch (error) {
    if (fd !== undefined) {
      try {
        if (snapshot) removeOwnLock(file, snapshot);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(
      new Error(
        `Resource is busy (${file}). On the host, run pis --unlock --dry-run to inspect stale locks, then pis --unlock to recover them. Live or unverifiable owners are never removed.`,
      ),
      { code: 'PIS_LOCKED' },
    );
  }
  let retain = false;
  try {
    return await action();
  } catch (error) {
    retain = retainOnError(error) === true;
    throw error;
  } finally {
    try {
      if (!retain) removeOwnLock(file, snapshot);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function run(program, args, options = {}) {
  const { shutdownTimeoutMs = 5_000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', ...spawnOptions });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let shutdownTimer;
    let terminationSignal;
    const handlers = signals.map((signal) => {
      const handler = () => {
        child.kill(signal);
        // Ctrl-C may be handled by an interactive application. Termination must
        // eventually return control so the caller can clean up its container.
        if (signal !== 'SIGINT' && !shutdownTimer) {
          terminationSignal = signal;
          shutdownTimer = setTimeout(() => child.kill('SIGKILL'), shutdownTimeoutMs);
          shutdownTimer.unref();
        }
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const cleanup = () => {
      clearTimeout(shutdownTimer);
      handlers.forEach(([signal, handler]) => process.off(signal, handler));
    };
    child.once('error', (error) => {
      cleanup();
      reject(new Error(`Cannot start ${program}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(
        terminationSignal
          ? 128 + os.constants.signals[terminationSignal]
          : (code ?? 128 + (os.constants.signals[signal] || 1)),
      );
    });
  });
}

// Shell-like quoting for editor command configuration, without evaluating shell syntax.
export function splitCommand(text) {
  const words = [];
  let word = '',
    quote = '',
    escaped = false,
    started = false;
  for (const char of text) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  assert(!quote && !escaped, 'Unterminated quoting in editor command.');
  if (started) words.push(word);
  assert(words.length && words[0], 'Editor command is empty.');
  return words;
}
