// Explicit unavailable slots prevent a missing upstream window from silently
// collapsing the panel to one unexplained percentage after an account switch.
import { usageWindows } from './usage-format.js';

// Lowest known remaining percentage, used by the panel to colour the warning level.
function lowest(slots) {
  const values = slots.map((slot) => slot.remaining).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

export function usageDisplay(data, fetchedAt, now = Date.now()) {
  const windows = usageWindows(data, fetchedAt, now);
  const slots = ['primary_window', 'secondary_window'].map((key, index) => {
    const window = windows.find((value) => value.key === key);
    const name = index === 0 ? 'Primary' : 'Secondary';
    if (!window)
      return {
        panel: '—',
        menu: `${name}: not reported for the selected account (not 0% or 100%)`,
      };
    return {
      remaining: window.remaining,
      panel: `${Math.round(window.remaining)}% ${window.resetCompact}`,
      menu: `${name} · ${window.label}: ${window.remaining.toFixed(1)}% left · resets in ${window.resetIn}`,
    };
  });
  return {
    panel: `⬡ ${slots.map((slot) => slot.panel).join(' · ')}`,
    level: lowest(slots),
    menu: `${slots.map((slot) => slot.menu).join('\n')}\nSelected host account only · refreshed every 5 minutes; use Refresh after switching.`,
  };
}

function age(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return minutes < 2880 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

// Claude values are cached from proxy responses, so each window carries the time it
// was last observed. Missing/expired windows are unknown, never invented as 0%/100%.
export function claudeDisplay(data, fetchedAt, now = Date.now()) {
  const windows = usageWindows(data, fetchedAt, now);
  const slots = ['primary_window', 'secondary_window'].map((key, index) => {
    const name = index === 0 ? '5h' : 'Week';
    const window = windows.find((value) => value.key === key);
    if (!window)
      return {
        panel: '—',
        menu: `${name}: no current value (appears after Claude Code is used)`,
      };
    const updated = data.rate_limit[key].updated_at;
    // '~' marks a value last seen over an hour ago (cache, not a live reading).
    const stale = Math.floor(now / 1000) - updated > 3600 ? '~' : '';
    return {
      remaining: window.remaining,
      panel: `${stale}${Math.round(window.remaining)}% ${window.resetCompact}`,
      menu: `${name}: ${window.remaining.toFixed(1)}% left · resets in ${window.resetIn} · seen ${age(Math.floor(now / 1000) - updated)}`,
    };
  });
  return {
    panel: `✻ ${slots.map((slot) => slot.panel).join(' · ')}`,
    level: lowest(slots),
    menu: `${slots.map((slot) => slot.menu).join('\n')}\nCached from Claude Code responses; updates only while Claude Code is used.`,
  };
}
