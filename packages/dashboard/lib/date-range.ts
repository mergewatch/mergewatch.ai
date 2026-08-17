/**
 * #337 — date-parameter normalization for the analytics query surface.
 *
 * The stores filter `createdAt` by STRING comparison against full ISO
 * timestamps. A date-only bound therefore misbehaves at one edge:
 * `'2026-08-16T09:31:00.000Z' <= '2026-08-16'` is false, so a date-only
 * `end_date` silently excluded the entire final day of the range. The fix is
 * to normalize at the API boundary — expand date-only values to the edge
 * instant of that UTC day — so both backends receive the same exact instants
 * and behave identically by construction.
 */

/**
 * Accepted forms: `YYYY-MM-DD`, or a full UTC timestamp
 * `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. Anything else is rejected (treated as
 * absent, matching the route's long-standing invalid-input behavior).
 */
const ISO_DATE_OR_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/;

/**
 * Validate a `start_date` / `end_date` query parameter and expand a
 * date-only value to the edge instant of that UTC day:
 *
 *   - `edge: 'start'` → `T00:00:00.000Z` (whole first day included)
 *   - `edge: 'end'`   → `T23:59:59.999Z` (whole final day included)
 *
 * Full timestamps pass through untouched — the dashboard UI already sends
 * exact instants derived from the viewer's local day boundaries, and those
 * must not be re-widened. Returns `undefined` for absent or invalid input.
 */
export function normalizeDateParam(
  raw: string | null,
  edge: 'start' | 'end',
): string | undefined {
  if (!raw || !ISO_DATE_OR_TIMESTAMP_REGEX.test(raw)) return undefined;
  if (raw.includes('T')) return raw;
  return edge === 'start' ? `${raw}T00:00:00.000Z` : `${raw}T23:59:59.999Z`;
}
