/**
 * Shared types for the dashboard insight surfaces.
 *
 * One source of truth for the `InstallationFPInsight` shape returned by
 * `/api/insights`, consumed by both the Analytics "Impact" sections (cost /
 * cycle-time / engagement) and the Accuracy (false-positive) views, so the two
 * pages stay in lock-step.
 */

export interface CategoryBucket {
  surfaced: number;
  disputed: number;
  rate: number;
}

export interface ClusterRow {
  sigTokens: string[];
  representativeTitle: string;
  surfaceCount: number;
  disputeCount: number;
  rate: number;
}

export interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
}

/** TTM (#194) — cycle-time block. Optional for back-compat with pre-Stage-2 rollups. */
export interface CycleTime {
  mergedCount: number;
  reviewedMergedCount: number;
  unreviewedMergedCount: number;
  closedUnmergedCount: number;
  openCount: number;
  timeToMergeHours: Percentiles | null;
  timeToMergeHoursReviewed: Percentiles | null;
  timeToMergeHoursUnreviewed: Percentiles | null;
  timeToMergeFromFirstReviewHours: Percentiles | null;
  roundTripsBeforeMerge: Percentiles | null;
}

/** #195 — developer-engagement block. Optional for pre-engagement rollups. */
export interface Engagement {
  // Tier 1 — behavioral
  acceptanceRate: number | null;
  totalResolves: number;
  totalRejectCommands: number;
  commandUsageCount: number;
  findingActionRateApprox: number | null;
  reReviewRate: number | null;
  reviewedPrCount: number;
  activeInstallation: boolean;
  // Tier 2 — explicit satisfaction (Phase 4 + 5). `0` / `null` on rollups run
  // before a satisfaction store was wired.
  helpfulUp?: number;
  helpfulDown?: number;
  helpfulRate?: number | null;
  npsResponses?: number;
  npsScore?: number | null;
}

/** #193 — LLM-cost block. Optional for pre-cost rollups. */
export interface Cost {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  reviewCount: number;
  pricedReviewCount: number;
  unpricedReviewCount: number;
  avgCostPerReview: number | null;
  findingCount: number;
  avgCostPerFinding: number | null;
  perRepo: Record<string, { costUsd: number; reviewCount: number }>;
}

export interface Insight {
  installationId: string;
  window: "7d" | "30d" | "90d";
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  totalFindingsSurfaced: number;
  totalDisputes: number;
  disputeRate: number;
  totalSilentDrops: number;
  totalAgreements: number;
  perCategory: Record<string, CategoryBucket>;
  /** FB-I — buckets by severity. Optional for back-compat with pre-FB-I rollups (treated as `{}`). */
  perSeverity?: Record<string, CategoryBucket>;
  perRepo: Record<string, CategoryBucket>;
  topClusters: ClusterRow[];
  /** TTM (#194) — present only on rollups generated after Stage 2 shipped. */
  cycleTime?: CycleTime;
  /** #195 — present only on rollups generated after the engagement stage shipped. */
  engagement?: Engagement;
  /** #193 — present only on rollups generated after the cost stage shipped. */
  cost?: Cost;
}
