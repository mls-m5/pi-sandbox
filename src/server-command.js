import { fileURLToPath } from 'node:url';
import { run } from './util.js';

// Host-only convenience alias for the existing first-party launcher. This module
// has no optional web dependencies and is compatible with older host Node so the
// launcher can select its supported runtime before loading the web application.
export async function startAgent(args) {
  return run('bash', [fileURLToPath(new URL('../start_server.sh', import.meta.url)), '--connect', ...args], { shutdownTimeoutMs: 100_000 });
}

export async function startServer(args) {
  const allowed = new Set(['--project', '--port', '--agents', '--password-stdin', '--diagnostics', '--standalone', '--help', '-h']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new Error('Unknown server option. Use pis --server --help.');
    if (['--project', '--port', '--agents'].includes(flag)) {
      if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error(`Missing value for ${flag}.`);
      index++;
    }
  }
  // Leave time for the web controller's 90-second real-project cleanup window;
  // the generic runner's normal five-second cutoff would kill it prematurely.
  return run('bash', [fileURLToPath(new URL('../start_server.sh', import.meta.url)), ...args], { shutdownTimeoutMs: 100_000 });
}
