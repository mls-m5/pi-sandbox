import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PiRpc, validateControlCommand } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';
import { budget, exact, send, wsOptions } from './common.js';
import { resultCode } from './public/diagnostics.js';

// Network lifecycle is independent of local runtime lifecycle. No arbitrary
// executable, filesystem path, native RPC method or host action crosses this API.
export function connectView({
  view,
  origin,
  token,
  diagnostic = () => {},
  createConnection,
  hostPush,
}) {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  )
    throw new Error('Only explicit local loopback connections are supported in this version.');
  const events = new EventEmitter();
  let socket,
    timer,
    stopped = false,
    attempts = 0,
    registeredGeneration;
  const onFrame = (frame) => {
    if (socket) send(socket, { v: 1, type: 'frame', frame });
  };
  view.on('frame', onFrame);
  const onFault = (code) => diagnostic({ component: 'connector', event: 'rpc_fault', code });
  const onClosed = (code) => diagnostic({ component: 'connector', event: 'rpc_closed', code });
  view.rpc.on('fault', onFault);
  view.rpc.on('closed', onClosed);
  const proposal = (value) => {
    if (
      !socket ||
      !send(socket, {
        v: 1,
        type: 'host_push',
        generation: view.control.generation,
        proposal: value,
      })
    )
      hostPush.cancel();
  };
  const outcome = (value) => {
    if (socket)
      send(socket, {
        v: 1,
        type: 'host_push_outcome',
        generation: view.control.generation,
        ...value,
      });
  };
  hostPush?.events.on('proposal', proposal);
  hostPush?.events.on('outcome', outcome);
  function connect() {
    if (stopped) return;
    const ws = new WebSocket(`${url.origin.replace('http:', 'ws:')}/agent`, {
      ...wsOptions,
      followRedirects: false,
      handshakeTimeout: 5000,
      headers: { Authorization: `Bearer ${token}` },
      ...(createConnection ? { createConnection } : {}),
    });
    socket = ws;
    let pending = 0,
      lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > 45_000) ws.terminate();
    }, 10_000);
    ws.on('ping', () => {
      lastActivity = Date.now();
    });
    const receiveBudget = budget(30, 1000);
    ws.on('error', () => {}); // Never log URLs, headers or arbitrary peer error text.
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403) {
        stopped = true;
        events.emit('rejected'); // New registration needed, not an endless auth retry loop.
      }
      ws.terminate();
    });
    ws.on('open', () => {
      attempts = 0;
      send(ws, {
        v: 1,
        type: 'hello',
        generation: view.control.generation,
        seq: view.sequence,
        status: view.rpc.status,
      });
      events.emit('connected');
    });
    ws.on('message', (data, binary) => {
      lastActivity = Date.now();
      try {
        if (binary || !receiveBudget() || pending >= 16) throw new Error('Protocol.');
        const message = JSON.parse(data.toString());
        if (
          exact(message, ['v', 'type', 'generation']) &&
          message.v === 1 &&
          message.type === 'registered' &&
          message.generation === view.control.generation
        ) {
          registeredGeneration = message.generation;
          events.emit('registered');
          return;
        }
        if (
          hostPush &&
          exact(message, ['v', 'type', 'generation', 'id', 'approved', 'code']) &&
          message.v === 1 &&
          message.type === 'host_push_decision' &&
          message.generation === view.control.generation &&
          typeof message.id === 'string' &&
          /^[a-f0-9-]{36}$/.test(message.id) &&
          typeof message.approved === 'boolean' &&
          typeof message.code === 'string' &&
          message.code.length <= 2
        ) {
          hostPush.decide(message);
          return;
        }
        if (
          !exact(message, ['v', 'type', 'routeId', 'command']) ||
          message.v !== 1 ||
          message.type !== 'command' ||
          typeof message.routeId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(message.routeId)
        )
          throw new Error('Protocol.');
        const command = validateControlCommand(message.command);
        // Old in-flight commands belong to the retired generation, never the replacement.
        if (command.generation !== view.control.generation) return;
        const executingView = view;
        const startedAt = Date.now();
        diagnostic({
          component: 'connector',
          event: 'command_received',
          action: command.action,
          trace: message.routeId,
        });
        pending++;
        void view
          .execute(command)
          .then((result) => {
            diagnostic({
              component: 'connector',
              event: 'command_result',
              action: command.action,
              trace: message.routeId,
              code: resultCode(result),
              durationMs: Date.now() - startedAt,
              stable: result.stable,
            });
            // A reply belongs only to this connection. Never queue it for reconnect.
            if (socket === ws && view === executingView)
              send(ws, { v: 1, type: 'result', routeId: message.routeId, result });
          })
          .catch(() => {
            if (view === executingView && socket === ws) ws.terminate();
          })
          .finally(() => pending--);
      } catch {
        diagnostic({
          component: 'connector',
          event: 'protocol_rejected',
          code: 'protocol_rejected',
        });
        ws.terminate();
      }
    });
    ws.on('close', () => {
      hostPush?.cancel();
      diagnostic({ component: 'connector', event: 'agent_disconnected' });
      clearInterval(watchdog);
      if (socket === ws) {
        socket = undefined;
        registeredGeneration = undefined;
      }
      events.emit('disconnected');
      if (!stopped)
        timer = setTimeout(
          connect,
          Math.min(10_000, 250 * 2 ** Math.min(attempts++, 6)) + Math.random() * 200,
        );
    });
  }
  connect();
  return {
    events,
    async replaceView(next, nextHostPush) {
      if (
        stopped ||
        next.rpc.status !== 'idle' ||
        next.control.generation === view.control.generation
      )
        throw new Error('Runtime replacement unavailable.');
      const previousGeneration = view.control.generation;
      view.off('frame', onFrame);
      view.rpc.off('fault', onFault);
      view.rpc.off('closed', onClosed);
      hostPush?.events.off('proposal', proposal);
      hostPush?.events.off('outcome', outcome);
      view = next;
      hostPush = nextHostPush;
      view.on('frame', onFrame);
      view.rpc.on('fault', onFault);
      view.rpc.on('closed', onClosed);
      hostPush?.events.on('proposal', proposal);
      hostPush?.events.on('outcome', outcome);
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(deadline);
          events.off('registered', ready);
          events.off('rejected', failed);
          events.off('stopped', failed);
          error ? reject(new Error('Runtime registration unavailable.')) : resolve();
        };
        const ready = () => {
          if (registeredGeneration === view.control.generation) finish();
        };
        const failed = () => finish(true);
        const deadline = setTimeout(failed, 8000);
        events.on('registered', ready);
        events.on('rejected', failed);
        events.on('stopped', failed);
        if (socket && registeredGeneration === previousGeneration)
          send(socket, {
            v: 1,
            type: 'runtime_replaced',
            previousGeneration,
            generation: view.control.generation,
            seq: view.sequence,
            status: 'idle',
          });
        else socket?.terminate(); // Existing bounded reconnect sends only a fresh hello, no replay.
      });
    },
    disconnect() {
      socket?.terminate();
    }, // Testable transport interruption, never EOF on Pi.
    close() {
      stopped = true;
      events.emit('stopped');
      clearTimeout(timer);
      socket?.terminate();
      hostPush?.cancel();
      hostPush?.events.off('proposal', proposal);
      hostPush?.events.off('outcome', outcome);
      view.off('frame', onFrame);
      view.rpc.off('fault', onFault);
      view.rpc.off('closed', onClosed);
    },
  };
}

export async function startDummyConnector({
  origin,
  token,
  autoResume = true,
  diagnostic,
  createConnection,
}) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/pis-dummy.js', import.meta.url)),
      ...(autoResume ? ['--auto-resume'] : []),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: '/nonexistent-pis-dummy-home', TERM: 'dumb' },
    },
  );
  const rpc = new PiRpc(child),
    view = new PiView(rpc);
  try {
    const state = await rpc.request('get_state');
    if (!state.success) throw new Error('Dummy initialization failed.');
    const network = connectView({ view, origin, token, diagnostic, createConnection });
    rpc.once('closed', () => network.close());
    return {
      network,
      view,
      rpc,
      async close() {
        network.close();
        view.detach();
        await rpc.shutdown();
      },
    };
  } catch {
    view.detach();
    await rpc.shutdown();
    throw new Error('Dummy connector startup failed.');
  }
}
