import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResetTime, resetTimestamp, usageWindows } from '../gnome-codex-usage/usage-format.js';
import { usageDisplay } from '../gnome-codex-usage/usage-display.js';

const now = 1700000000000;

test('GNOME display keeps two explicit slots across two-window, one-window and recovered account snapshots', () => {
  const short = { used_percent: 25, reset_after_seconds: 3600, limit_window_seconds: 18000 };
  const weekly = { used_percent: 10, reset_after_seconds: 172800, limit_window_seconds: 604800 };
  const both = usageDisplay({ rate_limit: { primary_window: short, secondary_window: weekly } }, now, now);
  assert.match(both.panel, /Short 75%.* \/ Week 90%/);
  const switched = usageDisplay({ rate_limit: { primary_window: null, secondary_window: weekly } }, now, now);
  assert.match(switched.panel, /Primary — \/ Week 90%/);
  assert.match(switched.menu, /not reported for the selected account/);
  assert.doesNotMatch(switched.panel, /75%/);
  assert.deepEqual(usageDisplay({ rate_limit: { primary_window: short, secondary_window: weekly } }, now, now), both);
  const reversed = usageDisplay({ rate_limit: { primary_window: weekly, secondary_window: null } }, now, now);
  assert.match(reversed.panel, /Week 90%.* \/ Secondary —/);
  assert.equal(usageWindows({ rate_limit: { primary_window: weekly } }, now, now)[0].label, 'Weekly window');
  const invalid = usageDisplay({ rate_limit: { primary_window: { used_percent: 101 }, secondary_window: weekly } }, now, now);
  assert.match(invalid.panel, /Primary —/);
});

test('reported window duration overrides primary/secondary label guesses, without guessing from reset countdown', () => {
  const data = { rate_limit: {
    primary_window: { used_percent: 0, reset_after_seconds: 5, limit_window_seconds: 604800 },
    secondary_window: { used_percent: 100, reset_after_seconds: 172800, limit_window_seconds: 18000 },
  } };
  const windows = usageWindows(data, now, now);
  assert.equal(windows[0].label, 'Weekly window');
  assert.equal(windows[0].resetIn, '0d 1h');
  assert.equal(windows[1].label, 'Short window');
  assert.equal(windows[1].resetIn, '48h 0m');
  assert.match(usageDisplay(data, now, now).panel, /Week 100%.*Short 0%/);
});

test('GNOME reset countdown uses hours/minutes for short and days/hours for weekly windows', () => {
  assert.equal(formatResetTime(now + (3 * 3600 + 25 * 60) * 1000, false, now), '3h 25m');
  assert.equal(formatResetTime(now + (3 * 24 + 6) * 3600000, true, now), '3d 6h');
  assert.equal(formatResetTime(now + 1000, false, now), '0h 1m');
  assert.equal(formatResetTime(now + 1000, true, now), '0d 1h');
  assert.equal(formatResetTime(now, false, now), 'now');
  assert.equal(formatResetTime(now - 1000, true, now), 'now');
  assert.equal(formatResetTime(null, false, now), 'unknown');
});

test('relative reset timestamps remain anchored to fetch time rather than restarting each tick', () => {
  const window = { used_percent: 25, reset_after_seconds: 7200 };
  assert.equal(resetTimestamp(window, now), now + 7200000);
  const data = { rate_limit: { primary_window: window } };
  assert.equal(usageWindows(data, now, now)[0].resetIn, '2h 0m');
  assert.equal(usageWindows(data, now, now + 60000)[0].resetIn, '1h 59m');
  assert.equal(usageWindows(data, now, now + 7200000)[0].resetIn, 'now');
  assert.equal(usageWindows(data, now, now + 7200000)[0].remaining, 75);
});

test('absolute reset time takes precedence and missing primary does not relabel weekly as short', () => {
  assert.equal(resetTimestamp({ reset_at: now / 1000 + 3600, reset_after_seconds: 9999 }, now), now + 3600000);
  const windows = usageWindows({ rate_limit: { secondary_window: { used_percent: 2, reset_after_seconds: 172800 } } }, now, now);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].label, 'Weekly window');
  assert.equal(windows[0].remaining, 98);
  assert.equal(windows[0].resetIn, '2d 0h');
  assert.deepEqual(usageWindows({ rate_limit: { primary_window: { used_percent: 101 } } }, now, now), []);
  assert.equal(resetTimestamp({}, now), null);
  assert.equal(resetTimestamp({ reset_after_seconds: 0 }, now), now);
});
