// Host-only, detached housekeeping. No container command can invoke this via IPC.
import path from 'node:path';
import { Store } from './store.js';
import { pruneImages } from './prune.js';
import { writeJson } from './util.js';

process.umask(0o077);
try {
  const store = new Store(process.argv[2]);
  const result = await pruneImages(store, { automatic: true });
  if (!result.throttled) writeJson(path.join(store.root, 'prune-report.json'), { time: Date.now(), ...result });
} catch {
  // A busy cleaner or transient Podman failure is retried after a later build.
  process.exitCode = 1;
}
