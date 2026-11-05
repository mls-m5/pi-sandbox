import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withLock, writeJson } from './util.js';

const exec = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;

async function podman(args) {
  const { stdout } = await exec('podman', args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// Pure selection: no untagged layers, foreign tags, recent images or used images.
export function pruneCandidates(images, projectId, currentImage, now = Date.now()) {
  const prefix = `localhost/pis-${projectId}:`;
  const entries = images.flatMap(image => {
    const names = image.Names || [];
    const tags = names.filter(name => name.startsWith(prefix) && /^[a-f0-9]{20}$/.test(name.slice(prefix.length)));
    return tags.map(tag => ({ tag, id: image.Id, created: image.Created * 1000, used: image.Containers,
      foreign: names.some(name => !name.startsWith(prefix)) }));
  }).sort((a, b) => b.created - a.created || a.tag.localeCompare(b.tag));
  // Keep the configured image plus one most recent *other* image. If the
  // configured image isn't built yet, keep two existing versions for rollback.
  const current = entries.find(entry => entry.tag === currentImage);
  const keep = new Set(current ? [current.id] : []);
  for (const entry of entries) {
    if (keep.size < 2 && typeof entry.id === 'string') keep.add(entry.id);
  }
  return entries.filter(entry => typeof entry.id === 'string' && !keep.has(entry.id) && entry.used === 0 && !entry.foreign &&
    Number.isFinite(entry.created) && entry.created > 0 && now - entry.created >= DAY);
}

export async function pruneImages(store, { dryRun = false, automatic = false, runPodman = podman, now = Date.now() } = {}) {
  return withLock(path.join(store.root, 'prune.lock'), async () => {
    const stamp = path.join(store.root, 'prune-last-run.json');
    if (automatic) {
      try { if (now - JSON.parse(fs.readFileSync(stamp, 'utf8')).time < DAY) return { throttled: true, candidates: [], removed: [], skipped: [], failed: [] }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const { imagePlan } = await import('./container.js');
    const result = { candidates: [], removed: [], skipped: [], failed: [] };
    for (const project of store.all()) {
      try {
        await store.projectLock(project.id, () => store.lock(async () => {
          // Same lock as launch/build; re-read config and inventory while held.
          const current = store.load(project.id, false);
          const images = JSON.parse(await runPodman(['images', '--all', '--format', 'json']));
          if (!Array.isArray(images)) throw new Error('Invalid Podman image inventory.');
          const candidates = pruneCandidates(images, project.id, imagePlan(current).image, now);
          result.candidates.push(...candidates.map(entry => entry.tag));
          if (dryRun) return;
          for (const entry of candidates) {
            try {
              // Check again immediately before removal. Never force deletion and
              // never recursively prune parents that may belong to other builds.
              const latest = JSON.parse(await runPodman(['images', '--all', '--format', 'json']));
              if (!pruneCandidates(latest, project.id, imagePlan(current).image, now).some(candidate => candidate.tag === entry.tag && candidate.id === entry.id)) {
                result.skipped.push(entry.tag); continue;
              }
              await runPodman(['rmi', '--no-prune', entry.tag]);
              result.removed.push(entry.tag);
            } catch { result.failed.push(entry.tag); }
          }
        }));
      } catch (error) {
        if (error.code !== 'PIS_LOCKED') throw error;
        result.skipped.push(project.id);
      }
    }
    // Busy projects must be retried when their launch releases its lock.
    if (automatic && !dryRun && result.skipped.length === 0 && result.failed.length === 0) writeJson(stamp, { time: now });
    return result;
  });
}

// Detached host worker: never holds up the foreground or receives proxy keys.
export function schedulePrune(store) {
  if (process.env.PIS_AUTO_PRUNE === '0') return;
  const env = {};
  for (const name of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'CONTAINERS_CONF', 'CONTAINERS_STORAGE_CONF']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./prune-worker.js', import.meta.url)), store.root], {
      detached: true, stdio: 'ignore', env,
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* Optional housekeeping must not prevent launch. */ }
}
