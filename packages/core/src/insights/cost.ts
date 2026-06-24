/**
 * #193 — aggregate `ReviewCostRecord` rows into the LLM-cost block of an
 * `InstallationFPInsight` for one rolling window.
 *
 * Pure function: takes already-fetched cost records + a window length, returns
 * the typed block. Doesn't touch storage; window bounds come in as an ISO
 * string. Mirrors `buildCycleTimeInsight` / `buildEngagementInsight` so the
 * rollup orchestrator computes every block from the same windowEnd.
 *
 * Windowing: each review is attributed to the window of its `completedAt`.
 *
 * Pricing discipline: cost is summed over PRICED reviews only (`costUsd != null`
 * — the model matched the pricing table). Unpriced reviews (unknown model) are
 * counted separately and excluded from the money totals so a mis-priced model
 * can't silently pull the average toward 0. Token sums include every review
 * (tokens are known regardless of pricing). Averages are `number | null`; null
 * means "empty denominator" so the dashboard can tell "no spend data" from a
 * real `$0`.
 */

import type { ReviewCostRecord, InstallationFPInsight } from '../types/db.js';
import { WINDOW_LENGTH_MS } from './rollup.js';

export type CostInsight = NonNullable<InstallationFPInsight['cost']>;

/** A money/count → average, or null when the denominator is 0. */
function avgOrNull(total: number, denominator: number): number | null {
  return denominator > 0 ? total / denominator : null;
}

/**
 * Build the cost block for one window.
 *
 * @param costRecords  every review-cost row for the installation (empty when no
 *                     review-cost store is wired)
 */
export function buildCostInsight(
  window: InstallationFPInsight['window'],
  windowEndIso: string,
  costRecords: readonly ReviewCostRecord[],
): CostInsight {
  const windowEndMs = new Date(windowEndIso).getTime();
  const windowStartMs = windowEndMs - WINDOW_LENGTH_MS[window];
  const inWindow = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= windowStartMs && t <= windowEndMs;
  };

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let reviewCount = 0;
  let pricedReviewCount = 0;
  let unpricedReviewCount = 0;
  let findingCount = 0;
  const perRepo: Record<string, { costUsd: number; reviewCount: number }> = {};

  for (const r of costRecords) {
    if (!inWindow(r.completedAt)) continue;
    reviewCount++;
    // Tokens are known regardless of whether the model was priced.
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;

    const repoBucket = (perRepo[r.repoFullName] ??= { costUsd: 0, reviewCount: 0 });
    repoBucket.reviewCount++;

    if (r.costUsd == null) {
      // Unknown-model review — counted, but excluded from money totals.
      unpricedReviewCount++;
      continue;
    }
    pricedReviewCount++;
    totalCostUsd += r.costUsd;
    findingCount += r.findingCount;
    repoBucket.costUsd += r.costUsd;
  }

  return {
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    reviewCount,
    pricedReviewCount,
    unpricedReviewCount,
    avgCostPerReview: avgOrNull(totalCostUsd, pricedReviewCount),
    findingCount,
    avgCostPerFinding: avgOrNull(totalCostUsd, findingCount),
    perRepo,
  };
}
