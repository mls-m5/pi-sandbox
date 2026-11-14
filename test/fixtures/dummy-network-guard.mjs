// Test guard: the dummy may use only its private quota Unix socket, never TCP.
// This is not an OS sandbox against arbitrary untrusted code.
import net from 'node:net';
const connect = net.Socket.prototype.connect;
function allowed(args) {
  if (Array.isArray(args[0])) return allowed(args[0]);
  const first = args[0];
  const path = typeof first === 'string' ? first : first?.path;
  return typeof path === 'string' && /^\/tmp\/pis-codex-auto-[A-Za-z0-9]{6}\/wait\.sock$/.test(path);
}
net.Socket.prototype.connect = function (...args) {
  if (!allowed(args)) process.exit(91);
  return connect.apply(this, args);
};
globalThis.fetch = () => process.exit(92);
