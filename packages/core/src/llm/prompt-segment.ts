/**
 * #489 (Phase 1a of #488) — a prompt as ordered segments rather than a string.
 *
 * `buildPrompt` returned a flat `string`, and a flat string cannot express
 * which of its parts are stable. Three separate problems need exactly that
 * distinction:
 *
 *   - prompt caching needs it to place a `cache_control` breakpoint at each
 *     stability boundary;
 *   - cassette keys need it to stay valid across unrelated edits, excluding
 *     volatile parts by declaration rather than by hoping;
 *   - blast-radius detection needs it to scope re-recording.
 *
 * One ordering discipline, three payoffs. That is the argument for doing it as
 * one change rather than three.
 */

/**
 * How often a segment's text changes. Ordered least- to most-volatile; the
 * lint below depends on this order.
 */
export type PromptStability =
  /** Frozen in source: directives, agent templates. */
  | 'static'
  /** Conventions, tone, custom rules — changes when a repo changes. */
  | 'per-repo'
  /** PR context, diff — changes per pull request. */
  | 'per-pr'
  /** Fetched files, the finding under verification, previous findings. */
  | 'per-call';

export interface PromptSegment {
  /** Stable identifier, used for cassette keys and cache-boundary reporting. */
  id: string;
  text: string;
  stability: PromptStability;
}

/** Volatility rank. Higher = changes more often. */
const RANK: Record<PromptStability, number> = {
  static: 0,
  'per-repo': 1,
  'per-pr': 2,
  'per-call': 3,
};

/** The most volatile of the given stabilities — a merged segment's honest label. */
export function mostVolatile(...s: PromptStability[]): PromptStability {
  return s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'static' as PromptStability);
}

/**
 * Segments must be non-decreasing in volatility.
 *
 * A cache breakpoint can only be placed where everything before it is at least
 * as stable as the breakpoint itself. One `static` segment sitting after a
 * `per-pr` one makes the whole prefix unstable, so the cache never hits and
 * nothing says why. Catching that here turns a silent cost regression into a
 * build failure.
 *
 * Returns the offending index pair, or null when the order is sound.
 */
export function findVolatilityInversion(
  segments: readonly PromptSegment[],
): { at: number; previous: PromptSegment; offending: PromptSegment } | null {
  for (let i = 1; i < segments.length; i++) {
    if (RANK[segments[i].stability] < RANK[segments[i - 1].stability]) {
      return { at: i, previous: segments[i - 1], offending: segments[i] };
    }
  }
  return null;
}

/**
 * Throwing form, for use at the point a prompt is assembled.
 *
 * Deliberately throws rather than warns: a warning here would be read by
 * nobody and the cost would show up as an unexplained bill.
 */
export function assertNonDecreasingVolatility(
  segments: readonly PromptSegment[],
  label: string,
): void {
  const bad = findVolatilityInversion(segments);
  if (!bad) return;
  throw new Error(
    `[prompt] ${label}: segment '${bad.offending.id}' (${bad.offending.stability}) follows `
      + `'${bad.previous.id}' (${bad.previous.stability}) — segments must be `
      + `non-decreasing in volatility, or no cache prefix is stable (#489)`,
  );
}

/**
 * A prompt, either already-assembled or segmented.
 *
 * The union exists so this phase does not have to convert all 26 call sites at
 * once. A provider renders whichever it is given; a caller that has not been
 * migrated keeps passing a string and behaves exactly as before.
 */
export type PromptInput = string | readonly PromptSegment[];

/**
 * Render segments to the wire format.
 *
 * Segments are joined with NO separator: each segment carries whatever
 * whitespace preceded it in the original flat string, so rendering is
 * byte-identical to the concatenation it replaced. Adding a separator here
 * would silently reflow every prompt.
 */
export function renderPrompt(prompt: PromptInput): string {
  return typeof prompt === 'string' ? prompt : prompt.map((s) => s.text).join('');
}
