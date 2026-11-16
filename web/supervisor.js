import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Host-owned parent keeps only the salted password hash over an explicit restart.
// No detached child, autorestart-on-crash, shell commands or persisted login sessions.
let child,
  stopping = false,
  restarting = false,
  passwordHash,
  timer;
function launch() {
  restarting = false;
  child = fork(fileURLToPath(new URL('./cli.js', import.meta.url)), process.argv.slice(2), {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (message) => {
    if (message?.type === 'supervisor_ready')
      child.send({ type: 'supervisor_config', passwordHash });
    if (
      message?.type === 'password_hash' &&
      !passwordHash &&
      /^[a-f0-9]{64}$/.test(message.passwordHash?.salt) &&
      /^[a-f0-9]{128}$/.test(message.passwordHash?.hash)
    )
      passwordHash = message.passwordHash;
    if (message?.type === 'restart_server' && !stopping && passwordHash) restarting = true;
  });
  child.on('error', () => {
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (!stopping && restarting && code === 0) launch();
    else {
      passwordHash = undefined;
      process.exitCode =
        code ?? (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] || 1) : 1);
    }
  });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child?.kill(signal);
    timer = setTimeout(() => child?.kill('SIGKILL'), 100000);
    timer.unref();
  });
launch();
