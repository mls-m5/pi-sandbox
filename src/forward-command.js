import net from 'node:net';
import { serverAddress } from '../web/server-address.js';
import { openServerTransport } from '../web/ssh-transport.js';

export const FORWARD_HELP = `Usage: pis --forward ssh://[USER@]HOST[:SSH_PORT][/PIS_PORT]

Examples:
  pis --forward ssh://alice@server.example
  pis --forward ssh://192.0.2.10
  pis --forward ssh://alice@server.example:2222/43129

Defaults: SSH port 22, pis/browser port 43128. USER defaults to your host login.
The command prints http://127.0.0.1:43128/ when ready. Keep this terminal open;
Ctrl-C closes only this forward. It does not stop the remote server or agents.
Run pis --server --standalone on the SSH host first.

The local browser port MUST equal the remote pis port to preserve exact HTTP
Host/Origin and WebSocket checks. /43129 therefore uses localhost port 43129
as well. A busy port fails; no random fallback, public bind or header rewrite.
Only 127.0.0.1 is opened, not 0.0.0.0. No browser is launched automatically.
Other local users can reach this TCP port; normal server admin login is required.

Requires OpenSSH on the client host, key-based login and an independently verified
known_hosts entry. Test ssh -p SSH_PORT USER@HOST first. StrictHostKeyChecking=yes
and BatchMode=yes: no password prompt or automatic acceptance of unknown keys.
Host ~/.ssh/config aliases/ProxyCommand are not loaded; default keys/SSH agent
remain usable. A public HTTPS domain must also have separately reachable SSH.
No host credentials are mounted into agents. No project/profile/enrollment is
created. No reconnect or command replay; restart this forward after a failure.
For agent connection instead: pis --connect --set-server ssh://[USER@]HOST.
`;

export function parseForwardAddress(args) {
  if (args.length !== 1)
    throw new Error('Use pis --forward ssh://[USER@]HOST; see pis --forward --help.');
  const target = serverAddress(args[0]);
  if (target.kind !== 'ssh')
    throw new Error('Browser forwarding requires an explicit ssh:// address.');
  return target;
}

export async function startBrowserForward(
  address,
  { signal, openTransport = openServerTransport } = {},
) {
  const target = serverAddress(address);
  if (target.kind !== 'ssh')
    throw new Error('Browser forwarding requires an explicit ssh:// address.');
  signal?.throwIfAborted();
  const sockets = new Set();
  let transport,
    closing,
    listening = false,
    listenerBroken = false,
    listenerFailed;
  const listenerFailure = new Promise((resolve) => {
    listenerFailed = resolve;
  });
  const server = net.createServer({ maxConnections: 32 }, (socket) => {
    if (!transport || closing) {
      socket.destroy();
      return;
    }
    const upstream = transport.createConnection();
    sockets.add(socket);
    sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    socket.pipe(upstream).pipe(socket);
  });
  server.maxConnections = 32;
  server.on('error', () => {
    if (listening) {
      listenerBroken = true;
      listenerFailed();
      if (transport) void close();
    }
  });
  const close = () =>
    (closing ||= (async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await transport?.close();
    })());
  const aborted = () => {
    void close();
  };
  try {
    await new Promise((resolve, reject) => {
      const error = () => {
        server.off('listening', ready);
        reject(
          new Error(
            `Local browser port ${target.serverPort} is unavailable. Close your existing forward/server or use matching /PIS_PORT; see --forward --help.`,
          ),
        );
      };
      const ready = () => {
        server.off('error', error);
        resolve();
      };
      server.once('error', error);
      server.once('listening', ready);
      server.listen(target.serverPort, '127.0.0.1');
    });
    listening = true;
    signal?.throwIfAborted();
    transport = await openTransport(target.address, { signal });
    if (listenerBroken) throw new Error('Local browser forward unavailable.');
    signal?.throwIfAborted();
    signal?.addEventListener('abort', aborted, { once: true });
    return {
      url: `${target.origin}/`,
      closed: Promise.race([listenerFailure, transport.closed || new Promise(() => {})]),
      close: async () => {
        signal?.removeEventListener('abort', aborted);
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function forwardMain(args = process.argv.slice(3)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(FORWARD_HELP);
    return 0;
  }
  const target = parseForwardAddress(args);
  const controller = new AbortController();
  let stopped;
  const stopRequested = new Promise((resolve) => {
    stopped = resolve;
  });
  const stop = () => {
    controller.abort();
    stopped('stopped');
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
  let forward;
  try {
    forward = await startBrowserForward(target.address, { signal: controller.signal });
    console.log(
      `pis: browser forward ready: ${forward.url}\nKeep this terminal open. Ctrl-C closes the forward, not the server.`,
    );
    const outcome = await Promise.race([
      stopRequested,
      forward.closed?.then(() => 'lost') || new Promise(() => {}),
    ]);
    if (outcome === 'lost' && !controller.signal.aborted)
      throw new Error(
        'Browser/SSH forward unavailable. No automatic reconnect; run pis --forward again.',
      );
    return 0;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    throw error;
  } finally {
    try {
      await forward?.close();
    } finally {
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, stop);
    }
  }
}
