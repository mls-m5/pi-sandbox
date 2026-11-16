import fs from 'node:fs';
import path from 'node:path';
import { assert, privateDir, writeJson } from './util.js';

// Only Pi's persisted ~/.pi tree, not the potentially huge SDK/tooling in HOME.
// Backups are outside all runtime mounts. Links are recorded as inert JSON and
// are never followed or recreated. There is deliberately no automatic restore.
export function backupPiState(
  store,
  config,
  { from, to, maxBytes = 256 * 1024 * 1024, maxEntries = 20000, maxMs = 15000 } = {},
) {
  const project = store.projectDir(config.id),
    state = path.join(project, 'state');
  const backup = path.join(project, 'update-backup'),
    old = path.join(project, 'update-backup.old');
  const started = Date.now(),
    links = [];
  let bytes = 0,
    entries = 0,
    linkBytes = 0,
    temp;
  const directory = (file) => {
    const stat = fs.lstatSync(file);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(),
      'Unsafe Pi state directory.',
    );
    return stat;
  };
  const ownedBackup = (file) => {
    try {
      const stat = directory(file);
      assert((stat.mode & 0o077) === 0, 'Backup must be private.');
      const marker = path.join(file, 'backup.json');
      const fd = fs.openSync(
        marker,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const meta = fs.fstatSync(fd);
        assert(
          meta.isFile() && meta.nlink === 1 && meta.size <= 4096 && meta.uid === process.getuid(),
          'Unsafe backup marker.',
        );
        const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
        assert(
          data.version === 1 && data.project === config.id && data.scope === 'state/.pi',
          'Unrecognized backup directory.',
        );
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' && !fs.existsSync(file)) return false;
      throw error;
    }
  };
  const copy = (source, destination, relative) => {
    assert(
      ++entries <= maxEntries && Date.now() - started <= maxMs,
      'Pi state backup limit exceeded.',
    );
    const before = fs.lstatSync(source);
    if (before.isSymbolicLink()) {
      const record = { path: relative, target: fs.readlinkSync(source) };
      const size = Buffer.byteLength(JSON.stringify(record)) + 32; // Includes pretty-JSON overhead.
      assert(
        (linkBytes += size) <= 1024 * 1024 && (bytes += size) <= maxBytes,
        'Pi state link metadata limit exceeded.',
      );
      links.push(record);
      return;
    }
    assert(before.uid === process.getuid(), 'Pi state ownership changed.');
    if (before.isDirectory()) {
      privateDir(destination);
      for (const name of fs.readdirSync(source))
        copy(
          path.join(source, name),
          path.join(destination, name),
          path.posix.join(relative, name),
        );
      const after = fs.lstatSync(source);
      assert(
        after.dev === before.dev && after.ino === before.ino && after.mtimeMs === before.mtimeMs,
        'Pi state changed during backup.',
      );
      return;
    }
    assert(
      before.isFile() && before.nlink === 1 && (bytes += before.size) <= maxBytes,
      'Pi state backup size/type limit exceeded.',
    );
    const fd = fs.openSync(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const opened = fs.fstatSync(fd);
      assert(
        opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size,
        'Pi state changed during backup.',
      );
      const output = fs.openSync(
        destination,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let count,
          copied = 0;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length)) !== 0) {
          copied += count;
          assert(
            copied <= before.size && Date.now() - started <= maxMs,
            'Pi state changed or backup timed out.',
          );
          let written = 0;
          while (written < count) written += fs.writeSync(output, buffer, written, count - written);
        }
        const after = fs.fstatSync(fd);
        assert(
          copied === before.size && after.mtimeMs === before.mtimeMs && after.nlink === 1,
          'Pi state changed during backup.',
        );
      } finally {
        fs.closeSync(output);
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const hadBackup = ownedBackup(backup),
      hadOld = ownedBackup(old);
    temp = fs.mkdtempSync(path.join(project, 'update-backup-pending-'));
    privateDir(temp);
    directory(state);
    const pi = path.join(state, '.pi');
    let exists = false;
    try {
      directory(pi);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exists) copy(pi, path.join(temp, 'pi'), '.pi');
    writeJson(path.join(temp, 'symlinks.json'), links);
    writeJson(path.join(temp, 'backup.json'), {
      version: 1,
      project: config.id,
      scope: 'state/.pi',
      from,
      to,
      createdAt: new Date().toISOString(),
      bytes,
      entries,
    });
    if (hadOld) fs.rmSync(old, { recursive: true });
    if (hadBackup) fs.renameSync(backup, old);
    fs.renameSync(temp, backup);
    temp = undefined;
    if (hadBackup) fs.rmSync(old, { recursive: true });
    return { directory: 'update-backup', scope: 'state/.pi', bytes, entries };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
