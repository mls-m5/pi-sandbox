import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PiRpc, JsonlDecoder } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { ID_PATTERN } from '../src/config.js';
import { connectView } from './connector.js';
import { createProjectHostPush } from './project-host-push.js';
import { captureProjectRuntime } from './project-runtime-bundle.js';
import { startupPhase, startupFailure } from './public/startup.js';

// Only the local host supplies a descriptor resolved from its registered Store.
// The server/browser cannot supply paths, mounts, model args or executables.
async function startProjectRuntime({
  project,
  signal,
  startupTimeoutMs = 600_000,
  onProgress = () => {},
  allowWebGit = false,
  programEntry = fileURLToPath(new URL('../bin/pis-project-rpc.js', import.meta.url)),
}) {
  if (
    !project ||
    !ID_PATTERN.test(project.id) ||
    !path.isAbsolute(project.root) ||
    !path.isAbsolute(project.storeRoot)
  )
    throw new Error('Expected a locally registered project descriptor.');
  signal?.throwIfAborted();
  let lastPhase;
  const report = (phase) => {
    lastPhase = phase;
    onProgress(phase);
  };
  report('starting_wrapper');
  const environment = {
    ...process.env,
    PIS_HOME: project.storeRoot,
    PIS_WEB_PROGRESS: '1',
    PIS_ALLOW_WEB_GIT: allowWebGit ? '1' : '0',
  };
  // Opted-in re-exec must not import a mutable project hook or code cache.
  if (allowWebGit) {
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_COMPILE_CACHE',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
    ])
      delete environment[name];
    environment.NODE_DISABLE_COMPILE_CACHE = '1';
  }
  const child = spawn(process.execPath, [programEntry, project.id], {
    cwd: project.root,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', ...(allowWebGit ? ['ipc'] : [])],
    // Host credentials may be needed by the existing local provider proxy. They
    // never enter network envelopes or new mounts; launchArgs retains its rules.
    env: environment,
  });
  const rpc = new PiRpc(child, { timeoutMs: startupTimeoutMs }),
    view = new PiView(rpc);
  const hostPush = allowWebGit ? createProjectHostPush(child, rpc) : undefined;
  const progress = new JsonlDecoder(
    (record) => {
      if (
        record.type === 'startup' &&
        startupPhase(record.phase) &&
        Object.keys(record).length === 2
      )
        report(record.phase);
    },
    () => {},
    512,
  );
  child.stdio[3].on('data', (chunk) => progress.push(chunk));
  child.stdio[3].on('error', () => {});
  let closing;
  const close = () =>
    (closing ||= (async () => {
      hostPush?.close();
      view.detach();
      let deadline;
      try {
        if (!rpc.closed && !rpc.faulted) {
          await Promise.race([
            rpc
              .request('clear_queue')
              .then((response) => (response.success ? rpc.request('abort') : undefined))
              .catch(() => {}),
            new Promise((resolve) => {
              deadline = setTimeout(resolve, 1000);
            }),
          ]);
        }
      } finally {
        clearTimeout(deadline);
        // Do not use the short dummy-process kill window for the host wrapper:
        // it forwards termination then independently removes/checks the container.
        await rpc.shutdown({ graceMs: 1000, killMs: 60_000 });
      }
      if (child.exitCode !== 0)
        throw new Error(
          'Project RPC wrapper exit was not clean; inspect the host and any retained project lock.',
        );
    })());
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const state = await rpc.request('get_state');
    signal?.throwIfAborted();
    if (closing || !state.success) throw new Error('Project RPC initialization failed.');
    rpc.timeoutMs = 30_000;
    report('rpc_ready');
    return { view, rpc, hostPush, child, close };
  } catch (error) {
    let cleanupError;
    await close().catch((failure) => {
      cleanupError = failure;
    });
    if (signal?.aborted)
      throw Object.assign(new Error('Project startup cancelled.'), { code: 'STARTUP_CANCELLED' });
    const failurePhase = startupFailure(lastPhase)
      ? lastPhase
      : cleanupError?.code === 'rpc_shutdown_unconfirmed'
        ? 'cleanup_unconfirmed'
        : lastPhase === 'rpc_ready'
          ? 'registration_failed'
          : error.code === 'rpc_timeout_ambiguous'
            ? 'startup_timeout'
            : [
                  'rpc_invalid_record',
                  'rpc_record_too_large',
                  'rpc_response_mismatch',
                  'rpc_incomplete_record',
                ].includes(error.code)
              ? 'rpc_failed'
              : lastPhase === 'starting_container'
                ? 'pi_failed'
                : 'failed';
    if (lastPhase !== failurePhase) report(failurePhase);
    throw Object.assign(
      new Error('Project RPC startup failed; see its fixed host startup phase.'),
      { code: 'PROJECT_STARTUP_FAILED', phase: failurePhase },
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// Owns the connection across *verified Git-flow* runtime replacements. It never
// restarts a crashed runtime, replays a command or supplies a continuation prompt.
export async function startProjectConnector(options) {
  const controller = new AbortController(),
    events = new EventEmitter();
  let current,
    network,
    transition,
    closing,
    terminalFailure,
    bundle,
    stopping = false,
    ended = false;
  const finish = () => {
    if (!ended) {
      ended = true;
      events.emit('closed');
    }
  };
  const close = () =>
    (closing ||= (async () => {
      stopping = true;
      controller.abort();
      network?.close();
      try {
        await transition;
      } finally {
        try {
          await current?.close();
          if (terminalFailure) throw terminalFailure;
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
          finish();
        }
      }
    })());
  const onAbort = () => {
    void close().catch(() => {});
  };
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const start = () => {
    bundle?.verify();
    return startProjectRuntime({
      ...options,
      signal: controller.signal,
      programEntry: bundle?.entry,
    });
  };
  function watch(runtime) {
    const endedRuntime = () => {
      if (stopping || runtime !== current) return;
      transition = replace(runtime);
    };
    runtime.rpc.once('closed', endedRuntime);
    if (runtime.rpc.closed) endedRuntime();
  }
  async function replace(runtime) {
    const eligible =
      options.allowWebGit === true &&
      runtime.child.exitCode === 0 &&
      runtime.hostPush?.restartReady === true;
    if (!eligible) {
      network.close();
      finish();
      return;
    }
    try {
      await runtime.close();
      if (stopping) return;
      current = await start();
      if (stopping) {
        await current.close();
        return;
      }
      if (current.rpc.closed || current.rpc.status !== 'idle')
        throw new Error('Replacement is not idle.');
      await network.replaceView(current.view, current.hostPush);
      if (current.rpc.closed) throw new Error('Replacement exited.');
      options.onProgress?.('connected');
      watch(current);
      events.emit('runtime_restarted');
    } catch (error) {
      const phase = startupFailure(error.phase) ? error.phase : 'failed';
      terminalFailure = Object.assign(
        new Error('Project runtime replacement failed; inspect host startup and cleanup state.'),
        { code: 'PROJECT_REPLACEMENT_FAILED', phase },
      );
      network.close();
      await current?.close().catch(() => {});
      options.onProgress?.(phase);
      finish();
    }
  }
  try {
    if (options.allowWebGit) bundle = captureProjectRuntime(options.project.storeRoot);
    current = await start();
    controller.signal.throwIfAborted();
    network = connectView({ ...options, view: current.view, hostPush: current.hostPush });
    await new Promise((resolve, reject) => {
      const done = (error) => {
        clearTimeout(deadline);
        network.events.off('registered', registered);
        network.events.off('rejected', rejected);
        controller.signal.removeEventListener('abort', aborted);
        error ? reject(new Error('Agent registration unavailable.')) : resolve();
      };
      const registered = () => done(),
        rejected = () => done(true),
        aborted = () => done(true);
      const deadline = setTimeout(rejected, 8000);
      network.events.once('registered', registered);
      network.events.once('rejected', rejected);
      controller.signal.addEventListener('abort', aborted, { once: true });
      if (controller.signal.aborted) aborted();
    });
    if (current.rpc.closed) throw new Error('Project runtime exited during registration.');
    options.onProgress?.('connected');
    watch(current);
    return {
      events,
      network,
      get rpc() {
        return current.rpc;
      },
      get view() {
        return current.view;
      },
      get isClosed() {
        return ended;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    if (error.code === 'PROJECT_STARTUP_FAILED' || error.code === 'STARTUP_CANCELLED') throw error;
    const phase = options.signal?.aborted ? 'cancelled' : 'registration_failed';
    options.onProgress?.(phase === 'cancelled' ? 'failed' : phase);
    throw Object.assign(new Error('Project connection startup failed.'), {
      code: options.signal?.aborted ? 'STARTUP_CANCELLED' : 'PROJECT_STARTUP_FAILED',
      phase,
    });
  }
}
