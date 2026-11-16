import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function listenLocal(server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return `http://127.0.0.1:${server.address().port}`;
}

export async function waitFor(
  predicate,
  { attempts = 500, intervalMs = 10, message = 'Local test deadline.' } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  assert.fail(message);
}
