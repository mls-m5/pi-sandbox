import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PiRpc, validateControlCommand } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { budget, exact, send, wsOptions } from './common.js';

// Network lifecycle is independent of local runtime lifecycle. No arbitrary
// executable, filesystem path, native RPC method or host action crosses this API.
export function connectView({ view, origin, token }) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Only explicit local loopback connections are supported in this version.');
  const events = new EventEmitter();
  let socket, timer, stopped = false, attempts = 0;
  const onFrame = frame => { if (socket) send(socket, { v: 1, type: 'frame', frame }); };
  view.on('frame', onFrame);
  function connect() {
    if (stopped) return;
    const ws = new WebSocket(`${url.origin.replace('http:', 'ws:')}/agent`, {
      ...wsOptions, followRedirects: false, handshakeTimeout: 5000, headers: { Authorization: `Bearer ${token}` },
    });
    socket = ws;
    let pending = 0, lastActivity = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - lastActivity > 45_000) ws.terminate(); }, 10_000);
    ws.on('ping', () => { lastActivity = Date.now(); });
    const receiveBudget = budget(30, 1000);
    ws.on('error', () => {}); // Never log URLs, headers or arbitrary peer error text.
    ws.on('open', () => {
      attempts = 0;
      send(ws, { v: 1, type: 'hello', generation: view.control.generation, seq: view.sequence, status: view.rpc.status });
      events.emit('connected');
    });
    ws.on('message', (data, binary) => {
      lastActivity = Date.now();
      try {
        if (binary || !receiveBudget() || pending >= 16) throw new Error('Protocol.');
        const message = JSON.parse(data.toString());
        if (!exact(message, ['v', 'type', 'routeId', 'command']) || message.v !== 1 || message.type !== 'command' || typeof message.routeId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.routeId)) throw new Error('Protocol.');
        const command = validateControlCommand(message.command);
        pending++;
        void view.execute(command).then(result => {
          // A reply belongs only to this connection. Never queue it for reconnect.
          if (socket === ws) send(ws, { v: 1, type: 'result', routeId: message.routeId, result });
        }).catch(() => ws.terminate()).finally(() => pending--);
      } catch { ws.terminate(); }
    });
    ws.on('close', () => {
      clearInterval(watchdog);
      if (socket === ws) socket = undefined;
      events.emit('disconnected');
      if (!stopped) timer = setTimeout(connect, Math.min(10_000, 250 * 2 ** Math.min(attempts++, 6)) + Math.random() * 200);
    });
  }
  connect();
  return {
    events,
    disconnect() { socket?.terminate(); }, // Testable transport interruption, never EOF on Pi.
    close() { stopped = true; clearTimeout(timer); socket?.terminate(); view.off('frame', onFrame); },
  };
}

export async function startDummyConnector({ origin, token, autoResume = true }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pis-dummy.js', import.meta.url)), ...(autoResume ? ['--auto-resume'] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/nonexistent-pis-dummy-home', TERM: 'dumb' },
  });
  const rpc = new PiRpc(child), view = new PiView(rpc);
  try {
    const state = await rpc.request('get_state');
    if (!state.success) throw new Error('Dummy initialization failed.');
    const network = connectView({ view, origin, token });
    rpc.once('closed', () => network.close());
    return {
      network, view, rpc,
      async close() { network.close(); view.detach(); await rpc.shutdown(); },
    };
  } catch {
    view.detach(); await rpc.shutdown(); throw new Error('Dummy connector startup failed.');
  }
}
