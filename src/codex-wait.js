import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assert } from './util.js';
import { getCodexUsage } from './codex-auth.js';
import { codexUsageSummary } from './codex-usage.js';

export const CODEX_RESUME_NOTICE = '[pis] Codex usage now reports available quota. Continue the previous task from this saved session. Review the current state before repeating any tool action; do not restart completed work.';
const MIN_POLL = 60_000;
const MAX_POLL = 300_000;

export function validateCodexWait(config, options) {
  assert((config.agent || 'pi') === 'pi' && config.credentials.proxy?.provider === 'openai-codex', '--wait-codex requires the Pi agent with the openai-codex host proxy.');
  assert(options.mode === 'pi' && !options.fresh && !options.buildOnly && !options.stdio && !(options.args || []).length, '--wait-codex only resumes the latest saved Pi session; no --fresh, shell/exec, custom stdio or trailing agent arguments.');
}

export function requireSavedPiSession(store, id) {
  let dir = path.join(store.projectDir(id), 'state');
  try {
    for (const part of ['', '.pi', 'agent', 'sessions']) {
      if (part) dir = path.join(dir, part);
      const stat = fs.lstatSync(dir);
      assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Invalid session directory.');
    }
    const hasSession = folder => fs.readdirSync(folder, { withFileTypes: true }).some(entry => {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return false;
      const stat = fs.lstatSync(path.join(folder, entry.name));
      return stat.isFile() && stat.size > 0;
    });
    // Support the shared session directory and Pi's encoded-cwd subdirectories.
    const found = hasSession(dir) || fs.readdirSync(dir, { withFileTypes: true }).some(entry => {
      const child = path.join(dir, entry.name);
      return entry.isDirectory() && fs.lstatSync(child).isDirectory() && hasSession(child);
    });
    assert(found, 'No sessions.');
  } catch { throw new Error('--wait-codex needs an existing saved Pi session. Start a normal pis session first. Symlinked session directories are not supported.'); }
}

export function codexAvailability(data, now = Date.now()) {
  const { rate_limit } = codexUsageSummary(data);
  const windows = [rate_limit.primary_window, rate_limit.secondary_window].filter(Boolean);
  assert(windows.length > 0, 'Codex usage returned no quota windows; cannot safely decide when to resume.');
  const exhausted = windows.filter(window => window.used_percent >= 100);
  const available = !exhausted.length && rate_limit.allowed !== false && rate_limit.limit_reached !== true;
  const resetTimes = exhausted.map(window => window.reset_at !== undefined ? window.reset_at * 1000 : now + window.reset_after_seconds * 1000);
  const untilReset = resetTimes.length ? Math.max(...resetTimes) - now + 5000 : MAX_POLL;
  return { available, delayMs: Math.max(MIN_POLL, Math.min(MAX_POLL, untilReset)) };
}

export async function waitForCodex(store, { signal, usage = getCodexUsage, sleep = delay, now = Date.now, notify = console.error } = {}) {
  notify('pis: Checking Codex quota on the host (no model request). Ctrl-C cancels.');
  while (true) {
    signal?.throwIfAborted();
    let data;
    try { data = await usage(store, { signal }); }
    catch {
      signal?.throwIfAborted();
      throw new Error('Cannot check Codex usage; no agent was started. Check pis --codex-usage and the host sign-in before retrying.');
    }
    signal?.throwIfAborted();
    const time = now();
    const state = codexAvailability(data, time);
    if (state.available) {
      notify('pis: Codex usage reports available quota. Resuming the latest saved Pi session with a continuation prompt (uses model quota).');
      return;
    }
    notify(`pis: Codex quota is still unavailable. Next check: ${new Date(time + state.delayMs).toISOString()} (Ctrl-C cancels).`);
    // A passed reset time never authorizes a start: always fetch usage again.
    await sleep(state.delayMs, undefined, { signal });
  }
}

export async function waitForCodexOnHost(store, { signalSource = process, ...options } = {}) {
  const controller = new AbortController();
  let exitCode = 130;
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => { exitCode = 128 + os.constants.signals[signal]; controller.abort(); };
    signalSource.on(signal, handler);
    return [signal, handler];
  });
  try {
    await waitForCodex(store, { ...options, signal: controller.signal });
    return 0;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    (options.notify || console.error)('pis: Codex wait cancelled; no agent was started.');
    return exitCode;
  } finally { handlers.forEach(([signal, handler]) => signalSource.off(signal, handler)); }
}
