// =============================================================================
// MergeWatch DynamoDB Type Definitions
// =============================================================================
//
// TypeScript types for all DynamoDB table items. These types are the single
// source of truth for the shape of data stored in DynamoDB.
//
// Tables:
//   1. mergewatch-installations — GitHub App installations and repo config
//   2. mergewatch-reviews       — PR review jobs and their status
//
// Usage:
//   import { InstallationItem, ReviewItem, ReviewStatus } from '../types/db';
// =============================================================================

// =============================================================================
// mergewatch-installations Table
// =============================================================================

/**
 * Configuration parsed from a repository's `.mergewatch.yml` file.
 *
 * This config is loaded when a GitHub App installation event is received
 * and cached in DynamoDB. It controls how MergeWatch reviews PRs for
 * this specific repository.
 *
 * Example `.mergewatch.yml`:
 * ```yaml
 * enabled: true
 * language: typescript
 * ignore:
 *   - "*.test.ts"
 *   - "dist/**"
 * reviewScope: changed-files
 * maxFileSize: 500
 * ```
 */
export interface RepoConfig {
  /** Whether MergeWatch is enabled for this repo (default: true) */
  enabled?: boolean;

  /** Primary language hint — helps the AI model provide better reviews */
  language?: string;

  /** Glob patterns for files to ignore during review */
  ignore?: string[];

  /**
   * What to include in the review context:
   *   - "changed-files": Only review files modified in the PR (default)
   *   - "full-diff": Send the entire diff for holistic review
   */
  reviewScope?: 'changed-files' | 'full-diff';

  /** Maximum file size in KB to include in review (files larger are skipped) */
  maxFileSize?: number;

  /**
   * Custom review prompt — appended to the system prompt sent to Bedrock.
   * Use this for repo-specific review guidelines.
   */
  customPrompt?: string;
}

/**
 * DynamoDB item for the `mergewatch-installations` table.
 *
 * Each item represents a single GitHub App installation for a specific
 * repository. The composite key (installationId + repoFullName) allows
 * querying all repos for a given installation, or looking up the config
 * for a specific repo.
 *
 * Table key schema:
 *   PK (Partition Key): installationId
 *   SK (Sort Key):      repoFullName
 */
export interface InstallationItem {
  // --- Key attributes ---

  /**
   * GitHub App installation ID (partition key).
   * This is a numeric ID assigned by GitHub, stored as a string in DynamoDB
   * because DynamoDB partition keys work best as strings.
   *
   * Example: "12345678"
   */
  installationId: string;

  /**
   * Full repository name in "owner/repo" format (sort key).
   * Using the full name ensures uniqueness across GitHub organizations.
   *
   * Example: "octocat/Hello-World"
   */
  repoFullName: string;

  // --- Data attributes ---

  /**
   * ISO 8601 timestamp of when the GitHub App was installed on this repo.
   * Set once during the installation webhook event.
   *
   * Example: "2025-01-15T10:30:00.000Z"
   */
  installedAt: string;

  /**
   * Parsed contents of the repository's `.mergewatch.yml` configuration file.
   * This is fetched from the repo's default branch during installation and
   * updated when the config file changes.
   *
   * Stored as a DynamoDB Map type. If the repo has no config file, this
   * will be an empty object (defaults are applied at review time).
   */
  config: RepoConfig;

  /**
   * Amazon Bedrock model ID override for this specific repository.
   * If set, this takes precedence over the global DEFAULT_BEDROCK_MODEL_ID.
   *
   * Use this to assign different models to different repos — for example,
   * a larger model for critical repos or a smaller model for high-volume repos.
   *
   * Example: "us.anthropic.claude-sonnet-4-20250514-v1:0"
   */
  modelId?: string;

  /** Deprecated — retained for backward compatibility. The pipeline reviews all installed repos regardless of this flag. */
  monitored?: boolean;
}

// =============================================================================
// Installation-level Settings (stored as SK="#SETTINGS" sentinel row)
// =============================================================================

/**
 * Settings scoped to a GitHub App installation.
 * Stored as a sentinel row in mergewatch-installations with SK="#SETTINGS".
 * These are the defaults for all repos in this installation; per-repo
 * overrides are done via .mergewatch.yml files.
 */
export interface InstallationSettings {
  severityThreshold: 'Low' | 'Med' | 'High';
  commentTypes: { syntax: boolean; logic: boolean; style: boolean };
  maxComments: number;
  summary: {
    prSummary: boolean;
    confidenceScore: boolean;
    issuesTable: boolean;
    diagram: boolean;
  };
  customInstructions: string;
  commentHeader: string;
}

export const DEFAULT_INSTALLATION_SETTINGS: InstallationSettings = {
  severityThreshold: 'Med',
  commentTypes: { syntax: true, logic: true, style: true },
  maxComments: 10,
  summary: {
    prSummary: true,
    // Confidence scores are LLM-self-reported and not well-calibrated against
    // actual hit rate. A "85% confidence" finding has been observed to be 0%
    // true in production. Hidden by default; users who want them can opt in
    // via the dashboard. The score is still stored on each finding for
    // internal sorting / future threshold-based filtering.
    confidenceScore: false,
    issuesTable: true,
    diagram: true,
  },
  customInstructions: '',
  commentHeader: '',
};

// =============================================================================
// mergewatch-reviews Table
// =============================================================================

/**
 * Enum-like type for review job status.
 *
 * State machine:
 *   pending -> in_progress -> complete
 *                          -> failed
 *
 * - pending:     Review job created, waiting for ReviewAgent to pick it up
 * - in_progress: ReviewAgent is actively processing the PR
 * - complete:    Review posted to GitHub successfully
 * - failed:      Review failed (error details logged to CloudWatch)
 */
export type ReviewStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';

/**
 * DynamoDB item for the `mergewatch-reviews` table.
 *
 * Each item represents a single review job for a specific PR at a specific
 * commit. When a new commit is pushed to a PR, a new review item is created
 * with the updated commit SHA in the sort key.
 *
 * Table key schema:
 *   PK (Partition Key): repoFullName
 *   SK (Sort Key):      prNumberCommitSha (format: "{prNumber}#{commitSha}")
 *
 * Access patterns:
 *   - Get a specific review:     PK=repoFullName, SK="42#abc123"
 *   - List reviews for a repo:   PK=repoFullName (Query)
 *   - List reviews for a PR:     PK=repoFullName, SK begins_with("42#") (Query)
 */
export interface ReviewItem {
  // --- Key attributes ---

  /**
   * Full repository name in "owner/repo" format (partition key).
   * Same format as InstallationItem.repoFullName.
   *
   * Example: "octocat/Hello-World"
   */
  repoFullName: string;

  /**
   * Composite sort key combining PR number and commit SHA.
   * Format: "{prNumber}#{shortCommitSha}"
   *
   * The PR number comes first so we can use begins_with() queries
   * to find all reviews for a specific PR.
   *
   * Example: "42#abc123def"
   */
  prNumberCommitSha: string;

  // --- Data attributes ---

  /**
   * Current status of the review job.
   * See ReviewStatus type for the state machine.
   */
  status: ReviewStatus;

  /**
   * GitHub comment ID for the review comment posted by MergeWatch.
   *
   * When a review is first posted, we store the comment ID so that
   * subsequent updates (e.g., re-review on new commits) can edit
   * the existing comment in-place instead of creating new ones.
   *
   * This is a number because GitHub's API returns comment IDs as numbers.
   * Optional because it's only set after the comment is created.
   */
  commentId?: number;

  /**
   * ISO 8601 timestamp of when the review job was created.
   * Set by WebhookHandler when the job is first enqueued.
   *
   * Example: "2025-01-15T10:30:00.000Z"
   */
  createdAt: string;

  /**
   * ISO 8601 timestamp of when the review job completed (or failed).
   * Set by ReviewAgent when the job finishes processing.
   * Undefined while the job is pending or in progress.
   *
   * Example: "2025-01-15T10:31:45.000Z"
   */
  completedAt?: string;

  /** PR title from GitHub, stored for display in the dashboard. */
  prTitle?: string;

  /** Bedrock model ID used for the review. */
  model?: string;

  /** Snapshot of the effective settings used for this review. */
  settingsUsed?: {
    severityThreshold: string;
    commentTypes: { syntax: boolean; logic: boolean; style: boolean };
    maxComments: number;
    summaryEnabled: boolean;
    customInstructions: boolean;
  };

  // --- Rich review data (Phase 1 — Reviews page) ---

  /** PR author login from GitHub. */
  prAuthor?: string;
  /** PR author avatar URL. */
  prAuthorAvatar?: string;
  /** Who authored the PR this review covers. Populated by the webhook handler via
   *  agentReview.detection, or hardcoded 'agent' for MCP-triggered reviews. */
  source?: 'agent' | 'human';
  /** Which agent, when source='agent'. Derived from whichever detection rule matched. */
  agentKind?: 'claude' | 'cursor' | 'codex' | 'other';
  /** Head branch name (e.g. "feature/foo"). */
  headBranch?: string;
  /** Base branch name (e.g. "main"). */
  baseBranch?: string;
  /** Number of findings in the review. */
  findingCount?: number;
  /** Highest severity found (critical > warning > info). */
  topSeverity?: 'critical' | 'warning' | 'info';
  /** Review duration in milliseconds. */
  durationMs?: number;
  /** Full summary text from the summary agent. */
  summaryText?: string;
  /** Mermaid diagram text from the diagram agent. */
  diagramText?: string;
  /** Reason the review was skipped (only set when status is 'skipped'). */
  skipReason?: string;
  /** Overall merge readiness score (1-5, where 5 = safe to merge). */
  mergeScore?: number;
  /** One-line justification for the merge score. */
  mergeScoreReason?: string;
  /** All findings from the review. */
  findings?: ReviewFinding[];
  /** User feedback from dashboard: thumbs up or down. */
  feedback?: 'up' | 'down';
  /** Reactions collected from the GitHub PR comment. */
  reactions?: Record<string, number>;
  /** GitHub App installation ID (stored for dashboard queries). */
  installationId?: string;
  /** Total input tokens used for this review. */
  inputTokens?: number;
  /** Total output tokens used for this review. */
  outputTokens?: number;
  /** Estimated cost in USD for this review. Stored as string in Postgres to avoid float precision issues. */
  estimatedCostUsd?: number;

  /**
   * FB-C — Last-observed reaction counts per inline bot comment on this PR,
   * keyed by comment ID. Used to compute reaction deltas on the next
   * review run (counters in `FindingDispositionRecord` are monotonic, so
   * we need to know "what we've already counted" to avoid double-writing
   * the same 👎 on every re-review).
   *
   * Inner map shape: each GitHub reaction content type ('+1', '-1',
   * 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes') → count
   * of non-bot reactions observed at the time of the last poll. Reactions
   * added by `mergewatch[bot]` (the bot's own 👀 read-receipt etc.) are
   * filtered out client-side and never enter this snapshot.
   *
   * Persisted on the LATEST complete review for the PR. Updated on every
   * review run that polls reactions.
   */
  inlineReactionsSnapshot?: Record<string, Record<string, number>>;

  /**
   * #195 Phase 4 — last-polled raw reaction counts on the summary comment's
   * "Was this review helpful? 👍 / 👎" prompt, keyed by GitHub reaction type
   * (`+1` / `heart` / `rocket` / `-1` / `confused`). Drives the snapshot-delta
   * that turns new reactions into `ISatisfactionStore.recordHelpfulVotes`
   * increments without double-counting on re-review polls. Monotonic — only
   * positive deltas vs this snapshot are recorded.
   *
   * Persisted on the LATEST complete review for the PR; absent on reviews run
   * before this prompt shipped (no helpful votes recorded for them).
   */
  summaryReactionsSnapshot?: Record<string, number>;

  /**
   * FP-F — Stable `findingMatchKeys` for findings the author resolved by
   * replying `/resolve` (or equivalent) on an inline review-comment thread.
   *
   * Persisted on the LATEST complete review for the PR; the union of this
   * set with the live-computed W3 `disputedKeys` becomes the per-review
   * "don't re-raise" set. Same logical mechanism as W3, scoped to inline
   * threads instead of top-level `## mergewatch triage` comments — when a
   * developer explicitly resolves an inline thread, the next full review
   * must not re-emit the same finding under a slightly-different framing
   * (which W3's stable-key match would otherwise catch on the triage path
   * but couldn't see on the inline-resolve path before FP-F).
   *
   * Keys use the W9 union form (`file::T::<title>` always, `file::F::<fp>`
   * when a fingerprint is available). De-duplicated; capped at a sane
   * upper bound by the handler to keep the field small.
   */
  inlineResolvedKeys?: string[];
}

/** A single finding stored on a ReviewItem (matches comment-formatter Finding). */
export interface ReviewFinding {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  confidence?: number;
  category: string;
  title: string;
  description: string;
  suggestion: string;
  /**
   * Stable cross-commit identity (W9). Normalized cited code, not line/title.
   * Persisted so the next review's delta can match by code, not by the LLM's
   * (drifting) wording. Optional for back-compat with pre-W9 stored reviews.
   */
  fingerprint?: string;
  /**
   * Result of the W2 critical-verification pass (W7 score-guardrail input).
   * `verified` = the verifier model confirmed the defect against the full
   * file; `unverified` = inconclusive / fail-safe-kept. Persisted so a
   * later re-review can still reason about the prior verification result.
   * Optional / back-compat with pre-W7 stored reviews.
   */
  verification?: 'verified' | 'unverified';
}

// =============================================================================
// Billing Fields (stored on #SETTINGS sentinel row)
// =============================================================================

/**
 * Optional billing fields stored alongside InstallationSettings on the
 * #SETTINGS sentinel row. These are only populated in SaaS mode.
 */
export interface BillingFields {
  /** Number of free reviews consumed (lifetime). */
  freeReviewsUsed?: number;
  /** Stripe customer ID (set after first card setup). */
  stripeCustomerId?: string;
  /** Prepaid credit balance in cents. */
  balanceCents?: number;
  /** Current billing period (YYYY-MM). */
  billingPeriod?: string;
  /** Number of PRs reviewed in the current billing period. */
  prCount?: number;
  /** ISO timestamps of recent PR reviews (for pace calculation). */
  prTimestamps?: string[];
  /** Total amount billed in cents (lifetime). */
  totalBilledCents?: number;
  /** Whether auto-reload is enabled. */
  autoReloadEnabled?: boolean;
  /** Balance threshold in cents that triggers auto-reload. */
  autoReloadThresholdCents?: number;
  /** Amount in cents to reload when threshold is hit. */
  autoReloadAmountCents?: number;
  /** Mutex: true while an auto-reload payment is in flight. */
  autoReloadInFlight?: boolean;
  /** ISO timestamp of when the installation was first blocked. */
  blockedAt?: string;
  /** GitHub Issue number for the billing block notification. */
  blockIssueNumber?: number;
  /** Repo where the billing block issue was filed (owner/repo). */
  blockIssueRepo?: string;
}

// =============================================================================
// Helper Types
// =============================================================================
// Utility types for working with DynamoDB items in application code.

/**
 * Key-only type for InstallationItem — useful for GetItem/DeleteItem operations
 * where you only need to specify the key attributes.
 */
export type InstallationKey = Pick<InstallationItem, 'installationId' | 'repoFullName'>;

/**
 * Key-only type for ReviewItem — useful for GetItem/DeleteItem operations.
 */
export type ReviewKey = Pick<ReviewItem, 'repoFullName' | 'prNumberCommitSha'>;

/**
 * Type for creating a new review — all required fields except completedAt
 * (which is set when the review finishes).
 */
export type CreateReviewInput = Omit<ReviewItem, 'completedAt' | 'commentId'>;

/**
 * FB-A — Per-finding cross-PR identity record. One row per distinct
 * `findingMatchKey` per repo per installation. Created on first surfacing;
 * counters incremented on every subsequent surfacing, dispute, verification,
 * agreement, silent drop, etc.
 *
 * Storage:
 *   - DynamoDB (SaaS) table: mergewatch-finding-dispositions
 *     PK: `${installationId}#${repoFullName}`   SK: `findingMatchKey`
 *   - Postgres (self-hosted) table: finding_dispositions
 *     PK: (installation_id, repo_full_name, finding_match_key)
 *
 * Read path: only the FB-E nightly rollup queries this directly. Dashboard
 * pages read the FB-E rollups, never the raw records — keeps O(1) on the
 * page-load side.
 *
 * Write path: best-effort. Failed writes are logged but never block the
 * review pipeline. Counters are monotonic — we never decrement (avoids the
 * need for an event-source table to reconcile reaction removals).
 */
export interface FindingDispositionRecord {
  installationId: string;
  repoFullName: string;
  /** W9-style stable identity. Either `${file}::T::${title}` or `${file}::F::${fingerprint}`. */
  findingMatchKey: string;

  /** ISO 8601. Set once on creation. */
  firstSeen: string;
  /** ISO 8601. Refreshed on every surfacing. */
  lastSeen: string;

  /** Distinct reviews this key appeared in. */
  surfaceCount: number;
  /** Explicit disputes (W3 triage, FP-F inline-resolve, FB-C 👎/🤔, FB-D /mergewatch reject). */
  disputeCount: number;
  /** W2 verifyFindings explicit `valid: true` verdicts on a finding carrying this key. */
  verifiedCount: number;
  /** W2 verifyFindings inconclusive verdicts on a finding carrying this key. */
  unverifiedCount: number;
  /** FB-B — finding was in previousFindings, code at the cited line didn't change, finding was NOT in current. */
  silentDropCount: number;
  /** FB-C — 👍 / ❤️ / 🚀 reactions on the bot's inline comment for a finding with this key. */
  agreementCount: number;
  /**
   * #195 — `/resolve` (or `/mergewatch resolve`) command invocations on the
   * bot's inline thread for a finding with this key. A first-class engagement
   * signal: an explicit "I acted on this" distinct from a 👎 dispute. Drives
   * the command-usage and approximate finding-action KPIs in the FB-E rollup.
   * Defaults to 0 on records written before this counter existed.
   */
  resolveCount: number;

  /** Last-seen finding category for this key (the few seen are stable; we keep the most recent). */
  category?: 'security' | 'bug' | 'style' | 'errorHandling' | 'testCoverage' | 'commentAccuracy' | 'custom';
  /**
   * FB-I — last-seen severity for this finding key. Drives the
   * severity-shopping detector rollup (`perSeverity` on `InstallationFPInsight`).
   * Optional for back-compat with pre-FB-I records that wrote the row before
   * the column existed; rollups treat missing values as 'uncategorized'.
   * Last-writer-wins is fine — severity for a given match key is highly
   * stable in practice (only changes if the orchestrator deliberately
   * down-/up-grades, which is exactly the signal FB-I exists to surface).
   */
  severity?: 'critical' | 'warning' | 'info';
  /** Last-seen producing agent (heuristic — same finding can drift agent across reviews). */
  topAgent?: string;
  /** W10 significant-token bag for this finding's title — drives cluster-level rollup in FB-E. */
  sigTokens?: string[];
  /** FB-D — appended one entry per `/mergewatch reject <category>` invocation. */
  rejectReasons?: Array<{
    category: 'already-handled' | 'out-of-scope' | 'wrong-target' | 'style-disagreement' | 'other';
    text?: string;
    at: string;
  }>;
}

/**
 * TTM — Per-PR lifecycle record. One row per pull request MergeWatch saw,
 * independent of the per-commit `ReviewItem` (a PR has N review rows, one per
 * push, but exactly one lifecycle row). Drives the time-to-merge / cycle-time
 * rollup (#194).
 *
 * Storage:
 *   - DynamoDB (SaaS) table: mergewatch-pr-lifecycle
 *     PK: `${installationId}#${repoFullName}`   SK: `prNumber` (string)
 *   - Postgres (self-hosted) table: pr_lifecycle
 *     PK: (installation_id, repo_full_name, pr_number)
 *
 * Write path (all best-effort — never blocks the review pipeline):
 *   - webhook `opened` / `reopened` → upsertOpened (sets prCreatedAt, state=open)
 *   - webhook `synchronize`         → recordPush (bumps push counters)
 *   - webhook `closed` (merged)     → markMerged (terminal)
 *   - webhook `closed` (unmerged)   → markClosedUnmerged (terminal)
 *   - review processor on complete  → markReviewed (firstReviewAt set-once)
 *   - review processor on skip      → markSkipped
 *
 * Read path: the nightly cycle-time rollup (Stage 2) pages these rows per
 * installation and computes time-to-merge percentiles.
 */
export interface PRLifecycleRecord {
  installationId: string;
  repoFullName: string;
  prNumber: number;

  /** ISO 8601 — PR `created_at` from GitHub. The anchor for time-to-merge. */
  prCreatedAt: string;
  /**
   * ISO 8601 — when MergeWatch first completed a review for this PR. Set once
   * (never overwritten by later pushes). Unset if the PR was never reviewed.
   * The anchor for time-from-first-review-to-merge.
   */
  firstReviewAt?: string;
  /** ISO 8601 — PR `merged_at`. Set only on a merge. */
  mergedAt?: string;
  /** ISO 8601 — PR `closed_at` when closed WITHOUT merging. */
  closedAt?: string;

  /** Terminal-aware lifecycle state. Never downgrades once merged/closed. */
  state: 'open' | 'merged' | 'closed_unmerged';

  /** True once MergeWatch completed a review (segmentation: reviewed vs not). */
  reviewed: boolean;
  /** True when `shouldSkipPR` short-circuited the review (docs-only / lockfile / …). */
  skipped: boolean;

  /** Total `synchronize` (push) events seen on this PR. */
  totalPushes: number;
  /**
   * Pushes observed AFTER `firstReviewAt` was set — the round-trip / iteration
   * proxy the rollup reports. 0 until the first review lands.
   */
  pushesAfterFirstReview: number;

  /** ISO 8601 — last time any field on this row was written. */
  updatedAt: string;
  /**
   * Unix epoch seconds for DynamoDB TTL (≈90 days past the terminal event).
   * Unset while open. Postgres ignores this (no TTL).
   */
  ttl?: number;
}

/**
 * FB-E — Per-installation FP insight rollup. Produced nightly by aggregating
 * `FindingDispositionRecord` rows over a rolling window (7d / 30d / 90d).
 *
 * Storage:
 *   - DynamoDB (SaaS) table: mergewatch-installation-fp-insights
 *     PK: `installationId`   SK: `window`   (e.g. PK=42, SK="30d")
 *   - Postgres (self-hosted) table: installation_fp_insights
 *     PK: (installation_id, window)
 *
 * Read path: dashboard charts (FB-F..FB-J) read these rows; never the raw
 * `FindingDispositionRecord` table. Keeps page-load O(1).
 *
 * Write path: a scheduled job (EventBridge → Lambda for SaaS; node-cron
 * in the Express server for self-hosted) replaces the three rolling-window
 * rows for each installation once per night. Idempotent — re-running the
 * same night overwrites with identical numbers.
 */
export interface InstallationFPInsight {
  installationId: string;
  /** Rolling window the row aggregates over. */
  window: '7d' | '30d' | '90d';
  /** ISO 8601 — the lower bound of the window (now - window length). */
  windowStart: string;
  /** ISO 8601 — the upper bound (rollup timestamp). */
  windowEnd: string;
  /** ISO 8601 — when this row was last computed; same as windowEnd for fresh rollups. */
  generatedAt: string;

  /** Sum of surfaceCount across every disposition record whose lastSeen falls inside the window. */
  totalFindingsSurfaced: number;
  /** Sum of disputeCount across the same set. */
  totalDisputes: number;
  /** disputeCount / surfaceCount across the window. 0 when totalFindingsSurfaced is 0. */
  disputeRate: number;
  /** Sum of silentDropCount — the implicit FP signal. */
  totalSilentDrops: number;
  /** Sum of agreementCount — the implicit TP signal. */
  totalAgreements: number;

  /** Bucketed by `FindingDispositionRecord.category` (security / bug / style / …). */
  perCategory: Record<string, { surfaced: number; disputed: number; rate: number }>;
  /**
   * FB-I — bucketed by `FindingDispositionRecord.severity` (critical / warning /
   * info / uncategorized). Drives the severity-shopping detector chart:
   * when `warning.rate > critical.rate * 1.5` consistently across both the
   * 7d and 30d windows, it signals the orchestrator is downgrading findings
   * to dodge W2/W7's critical-only attention rather than letting FP-E
   * verification do its job.
   *
   * Optional for back-compat with rollups generated before FB-I shipped
   * (those rows simply lack the bucket; consumers handle the undefined case).
   */
  perSeverity?: Record<string, { surfaced: number; disputed: number; rate: number }>;
  /** Bucketed by `FindingDispositionRecord.repoFullName`. */
  perRepo: Record<string, { surfaced: number; disputed: number; rate: number }>;

  /**
   * Top-N clusters by `disputeRate × surfaceCount`. Clusters are built via
   * union-find on shared significant tokens (same W10 token bag the
   * orchestrator's FB-A writer captures on each surfacing).
   */
  topClusters: Array<{
    sigTokens: string[];
    representativeTitle: string;
    surfaceCount: number;
    disputeCount: number;
    rate: number;
  }>;

  /**
   * TTM (#194) — time-to-merge / cycle-time block, computed from
   * `PRLifecycleRecord` rows in the same window. Optional: present only on
   * rollups generated after Stage 2 shipped AND when a PR-lifecycle store is
   * wired into the rollup. Consumers must handle the undefined case.
   *
   * A PR is windowed by its terminal (or, for still-open PRs, creation)
   * timestamp: merged → `mergedAt`, closed-unmerged → `closedAt`, open →
   * `prCreatedAt`. Percentiles are in HOURS; each percentile object is null
   * when its underlying sample is empty (no merged PRs, no reviewed merges,
   * etc.) so the dashboard can distinguish "0 hours" from "no data".
   */
  cycleTime?: {
    /** Merged in-window. The denominator for the time-to-merge stats. */
    mergedCount: number;
    /** Of `mergedCount`, those MergeWatch reviewed vs not (segmentation). */
    reviewedMergedCount: number;
    unreviewedMergedCount: number;
    /** Closed without merging in-window — excluded from time stats. */
    closedUnmergedCount: number;
    /** Still open (created in-window) — no merge time yet. */
    openCount: number;

    /** created_at → merged_at, all merged PRs. */
    timeToMergeHours: CycleTimePercentiles | null;
    /** created_at → merged_at, reviewed merged PRs only. */
    timeToMergeHoursReviewed: CycleTimePercentiles | null;
    /** created_at → merged_at, unreviewed merged PRs only. */
    timeToMergeHoursUnreviewed: CycleTimePercentiles | null;
    /** first_review_at → merged_at, reviewed merged PRs only. */
    timeToMergeFromFirstReviewHours: CycleTimePercentiles | null;
    /** pushesAfterFirstReview distribution, reviewed merged PRs only. */
    roundTripsBeforeMerge: CycleTimePercentiles | null;
  };

  /**
   * #195 — developer-engagement block, computed from the same disposition +
   * PR-lifecycle records in this window. Optional: present only on rollups
   * generated after this feature shipped. Consumers must handle the undefined
   * case. Tier-2 satisfaction fields (helpful / NPS) are added by later stages.
   *
   * Rates are `number | null` — null distinguishes "no signal in this window"
   * (empty denominator) from a real `0`, exactly like the cycle-time block.
   */
  engagement?: {
    /**
     * agreements / (agreements + disputes + silentDrops) — the share of
     * acted-on findings that were accepted vs disputed/quietly dropped. null
     * when nothing was acted on in the window.
     */
    acceptanceRate: number | null;
    /** `/resolve` (or `/mergewatch resolve`) command invocations in-window. */
    totalResolves: number;
    /** `/mergewatch reject` invocations in-window (rejectReasons[].at). */
    totalRejectCommands: number;
    /** totalResolves + totalRejectCommands — overall `/mergewatch` command usage. */
    commandUsageCount: number;
    /**
     * APPROXIMATE finding-action rate: (agreements + resolves) / findings
     * surfaced, capped at 1. A proxy for "the developer acted on this finding".
     * The exact signal (cited code actually changed in a later commit) needs
     * per-commit diff capture and is deferred to a follow-up. null when no
     * findings surfaced in the window.
     */
    findingActionRateApprox: number | null;
    /**
     * Of PRs MergeWatch reviewed in-window, the share that got another push
     * after the first review (devs iterating against feedback). null when no
     * reviewed PRs in the window.
     */
    reReviewRate: number | null;
    /** PRs MergeWatch reviewed in-window (firstReviewAt in window). */
    reviewedPrCount: number;
    /** reviewedPrCount > 0 — this installation's per-window activity signal. */
    activeInstallation: boolean;

    // ── Tier 2 — explicit satisfaction (#195 Phase 4 + 5) ────────────────────
    // Always present once the engagement block is computed; they read `0` /
    // `null` when no `ISatisfactionStore` is wired into the rollup (back-compat
    // with Phase-1..3 deployments that provisioned no satisfaction table).

    /**
     * Phase 4 — 👍 reactions on the summary-comment "Was this review helpful?"
     * prompt, summed over rows whose most-recent vote falls in the window.
     */
    helpfulUp: number;
    /** Phase 4 — 👎 reactions on the same prompt, windowed the same way. */
    helpfulDown: number;
    /** Phase 4 — helpfulUp / (helpfulUp + helpfulDown). null when no votes in-window. */
    helpfulRate: number | null;
    /** Phase 5 — NPS survey responses recorded in-window. */
    npsResponses: number;
    /**
     * Phase 5 — Net Promoter Score: %promoters (9–10) − %detractors (0–6),
     * an integer in −100..100. null when no responses landed in the window.
     */
    npsScore: number | null;
  };

  /**
   * #193 — LLM cost block, aggregated from per-review `ReviewCostRecord` rows
   * in the same window. Optional: present only on rollups generated after this
   * feature shipped AND when a review-cost store is wired into the rollup.
   * Consumers must handle the undefined case.
   *
   * A review is windowed by its `completedAt`. Cost is summed over PRICED
   * reviews only (a known model→pricing match); unpriced reviews (unknown
   * model) are counted separately and excluded from the money totals so a
   * mis-priced model can't silently drag the average to 0. Averages are
   * `number | null` — null when their denominator is empty, exactly like the
   * cycle-time and engagement blocks.
   */
  cost?: {
    /** Sum of estimated USD across priced reviews in-window. */
    totalCostUsd: number;
    /** Sum of input / output tokens across ALL reviews in-window (tokens are known even when the model is unpriced). */
    totalInputTokens: number;
    totalOutputTokens: number;
    /** Every review completed in-window (priced + unpriced). */
    reviewCount: number;
    /** Reviews with a known cost (model matched the pricing table). */
    pricedReviewCount: number;
    /** Reviews whose model wasn't in the pricing table — surfaced as "N unpriced", excluded from money totals. */
    unpricedReviewCount: number;
    /** totalCostUsd / pricedReviewCount. null when no priced reviews in-window. */
    avgCostPerReview: number | null;
    /** Findings surfaced across priced reviews in-window — the cost-per-finding denominator. */
    findingCount: number;
    /** totalCostUsd / findingCount. null when no findings on priced reviews in-window. */
    avgCostPerFinding: number | null;
    /** Per-repo spend bucket — which repos drive cost. Keyed by repoFullName. */
    perRepo: Record<string, { costUsd: number; reviewCount: number }>;
  };
}

/** Median / p75 / p90 of a cycle-time sample. */
export interface CycleTimePercentiles {
  p50: number;
  p75: number;
  p90: number;
}

// ─── #195 Tier 2 — explicit-satisfaction records ────────────────────────────

/**
 * Phase 4 — one aggregate row per summary comment (installation + repo + PR)
 * tracking 👍/👎 reactions on the "Was this review helpful?" prompt. Updated
 * by snapshot-delta from the review path; the nightly engagement rollup windows
 * these rows by `lastVoteAt` (same convention disposition counters use for
 * `lastSeen`).
 */
export interface HelpfulVoteRecord {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  /** Cumulative 👍 (`+1` / `heart` / `rocket`) reactions on the prompt. */
  up: number;
  /** Cumulative 👎 (`-1` / `confused`) reactions on the prompt. */
  down: number;
  /** ISO 8601 — most-recent vote activity; the rollup's windowing anchor. */
  lastVoteAt: string;
}

/**
 * Phase 5 — one row per (installation, GitHub user) carrying that admin's most
 * recent NPS survey response. Latest-wins on re-submit; `respondedAt` drives
 * both the 90-day prompt throttle and the rollup's per-window NPS computation.
 */
export interface NpsResponseRecord {
  installationId: string;
  /** GitHub user ID of the responding dashboard admin (NextAuth `githubUserId`). */
  githubUserId: string;
  /** 0–10 likelihood-to-recommend score. */
  score: number;
  /** ISO 8601 — when the response was recorded. */
  respondedAt: string;
}

// ─── #193 — per-review LLM cost record ──────────────────────────────────────

/**
 * One row per completed review, denormalizing the cost/token figures off the
 * `ReviewItem` so the nightly rollup can aggregate spend per installation
 * without scanning the (repo-partitioned) reviews table. Written best-effort
 * at review completion; the cost rollup windows these rows by `completedAt`.
 *
 * Identity is per-review (installation + repo + PR + commit), so a re-review of
 * the same PR on a new commit is a distinct row — re-reviews accrue cost.
 */
export interface ReviewCostRecord {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  /** Head commit SHA the review ran against — distinguishes re-reviews of the same PR. */
  commitSha: string;
  /** ISO 8601 — review completion time; the rollup's windowing anchor. */
  completedAt: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Estimated USD for this review, or null when the model wasn't in the pricing
   * table (unknown-model review). null is excluded from cost aggregates and
   * surfaced separately as an "unpriced" count — never coerced to 0.
   */
  costUsd: number | null;
  /** Findings surfaced by this review — the cost-per-finding denominator. */
  findingCount: number;
  /** Model id the review ran on (for debugging / future per-model breakdowns). */
  model?: string;
}

/**
 * Type for updating a review's status — partial update to an existing item.
 */
export type UpdateReviewInput = ReviewKey & {
  status: ReviewStatus;
  commentId?: number;
  completedAt?: string;
};

