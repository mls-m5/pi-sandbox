// Runs INSIDE the container. It has only a dummy key and a mounted Unix socket.
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';

const connections = new Set();
const relay = net.createServer(client => {
  const upstream = net.createConnection('/pis/proxy/api.sock');
  for (const socket of [client, upstream]) {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  }
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
});
relay.maxConnections = 64;

try {
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(43127, '127.0.0.1', resolve);
  });
  const [program, ...args] = process.argv.slice(2);
  if (!program) throw new Error('No sandbox command.');
  const child = spawn(program, args, { stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map(signal => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] || 1)));
    });
  } finally {
    handlers.forEach(([signal, handler]) => process.off(signal, handler));
  }
} catch {
  console.error('pis: sandbox proxy relay or command failed.');
  process.exitCode = 1;
} finally {
  for (const socket of connections) socket.destroy();
  await new Promise(resolve => relay.close(resolve));
}
