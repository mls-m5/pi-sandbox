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
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function overlap(a, b) { return within(a, b) || within(b, a); }

export function directory(input) {
  assert(typeof input === 'string' && path.isAbsolute(input), `Expected an absolute directory: ${input}`);
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

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON at ${file}: ${error.message}`); }
}

export async function withLock(file, action) {
  // Do not automatically unlink stale locks: competing recoveries can break exclusivity.
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`Resource is busy (${file}). If a previous pis crashed, inspect the lock PID and remove it only after confirming no pis/container is using this project.`), { code: 'PIS_LOCKED' });
  }
  try { return await action(); }
  finally { fs.rmSync(file, { force: true }); }
}

export function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', ...options });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let shutdownTimer;
    let terminationSignal;
    const handlers = signals.map(signal => {
      const handler = () => {
        child.kill(signal);
        // Ctrl-C may be handled by an interactive application. Termination must
        // eventually return control so the caller can clean up its container.
        if (signal !== 'SIGINT' && !shutdownTimer) {
          terminationSignal = signal;
          shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
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
    child.once('error', error => { cleanup(); reject(new Error(`Cannot start ${program}: ${error.message}`)); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(terminationSignal ? 128 + os.constants.signals[terminationSignal] : code ?? (128 + (os.constants.signals[signal] || 1)));
    });
  });
}

// Shell-like quoting for editor command configuration, without evaluating shell syntax.
export function splitCommand(text) {
  const words = [];
  let word = '', quote = '', escaped = false, started = false;
  for (const char of text) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  assert(!quote && !escaped, 'Unterminated quoting in editor command.');
  if (started) words.push(word);
  assert(words.length && words[0], 'Editor command is empty.');
  return words;
}
