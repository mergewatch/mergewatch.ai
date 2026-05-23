/**
 * FP-J L1 — derive a `categoryDisputeRates` map for `reconcileMergeScore`.
 *
 * Reads the latest 30d `InstallationFPInsight` rollup (produced nightly by
 * FB-E) and projects its `perCategory` bucket into the
 * `Record<string, number>` shape that the verdict-tier softening accepts.
 * Filters out below-threshold categories so the verdict only down-weights
 * on statistically meaningful evidence.
 *
 * Best-effort by design: any read failure (no rollup yet, store unwired,
 * upstream-degraded) returns an empty map, which is identical to "no
 * down-weighting" in the reconcile path. The review pipeline never blocks
 * on insights I/O.
 */

import type { IFPInsightStore } from '../storage/types.js';

/**
 * Minimum surfacing count for a category's rate to be included. Matches the
 * `DISPUTE_RATE_MIN_SURFACED` constant in `reviewer.ts` so the loader and
 * the verdict-tier consumer can't drift on the trust floor. A category with
 * 1 surfacing + 1 dispute reads as 100% disputed but is statistically
 * unreliable; the floor keeps single-event noise out of the verdict.
 */
const MIN_SURFACED = 5;

/**
 * Window the loader reads from. 30d is the same window FB-G's dispute-by-
 * agent chart uses on the dashboard — keeps the verdict tier and the
 * dashboard visualisation in agreement about what "recent dispute history"
 * means.
 */
const WINDOW: '7d' | '30d' | '90d' = '30d';

/**
 * Load per-category dispute rates for an installation.
 *
 * Returns `{}` (which behaves identically to "no down-weighting" in
 * `reconcileMergeScore`) when:
 *   - no store is provided (older deployment shape)
 *   - the installation has no rollup yet (fresh install)
 *   - the read itself failed (logged, swallowed)
 *
 * The map only includes categories clearing `MIN_SURFACED`, so callers can
 * pass the result straight to `reconcileMergeScore` without further filtering.
 */
export async function loadCategoryDisputeRates(
  store: IFPInsightStore | undefined,
  installationId: string | number | undefined,
): Promise<Record<string, number>> {
  if (!store || installationId == null) return {};

  let insight;
  try {
    insight = await store.get(String(installationId), WINDOW);
  } catch (err) {
    console.warn(
      '[fp-j-l1] loadCategoryDisputeRates: insight read failed for %s; defaulting to no down-weighting',
      installationId,
      err,
    );
    return {};
  }

  if (!insight || !insight.perCategory) return {};

  const rates: Record<string, number> = {};
  for (const [category, bucket] of Object.entries(insight.perCategory)) {
    if (bucket.surfaced >= MIN_SURFACED) {
      rates[category] = bucket.rate;
    }
  }
  return rates;
}
