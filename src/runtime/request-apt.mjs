// Trusted image-owned Pi extension. The container may suggest packages, never approve them.
import net from 'node:net';
import { Type } from '@earendil-works/pi-ai';

export default function (pi) {
  if (!process.env.PIS_APT_SOCKET) return;
  pi.registerTool({
    name: 'request_apt_packages',
    label: 'Request apt packages',
    exposure: 'model-only',
    description: 'If a task requires missing Debian apt packages, request their installation. Supply only exact apt package names and a short reason. This pauses Pi; the user reviews and approves or rejects the request outside the sandbox. Never claim packages were installed before the next start.',
    parameters: Type.Object({
      packages: Type.Array(Type.String({ description: 'Debian apt package name, not a shell command' }), { minItems: 1, maxItems: 10 }),
      reason: Type.String({ description: 'Why these packages are necessary for the current task' }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const accepted = await new Promise((resolve, reject) => {
        const socket = net.createConnection(process.env.PIS_APT_SOCKET);
        let data = '';
        socket.setTimeout(5000, () => socket.destroy(new Error('Request timed out.')));
        socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'apt-packages', ...params })}\n`));
        socket.on('data', chunk => {
          data += chunk.toString('utf8');
          if (data.length > 128) return socket.destroy(new Error('Invalid response.'));
          if (data.includes('\n')) socket.end();
        });
        socket.on('end', () => { try { resolve(JSON.parse(data).ok === true); } catch { reject(new Error('Invalid response.')); } });
        socket.on('error', reject);
      });
      if (!accepted) throw new Error('Package request rejected or invalid; nothing was installed.');
      // The host prompts after Podman exits; this is NOT user approval.
      ctx.shutdown();
      return { content: [{ type: 'text', text: 'Package request sent to the host. Pi is stopping so the user can review it. No packages have been installed.' }], details: undefined, terminate: true };
    },
  });
}
