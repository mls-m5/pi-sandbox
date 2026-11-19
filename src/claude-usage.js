// Cached Claude subscription usage. It is observed only from rate-limit headers
// on responses the host proxy already forwards: no extra upstream request, no
// quota spent, and only numbers/timestamps are stored (never headers/bodies).
// The header names are Anthropic's undocumented unified rate-limit headers and
// are unverified against a real account; unknown/invalid values are ignored.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './util.js';

const WINDOWS = [
  { key: 'five_hour', header: '5h', seconds: 5 * 3600 },
  { key: 'seven_day', header: '7d', seconds: 7 * 86400 },
];
const MAX_FILE_BYTES = 16 * 1024;

export function claudeUsagePath(store) {
  return path.join(store.root, 'claude-usage.json');
}

function header(headers, name) {
  const value = headers?.[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

/** Extracts {five_hour,seven_day} windows ({used_percent,reset_at}) from response headers. */
export function parseClaudeUsageHeaders(headers, now = Date.now()) {
  const result = {};
  for (const { key, header: part } of WINDOWS) {
    const utilization = Number(header(headers, `anthropic-ratelimit-unified-${part}-utilization`));
    const reset = Number(header(headers, `anthropic-ratelimit-unified-${part}-reset`));
    if (
      !(header(headers, `anthropic-ratelimit-unified-${part}-utilization`)?.trim() &&
        header(headers, `anthropic-ratelimit-unified-${part}-reset`)?.trim()) ||
      !Number.isFinite(utilization) ||
      utilization < 0 ||
      utilization > 1 ||
      !Number.isFinite(reset) ||
      reset <= 0 ||
      reset * 1000 > now + 8 * 86400_000
    )
      continue;
    result[key] = {
      used_percent: Math.round(utilization * 1000) / 10,
      reset_at: Math.floor(reset),
      updated_at: Math.floor(now / 1000),
    };
  }
  return result;
}

function validWindow(window) {
  return (
    window &&
    Number.isFinite(window.used_percent) &&
    window.used_percent >= 0 &&
    window.used_percent <= 100 &&
    Number.isFinite(window.reset_at) &&
    window.reset_at > 0 &&
    Number.isFinite(window.updated_at) &&
    window.updated_at > 0
  );
}

function readFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.uid !== process.getuid()) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(
      WINDOWS.flatMap(({ key }) => (validWindow(data?.windows?.[key]) ? [[key, data.windows[key]]] : [])),
    );
  } catch {
    return {};
  }
}

/** Merges newer observed windows into the private cache; unchanged data is not rewritten. */
export function recordClaudeUsage(store, headers, now = Date.now()) {
  const seen = parseClaudeUsageHeaders(headers, now);
  if (!Object.keys(seen).length) return false;
  const file = claudeUsagePath(store);
  const known = readFile(file);
  let changed = false;
  for (const [key, window] of Object.entries(seen)) {
    const old = known[key];
    if (old && old.used_percent === window.used_percent && old.reset_at === window.reset_at) continue;
    if (old && old.updated_at > window.updated_at) continue;
    known[key] = window;
    changed = true;
  }
  if (!changed) return false;
  fs.mkdirSync(store.root, { recursive: true, mode: 0o700 });
  atomicWrite(file, `${JSON.stringify({ version: 1, windows: known })}\n`);
  return true;
}

/**
 * Sanitized cached view for the GNOME widget, shaped like the Codex usage so the
 * same formatting works. Windows whose reset time has passed are unknown, not 0%.
 */
export function readClaudeUsage(store, now = Date.now()) {
  const known = readFile(claudeUsagePath(store));
  const rate_limit = {};
  for (const [slot, { key, seconds }] of [
    ['primary_window', WINDOWS[0]],
    ['secondary_window', WINDOWS[1]],
  ]) {
    const window = known[key];
    if (!window || window.reset_at * 1000 <= now) continue;
    rate_limit[slot] = {
      used_percent: window.used_percent,
      reset_at: window.reset_at,
      limit_window_seconds: seconds,
      updated_at: window.updated_at,
    };
  }
  return { rate_limit };
}
