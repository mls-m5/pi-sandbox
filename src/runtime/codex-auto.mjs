// Image-owned Pi 1.2 extension. Real credentials and quota checks stay on the host.
import net from 'node:net';

export const AUTO_RESUME_NOTICE = '[pis] The host confirmed that Codex quota was exhausted and now reports available quota again. Continue the previous task in this same session. Review the current state before repeating tool actions; do not restart completed work.';

export function isCodexQuotaError(message) {
  return message?.role === 'assistant' && message.provider === 'openai-codex' && message.stopReason === 'error' && typeof message.errorMessage === 'string' && /\b429\b|usage_limit_reached|(?:usage|subscription|rate)[_ -]limit|quota[_ -](?:exceeded|exhausted)|insufficient_quota/i.test(message.errorMessage);
}

export function requestCodexWait(socketPath, { signal, onWaiting = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = net.createConnection(socketPath);
    let buffer = '', settled = false, confirmed = false;
    const finish = (error, state) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(state);
    };
    const abort = () => finish(new Error('Codex wait cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.setTimeout(180_000, () => finish(new Error('Codex wait service timed out.')));
    socket.on('connect', () => socket.write('{"type":"codex-wait"}\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        if (end > 128) { finish(new Error('Invalid Codex wait response.')); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let state;
        try {
          const data = JSON.parse(line);
          if (Object.keys(data).length !== 1) throw new Error('Invalid response.');
          state = data.state;
        } catch { finish(new Error('Invalid Codex wait response.')); return; }
        if (state === 'waiting') {
          confirmed = true;
          socket.setTimeout(600_000); // Host sends a heartbeat at each 1–5 minute poll.
          try { onWaiting(); } catch { finish(new Error('Codex wait callback failed.')); return; }
        } else if (['ready', 'not-quota', 'busy', 'error'].includes(state)) {
          if (state === 'ready' && !confirmed) finish(new Error('Unconfirmed Codex wait response.'));
          else finish(undefined, state);
          return;
        } else { finish(new Error('Invalid Codex wait response.')); return; }
      }
      if (buffer.length > 128) finish(new Error('Invalid Codex wait response.'));
    });
    socket.on('error', () => finish(new Error('Codex wait service unavailable.')));
    socket.on('close', () => finish(new Error('Codex wait service disconnected.')));
  });
}

export default function (pi, { socketPath = process.env.PIS_CODEX_AUTO_SOCKET, request = requestCodexWait, defer = setImmediate } = {}) {
  if (!socketPath) return;
  let enabled = true, candidate, pending, removeInput, epoch = 0;
  const status = (ctx, text) => { try { if (ctx.hasUI) ctx.ui.setStatus('pis-codex-auto', text); } catch { /* UI may already be disposed. */ } };
  const notify = (ctx, text, level) => { try { if (ctx.hasUI) ctx.ui.notify(text, level); } catch { /* Session shutdown wins. */ } };
  const cancel = ctx => {
    epoch += 1;
    candidate = undefined;
    const old = pending;
    pending = undefined;
    old?.controller.abort();
    status(ctx, enabled ? 'Codex auto-wait: enabled' : undefined);
  };
  const begin = async (ctx, failedModel) => {
    if (!enabled || pending || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.model?.provider !== 'openai-codex' || ctx.model.id !== failedModel || !ctx.sessionManager.getSessionFile()) return;
    const task = {
      controller: new AbortController(),
      file: ctx.sessionManager.getSessionFile(), leaf: ctx.sessionManager.getLeafId(), model: ctx.model.id, thinking: ctx.thinkingLevel,
    };
    pending = task;
    status(ctx, 'Codex quota: checking on host…');
    try {
      const result = await request(socketPath, {
        signal: task.controller.signal,
        onWaiting: () => { if (pending === task) status(ctx, 'Codex quota exhausted: waiting (Esc or /codex-auto off cancels)'); },
      });
      if (pending !== task || task.controller.signal.aborted) return;
      const unchanged = enabled && ctx.isIdle() && !ctx.hasPendingMessages() && ctx.model?.provider === 'openai-codex' && ctx.model.id === task.model && ctx.thinkingLevel === task.thinking && ctx.sessionManager.getSessionFile() === task.file && ctx.sessionManager.getLeafId() === task.leaf;
      pending = undefined;
      status(ctx, 'Codex auto-wait: enabled');
      if (result === 'ready' && unchanged) {
        notify(ctx, 'Codex quota is available again. Continuing this session (uses model quota).', 'info');
        pi.sendUserMessage(AUTO_RESUME_NOTICE);
      } else if (result === 'not-quota') {
        notify(ctx, 'Host usage did not confirm exhausted Codex quota. No automatic retry was sent.', 'info');
      } else if (result === 'error' || result === 'busy') {
        notify(ctx, 'Automatic Codex wait stopped: host usage check unavailable or busy. No continuation was sent.', 'warning');
      }
      // "not-quota" is not a subscription stop. Never loop/retry on that result.
    } catch {
      if (pending !== task) return;
      pending = undefined;
      status(ctx, 'Codex auto-wait: enabled');
      if (!task.controller.signal.aborted) notify(ctx, 'Automatic Codex wait stopped; check host usage/sign-in. No continuation was sent.', 'warning');
    }
  };

  pi.on('session_start', (_event, ctx) => {
    cancel(ctx);
    removeInput?.();
    if (ctx.mode === 'tui') removeInput = ctx.ui.onTerminalInput(data => {
      // Standard and Kitty Escape/Ctrl-C. Do not consume Pi's own input.
      if (/^(?:\x03|\x1b|\x1b\[(?:27(?:;1)?|99;5)(?::[123])?u)$/.test(data)) cancel(ctx);
      return undefined;
    });
  });
  pi.on('message_end', ({ message }) => {
    if (message.role === 'assistant') candidate = isCodexQuotaError(message) ? message.model : undefined;
  });
  pi.on('session_compact_failed', (event, ctx) => {
    // Overflow recovery interrupted a model turn. A failed idle/manual compaction
    // is not proof of unfinished work and must not restart an otherwise done task.
    if (event.reason === 'overflow' && !event.aborted && !event.fromExtension && isCodexQuotaError({ role: 'assistant', provider: ctx.model?.provider, stopReason: 'error', errorMessage: event.errorMessage })) candidate = ctx.model.id;
  });
  pi.on('agent_settled', (event, ctx) => {
    const failedModel = candidate;
    candidate = undefined;
    if (event.aborted) { cancel(ctx); return; }
    if (!failedModel || ctx.mode !== 'tui') return;
    // agent_settled is notification-only. Start background work after dispatch;
    // never hold an event handler or send a model message inside that boundary.
    const file = ctx.sessionManager.getSessionFile(), version = epoch;
    defer(() => {
      // Capture the final leaf in begin(), after other settlement observers have
      // appended metadata. Explicit session/tree/input changes invalidate epoch.
      if (version === epoch && file === ctx.sessionManager.getSessionFile()) void begin(ctx, failedModel);
    });
  });
  pi.on('session_before_compact', (event, ctx) => {
    const failedModel = candidate;
    cancel(ctx);
    // Internal recovery must not erase an already observed failed main turn.
    if (event.reason === 'threshold' || event.reason === 'overflow') candidate = failedModel;
  });
  for (const event of ['input', 'before_agent_start', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'model_select', 'thinking_level_select', 'user_bash']) pi.on(event, (_event, ctx) => { cancel(ctx); });
  pi.on('cache_warming_decision', () => enabled ? { action: 'stop' } : undefined);
  pi.on('session_shutdown', (_event, ctx) => { cancel(ctx); removeInput?.(); removeInput = undefined; });
  pi.registerCommand('codex-auto', {
    description: 'Codex quota auto-wait: on, off, or status. Off cancels pending continuation.',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'off') { enabled = false; cancel(ctx); }
      else if (action === 'on') { enabled = true; status(ctx, 'Codex auto-wait: enabled'); }
      else if (action && action !== 'status') { notify(ctx, 'Usage: /codex-auto on|off|status', 'warning'); return; }
      notify(ctx, `Codex auto-wait: ${enabled ? 'enabled' : 'disabled'}${pending ? ', waiting for host quota' : ''}.`, 'info');
    },
  });
}
