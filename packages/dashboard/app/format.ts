// Tiny formatting helpers used across the dashboard panels.
// Centralized so durations / counts read the same everywhere.

/**
 * Render a duration as a short human string: `42s`, `3m 12s`,
 * `1h 4m`. Truncates on the right for readability — e.g. an hour
 * gets `1h 4m`, not `1h 4m 12s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${String(totalSec)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60)
    return sec === 0 ? `${String(totalMin)}m` : `${String(totalMin)}m ${String(sec)}s`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(min)}m`;
}

/** Format a token count with thousand-separators: `1,500`. */
export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Format a USD amount: `$0.0123`. Returns `-` for null. */
export function formatUsd(n: number | null): string {
  if (n === null) return '-';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * `2026-04-29T10:00:00Z` → `2026-04-29 10:00:00`. We deliberately
 * skip locale formatting — the dashboard is a tool, not a consumer
 * app, and ambiguous "Apr 29" / "04/29" formatting is worse than
 * a clear ISO-ish wall-clock.
 */
export function formatTimestamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
