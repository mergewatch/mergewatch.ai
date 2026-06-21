/**
 * #195 — aggregate `FindingDispositionRecord` + `PRLifecycleRecord` rows into
 * the developer-engagement block of an `InstallationFPInsight` for one rolling
 * window.
 *
 * Pure function: takes already-fetched records + a window length, returns the
 * typed block. Doesn't touch storage; window bounds come in as an ISO string.
 * Mirrors `buildInsightFromDispositions` (FB-E) and `buildCycleTimeInsight`
 * (TTM) so the rollup orchestrator computes all three from the same windowEnd.
 *
 * Windowing matches the rest of the rollup:
 *   - disposition counters (agreement / dispute / silentDrop / resolve /
 *     surface) are summed over records whose `lastSeen` falls in the window —
 *     same convention `buildInsightFromDispositions` uses for the FP funnel;
 *   - `/mergewatch reject` commands carry their own `at` timestamp, so they're
 *     windowed precisely by that, independent of `lastSeen`;
 *   - PR-lifecycle engagement (reviewed / re-review) windows by `firstReviewAt`
 *     — the moment MergeWatch reviewed the PR.
 *
 * Rates are `number | null`; null means "empty denominator in this window" so
 * the dashboard can tell "no signal" from a real 0.
 */

import type { FindingDispositionRecord, PRLifecycleRecord, InstallationFPInsight } from '../types/db.js';
import { WINDOW_LENGTH_MS } from './rollup.js';

export type EngagementInsight = NonNullable<InstallationFPInsight['engagement']>;

/** A count / denominator → rate, or null when the denominator is 0. */
function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Build the engagement block for one window.
 *
 * @param dispositionRecords  every disposition row for the installation
 * @param prLifecycleRecords  every PR-lifecycle row for the installation
 *                            (empty when no PR-lifecycle store is wired)
 */
export function buildEngagementInsight(
  window: InstallationFPInsight['window'],
  windowEndIso: string,
  dispositionRecords: readonly FindingDispositionRecord[],
  prLifecycleRecords: readonly PRLifecycleRecord[],
): EngagementInsight {
  const windowEndMs = new Date(windowEndIso).getTime();
  const windowStartMs = windowEndMs - WINDOW_LENGTH_MS[window];
  const inWindow = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= windowStartMs && t <= windowEndMs;
  };

  // ── Disposition-derived signals ──────────────────────────────────────────
  let surfaced = 0;
  let agreements = 0;
  let disputes = 0;
  let silentDrops = 0;
  let resolves = 0;
  let rejectCommands = 0;

  for (const r of dispositionRecords) {
    // `/mergewatch reject` entries are timestamped — window each one by its own
    // `at`, so a long-lived record still attributes its rejects to the right
    // window regardless of where `lastSeen` landed.
    if (r.rejectReasons) {
      for (const rr of r.rejectReasons) {
        if (inWindow(rr.at)) rejectCommands++;
      }
    }
    // Cumulative counters have no per-event timestamp, so attribute the whole
    // record to the window of its most recent activity — the same convention
    // the FP-funnel rollup uses.
    if (!inWindow(r.lastSeen)) continue;
    surfaced += r.surfaceCount;
    agreements += r.agreementCount;
    disputes += r.disputeCount;
    silentDrops += r.silentDropCount;
    resolves += r.resolveCount;
  }

  const actedOn = agreements + disputes + silentDrops;
  // Proxy capped at 1: a finding can carry both a 👍 and a /resolve, which
  // would push the raw ratio past 100% — meaningless for a "rate".
  const actionRateRaw = rateOrNull(agreements + resolves, surfaced);
  const findingActionRateApprox = actionRateRaw === null ? null : Math.min(1, actionRateRaw);

  // ── PR-lifecycle-derived signals ─────────────────────────────────────────
  let reviewedPrCount = 0;
  let reReviewedPrCount = 0;
  for (const p of prLifecycleRecords) {
    if (!p.reviewed || !inWindow(p.firstReviewAt)) continue;
    reviewedPrCount++;
    if (p.pushesAfterFirstReview > 0) reReviewedPrCount++;
  }

  const totalResolves = resolves;
  const totalRejectCommands = rejectCommands;

  return {
    acceptanceRate: rateOrNull(agreements, actedOn),
    totalResolves,
    totalRejectCommands,
    commandUsageCount: totalResolves + totalRejectCommands,
    findingActionRateApprox,
    reReviewRate: rateOrNull(reReviewedPrCount, reviewedPrCount),
    reviewedPrCount,
    activeInstallation: reviewedPrCount > 0,
  };
}
