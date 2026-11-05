import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { assert, privateDir } from './util.js';
import { getCodexUsage } from './codex-auth.js';
import { codexAvailability, waitForCodex } from './codex-wait.js';

export function validateCodexAuto(config, options, command, { terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) } = {}) {
  assert((config.agent || 'pi') === 'pi' && config.credentials.proxy?.provider === 'openai-codex', '--auto-wait-codex requires Pi with the openai-codex host proxy.');
  const args = command.slice(1, command.indexOf('--') === -1 ? command.length : command.indexOf('--'));
  const management = ['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp'];
  const unsupported = ['--no-session', '--no-extensions', '-ne', '-p', '--print', '--export', '--help', '-h', '--version', '-v', '--list-models'];
  assert(terminal && options.mode === 'pi' && !options.buildOnly && !options.stdio && command[0] === 'pi' && !management.includes(args[0]) && !args.some((arg, index) => unsupported.includes(arg.split('=')[0]) || (arg === '--mode' && args[index + 1] !== 'text') || (arg.startsWith('--mode=') && arg !== '--mode=text')), '--auto-wait-codex requires a normal terminal Pi session with persisted sessions and extensions enabled; print/JSON/RPC, management and custom stdio are unsupported.');
}

// This is not an approval/host-command service. It accepts one fixed query and
// returns only availability states. No error text, path, token or command crosses it.
export async function startCodexAutoServer(store, { usage = getCodexUsage, sleep, now = Date.now, minCheckInterval = 60_000 } = {}) {
  const directory = fs.mkdtempSync('/tmp/pis-codex-auto-');
  privateDir(directory);
  const socketPath = path.join(directory, 'wait.sock');
  const peers = new Map();
  const tasks = new Set();
  let active = false, lastCheck = -Infinity, closing;
  const end = (socket, state) => {
    if (!socket.destroyed) {
      socket.end(`${JSON.stringify({ state })}\n`);
      socket.setTimeout(5000, () => socket.destroy());
    }
  };
  const server = net.createServer(socket => {
    if (closing) { socket.destroy(); return; }
    const controller = new AbortController();
    peers.set(socket, controller);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', chunk => {
      if (handled) { socket.destroy(); return; }
      input += chunk;
      if (Buffer.byteLength(input) > 128) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(input);
        assert(input.indexOf('\n') === input.length - 1 && request?.type === 'codex-wait' && Object.keys(request).length === 1, 'Invalid request.');
      } catch { end(socket, 'error'); return; }
      if (active || now() - lastCheck < minCheckInterval) { end(socket, 'busy'); return; }
      active = true;
      lastCheck = now();
      socket.setTimeout(0);
      const task = (async () => {
        try {
          const initial = await usage(store, { signal: controller.signal });
          controller.signal.throwIfAborted();
          if (codexAvailability(initial, now()).available) { end(socket, 'not-quota'); return; }
          let first = true;
          await waitForCodex(store, {
            signal: controller.signal, sleep, now,
            usage: async (...args) => {
              if (first) { first = false; return initial; }
              return usage(...args);
            },
            // Heartbeats are bounded fixed states, never host/upstream text.
            notify: () => { if (!socket.destroyed) socket.write('{"state":"waiting"}\n'); },
          });
          controller.signal.throwIfAborted();
          end(socket, 'ready');
        } catch { end(socket, 'error'); }
        finally { active = false; }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
    socket.on('error', () => {});
    socket.once('close', () => { controller.abort(); peers.delete(socket); });
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
    close() {
      return closing ||= (async () => {
        for (const [socket, controller] of peers) { controller.abort(); socket.destroy(); }
        await new Promise(resolve => server.close(resolve));
        await Promise.allSettled([...tasks]);
        fs.rmSync(directory, { recursive: true, force: true });
      })();
    },
  };
}
