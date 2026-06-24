/**
 * Compact formatters shared across the dashboard insight sections (Impact +
 * Accuracy). Kept dependency-free so they can be imported from any client
 * component without pulling in chart libs.
 */

/**
 * Format a duration given in hours as a compact human string:
 *   < 1h → minutes, < 48h → hours, else → days. `null`/`undefined` → em-dash.
 */
export function fmtHours(h: number | null | undefined): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Format a 0..1 rate as a whole-number percentage; null/undefined → em-dash. */
export function fmtPct(r: number | null | undefined): string {
  if (r == null) return "—";
  return `${Math.round(r * 100)}%`;
}

/**
 * #193 — format a USD amount. Sub-dollar values (a per-finding cost is often a
 * few cents) keep more precision; dollar+ values round to cents. `null` → `—`.
 */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 1) return `$${n.toFixed(n < 0.01 ? 4 : 3)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
