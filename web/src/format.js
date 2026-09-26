// Pure display helpers. Figures render in Geist Mono with tabular numbers.
const usdFormats = new Map();
export function usd(value) {
  const size = Math.abs(value), digits = size > 0 && size < 0.1 ? 4 : 2;
  if (!usdFormats.has(digits)) usdFormats.set(digits, new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
  }));
  return usdFormats.get(digits).format(value);
}

export const count = value => new Intl.NumberFormat('en-US').format(value);

export const plural = (value, one, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;

// "2026-09" -> "September 2026"
export function monthName(month) {
  const [year, index] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, index - 1, 1));
}

// Monthly counts reset at 00:00 UTC, so show the UTC calendar date.
export function utcDate(iso) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
}

export function dateTime(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(iso));
}

// Share of a limit for a progress bar, clamped to 0-100. A zero limit reads as full.
export function share(used, limit) {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export const runStates = {
  queued: { label: 'Queued', mark: 'waiting' },
  running: { label: 'Running', mark: 'running' },
  publishing: { label: 'Publishing', mark: 'running' },
  completed: { label: 'Completed', mark: 'complete' },
  failed: { label: 'Failed', mark: 'failed' },
  cancelled: { label: 'Cancelled', mark: 'cancelled' },
  skipped: { label: 'Skipped', mark: 'stopped' },
  uncertain: { label: 'Not confirmed', mark: 'blocked' },
};

// Unknown cost is never shown as zero.
export function runCost(run) {
  if (run.usage && run.usage.totalUsd !== null) return usd(run.usage.totalUsd);
  return run.started ? 'Unsettled' : 'None';
}
