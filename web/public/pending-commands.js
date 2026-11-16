import { safeTrace } from './diagnostics.js';

const BUSY = { data: { success: false, error: 'not_connected_or_busy' } };
const UNKNOWN = { data: { success: false, error: 'outcome_unknown' } };

export function createPendingCommands({
  timeout = 40_000,
  maxPending = 8,
  maxBuffered = 128 * 1024,
} = {}) {
  const pending = new Map();

  function finish(id, result) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(result);
    return true;
  }

  const available = (socket) => pending.size < maxPending && socket.bufferedAmount <= maxBuffered;

  return {
    isAvailable: available,
    send({ id, agentId, payload, socket }) {
      if (!available(socket)) return Promise.resolve(BUSY);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const trace = pending.get(id)?.diagnosticTrace;
          finish(id, {
            diagnosticTrace: trace,
            data: { success: false, error: 'outcome_unknown' },
          });
        }, timeout);
        pending.set(id, { agentId, resolve, timer });
        try {
          socket.send(payload);
        } catch {
          finish(id, UNKNOWN);
        }
      });
    },
    accepted(value) {
      const entry = pending.get(value.id);
      if (entry?.agentId === value.agentId) entry.diagnosticTrace = safeTrace(value.trace);
    },
    result(value) {
      const result = value.result;
      const entry = pending.get(result?.id);
      if (entry?.agentId === value.agentId)
        finish(result.id, { ...result, diagnosticTrace: safeTrace(value.trace) });
    },
    failAll() {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve({
          diagnosticTrace: entry.diagnosticTrace,
          data: { success: false, error: 'outcome_unknown' },
        });
      }
    },
    get size() {
      return pending.size;
    },
  };
}
