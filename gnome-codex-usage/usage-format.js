// Pure helpers shared by GNOME Shell and offline Node tests.
export function resetTimestamp(window, fetchedAt) {
  if (Number.isFinite(window?.reset_at) && window.reset_at > 0) return window.reset_at * 1000;
  if (Number.isFinite(window?.reset_after_seconds) && window.reset_after_seconds >= 0)
    return fetchedAt + window.reset_after_seconds * 1000;
  return null;
}

const pad = (value) => String(value).padStart(2, '0');

// compact: '3h25' / '3d06' for the panel; default keeps the readable '3h 25m' / '3d 6h'.
export function formatResetTime(resetAt, weekly, now = Date.now(), compact = false) {
  if (!Number.isFinite(resetAt)) return compact ? '—' : 'unknown';
  const remaining = Math.max(0, resetAt - now);
  if (remaining === 0) return 'now';
  // Round up to the displayed unit rather than claiming reset prematurely.
  if (weekly) {
    const hours = Math.ceil(remaining / 3600000);
    return compact ? `${Math.floor(hours / 24)}d${pad(hours % 24)}` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  const minutes = Math.ceil(remaining / 60000);
  return compact ? `${Math.floor(minutes / 60)}h${pad(minutes % 60)}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function usageWindows(data, fetchedAt, now = Date.now()) {
  return ['primary_window', 'secondary_window'].flatMap((key, index) => {
    const window = data?.rate_limit?.[key];
    if (
      !window ||
      !Number.isFinite(window.used_percent) ||
      window.used_percent < 0 ||
      window.used_percent > 100
    )
      return [];
    const resetAt = resetTimestamp(window, fetchedAt);
    // Account tiers may return different/missing windows. Prefer the
    // reported duration rather than assuming primary always means short.
    const hasDuration =
      Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0;
    const weekly = hasDuration ? window.limit_window_seconds >= 7 * 86400 : index === 1;
    const label =
      hasDuration && !weekly && window.limit_window_seconds > 86400
        ? 'Long window'
        : weekly
          ? 'Weekly window'
          : 'Short window';
    return [
      {
        key,
        label,
        remaining: 100 - window.used_percent,
        resetAt,
        resetIn: formatResetTime(resetAt, weekly, now),
        resetCompact: formatResetTime(resetAt, weekly, now, true),
      },
    ];
  });
}
