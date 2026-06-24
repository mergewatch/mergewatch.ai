/**
 * #195 Phase 4 — write fan-out for the summary-comment "Was this review
 * helpful? 👍 / 👎" prompt.
 *
 * GitHub emits no webhook for reactions added to an issue comment, so — exactly
 * like the inline-reaction poll (`pollAndRecordInlineReactions`) — we fold a
 * snapshot-delta into the existing post-review path: the review handler already
 * fetches the summary comment's reaction counts, so we diff them against the
 * snapshot persisted on the prior review and turn only the *new* 👍/👎 into
 * `ISatisfactionStore.recordHelpfulVotes` increments.
 *
 * Best-effort by design: catches and logs; a satisfaction write must never
 * block a review. Counters are monotonic — reaction removals never decrement,
 * and the snapshot prevents double-counting on subsequent polls.
 */

import type { ISatisfactionStore } from '../storage/types.js';

/**
 * GitHub reaction content types mapped onto the helpful prompt. Mirrors the
 * inline-reaction mapping (FB-C) so 👍 / ❤️ / 🚀 read as positive and 👎 / 🤔
 * as negative; the ambiguous 👀 / 😄 / 🎉 are ignored.
 */
export const HELPFUL_UP_TYPES = ['+1', 'heart', 'rocket'] as const;
export const HELPFUL_DOWN_TYPES = ['-1', 'confused'] as const;

/** Collapse a raw per-type reaction-count map into up / down vote totals. */
export function summaryReactionsToVotes(
  counts: Record<string, number> | undefined,
): { up: number; down: number } {
  if (!counts) return { up: 0, down: 0 };
  let up = 0;
  let down = 0;
  for (const t of HELPFUL_UP_TYPES) up += Number(counts[t] ?? 0);
  for (const t of HELPFUL_DOWN_TYPES) down += Number(counts[t] ?? 0);
  return { up, down };
}

/**
 * Phase 4 — record the helpful-vote delta on the summary comment.
 *
 * @param reactionCounts  the summary comment's CURRENT per-type reaction counts
 *                        (already fetched by the caller via `getCommentReactions`)
 * @param prevSnapshot    the per-type counts persisted on the prior review's
 *                        `summaryReactionsSnapshot`, or undefined on first sight
 * @returns the new snapshot to persist (the tracked subset of `reactionCounts`)
 */
export async function recordSummaryHelpfulVotes(
  store: ISatisfactionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  prNumber: number,
  reactionCounts: Record<string, number> | undefined,
  prevSnapshot: Record<string, number> | undefined,
  nowIso: string,
): Promise<Record<string, number>> {
  // Always recompute the snapshot from the current counts so the next poll has
  // an accurate baseline — even when no store is wired or the delta is zero.
  const newSnapshot: Record<string, number> = {};
  const tracked = [...HELPFUL_UP_TYPES, ...HELPFUL_DOWN_TYPES];
  for (const t of tracked) {
    const n = Number(reactionCounts?.[t] ?? 0);
    if (n > 0) newSnapshot[t] = n;
  }

  if (!store || installationId == null) return newSnapshot;

  const current = summaryReactionsToVotes(reactionCounts);
  const prior = summaryReactionsToVotes(prevSnapshot);
  // Monotonic: only positive deltas become increments (a removed reaction must
  // not decrement the cumulative vote counters).
  const up = Math.max(0, current.up - prior.up);
  const down = Math.max(0, current.down - prior.down);
  if (up === 0 && down === 0) return newSnapshot;

  try {
    await store.recordHelpfulVotes(String(installationId), repoFullName, prNumber, { up, down }, nowIso);
  } catch (err) {
    console.warn('[fb-k] recordSummaryHelpfulVotes: write failed for %s#%d', repoFullName, prNumber, err);
  }

  return newSnapshot;
}
