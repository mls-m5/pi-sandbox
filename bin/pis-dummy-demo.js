#!/usr/bin/env node
// Fixed local subprocess only. This demo cannot select a provider or real agent.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PiRpc } from '../src/pi-rpc.js';
import { PiView } from '../src/pi-view.js';

const child = spawn(process.execPath, [fileURLToPath(new URL('./pis-dummy.js', import.meta.url)), '--auto-resume'], {
  stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/nonexistent-pis-dummy-home', TERM: 'dumb' },
});
const rpc = new PiRpc(child), view = new PiView(rpc);
let id = 0;
const execute = (action, extra = {}) => view.execute({ v: 1, generation: view.control.generation, id: `demo-${++id}`, action, ...extra });
const completed = () => new Promise((resolve, reject) => {
  const listener = frame => {
    if (frame.event.type === 'message_end' && frame.event.message.role === 'assistant' && frame.event.message.stopReason === 'stop') {
      clearTimeout(timer); view.off('frame', listener); resolve();
    }
  };
  const timer = setTimeout(() => { view.off('frame', listener); reject(new Error('Dummy demo timed out.')); }, 10_000);
  view.on('frame', listener);
});
view.on('frame', ({ event }) => {
  if (event.update?.type === 'text_delta') process.stdout.write(event.update.text);
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    if (event.message.stopReason === 'error') console.log('[dummy] Simulated quota failure.');
    else console.log();
  }
  if (event.type === 'dummy_status') console.log(`[dummy quota] ${event.state}`);
});
try {
  console.log('Offline dummy demo: no Pi process, provider credentials or model tokens.');
  await execute('state');
  const hello = completed();
  await execute('prompt', { message: 'Hello dummy' }); await hello;
  // Final message precedes settlement: refresh idle state before submitting again.
  await new Promise(resolve => setImmediate(resolve));
  await execute('state');
  console.log('Simulating exhausted Codex quota for 2 seconds, then automatic continuation…');
  const resumed = completed();
  await execute('prompt', { message: '/dummy quota 2' }); await resumed;
  console.log('Demo complete. Continuation stayed in the same synthetic session.');
} catch {
  console.error('Dummy demo failed. No real provider fallback is available.');
  process.exitCode = 1;
} finally {
  view.detach();
  try { await rpc.shutdown(); }
  catch { child.kill('SIGKILL'); process.exitCode = 1; }
}
