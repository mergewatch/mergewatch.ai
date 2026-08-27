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

import type { InstallationItem, InstallationSettings, ReviewItem, InstallationFPInsight, NpsResponseRecord, OrgCustomAgent,
  ReviewTraceItem,
} from '../types/db.js';

/**
 * #494 — trace storage is not configured for this deployment.
 *
 * Thrown rather than returning `null` because the two are not the same answer:
 * `null` means "this review has no trail", and a reader shown that when the
 * dashboard could not look is being told something false. The trail panel
 * already renders the distinction — a failed fetch says "could not be loaded",
 * a null says "none was recorded" — so the only thing missing was a store that
 * stopped conflating them.
 *
 * Found in production: a review whose trace existed in DynamoDB the whole time
 * displayed "No decision trail was recorded" because the table name never
 * reached the runtime (#497). Nothing in any log said otherwise.
 *
 * SaaS only in practice. The Postgres implementation queries its table
 * directly, so a missing table already throws — there is no name to forget.
 */
export class TraceStorageNotConfiguredError extends Error {
  constructor() {
    super(
      'Review trace storage is not configured — no trace table name was provided. ' +
      'On Amplify, check that DYNAMODB_TABLE_REVIEW_TRACES is set AND declared in ' +
      'the next.config.js env block; a var absent from that block does not exist at runtime.',
    );
    this.name = 'TraceStorageNotConfiguredError';
  }
}

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

  /** #235 — read the installation's org custom agents (sanitized; [] when unset). */
  getCustomAgents(installationId: string): Promise<OrgCustomAgent[]>;

  /** #235 — replace the installation's org custom agents (full set). */
  updateCustomAgents(installationId: string, agents: OrgCustomAgent[]): Promise<void>;
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

  /**
   * #472 — the filter outcome ledger for one review (#470/#471), or null when
   * none was written (a review from before #471, or a trace write that failed).
   *
   * REQUIRED, not optional, and that is the point. A Dynamo-only
   * implementation would leave self-hosted users looking at an empty decision
   * trail with no error — worse than the feature not existing, because an
   * empty trail reads as "nothing was filtered". Requiring it here makes
   * shipping one backend a compile error rather than a silent asymmetry.
   */
  getReviewTrace(
    repoFullName: string,
    prNumberCommitSha: string,
  ): Promise<ReviewTraceItem | null>;
  // #494 — `null` means "this review has no trail". An implementation that
  // cannot look at all must throw TraceStorageNotConfiguredError instead.

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

// ─── Satisfaction store (dashboard NPS operations, #195 Phase 5) ────────────

/**
 * Dashboard read/write surface for the NPS survey prompt. The dashboard needs
 * exactly two operations — check the caller's eligibility (last response) and
 * record a new response. The full `ISatisfactionStore` (helpful votes + rollup
 * paging) lives on the pipeline path; the dashboard never exercises those.
 */
export interface IDashboardSatisfactionStore {
  /** The caller's most recent NPS response, or null if they've never responded. */
  getNpsResponse(installationId: string, githubUserId: string): Promise<NpsResponseRecord | null>;
  /** Record (or replace, latest-wins) the caller's NPS response. */
  recordNpsResponse(rec: NpsResponseRecord): Promise<void>;
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
  /**
   * #195 Phase 5 — optional. Present when a satisfaction table is provisioned;
   * the NPS route returns "ineligible" (never prompts) when absent.
   */
  satisfaction?: IDashboardSatisfactionStore;
}
