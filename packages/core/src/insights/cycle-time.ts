/**
 * TTM (#194) — aggregate `PRLifecycleRecord` rows into the cycle-time block
 * of an `InstallationFPInsight` for one rolling window.
 *
 * Pure function: takes already-fetched lifecycle records + a window length,
 * returns the typed block. Doesn't touch storage; window bounds come in as
 * an ISO string. Mirrors `buildInsightFromDispositions` (FB-E) so the rollup
 * orchestrator can compute both from the same windowEnd.
 *
 * Merge times are heavily right-skewed, so we report percentiles
 * (median / p75 / p90), never a mean. All durations are in HOURS.
 */

import type { PRLifecycleRecord, InstallationFPInsight, CycleTimePercentiles } from '../types/db.js';
import { WINDOW_LENGTH_MS } from './rollup.js';

const MS_PER_HOUR = 60 * 60 * 1000;

export type CycleTimeInsight = NonNullable<InstallationFPInsight['cycleTime']>;

/**
 * Linear-interpolation percentile (the "R-7" / Excel `PERCENTILE.INC`
 * method) over an ascending-sorted, non-empty array. `p` is a fraction in
 * [0, 1]. Returns the single value for a 1-element array.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** p50 / p75 / p90 of a sample, or null when the sample is empty. */
export function percentilesOf(values: readonly number[]): CycleTimePercentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

/** Hours between two ISO timestamps, or null if either is missing/unparseable
 *  or the span is negative (clock skew / bad data — never feed it to stats). */
function hoursBetween(startIso: string | undefined, endIso: string | undefined): number | null {
  if (!startIso || !endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const hours = (b - a) / MS_PER_HOUR;
  return hours >= 0 ? hours : null;
}

/**
 * Build the cycle-time block for one window.
 *
 *   - merged PRs (mergedAt in window) drive every time stat;
 *   - closed-without-merge and still-open PRs are counted but excluded
 *     from the duration percentiles (no merge time);
 *   - a row whose `prCreatedAt` is the '' sentinel (created via a non-`opened`
 *     entry point) still counts toward `mergedCount` but is excluded from the
 *     created→merged percentiles, since its anchor is unknown.
 */
export function buildCycleTimeInsight(
  window: InstallationFPInsight['window'],
  windowEndIso: string,
  records: readonly PRLifecycleRecord[],
): CycleTimeInsight {
  const windowEndMs = new Date(windowEndIso).getTime();
  const windowStartMs = windowEndMs - WINDOW_LENGTH_MS[window];
  const inWindow = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= windowStartMs && t <= windowEndMs;
  };

  let mergedCount = 0;
  let reviewedMergedCount = 0;
  let unreviewedMergedCount = 0;
  let closedUnmergedCount = 0;
  let openCount = 0;

  const ttmAll: number[] = [];
  const ttmReviewed: number[] = [];
  const ttmUnreviewed: number[] = [];
  const ttmFromFirstReview: number[] = [];
  const roundTrips: number[] = [];

  for (const r of records) {
    if (r.state === 'merged' && inWindow(r.mergedAt)) {
      mergedCount++;
      const ttm = hoursBetween(r.prCreatedAt, r.mergedAt);
      if (ttm !== null) ttmAll.push(ttm);
      if (r.reviewed) {
        reviewedMergedCount++;
        if (ttm !== null) ttmReviewed.push(ttm);
        const fromReview = hoursBetween(r.firstReviewAt, r.mergedAt);
        if (fromReview !== null) ttmFromFirstReview.push(fromReview);
        roundTrips.push(r.pushesAfterFirstReview);
      } else {
        unreviewedMergedCount++;
        if (ttm !== null) ttmUnreviewed.push(ttm);
      }
    } else if (r.state === 'closed_unmerged' && inWindow(r.closedAt)) {
      closedUnmergedCount++;
    } else if (r.state === 'open' && inWindow(r.prCreatedAt)) {
      openCount++;
    }
  }

  return {
    mergedCount,
    reviewedMergedCount,
    unreviewedMergedCount,
    closedUnmergedCount,
    openCount,
    timeToMergeHours: percentilesOf(ttmAll),
    timeToMergeHoursReviewed: percentilesOf(ttmReviewed),
    timeToMergeHoursUnreviewed: percentilesOf(ttmUnreviewed),
    timeToMergeFromFirstReviewHours: percentilesOf(ttmFromFirstReview),
    roundTripsBeforeMerge: percentilesOf(roundTrips),
  };
}
