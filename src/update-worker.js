// Host-only optional maintenance. No model capability/auth is inherited and no
// candidate package is imported/executed here: package code runs only in Podman.
import { Store } from './store.js';
import { prepareUpdates } from './updates.js';

process.umask(0o077);
try {
  const store = new Store(process.argv[2]);
  const result = await prepareUpdates(store, process.argv[3]);
  if (result.failed) process.exitCode = 1;
} catch {
  // A busy/stale update lock is not stolen. Normal launches remain usable;
  // --updates status and --unlock expose explicit recovery to the host user.
  process.exitCode = 1;
}
