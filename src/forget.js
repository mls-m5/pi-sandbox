import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assert } from './util.js';
import { maintenanceEnvironment, projectContainers } from './locks.js';

const exec = promisify(execFile);

async function defaultPodman(args) {
  const { stdout } = await exec('podman', args, {
    env: maintenanceEnvironment(),
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function describe(store, project) {
  const dir = store.projectDir(project.id);
  const stat = fs.lstatSync(dir);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(dir) === dir,
    'Project storage is not an ordinary directory; nothing was removed.',
  );
  return dir;
}

/**
 * Removes a project's registration and ALL its sandbox state (sessions, Claude/Pi home,
 * update backups). Never touches the project's source directory, mounts, host
 * credentials or other projects. Refuses while any container/lock exists.
 * `confirm(summary)` must resolve true; image tags are untagged non-forcibly afterwards.
 */
export async function forgetProject(
  store,
  selector,
  { confirm, containers = projectContainers, runPodman = defaultPodman } = {},
) {
  assert(selector, 'Name or ID of the project to forget is required.');
  const target = store.all().find((p) => p.id === selector || p.name === selector);
  assert(target, `Unknown project: ${selector}. Use pis --list.`);
  const { id } = target;
  const result = await store.projectLock(id, () =>
    store.lock(async () => {
      // Re-read under both locks: another process may have changed or removed it.
      const current = store.load(id, false);
      assert(current.root === target.root, 'Project changed while waiting; nothing was removed.');
      const dir = describe(store, current);
      assert(
        !fs.existsSync(path.join(dir, 'updates.lock')),
        'Update maintenance has a lock for this project. Wait, or inspect with pis --unlock --dry-run; nothing was removed.',
      );
      const running = containers(id);
      assert(
        running.length === 0,
        `Project ${id} has containers (${running.join(', ')}); nothing was removed.`,
      );
      assert(
        await confirm({ id, name: current.name, root: current.root, storage: dir }),
        'Cancelled; nothing was removed.',
      );
      // Atomic unregistration first: a tombstone is never a valid project directory.
      const tombstone = path.join(store.projectsDir, `.forgotten-${id}-${randomBytes(4).toString('hex')}`);
      fs.renameSync(dir, tombstone);
      store.index(store.all());
      fs.rmSync(tombstone, { recursive: true, force: true });
      return { id, name: current.name, root: current.root };
    }),
  );
  // Images are best effort and non-forcing: tags in use or shared with other tags only lose this name.
  const images = { removed: [], failed: [], checked: false };
  try {
    const inventory = JSON.parse(await runPodman(['images', '--all', '--format', 'json']));
    assert(Array.isArray(inventory), 'Invalid image inventory.');
    images.checked = true;
    const prefix = `localhost/pis-${id}:`;
    const tags = inventory.flatMap((image) =>
      (image.Names || []).filter(
        (name) => name.startsWith(prefix) && /^[a-f0-9]{20}$/.test(name.slice(prefix.length)),
      ),
    );
    for (const tag of tags) {
      try {
        await runPodman(['rmi', '--no-prune', tag]);
        images.removed.push(tag);
      } catch {
        images.failed.push(tag);
      }
    }
  } catch {
    // Podman unavailable: the project is already forgotten; leave images for manual cleanup.
  }
  return { ...result, images };
}
