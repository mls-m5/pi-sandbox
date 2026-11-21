// Wait for a Claude subscription limit to reset, then continue the session.
// The limit is observed only from responses the host proxy already forwards (HTTP 429
// plus Anthropic's undocumented unified rate-limit headers, unverified against a real
// account). No extra upstream request is made while waiting and no credential is used.
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { readClaudeUsage } from './claude-usage.js';

export const CLAUDE_WAIT_MARGIN_MS = 5 * 60_000;
export const CLAUDE_WAIT_MIN_MS = 60_000; // shorter limits are left to Claude's own retries
export const CLAUDE_WAIT_MAX_MS = 8 * 86400_000;
export const CLAUDE_WAIT_GRACE_MS = 30_000;
export const CLAUDE_WAIT_MAX_FRUITLESS = 3;

export const CLAUDE_RESUME_NOTICE =
  '[pis] The Claude usage limit was reached and pis waited for it to reset; the agent has restarted. Continue the previous task from this session. Review the current state before repeating any tool action; do not restart completed work.';

function first(headers, name) {
  const value = headers?.[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text.trim() ? Number(text) : NaN;
}

/**
 * Epoch ms at which a 429 limit resets, or null when the response does not prove a
 * long limit (unknown, shorter than a minute, or implausibly far away).
 */
export function claudeLimitReset(status, headers, now = Date.now()) {
  if (status !== 429) return null;
  const exhausted = [];
  for (const part of ['5h', '7d']) {
    const utilization = first(headers, `anthropic-ratelimit-unified-${part}-utilization`);
    const reset = first(headers, `anthropic-ratelimit-unified-${part}-reset`);
    if (utilization >= 1 && Number.isFinite(reset)) exhausted.push(reset * 1000);
  }
  let resetAt = exhausted.length ? Math.max(...exhausted) : NaN;
  if (!Number.isFinite(resetAt)) {
    const overall = first(headers, 'anthropic-ratelimit-unified-reset');
    resetAt = Number.isFinite(overall) ? overall * 1000 : NaN;
  }
  if (!Number.isFinite(resetAt)) {
    const retry = first(headers, 'retry-after');
    resetAt = Number.isFinite(retry) ? now + retry * 1000 : NaN;
  }
  const ahead = resetAt - now;
  return ahead >= CLAUDE_WAIT_MIN_MS && ahead <= CLAUDE_WAIT_MAX_MS ? resetAt : null;
}

/** Latest reset of an already exhausted window in the proxy's cached usage, or null. */
export function cachedClaudeLimit(store, now = Date.now()) {
  const { rate_limit } = readClaudeUsage(store, now);
  const times = Object.values(rate_limit)
    .filter((window) => window.used_percent >= 100)
    .map((window) => window.reset_at * 1000);
  return times.length ? Math.max(...times) : null;
}

/**
 * Watches proxy responses. After a limit response and `graceMs` without a successful model
 * response, it stops the container once so the host can wait and restart.
 */
export function startLimitWatcher({
  stopContainer,
  onFire,
  graceMs = CLAUDE_WAIT_GRACE_MS,
  intervalMs = 2000,
  now = Date.now,
}) {
  let resetAt = null,
    limitSeenAt = 0,
    lastOk = 0,
    fired = false,
    okCount = 0;
  const check = async () => {
    if (fired || resetAt === null || lastOk >= limitSeenAt || now() - limitSeenAt < graceMs) return false;
    fired = true;
    onFire?.(resetAt);
    await stopContainer();
    return true;
  };
  const timer = setInterval(() => void check().catch(() => {}), intervalMs);
  timer.unref?.();
  return {
    check,
    observe(status, headers) {
      if (status >= 200 && status < 300) {
        lastOk = now();
        okCount++;
        return;
      }
      const reset = claudeLimitReset(status, headers, now());
      if (reset !== null) {
        resetAt = reset;
        limitSeenAt = now();
      }
    },
    get fired() {
      return fired;
    },
    get resetAt() {
      return resetAt;
    },
    get succeeded() {
      return okCount;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Sleeps until resetAt + margin in short chunks (robust to host suspend); returns false if cancelled. */
export async function waitForClaudeReset(
  resetAt,
  {
    signalSource = process,
    sleep = delay,
    now = Date.now,
    notify = console.error,
    marginMs = CLAUDE_WAIT_MARGIN_MS,
    chunkMs = 60_000,
  } = {},
) {
  const controller = new AbortController();
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => {
    const handler = () => controller.abort(name);
    signalSource.on(name, handler);
    return [name, handler];
  });
  const target = resetAt + marginMs;
  try {
    notify(
      `pis: Claude usage limit reached. Waiting until ${new Date(target).toISOString()} (reset + ${Math.round(marginMs / 60000)} min), then the session continues. Ctrl-C cancels.`,
    );
    let nextReport = now() + 3600_000;
    while (now() < target) {
      await sleep(Math.min(chunkMs, target - now()), undefined, { signal: controller.signal });
      if (now() >= nextReport && now() < target) {
        notify(`pis: still waiting for the Claude limit; ${Math.ceil((target - now()) / 60000)} min left.`);
        nextReport += 3600_000;
      }
    }
    return { ok: true };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    notify('pis: Claude wait cancelled.');
    return { ok: false, exitCode: 128 + (os.constants.signals[controller.signal.reason] || 2) };
  } finally {
    handlers.forEach(([name, handler]) => signalSource.off(name, handler));
  }
}
