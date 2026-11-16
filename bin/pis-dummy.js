#!/usr/bin/env node
// Standalone JSONL backend for local development, deliberately not normal pis.
import { createDummyAgent } from '../src/dummy-agent.js';
import { JsonlDecoder } from '../src/pi-rpc.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--auto-resume') || args.length > 1) {
  console.error(
    'Usage: node bin/pis-dummy.js [--auto-resume] (JSONL stdin/stdout; no model calls)',
  );
  process.exitCode = 2;
} else {
  let agent,
    stopping,
    requests = 0;
  async function stop(code = 0) {
    if (stopping) return stopping;
    process.exitCode = code;
    process.stdin.pause();
    stopping = (async () => {
      await agent?.close();
      const deadline = setTimeout(() => process.exit(process.exitCode || 0), 2000);
      deadline.unref();
      process.stdout.end(() => clearTimeout(deadline));
    })();
    return stopping;
  }
  process.stdout.on('error', () => {
    void stop(1);
  });
  agent = await createDummyAgent(
    (record) => {
      const line = `${JSON.stringify(record)}\n`;
      if (process.stdout.writableLength + Buffer.byteLength(line) > 2 * 1024 * 1024) {
        void stop(1);
        return;
      }
      process.stdout.write(line);
    },
    { autoResume: args.includes('--auto-resume') },
  );
  const decoder = new JsonlDecoder(
    (record) => {
      if (stopping) return;
      if (++requests > 16) {
        void stop(1);
        return;
      }
      void agent
        .command(record)
        .catch(() => stop(1))
        .finally(() => requests--);
    },
    () => {
      void stop(1);
    },
    128 * 1024,
  );
  process.stdin.on('data', (chunk) => decoder.push(chunk));
  process.stdin.on('end', () => {
    decoder.end();
    void stop();
  });
  process.stdin.on('error', () => {
    void stop(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      void stop();
    });
}
