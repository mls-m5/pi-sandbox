import { assert } from './util.js';

export function codexAvailability(data, now = Date.now()) {
  const { rate_limit } = codexUsageSummary(data);
  const windows = [rate_limit.primary_window, rate_limit.secondary_window].filter(Boolean);
  assert(windows.length > 0, 'Codex usage returned no quota windows; cannot safely decide when to resume.');
  const exhausted = windows.filter(window => window.used_percent >= 100);
  const available = !exhausted.length && rate_limit.allowed !== false && rate_limit.limit_reached !== true;
  const resetTimes = exhausted.map(window => window.reset_at !== undefined ? window.reset_at * 1000 : now + window.reset_after_seconds * 1000);
  const untilReset = resetTimes.length ? Math.max(...resetTimes) - now + 5000 : 300_000;
  return { available, delayMs: Math.max(60_000, Math.min(300_000, untilReset)) };
}

// Shared host/proxy allowlist. Never expose identity, plan, credits or tokens.
export function codexUsageSummary(data) {
  assert(data?.rate_limit && typeof data.rate_limit === 'object' && !Array.isArray(data.rate_limit), 'Invalid Codex usage response.');
  const rate_limit = {};
  for (const key of ['allowed', 'limit_reached']) if (data.rate_limit[key] !== undefined) {
    assert(typeof data.rate_limit[key] === 'boolean', 'Invalid Codex usage status.');
    rate_limit[key] = data.rate_limit[key];
  }
  for (const name of ['primary_window', 'secondary_window']) {
    const value = data.rate_limit[name];
    if (value === undefined || value === null) { rate_limit[name] = null; continue; }
    assert(Number.isFinite(value.used_percent) && value.used_percent >= 0 && value.used_percent <= 100, 'Invalid Codex usage window.');
    const window = { used_percent: value.used_percent };
    for (const key of ['limit_window_seconds', 'reset_at', 'reset_after_seconds']) if (value[key] !== undefined) {
      assert(Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1e12, 'Invalid Codex usage window.');
      window[key] = value[key];
    }
    assert(window.reset_at !== undefined || window.reset_after_seconds !== undefined, 'Missing Codex usage reset.');
    rate_limit[name] = window;
  }
  return { rate_limit };
}
