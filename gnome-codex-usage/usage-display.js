// Explicit unavailable slots prevent a missing upstream window from silently
// collapsing the panel to one unexplained percentage after an account switch.
import { usageWindows } from './usage-format.js';

export function usageDisplay(data, fetchedAt, now = Date.now()) {
  const windows = usageWindows(data, fetchedAt, now);
  const slots = ['primary_window', 'secondary_window'].map((key, index) => {
    const window = windows.find((value) => value.key === key);
    const name = index === 0 ? 'Primary' : 'Secondary';
    if (!window)
      return {
        panel: `${name} —`,
        menu: `${name}: not reported for the selected account (not 0% or 100%)`,
      };
    const short =
      window.label === 'Weekly window'
        ? 'Week'
        : window.label === 'Short window'
          ? 'Short'
          : 'Long';
    return {
      panel: `${short} ${Math.round(window.remaining)}% (${window.resetIn})`,
      menu: `${name} · ${window.label}: ${window.remaining.toFixed(1)}% left · resets in ${window.resetIn}`,
    };
  });
  return {
    panel: `Codex ${slots.map((slot) => slot.panel).join(' / ')}`,
    menu: `${slots.map((slot) => slot.menu).join('\n')}\nSelected host account only · refreshed every 5 minutes; use Refresh after switching.`,
  };
}
