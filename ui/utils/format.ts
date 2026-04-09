/** Shared formatting utilities for the ClaudeCockpit UI. */

/** Format a token count as a compact string (e.g. 1.2K, 3.5M) */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/**
 * Relative time from an ISO timestamp.
 * Compact mode (default): "now", "5m", "3h", "2d" — for sidebar labels.
 * Verbose mode: "just now", "5m ago", "3h ago", "2d ago" — for overview cards.
 */
export function formatRelativeTime(iso: string, verbose = false): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const suffix = verbose ? " ago" : "";
  if (mins < 1) return verbose ? "just now" : "now";
  if (mins < 60) return `${mins}m${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days}d${suffix}`;
}

/** Shorten an absolute path by replacing the home directory with `~` */
export function shortenHomePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Home directory prefix for expanding ~/... paths. Set via setHomeDirFromPath(). */
let _homeDirPrefix = "";

/** Extract and cache the home directory from an absolute macOS path. */
export function setHomeDirFromPath(absPath: string): void {
  const m = absPath.match(/^\/Users\/[^/]+/);
  if (m) _homeDirPrefix = m[0];
}

/** Expand ~/... to an absolute path using the cached home directory. */
export function expandHomePath(tilePath: string): string {
  if (!tilePath.startsWith("~/") || !_homeDirPrefix) return tilePath;
  return _homeDirPrefix + tilePath.slice(1);
}

/** Format gateway uptime from an ISO start time (e.g. "45s", "3m 20s", "2h 15m", "1d 4h") */
export function formatUptime(startIso: string): string {
  const ms = Date.now() - new Date(startIso).getTime();
  if (ms <= 0) return "0s";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Format a USD cost (e.g. "<$0.01", "$1.23", "$0.50") */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Format a duration between two ISO timestamps (e.g. "3m 20s", "1h 5m") */
export function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 0) return "—";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
