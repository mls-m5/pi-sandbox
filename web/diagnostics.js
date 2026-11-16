import { safeAction, safeCode, safeTrace } from './public/diagnostics.js';

const components = new Set(['server', 'connector']);
const events = new Set([
  'command_routed',
  'command_received',
  'command_result',
  'command_failed',
  'agent_registered',
  'agent_disconnected',
  'browser_connected',
  'browser_disconnected',
  'protocol_rejected',
  'session_probe',
  'rpc_fault',
  'rpc_closed',
]);
// Opt-in, bounded metadata only; never stringify the supplied source object.
export function createDiagnostics({
  enabled = false,
  write = (line) => process.stderr.write(line),
  now = Date.now,
} = {}) {
  let count = 0,
    until = 0,
    limited = false;
  return (source) => {
    if (!enabled || !components.has(source?.component) || !events.has(source?.event)) return;
    const time = now();
    if (time >= until) {
      count = 0;
      limited = false;
      until = time + 60_000;
    }
    try {
      if (++count > 120) {
        if (!limited)
          write('pis web diagnostic: {"event":"diagnostics_limited","limitPerMinute":120}\n');
        limited = true;
        return;
      }
      const record = { at: time, component: source.component, event: source.event };
      if (source.action !== undefined) record.action = safeAction(source.action);
      if (source.code !== undefined) record.code = safeCode(source.code);
      if (source.trace !== undefined) record.trace = safeTrace(source.trace);
      if (typeof source.durationMs === 'number' && Number.isFinite(source.durationMs))
        record.durationMs = Math.max(0, Math.min(600_000, Math.round(source.durationMs)));
      if (typeof source.stable === 'boolean') record.stable = source.stable;
      write(`pis web diagnostic: ${JSON.stringify(record)}\n`);
    } catch {
      /* A diagnostic sink must not break RPC draining or lifecycle. */
    }
  };
}
