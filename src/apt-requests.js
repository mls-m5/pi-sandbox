import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { privateDir } from './util.js';
import { validate } from './config.js';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const MAX_BYTES = 4096;

export function validateAptProposal(data, config, store) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid apt proposal.');
  const { type, packages, reason } = data;
  if (type !== 'apt-packages' || Object.keys(data).some(key => !['type', 'packages', 'reason'].includes(key))) throw new Error('Unsupported host action.');
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 10 ||
      packages.some(pkg => typeof pkg !== 'string' || !/^[a-z0-9][a-z0-9+.-]{0,79}$/.test(pkg)) ||
      new Set(packages).size !== packages.length ||
      typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 500 || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(reason)) {
    throw new Error('Invalid apt proposal.');
  }
  const proposed = packages.filter(pkg => !config.image.packages.includes(pkg));
  if (!proposed.length) throw new Error('Packages already configured.');
  validate({ ...config, image: { ...config.image, packages: [...config.image.packages, ...proposed] } }, { storage: store.root, identity: config, paths: false });
  return { type: 'apt-packages', packages: proposed, reason: reason.trim() };
}

// Only a proposal crosses the socket. The host never accepts an "approve" message.
export async function startAptRequestServer(config, store) {
  const directory = fs.mkdtempSync('/tmp/pis-apt-');
  privateDir(directory);
  const socketPath = path.join(directory, 'request.sock');
  let proposal;
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    let data = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BYTES) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      try {
        if (proposal || data.indexOf('\n') !== data.length - 1) throw new Error('Only one proposal is allowed.');
        proposal = validateAptProposal(JSON.parse(data.slice(0, -1)), config, store);
        socket.end('{"ok":true}\n');
      } catch { socket.end('{"ok":false}\n'); }
    });
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {});
  });
  server.maxConnections = 8;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  return {
    directory,
    get proposal() { return proposal; },
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function approveAptProposal(proposal, { input = process.stdin, output = process.stderr } = {}) {
  const code = String(randomInt(100000, 1000000));
  output.write(`\npis: Pi requested Debian packages: ${proposal.packages.join(', ')}\nReason supplied by the sandbox (untrusted): ${proposal.reason}\nThis changes the image configuration for this project and installs packages on the next start.\n`);
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(`Type ${code} to approve (Enter declines): `);
    return answer.trim() === code;
  } finally { prompt.close(); }
}

export async function applyAptProposal(store, original, proposal) {
  // save() re-reads the current config under the registry lock and refuses stale drafts.
  const updated = { ...original, image: { ...original.image, packages: [...original.image.packages, ...proposal.packages] } };
  validateAptProposal(proposal, original, store);
  await store.save(updated, original);
  return updated;
}
