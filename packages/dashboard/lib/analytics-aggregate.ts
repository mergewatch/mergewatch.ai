/**
 * Pure aggregation for the analytics surface (#333).
 *
 * Lifted verbatim out of `app/api/analytics/route.ts`, where ~110 lines of
 * reduction sat inline in the request handler with no test coverage — which is
 * how a 500-row truncation, an off-by-one percentile (#336) and a date-boundary
 * bug (#337) all shipped unnoticed.
 *
 * Kept dependency-free (no React, no Next, no store) so it can be exercised
 * against a hand-built fixture, the way `cost-insight.ts` is and the way
 * `buildInsightFromDispositions` is in `@mergewatch/core`.
 *
 * **This module deliberately preserves the existing behavior, bugs included.**
 * The percentile index and the UTC day bucketing below are wrong, and are fixed
 * under their own issues — reproducing them exactly here is what makes the
 * extraction reviewable as a no-op.
 */

/**
 * The fields of a review this aggregation actually reads.
 *
 * A structural subset rather than an import of `ReviewItem`: it keeps the
 * module dependency-free, lets tests build fixtures without satisfying two
 * dozen irrelevant required fields, and gives `estimatedCostUsd` a real type
 * instead of the `(review as any)` cast the route was using.
 */
export interface AggregatableReview {
  repoFullName: string;
  status?: string;
  createdAt?: string;
  mergeScore?: number | null;
  findingCount?: number | null;
  durationMs?: number | null;
  estimatedCostUsd?: number | string | null;
  findings?: Array<{ severity?: string; category?: string }> | null;
}

export interface TrendPoint {
  date: string;
  count: number;
}

export interface ScoreTrendPoint extends TrendPoint {
  avgScore: number;
}

export interface FindingsPerReviewPoint extends TrendPoint {
  avgFindings: number;
}

export interface AnalyticsAggregate {
  totalReviews: number;
  totalFindings: number;
  avgMergeScore: number;
  scoreTrend: ScoreTrendPoint[];
  severityBreakdown: Record<string, number>;
  durationStats: { avgMs: number; p95Ms: number; count: number };
  repoBreakdown: Array<{ repo: string; count: number }>;
  categoryBreakdown: Record<string, number>;
  statusCounts: Record<string, number>;
  findingsPerReviewTrend: FindingsPerReviewPoint[];
  mergeScoreDistribution: Record<number, number>;
  costStats: { totalCostUsd: number; avgCostUsd: number; costCount: number };
}

/**
 * Reduce a set of reviews into the analytics payload.
 *
 * Only the severities, categories and statuses seeded below are counted —
 * an unrecognized value is ignored rather than creating a new bucket, so a
 * future status cannot silently appear in the UI as an unlabelled slice.
 */
export function aggregateReviews(
  reviews: readonly AggregatableReview[],
): AnalyticsAggregate {
  // Score trend: average mergeScore per day
  const scoreByDate = new Map<string, { sum: number; count: number }>();
  // Severity breakdown
  const severityBreakdown: Record<string, number> = { critical: 0, warning: 0, info: 0 };
  // Duration stats
  const durations: number[] = [];
  // Repo breakdown
  const repoBreakdown = new Map<string, number>();
  // Category breakdown
  const categoryBreakdown: Record<string, number> = { security: 0, bug: 0, style: 0 };
  // Totals
  let totalFindings = 0;
  let mergeScoreSum = 0;
  let mergeScoreCount = 0;
  // Cost stats
  let totalCostUsd = 0;
  let costCount = 0;
  // Status counts
  const statusCounts: Record<string, number> = { complete: 0, failed: 0, skipped: 0, pending: 0, in_progress: 0 };
  // Findings-per-review trend
  const findingsByDate = new Map<string, { sum: number; count: number }>();
  // Merge score distribution (1-5)
  const mergeScoreDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (const review of reviews) {
    // Status counts
    if (review.status && statusCounts[review.status] !== undefined) {
      statusCounts[review.status]++;
    }

    // Score trend
    if (review.createdAt && review.mergeScore != null) {
      const date = review.createdAt.substring(0, 10); // YYYY-MM-DD
      const entry = scoreByDate.get(date) ?? { sum: 0, count: 0 };
      entry.sum += review.mergeScore;
      entry.count += 1;
      scoreByDate.set(date, entry);
      mergeScoreSum += review.mergeScore;
      mergeScoreCount += 1;

      // Merge score distribution
      const rounded = Math.round(review.mergeScore);
      if (rounded >= 1 && rounded <= 5) {
        mergeScoreDistribution[rounded]++;
      }
    }

    // Severity and category from findings
    if (review.findings && Array.isArray(review.findings)) {
      totalFindings += review.findings.length;
      for (const finding of review.findings) {
        if (finding.severity && severityBreakdown[finding.severity] !== undefined) {
          severityBreakdown[finding.severity]++;
        }
        if (finding.category && categoryBreakdown[finding.category] !== undefined) {
          categoryBreakdown[finding.category]++;
        }
      }
    }

    // Findings-per-review trend (only completed reviews)
    if (review.createdAt && review.status === "complete") {
      const date = review.createdAt.substring(0, 10);
      const fc = review.findingCount ?? 0;
      const entry = findingsByDate.get(date) ?? { sum: 0, count: 0 };
      entry.sum += fc;
      entry.count += 1;
      findingsByDate.set(date, entry);
    }

    // Cost stats
    if (review.estimatedCostUsd != null && review.status === "complete") {
      totalCostUsd += Number(review.estimatedCostUsd);
      costCount += 1;
    }

    // Duration stats
    if (review.durationMs != null && review.status === "complete") {
      durations.push(review.durationMs);
    }

    // Repo breakdown
    const repoCount = repoBreakdown.get(review.repoFullName) ?? 0;
    repoBreakdown.set(review.repoFullName, repoCount + 1);
  }

  // Compute score trend sorted by date
  const scoreTrend = Array.from(scoreByDate.entries())
    .map(([date, { sum, count }]) => ({
      date,
      avgScore: Math.round((sum / count) * 100) / 100,
      count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Duration statistics
  durations.sort((a, b) => a - b);
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
    : 0;
  // NOTE: this index is off by one and returns the maximum for n <= 20.
  // Preserved as-is by the #333 extraction; fixed under #336.
  const p95Duration = durations.length > 0
    ? durations[Math.floor(durations.length * 0.95)]
    : 0;

  return {
    totalReviews: reviews.length,
    totalFindings,
    avgMergeScore: mergeScoreCount > 0
      ? Math.round((mergeScoreSum / mergeScoreCount) * 100) / 100
      : 0,
    scoreTrend,
    severityBreakdown,
    durationStats: {
      avgMs: avgDuration,
      p95Ms: p95Duration,
      count: durations.length,
    },
    repoBreakdown: Array.from(repoBreakdown.entries())
      .map(([repo, count]) => ({ repo, count }))
      .sort((a, b) => b.count - a.count),
    categoryBreakdown,
    statusCounts,
    findingsPerReviewTrend: Array.from(findingsByDate.entries())
      .map(([date, { sum, count }]) => ({
        date,
        avgFindings: Math.round((sum / count) * 100) / 100,
        count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    mergeScoreDistribution,
    costStats: {
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      avgCostUsd: costCount > 0
        ? Math.round((totalCostUsd / costCount) * 10000) / 10000
        : 0,
      costCount,
    },
  };
}
