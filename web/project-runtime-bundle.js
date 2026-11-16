import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const digest = (data) => createHash('sha256').update(data).digest('hex');
function privateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw new Error('Unsafe runtime bundle directory.');
}
function readCode(file, { privateFile = false } = {}) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 1024 * 1024 ||
      (privateFile && (stat.uid !== process.getuid() || stat.mode & 0o077)) ||
      fs.realpathSync(file) !== file
    )
      throw new Error('Unsafe runtime code file.');
    const data = Buffer.alloc(stat.size + 1);
    let bytes = 0,
      read;
    while (bytes < data.length && (read = fs.readSync(fd, data, bytes, data.length - bytes, null)))
      bytes += read;
    if (bytes !== stat.size || fs.fstatSync(fd).mtimeMs !== stat.mtimeMs)
      throw new Error('Runtime code changed during capture.');
    return data.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

// Capture the trusted installation *before* launching agent tools. Future idle
// replacements must not execute a wrapper the agent edited in its project.
// Content-addressed bundles are retained: detached maintenance may still use them.
export function captureProjectRuntime(
  storeRoot,
  sourceRoot = fileURLToPath(new URL('../', import.meta.url)),
) {
  if (!path.isAbsolute(storeRoot)) throw new Error('Expected private host storage.');
  sourceRoot = fs.realpathSync(sourceRoot);
  privateDirectory(storeRoot);
  const files = new Map([['package.json', Buffer.from('{"type":"module"}\n')]]);
  let bytes = 0,
    entriesSeen = 0;
  function add(relative) {
    const data = readCode(path.join(sourceRoot, relative));
    bytes += data.length;
    if (files.size >= 256 || bytes > 8 * 1024 * 1024) throw new Error('Runtime bundle limit.');
    files.set(relative, data);
  }
  function walk(relative, depth = 0) {
    if (depth > 8) throw new Error('Runtime bundle nesting limit.');
    const directory = path.join(sourceRoot, relative),
      stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe source directory.');
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > 256) throw new Error('Runtime bundle directory limit.');
    for (const entry of entries) {
      if (++entriesSeen > 512) throw new Error('Runtime bundle entry limit.');
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name)) throw new Error('Unsafe source filename.');
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(name, depth + 1);
      } else if (/\.(?:js|mjs)$/.test(entry.name) || name === 'src/runtime/pi-launcher') add(name);
    }
  }
  walk('src');
  add('bin/pis-project-rpc.js');
  const hash = createHash('sha256');
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(name).update('\0').update(data).update('\0');
  const cache = path.join(storeRoot, 'web-runtime-code');
  privateDirectory(cache);
  const directory = path.join(cache, hash.digest('hex'));
  if (!fs.existsSync(directory)) {
    const temporary = fs.mkdtempSync(path.join(cache, '.prepare-'));
    try {
      for (const [name, data] of files) {
        const file = path.join(temporary, name);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
      }
      try {
        fs.renameSync(temporary, directory);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  const expected = new Map([...files].map(([name, data]) => [name, digest(data)]));
  files.clear();
  function verify() {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077
    )
      throw new Error('Unsafe runtime bundle.');
    for (const [name, value] of expected)
      if (digest(readCode(path.join(directory, name), { privateFile: true })) !== value)
        throw new Error('Runtime bundle integrity failure.');
  }
  verify();
  return { entry: path.join(directory, 'bin/pis-project-rpc.js'), verify };
}
