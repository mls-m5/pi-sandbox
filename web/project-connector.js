import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PiRpc } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { ID_PATTERN } from '../src/config.js';
import { connectView } from './connector.js';

// Only the local host supplies a descriptor resolved from its registered Store.
// The server/browser cannot supply paths, mounts, model args or executables.
export async function startProjectConnector({ project, origin, token, signal, startupTimeoutMs = 600_000 }) {
  if (!project || !ID_PATTERN.test(project.id) || !path.isAbsolute(project.root) || !path.isAbsolute(project.storeRoot)) throw new Error('Expected a locally registered project descriptor.');
  signal?.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis-project-rpc.js', import.meta.url)), project.id], {
    cwd: project.root, stdio: ['pipe', 'pipe', 'pipe'],
    // Host credentials may be needed by the existing local provider proxy. They
    // never enter network envelopes or new mounts; launchArgs retains its rules.
    env: { ...process.env, PIS_HOME: project.storeRoot },
  });
  const rpc = new PiRpc(child, { timeoutMs: startupTimeoutMs }), view = new PiView(rpc);
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
    network = connectView({ view, origin, token });
    rpc.once('closed', () => network.close());
    return { network, view, rpc, close };
  } catch {
    await close().catch(() => {});
    throw new Error('Project RPC did not become ready; inspect normal pis startup, configuration, locks and Podman on the host. No prompt was submitted by the connector.');
  } finally { signal?.removeEventListener('abort', onAbort); }
}
