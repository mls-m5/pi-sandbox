import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PiRpc, JsonlDecoder } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { ID_PATTERN } from '../src/config.js';
import { connectView } from './connector.js';
import { startupPhase, startupFailure } from './public/startup.js';

// Only the local host supplies a descriptor resolved from its registered Store.
// The server/browser cannot supply paths, mounts, model args or executables.
export async function startProjectConnector({ project, origin, token, signal, startupTimeoutMs = 600_000, onProgress = () => {}, diagnostic }) {
  if (!project || !ID_PATTERN.test(project.id) || !path.isAbsolute(project.root) || !path.isAbsolute(project.storeRoot)) throw new Error('Expected a locally registered project descriptor.');
  signal?.throwIfAborted();
  let lastPhase;
  const report = phase => { lastPhase = phase; onProgress(phase); };
  report('starting_wrapper');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis-project-rpc.js', import.meta.url)), project.id], {
    cwd: project.root, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    // Host credentials may be needed by the existing local provider proxy. They
    // never enter network envelopes or new mounts; launchArgs retains its rules.
    env: { ...process.env, PIS_HOME: project.storeRoot, PIS_WEB_PROGRESS: '1' },
  });
  const rpc = new PiRpc(child, { timeoutMs: startupTimeoutMs }), view = new PiView(rpc);
  const progress = new JsonlDecoder(record => {
    if (record.type === 'startup' && startupPhase(record.phase) && Object.keys(record).length === 2) report(record.phase);
  }, () => {}, 512);
  child.stdio[3].on('data', chunk => progress.push(chunk));
  child.stdio[3].on('error', () => {});
  let network, closing;
  const close = () => closing ||= (async () => {
    network?.close(); view.detach();
    let deadline;
    try {
      if (!rpc.closed && !rpc.faulted) {
        await Promise.race([
          rpc.request('clear_queue').then(response => response.success ? rpc.request('abort') : undefined).catch(() => {}),
          new Promise(resolve => { deadline = setTimeout(resolve, 1000); }),
        ]);
      }
    } finally {
      clearTimeout(deadline);
      // Do not use the short dummy-process kill window for the host wrapper:
      // it forwards termination then independently removes/checks the container.
      await rpc.shutdown({ graceMs: 1000, killMs: 60_000 });
    }
    if (child.exitCode !== 0) throw new Error('Project RPC wrapper exit was not clean; inspect the host and any retained project lock.');
  })();
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const state = await rpc.request('get_state');
    signal?.throwIfAborted();
    if (closing || !state.success) throw new Error('Project RPC initialization failed.');
    rpc.timeoutMs = 30_000;
    report('rpc_ready');
    network = connectView({ view, origin, token, diagnostic });
    rpc.once('closed', () => network.close());
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); network.events.off('registered', registered); network.events.off('rejected', rejected); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const registered = () => finish();
      const rejected = () => finish(new Error('Agent registration rejected.'));
      const aborted = () => finish(new Error('Startup cancelled.'));
      const timer = setTimeout(() => finish(new Error('Agent registration deadline.')), 8000);
      network.events.once('registered', registered); network.events.once('rejected', rejected);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    report('connected');
    return { network, view, rpc, close };
  } catch (error) {
    let cleanupError;
    await close().catch(failure => { cleanupError = failure; });
    if (signal?.aborted) throw Object.assign(new Error('Project startup cancelled.'), { code: 'STARTUP_CANCELLED' });
    const failurePhase = startupFailure(lastPhase) ? lastPhase
      : cleanupError?.code === 'rpc_shutdown_unconfirmed' ? 'cleanup_unconfirmed'
      : lastPhase === 'rpc_ready' ? 'registration_failed'
      : error.code === 'rpc_timeout_ambiguous' ? 'startup_timeout'
      : ['rpc_invalid_record', 'rpc_record_too_large', 'rpc_response_mismatch', 'rpc_incomplete_record'].includes(error.code) ? 'rpc_failed'
      : lastPhase === 'starting_container' ? 'pi_failed' : 'failed';
    if (lastPhase !== failurePhase) report(failurePhase);
    throw Object.assign(new Error('Project RPC startup failed; see its fixed host startup phase.'), { code: 'PROJECT_STARTUP_FAILED', phase: failurePhase });
  } finally { signal?.removeEventListener('abort', onAbort); }
}
