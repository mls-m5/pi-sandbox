import { setTimeout as delay } from 'node:timers/promises';
import { localServerOrigin } from './agent-profile.js';
import { validateEnrollment, labelValid } from './enrollment.js';
import { exact, generationValid, idValid } from './common.js';
import { assert } from '../src/util.js';

// Only an explicit 202 is safe to repeat. Any ambiguous HTTP/stream outcome stops.
export async function pairAgent(
  origin,
  enrollment,
  { fetchImpl = globalThis.fetch, signal, onCode = () => {}, intervalMs = 1000 } = {},
) {
  origin = localServerOrigin(origin);
  validateEnrollment(enrollment);
  async function request(route, body, token) {
    let reader;
    try {
      const response = await fetchImpl(`${origin}${route}`, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'X-Pis-Web': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      if (response.status === 409)
        throw Object.assign(new Error('Registration conflict.'), { code: 'ENROLLMENT_CONFLICT' });
      assert([200, 201, 202].includes(response.status) && !response.redirected, 'Pairing refused.');
      reader = response.body?.getReader();
      assert(reader, 'Missing pairing response.');
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        assert(bytes <= 1024, 'Pairing response limit.');
        chunks.push(value);
      }
      return {
        status: response.status,
        value: JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
        ),
      };
    } catch (error) {
      if (error.code === 'ENROLLMENT_CONFLICT') throw error;
      throw new Error(
        'Connection approval failed or outcome is unknown. No automatic retry; inspect the server before trying again.',
      );
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    }
  }
  signal?.throwIfAborted();
  const created = await request('/agent/requests', enrollment);
  const ticket = created.value;
  assert(
    created.status === 201 &&
      exact(ticket, ['id', 'token', 'code', 'expiresAt']) &&
      generationValid(ticket.id) &&
      typeof ticket.token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(ticket.token) &&
      typeof ticket.code === 'string' &&
      /^[0-9]{2}$/.test(ticket.code) &&
      Number.isSafeInteger(ticket.expiresAt) &&
      ticket.expiresAt > Date.now() &&
      ticket.expiresAt <= Date.now() + 120_000,
    'Invalid pairing response. No automatic retry.',
  );
  onCode(ticket.code);
  while (Date.now() < ticket.expiresAt) {
    signal?.throwIfAborted();
    const result = await request('/agent/requests/result', { id: ticket.id }, ticket.token);
    if (result.status === 202) {
      assert(
        exact(result.value, ['pending']) && result.value.pending === true,
        'Invalid pending response.',
      );
      await delay(Math.min(intervalMs, Math.max(0, ticket.expiresAt - Date.now())), undefined, {
        signal,
      });
      continue;
    }
    const value = result.value;
    assert(
      result.status === 201 &&
        exact(value, ['id', 'token', 'kind', 'label']) &&
        idValid(value.id) &&
        value.kind === enrollment.kind &&
        labelValid(value.label) &&
        typeof value.token === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(value.token),
      'Invalid connection confirmation. No automatic retry.',
    );
    return value;
  }
  throw new Error('Connection request expired; no agent started.');
}
