// Host-only worker, invoked under /usr/bin/flock by pis --unlock. No shell or
// arbitrary lock filename is accepted; targets are registry/current project only.
import { Store } from './store.js';
import { recoverProjectLocks } from './locks.js';

process.umask(0o077);
try {
  const [root, cwd, project, dryRun] = process.argv.slice(2);
  const result = recoverProjectLocks(new Store(root), {
    cwd,
    project: project || undefined,
    dryRun: dryRun === '1',
  });
  console.log(JSON.stringify({ dryRun: dryRun === '1', ...result }, null, 2));
  process.exitCode = result.locks.some((lock) => lock.status === 'blocked') ? 1 : 0;
} catch {
  console.error(
    'pis: lock recovery failed safely. No unverified owner was unlocked; inspect host storage permissions/configuration.',
  );
  process.exitCode = 1;
}
