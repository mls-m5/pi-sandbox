import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assert, privateDir, withLock, writeJson, atomicWrite } from './util.js';
import { maintenanceEnvironment, inspectLock, projectContainers } from './locks.js';
import { extensionManifest, extensionSource } from './extensions.js';
import { backupPiState } from './update-backup.js';
import { imagePlan, PI_VERSION } from './container.js';

const exec = promisify(execFile);
const DAY = 86400000,
  MIN_AGE = 7 * DAY; // cooldown: let the community notice compromised releases first
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/;

export function compareVersions(a, b) {
  assert(
    VERSION.test(a) && VERSION.test(b),
    'Only stable numeric versions are supported by automatic updates.',
  );
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function compatible(version, anchor, pi = false) {
  const a = version.split('.'),
    b = anchor.split('.');
  return a[0] === b[0] && (!(pi || b[0] === '0') || a[1] === b[1]);
}
export function updateSourceKey(config) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        policyVersion: 1,
        image: imagePlan(config).fingerprint,
        managedRecipe: imagePlan(config, {
          releaseLock: { packages: [] },
          releaseId: '0'.repeat(32),
        }).fingerprint,
        agent: config.agent,
        provider: config.credentials.proxy?.provider,
        models: config.credentials.proxy?.models || [],
      }),
    )
    .digest('hex');
}
function policyKey(config) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        enabled: config.updates.enabled,
        includePinnedExtensions: config.updates.includePinnedExtensions,
      }),
    )
    .digest('hex');
}
function stateFile(store, id) {
  return path.join(store.projectDir(id), 'updates.json');
}
function updateLock(store, id) {
  return path.join(store.projectDir(id), 'updates.lock');
}
function baseline(config) {
  return {
    baseline: true,
    piVersion: PI_VERSION,
    extensions: [...config.extensions],
    image: imagePlan(config).image,
  };
}
function emptyState(config) {
  return {
    version: 1,
    sourceKey: updateSourceKey(config),
    active: baseline(config),
    previous: null,
    candidate: null,
    lastCheck: 0,
    lastPolicy: null,
    lastError: null,
  };
}

function checkRelease(release, id) {
  if (release === null) return;
  assert(
    release &&
      typeof release === 'object' &&
      Object.keys(release).every((key) =>
        [
          'baseline',
          'piVersion',
          'extensions',
          'image',
          'imageId',
          'lock',
          'stagingImage',
          'policyKey',
          'releaseId',
        ].includes(key),
      ) &&
      VERSION.test(release.piVersion) &&
      Array.isArray(release.extensions),
    'Invalid managed release.',
  );
  extensionManifest(release.extensions);
  assert(
    new RegExp(`^localhost/pis-${id}:[a-f0-9]{20}$`).test(release.image),
    'Invalid managed image.',
  );
  if (release.baseline === true) {
    assert(
      Object.keys(release).every((key) =>
        ['baseline', 'piVersion', 'extensions', 'image'].includes(key),
      ),
      'Invalid baseline fields.',
    );
    return;
  }
  assert(
    typeof release.releaseId === 'string' && /^[a-f0-9]{32}$/.test(release.releaseId),
    'Invalid release build identity.',
  );
  assert(
    IMAGE_ID.test(release.imageId) && release.lock?.packages?.[0]?.name === PI_PACKAGE,
    'Invalid managed release verification.',
  );
  assert(
    release.lock.packages.length === release.extensions.length + 1 &&
      release.lock.packages.length <= 100,
    'Invalid release package set.',
  );
  assert(
    Object.keys(release.lock).length === 1 && Array.isArray(release.lock.packages),
    'Invalid release lock fields.',
  );
  for (const pkg of release.lock.packages) {
    assert(
      Object.keys(pkg).length === 3 &&
        ['name', 'version', 'integrity'].every((key) => Object.hasOwn(pkg, key)),
      'Invalid artifact fields.',
    );
    extensionSource(`npm:${pkg.name}@${pkg.version}`);
    assert(VERSION.test(pkg.version) && INTEGRITY.test(pkg.integrity), 'Invalid managed artifact.');
  }
  assert(release.lock.packages[0].version === release.piVersion, 'Invalid Pi release lock.');
  assert(
    release.extensions.every(
      (source, index) =>
        source ===
        `npm:${release.lock.packages[index + 1].name}@${release.lock.packages[index + 1].version}`,
    ),
    'Invalid extension release lock.',
  );
  if (release.policyKey !== undefined)
    assert(/^[a-f0-9]{64}$/.test(release.policyKey), 'Invalid candidate policy.');
  if (release.stagingImage !== undefined)
    assert(
      new RegExp(`^localhost/pis-update-${id}:[a-f0-9]{20}-[a-f0-9]{24}$`).test(
        release.stagingImage,
      ),
      'Invalid staging image.',
    );
}

export function readUpdateState(store, id) {
  let fd;
  try {
    fd = fs.openSync(
      stateFile(store, id),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 1024 * 1024,
      'Unsafe update state.',
    );
    const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
    assert(
      Object.keys(state).every((key) =>
        [
          'version',
          'sourceKey',
          'active',
          'previous',
          'candidate',
          'lastCheck',
          'lastPolicy',
          'lastError',
        ].includes(key),
      ),
      'Invalid update state fields.',
    );
    assert(
      state.version === 1 &&
        /^[a-f0-9]{64}$/.test(state.sourceKey) &&
        Number.isFinite(state.lastCheck) &&
        state.lastCheck >= 0,
      'Invalid update state.',
    );
    assert(
      state.lastPolicy === null || /^[a-f0-9]{64}$/.test(state.lastPolicy),
      'Invalid checked update policy.',
    );
    assert(
      [
        null,
        'metadata',
        'build',
        'probe',
        'configuration-changed',
        'image-missing',
        'state-backup',
      ].includes(state.lastError),
      'Invalid update status.',
    );
    for (const release of [state.active, state.previous, state.candidate])
      checkRelease(release, id);
    assert(state.active, 'Missing active release.');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(
      'Cannot read private managed-update state; declared image remains the fallback. Inspect updates.json on the host.',
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function managedPlan(config, release) {
  checkRelease(release, config.id);
  if (release.baseline) {
    const plan = imagePlan(config);
    assert(
      plan.image === release.image &&
        release.piVersion === PI_VERSION &&
        JSON.stringify(release.extensions) === JSON.stringify(config.extensions),
      'Baseline release changed.',
    );
    return plan;
  }
  const declared = extensionManifest(config.extensions),
    resolved = extensionManifest(release.extensions);
  assert(
    resolved.length === declared.length &&
      resolved.every((entry, i) => entry.name === declared[i].name),
    'Managed release cannot add or replace plugins.',
  );
  assert(
    compatible(release.piVersion, PI_VERSION, true) &&
      compareVersions(release.piVersion, PI_VERSION) >= 0,
    'Managed Pi release must stay on the source-pinned minor line.',
  );
  const plan = imagePlan(
    { ...config, extensions: release.extensions },
    { piVersion: release.piVersion, releaseLock: release.lock, releaseId: release.releaseId },
  );
  assert(
    plan.image === release.image,
    'Managed release no longer matches this wrapper/configuration.',
  );
  return plan;
}

export function protectedUpdateImages(store, id) {
  const state = readUpdateState(store, id);
  return state
    ? [state.active.image, state.previous?.image, state.candidate?.image].filter(Boolean)
    : [];
}

export async function registryMetadata(name, { fetchImpl = fetch } = {}) {
  extensionSource(`npm:${name}`);
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json' },
  });
  assert(response.ok && response.body, 'Registry metadata unavailable.');
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      assert(bytes <= 16 * 1024 * 1024, 'Registry metadata too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function artifact(metadata, name, version) {
  const info = metadata?.versions?.[version];
  assert(
    info?.name === name &&
      info.version === version &&
      VERSION.test(version) &&
      INTEGRITY.test(info.dist?.integrity),
    'Invalid registry release.',
  );
  // Tarball URLs and arbitrary registry fields are never persisted or executed.
  return { name, version, integrity: info.dist.integrity };
}
function newest(metadata, name, anchor, now, pi = false, tag = 'latest') {
  const ceiling = metadata?.['dist-tags']?.[tag];
  assert(VERSION.test(ceiling) && VERSION.test(anchor), 'Only stable version tags are supported.');
  const versions = Object.keys(metadata.versions || {})
    .filter(
      (version) =>
        VERSION.test(version) &&
        compatible(version, anchor, pi) &&
        compareVersions(version, anchor) >= 0 &&
        compareVersions(version, ceiling) <= 0 &&
        !metadata.versions[version].deprecated &&
        Number.isFinite(Date.parse(metadata.time?.[version])) &&
        now - Date.parse(metadata.time[version]) >= MIN_AGE,
    )
    .sort(compareVersions);
  assert(versions.length > 0, 'No mature compatible release is available yet.');
  return artifact(metadata, name, versions.at(-1));
}

export async function resolveUpdateRelease(
  config,
  state,
  { metadata = registryMetadata, now = Date.now() } = {},
) {
  assert(config.extensions.length <= 99, 'Automatic updates support at most 99 image npm plugins.');
  // Declared plugin names are unique; do not retain every large packument in RAM.
  const get = metadata;
  const anchor = state.candidate?.policyKey === policyKey(config) ? state.candidate : state.active;
  const pi = newest(await get(PI_PACKAGE), PI_PACKAGE, anchor.piVersion, now, true);
  const current = extensionManifest(anchor.extensions);
  const packages = [pi];
  for (const entry of extensionManifest(config.extensions)) {
    const data = await get(entry.name),
      old = current.find((pkg) => pkg.name === entry.name)?.version;
    let version;
    if (VERSION.test(entry.version || '') && !config.updates.includePinnedExtensions)
      version = entry.version;
    else {
      const tag = entry.version && !VERSION.test(entry.version) ? entry.version : 'latest';
      const anchor = VERSION.test(old || '')
        ? old
        : VERSION.test(entry.version || '')
          ? entry.version
          : data?.['dist-tags']?.[tag];
      version = newest(data, entry.name, anchor, now, false, tag).version;
    }
    packages.push(artifact(data, entry.name, version));
  }
  const extensions = packages.slice(1).map((pkg) => `npm:${pkg.name}@${pkg.version}`);
  const lock = { packages },
    releaseId = randomBytes(16).toString('hex');
  const plan = imagePlan(
    { ...config, extensions },
    { piVersion: pi.version, releaseLock: lock, releaseId },
  );
  return { piVersion: pi.version, extensions, lock, releaseId, image: plan.image };
}

export async function updatePodman(args, { timeout = 120000 } = {}) {
  const { stdout } = await exec('podman', args, {
    env: maintenanceEnvironment(),
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
async function exists(runPodman, image) {
  try {
    const id = await runPodman(['image', 'inspect', '--format', '{{.Id}}', image], {
      timeout: 15000,
    });
    return IMAGE_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
const sameRelease = (a, b) =>
  a &&
  JSON.stringify([a.piVersion, a.extensions, a.lock]) ===
    JSON.stringify([b.piVersion, b.extensions, b.lock]);

export async function prepareUpdates(
  store,
  id,
  {
    force = false,
    metadata,
    now = Date.now(),
    runPodman = updatePodman,
    inspect = () => {
      assert(process.getuid?.() !== 0, 'Run updates as your normal user, not root.');
      projectContainers(id); // Bounded local/rootless check; existing sessions are allowed.
    },
  } = {},
) {
  return withLock(updateLock(store, id), async () => {
    const config = store.load(id, false);
    if (config.agent !== 'pi' || !config.updates.enabled) return { skipped: true };
    const key = updateSourceKey(config);
    let state = readUpdateState(store, id);
    if (!state || state.sourceKey !== key) state = emptyState(config);
    if (!force && state.lastPolicy === policyKey(config) && now - state.lastCheck < DAY)
      return { throttled: true };
    state.lastCheck = now;
    state.lastPolicy = policyKey(config);
    state.lastError = null;
    writeJson(stateFile(store, id), state);
    let phase = 'metadata',
      staging,
      context,
      probeName,
      retained = false;
    try {
      const release = await resolveUpdateRelease(config, state, { metadata, now });
      if (
        sameRelease(state.active, release) ||
        (state.candidate?.policyKey === policyKey(config) && sameRelease(state.candidate, release))
      )
        return { unchanged: true };
      phase = 'build';
      await inspect();
      const plan = managedPlan(config, { ...release, imageId: '0'.repeat(64) });
      staging = `localhost/pis-update-${id}:${plan.fingerprint}-${randomBytes(12).toString('hex')}`;
      context = fs.mkdtempSync(path.join(store.projectDir(id), 'update-build-'));
      privateDir(context);
      for (const [name, contents] of Object.entries(plan.files)) {
        const file = path.join(context, name);
        privateDir(path.dirname(file));
        atomicWrite(file, contents);
      }
      await runPodman(
        [
          'build',
          '--layers',
          '--http-proxy=false',
          '--tag',
          staging,
          '--file',
          path.join(context, 'Containerfile'),
          context,
        ],
        { timeout: 1200000 },
      );
      const imageId = await exists(runPodman, staging);
      assert(imageId, 'Candidate image missing.');
      phase = 'probe';
      const provider = config.credentials.proxy?.provider;
      const required = ['openai', 'openai-codex', 'mistral'].includes(provider)
        ? (config.credentials.proxy.models || []).map((model) => ({ provider, id: model }))
        : [];
      assert(
        required.length <= 1000 && required.every((model) => model.id.length <= 256),
        'Model allowlist too large for probe.',
      );
      probeName = `pis-${id}-update-${randomBytes(12).toString('hex')}`;
      const output = await runPodman(
        [
          'run',
          '--rm',
          '--name',
          probeName,
          '--network=none',
          '--http-proxy=false',
          '--unsetenv-all',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
          '--cap-drop=all',
          '--security-opt=no-new-privileges',
          '--pids-limit=256',
          '--memory=1g',
          '--cpus=2',
          '--env',
          `PIS_PROBE_REQUIRED_MODELS=${JSON.stringify(required)}`,
          '--entrypoint',
          '/usr/local/bin/node',
          staging,
          '/opt/pis/update-probe.mjs',
        ],
        { timeout: 90000 },
      );
      const checked = JSON.parse(output);
      assert(
        checked.ok === true &&
          checked.piVersion === release.piVersion &&
          JSON.stringify(checked.extensions) === JSON.stringify(release.extensions),
        'Candidate probe failed.',
      );
      phase = 'configuration-changed';
      const current = store.load(id, false);
      assert(
        current.updates.enabled &&
          policyKey(current) === policyKey(config) &&
          updateSourceKey(current) === key,
        'Configuration changed.',
      );
      const oldCandidate = state.candidate,
        oldStage = oldCandidate?.stagingImage;
      await store.lock(async () => {
        const latest = store.load(id, false);
        assert(
          latest.updates.enabled &&
            policyKey(latest) === policyKey(config) &&
            updateSourceKey(latest) === key,
          'Configuration changed.',
        );
        state.candidate = {
          ...release,
          imageId,
          stagingImage: staging,
          policyKey: policyKey(config),
        };
        writeJson(stateFile(store, id), state);
        retained = true;
      });
      if (
        oldStage &&
        oldStage !== staging &&
        (await exists(runPodman, oldStage)) === oldCandidate.imageId
      )
        await runPodman(['rmi', '--no-prune', oldStage]).catch(() => {});
      return { prepared: true, piVersion: release.piVersion, extensions: release.extensions };
    } catch {
      state.lastError = phase;
      writeJson(stateFile(store, id), state);
      return { failed: phase }; // Never persist subprocess output/URLs/credentials.
    } finally {
      if (probeName) await runPodman(['rm', '--force', '--time', '1', probeName]).catch(() => {});
      if (staging && !retained) await runPodman(['rmi', '--no-prune', staging]).catch(() => {});
      if (context) fs.rmSync(context, { recursive: true, force: true });
    }
  });
}

// Called under the normal project lock. A concurrent maintenance build must not
// delay startup: read the current immutable release, but defer activation.
export async function selectUpdateImage(
  store,
  config,
  { runPodman = updatePodman, notify = console.error, backup = backupPiState } = {},
) {
  if (config.agent !== 'pi') return undefined;
  let state;
  try {
    state = readUpdateState(store, config.id);
  } catch {
    notify('pis: managed update state is invalid; using the declared image.');
    return undefined;
  }
  if (!state || state.sourceKey !== updateSourceKey(config) || config.agent !== 'pi')
    return undefined;
  if (process.env.PIS_AUTO_UPDATE !== '0' && config.updates.enabled && state.candidate) {
    try {
      await withLock(updateLock(store, config.id), async () => {
        state = readUpdateState(store, config.id);
        if (
          !state ||
          state.sourceKey !== updateSourceKey(config) ||
          !state.candidate ||
          state.candidate.policyKey !== policyKey(config)
        )
          return;
        const candidate = state.candidate,
          plan = managedPlan(config, candidate);
        if ((await exists(runPodman, candidate.stagingImage)) !== candidate.imageId) {
          state.lastError = 'image-missing';
          state.candidate = null;
          writeJson(stateFile(store, config.id), state);
          return;
        }
        try {
          backup(store, config, { from: state.active.image, to: candidate.image });
        } catch {
          state.lastError = 'state-backup';
          writeJson(stateFile(store, config.id), state);
          notify(
            'pis: bounded private Pi state backup failed; candidate deferred, keeping the current image.',
          );
          return;
        }
        await runPodman(['tag', candidate.stagingImage, plan.image]);
        assert(
          (await exists(runPodman, plan.image)) === candidate.imageId,
          'Candidate tag changed.',
        );
        await store.lock(async () => {
          const latest = store.load(config.id, false);
          assert(
            latest.updates.enabled &&
              policyKey(latest) === candidate.policyKey &&
              updateSourceKey(latest) === state.sourceKey,
            'Policy/configuration changed before activation.',
          );
          state.previous = state.active;
          state.active = { ...candidate };
          delete state.active.stagingImage;
          state.candidate = null;
          state.lastError = null;
          writeJson(stateFile(store, config.id), state);
        });
        await runPodman(['rmi', '--no-prune', candidate.stagingImage]).catch(() => {});
        notify(
          `pis: activated checked Pi ${candidate.piVersion} image updates (running sessions were not changed).`,
        );
      });
    } catch (error) {
      if (error.code !== 'PIS_LOCKED')
        notify('pis: candidate activation failed; keeping the previous image.');
    }
  }
  try {
    state = readUpdateState(store, config.id);
    if (!state || state.sourceKey !== updateSourceKey(config)) return undefined;
    const plan = managedPlan(config, state.active);
    if (state.active.baseline) return undefined;
    if ((await exists(runPodman, plan.image)) === state.active.imageId) return plan;
  } catch {
    /* Declared image is the safe fallback. */
  }
  notify('pis: managed image unavailable; using the declared image.');
  return undefined;
}

export async function updatesAction(
  store,
  config,
  action,
  { runPodman = updatePodman, prepare = prepareUpdates } = {},
) {
  assert(
    ['on', 'all', 'off', 'status', 'check', 'rollback'].includes(action),
    'Use --updates on|all|off|status|check|rollback.',
  );
  if (['on', 'all', 'check'].includes(action))
    assert(
      config.agent === 'pi',
      'Managed updates currently support Pi projects only, not Claude Code.',
    );
  if (action === 'status')
    return {
      policy: config.updates,
      maintenance: inspectLock(updateLock(store, config.id)),
      release: readUpdateState(store, config.id) || null,
    };
  if (action === 'check') return prepare(store, config.id, { force: true });
  if (action !== 'rollback') {
    // Policy-only changes are safe while Pi is running; no runtime/state is mutated.
    const current = store.load(config.id, false),
      edited = structuredClone(current);
    edited.updates.enabled = action !== 'off';
    if (action === 'all') edited.updates.includePinnedExtensions = true;
    await store.save(edited, current);
    return {
      policy: edited.updates,
      note: 'Off freezes an already active managed release. Explicit plugin sources were not rewritten.',
    };
  }
  return store.projectLock(config.id, async () => {
    const current = store.load(config.id, false);
    return withLock(updateLock(store, config.id), async () => {
      const state = readUpdateState(store, config.id);
      assert(
        state?.sourceKey === updateSourceKey(current) && state.previous,
        'No previous managed image exists for this configuration.',
      );
      const plan = managedPlan(current, state.previous);
      const previousId = await exists(runPodman, plan.image);
      assert(
        previousId && (state.previous.baseline || previousId === state.previous.imageId),
        'Previous image is missing or changed; no rollback was performed.',
      );
      const edited = structuredClone(current);
      edited.updates.enabled = false;
      await store.save(edited, current); // Stop re-adopting the rolled-back update.
      [state.active, state.previous] = [state.previous, state.active];
      const pending = state.candidate;
      state.candidate = null;
      state.lastError = null;
      writeJson(stateFile(store, config.id), state);
      if (
        pending?.stagingImage &&
        (await exists(runPodman, pending.stagingImage)) === pending.imageId
      )
        await runPodman(['rmi', '--no-prune', pending.stagingImage]).catch(() => {});
      return {
        rolledBack: true,
        policy: edited.updates,
        piVersion: state.active.piVersion,
        warning: 'Image rollback only; session/plugin state is not reverted.',
      };
    });
  });
}

export function scheduleUpdates(store, config, { spawnImpl = spawn } = {}) {
  if (process.env.PIS_AUTO_UPDATE === '0' || config.agent !== 'pi' || !config.updates?.enabled)
    return;
  try {
    if (inspectLock(updateLock(store, config.id)).status !== 'absent') return;
    const state = readUpdateState(store, config.id);
    if (
      state?.sourceKey === updateSourceKey(config) &&
      state.lastPolicy === policyKey(config) &&
      Date.now() - state.lastCheck < DAY
    )
      return;
    const child = spawnImpl(
      process.execPath,
      [fileURLToPath(new URL('./update-worker.js', import.meta.url)), store.root, config.id],
      { detached: true, stdio: 'ignore', env: maintenanceEnvironment() },
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    /* Optional maintenance never prevents normal launch. */
  }
}
