#!/usr/bin/env node
// First-party pipe runtime. No arbitrary executable, native RPC startup flags,
// registration, model prompt or terminal approval can be supplied here.
import fs from 'node:fs';
function report(phase) {
  if (process.env.PIS_WEB_PROGRESS !== '1') return;
  // Dedicated host-only fd, not stderr, RPC stdout or a container mount.
  try { fs.writeSync(3, `${JSON.stringify({ type: 'startup', phase })}\n`); } catch { /* Parent may have stopped reading. */ }
}
async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node >=22.19 is required.');
  if (process.argv.length !== 3) throw new Error('Expected one registered project ID.');
  process.umask(0o077);
  const { Store } = await import('../src/store.js');
  const { runProjectRpc } = await import('../src/project-rpc.js');
  process.exitCode = await runProjectRpc(new Store(), process.argv[2], { startupProgress: report });
}
main().catch(error => {
  report(error.code === 'PIS_LOCKED' ? 'project_busy' : error.code === 'PIS_CONTAINER_UNKNOWN' ? 'cleanup_unconfirmed' : 'failed');
  // Diagnostics stay on the host-side stderr pipe, never in protocol stdout.
  console.error(`pis project RPC: ${error.code === 'PIS_CONTAINER_UNKNOWN' ? 'shutdown unconfirmed; project lock retained. Inspect on host before pis --unlock.' : 'startup/runtime failed; inspect project configuration and normal pis startup on the host.'}`);
  process.exitCode = 1;
});
