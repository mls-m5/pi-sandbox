// Trusted image-owned Pi extension. The container may suggest host actions, never approve them.
import net from 'node:net';
import { Type } from '@earendil-works/pi-ai';

async function requestHostAction(data, ctx) {
  const accepted = await new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.PIS_APT_SOCKET);
    let response = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Request timed out.')));
    socket.on('connect', () => socket.write(`${JSON.stringify(data)}\n`));
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (response.length > 128) return socket.destroy(new Error('Invalid response.'));
      if (response.includes('\n')) socket.end();
    });
    socket.on('end', () => { try { resolve(JSON.parse(response).ok === true); } catch { reject(new Error('Invalid response.')); } });
    socket.on('error', reject);
  });
  if (!accepted) throw new Error('Host action request rejected or invalid; nothing was executed.');
  ctx.shutdown();
  return { content: [{ type: 'text', text: 'Request sent to pis. Pi is stopping so the user can review it on the host. Nothing has been executed or approved yet.' }], details: undefined, terminate: true };
}

export default function (pi) {
  if (!process.env.PIS_APT_SOCKET) return;
  pi.registerTool({
    name: 'request_apt_packages', label: 'Request apt packages', exposure: 'model-only',
    description: 'If a task requires missing Debian apt packages, request their installation. Supply only exact apt package names and a short reason. This pauses Pi; the user reviews and approves or rejects the request outside the sandbox. Never claim packages were installed before the next start.',
    parameters: Type.Object({
      packages: Type.Array(Type.String({ description: 'Debian apt package name, not a shell command' }), { minItems: 1, maxItems: 10 }),
      reason: Type.String({ description: 'Why these packages are necessary for the current task' }),
    }),
    async execute(_id, params, _signal, _update, ctx) { return requestHostAction({ type: 'apt-packages', ...params }, ctx); },
  });
  pi.registerTool({
    name: 'request_host_git', label: 'Request host Git command', exposure: 'model-only',
    description: 'Request ONE Git operation on the host, using host authentication only after the user approves it there. Pi stops for approval. Currently only args ["push", "REMOTE", "FULL_40_HEX_COMMIT:refs/heads/BRANCH"] are allowed: no shell, force, aliases or other commands. repo is relative to the registered project; use "." for its root. Inspect and commit changes inside the sandbox first. Do not claim the push succeeded until pis confirms it after restarting.',
    parameters: Type.Object({
      repo: Type.String({ description: 'Relative repository path in the project, usually ".". Ordinary .git directories only.' }),
      args: Type.Array(Type.String(), { description: 'Git arguments without the git executable. Example: ["push", "origin", "FULL_COMMIT:refs/heads/main"]', minItems: 3, maxItems: 3 }),
      reason: Type.String({ description: 'Why the push is needed' }),
    }),
    async execute(_id, params, _signal, _update, ctx) { return requestHostAction({ type: 'git-command', ...params }, ctx); },
  });
}
