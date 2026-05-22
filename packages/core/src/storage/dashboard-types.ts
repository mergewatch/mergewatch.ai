/**
 * Dashboard-specific storage interfaces.
 *
 * These operations serve the Next.js dashboard and are separate from the
 * pipeline interfaces (IInstallationStore / IReviewStore) because they need
 * pagination, stats aggregation, bulk monitoring, and feedback — operations
 * that don't belong on the lean pipeline stores.
 *
 * Implementations:
 *   - DynamoDashboardStore  (packages/storage-dynamo)  — SaaS / Amplify
 *   - PostgresDashboardStore (packages/storage-postgres) — self-hosted / Docker
 */

import type { InstallationItem, InstallationSettings, ReviewItem, InstallationFPInsight } from '../types/db.js';

// ─── Paginated result wrapper ───────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

// ─── Stats types ────────────────────────────────────────────────────────────

export interface ReviewStats {
  total: number;
  completed: number;
  findings: number;
}

export interface RepoStats {
  reviewCount: number;
  issueCount: number;
  lastReviewedAt: string | null;
}

// ─── Installation store (dashboard operations) ─────────────────────────────

export interface IDashboardInstallationStore {
  /** List all repos for a given GitHub App installation. */
  listByInstallation(installationId: string): Promise<InstallationItem[]>;

  /** Get installation-level settings (merged with defaults). */
  getSettings(installationId: string): Promise<InstallationSettings>;

  /** Save installation-level settings. */
  updateSettings(installationId: string, settings: InstallationSettings): Promise<void>;
}

// ─── Review store (dashboard operations) ────────────────────────────────────

export interface IDashboardReviewStore {
  /** List reviews across multiple repos with pagination and optional status/date filter. */
  listReviews(
    repos: string[],
    limit: number,
    cursor?: string,
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PaginatedResult<ReviewItem>>;

  /** Get a single review by composite key. */
  getReview(repoFullName: string, prNumberCommitSha: string): Promise<ReviewItem | null>;

  /** Set or clear feedback on a review. */
  updateFeedback(
    repoFullName: string,
    prNumberCommitSha: string,
    feedback: 'up' | 'down' | null,
  ): Promise<void>;

  /** Aggregate stats (total, completed, findings) across repos. */
  getReviewStats(repos: string[]): Promise<ReviewStats>;

  /** Per-repo stats (review count, issue count, last reviewed). */
  getRepoStats(repos: string[]): Promise<Map<string, RepoStats>>;
}

// ─── FP insight store (dashboard operations) ───────────────────────────────

/**
 * FB-F..FB-J dashboard read surface for the InstallationFPInsight rows
 * produced by the nightly FB-E rollup. Dashboard routes read here; never
 * from the raw FindingDispositionRecord table. Keeps page-load O(1).
 */
export interface IDashboardFPInsightStore {
  /**
   * Return all 7d / 30d / 90d insight rows for an installation, sorted
   * window-asc. Empty array when the rollup hasn't produced rows yet
   * (fresh installation; chart components render zero-state).
   */
  listByInstallation(installationId: string): Promise<InstallationFPInsight[]>;
}

// ─── Combined dashboard store ───────────────────────────────────────────────

export interface IDashboardStore {
  installations: IDashboardInstallationStore;
  reviews: IDashboardReviewStore;
  /**
   * FB-F..FB-J — optional in v1 so older deployments (pre-FB-E table
   * provisioning) can still serve the rest of the dashboard. Chart routes
   * render a zero-state when this field is absent.
   */
  fpInsights?: IDashboardFPInsightStore;
}
