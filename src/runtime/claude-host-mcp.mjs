// Trusted image-owned MCP stdio server for Claude Code. Like the Pi tools, it can
// only SUGGEST a typed host action; approval happens on the host after the sandbox
// has stopped. Dependency-free: newline-delimited JSON-RPC 2.0 on stdio.
import net from 'node:net';
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'request_apt_packages',
    description:
      'If a task requires missing Debian apt packages, request their installation. Supply only exact apt package names and a short reason. This stops Claude Code; the user reviews and approves or rejects the request outside the sandbox, after which the image is rebuilt and the session continues. Never claim packages were installed before the next start.',
    inputSchema: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string', description: 'Debian apt package name, not a shell command' },
          minItems: 1,
          maxItems: 10,
        },
        reason: { type: 'string', description: 'Why these packages are necessary for the task' },
      },
      required: ['packages', 'reason'],
      additionalProperties: false,
    },
    action: 'apt-packages',
  },
  {
    name: 'request_host_git',
    description:
      'Request ONE Git operation on the host, using host authentication only after the user approves it there. Claude Code stops for approval. Currently only args ["push", "REMOTE", "FULL_40_HEX_COMMIT:refs/heads/BRANCH"] are allowed: no shell, force, aliases or other commands. repo is relative to the registered project; use "." for its root. Commit changes inside the sandbox first and use the full commit hash. Submodules inside the project can be proposed individually using their relative path. After a successful push the session continues; do not claim success before the host reports it.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description:
            'Relative repository path in the project, usually ".". Ordinary .git directories only.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          minItems: 3,
          maxItems: 3,
          description:
            'Git arguments without the git executable. Example: ["push", "origin", "FULL_COMMIT:refs/heads/main"]',
        },
        reason: { type: 'string', description: 'Why the push is needed' },
      },
      required: ['repo', 'args', 'reason'],
      additionalProperties: false,
    },
    action: 'git-command',
  },
];

export function sendProposal(socketPath, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Request timed out.')));
    socket.on('connect', () => socket.write(`${JSON.stringify(data)}\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > 128) return socket.destroy(new Error('Invalid response.'));
      if (response.includes('\n')) socket.end();
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response).ok === true);
      } catch {
        reject(new Error('Invalid response.'));
      }
    });
    socket.on('error', reject);
  });
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

export async function callTool(params, env = process.env, stop = stopClaude) {
  const tool = TOOLS.find((entry) => entry.name === params?.name);
  if (!tool || !env.PIS_APT_SOCKET) return textResult('Unknown or unavailable tool.', true);
  const args = params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return textResult('Invalid arguments.', true);
  let accepted;
  try {
    accepted = await sendProposal(env.PIS_APT_SOCKET, { type: tool.action, ...args });
  } catch {
    return textResult('Host request failed; nothing was executed.', true);
  }
  if (!accepted)
    return textResult('Host action request rejected or invalid; nothing was executed.', true);
  stop();
  return textResult(
    'Request sent to pis. Claude Code is stopping so the user can review it on the host. Nothing has been executed or approved yet.',
  );
}

// Claude Code is this server's parent. Give the tool result a moment to flush, then ask
// it to exit; the host wrapper sees the container end and runs the approval flow.
function stopClaude() {
  setTimeout(() => {
    if (process.ppid > 1) {
      try {
        process.kill(process.ppid, 'SIGTERM');
      } catch {}
    }
    setTimeout(() => process.exit(0), 3000).unref();
  }, 300);
}

export async function handle(message, env = process.env, stop = stopClaude) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined) return undefined; // notifications need no answer
  if (method === 'initialize')
    return reply({
      protocolVersion:
        typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'pis-host', version: '1' },
    });
  if (method === 'ping') return reply({});
  if (method === 'tools/list')
    return reply({
      tools: env.PIS_APT_SOCKET
        ? TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        : [],
    });
  if (method === 'tools/call') return reply(await callTool(params, env, stop));
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (!line.trim() || line.length > 65536) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  lines.on('close', () => process.exit(0));
}
