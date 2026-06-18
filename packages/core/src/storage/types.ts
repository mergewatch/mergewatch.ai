/**
 * Provider-agnostic storage interfaces.
 *
 * Implementations:
 *   - DynamoInstallationStore / DynamoReviewStore (packages/storage-dynamo)
 *   - Future: PostgresInstallationStore / PostgresReviewStore
 */

import type {
  InstallationItem, InstallationSettings,
  ReviewItem, ReviewStatus,
  FindingDispositionRecord,
  InstallationFPInsight,
  PRLifecycleRecord,
} from '../types/db.js';

export interface IInstallationStore {
  get(installationId: string, repoFullName: string): Promise<InstallationItem | null>;
  getSettings(installationId: string): Promise<InstallationSettings>;
  upsert(item: InstallationItem): Promise<void>;
  /**
   * FB-E — enumerate every distinct installation ID known to the store.
   * Used by the nightly insight rollup to fan out across all
   * installations. Returns an empty array when the underlying store is
   * empty. No pagination — installation counts are bounded (low
   * hundreds even at scale).
   */
  listInstallationIds(): Promise<string[]>;
}

export interface IReviewStore {
  upsert(review: ReviewItem): Promise<void>;
  /**
   * Atomically claim a review for processing.
   * Inserts the review record only if no record with the same key exists
   * or the existing record is not already in_progress/complete.
   * Returns true if this caller claimed the review, false if another worker already has it.
   */
  claimReview(review: ReviewItem): Promise<boolean>;
  updateStatus(
    repoFullName: string,
    key: string,
    status: ReviewStatus,
    extra?: Partial<ReviewItem>,
  ): Promise<void>;
  queryByPR(repoFullName: string, prPrefix: string, limit?: number): Promise<ReviewItem[]>;
}

export interface ApiKeyRecord {
  /** sha256 hex of the raw key. Raw key is never stored. */
  keyHash: string;
  /** GitHub App installation this key unlocks. */
  installationId: string;
  /** Human-friendly label for the dashboard. */
  label: string;
  /** Either 'all' (all repos in the installation) or a specific list of owner/repo strings. */
  scope: 'all' | string[];
  /** GitHub user ID of the dashboard user who created the key. */
  createdBy: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, set on each MCP request. Optional on create. */
  lastUsedAt?: string;
}

export interface IApiKeyStore {
  create(record: Omit<ApiKeyRecord, 'lastUsedAt'>): Promise<void>;
  getByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  listByInstallation(installationId: string): Promise<ApiKeyRecord[]>;
  delete(keyHash: string): Promise<void>;
  touchLastUsed(keyHash: string, isoTimestamp: string): Promise<void>;
}

export interface McpSessionRecord {
  sessionId: string;
  installationId: string;
  /** ISO 8601 — used to derive ttl. */
  firstBilledAt: string;
  /** Highest cost billed so far in this session, in cents. */
  maxBilledCents: number;
  /** How many review_diff calls have been made in this session. */
  iteration: number;
  /** Unix epoch seconds for DynamoDB TTL. Postgres uses firstBilledAt + 30 min. */
  ttl: number;
}

export interface IMcpSessionStore {
  get(sessionId: string): Promise<McpSessionRecord | null>;
  upsert(record: McpSessionRecord): Promise<void>;
}

// ─── FB-A — Finding disposition store ──────────────────────────────────────

/**
 * Sentinel — the field passed to `upsertSurface` when attribution data
 * (category / topAgent / sigTokens) is unknown. Existing values are kept
 * when a fresher write doesn't carry them.
 */
export interface FindingDispositionAttribution {
  category?: FindingDispositionRecord['category'];
  topAgent?: string;
  sigTokens?: string[];
  /** FB-I — severity for the severity-shopping detector rollup. */
  severity?: FindingDispositionRecord['severity'];
}

export interface IFindingDispositionStore {
  /**
   * Increment surfaceCount + refresh lastSeen on the record for this key.
   * Creates the record (with firstSeen = lastSeen = now, surfaceCount = 1)
   * if it doesn't exist yet. Attribution fields are written-through on every
   * upsert (last writer wins; they're stable enough that this is fine).
   *
   * Idempotency: each `upsertSurface` is treated as exactly one "this finding
   * surfaced once". Callers must dedupe across multiple match-keys of the same
   * finding (typical pattern: write one upsertSurface per key returned by
   * `findingMatchKeys(f)`).
   */
  upsertSurface(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    nowIso: string,
    attribution?: FindingDispositionAttribution,
  ): Promise<void>;

  /** Increment disputeCount by 1. No-op if no record exists yet (we don't backfill — a dispute without prior surfacing is a write-ordering bug we'd want to see logged separately). */
  incrementDispute(installationId: string, repoFullName: string, findingMatchKey: string): Promise<void>;

  /** Increment verifiedCount by 1. */
  incrementVerified(installationId: string, repoFullName: string, findingMatchKey: string): Promise<void>;

  /** Increment unverifiedCount by 1. */
  incrementUnverified(installationId: string, repoFullName: string, findingMatchKey: string): Promise<void>;

  /** FB-B — increment silentDropCount by 1. */
  incrementSilentDrop(installationId: string, repoFullName: string, findingMatchKey: string): Promise<void>;

  /** FB-C — increment agreementCount by 1. */
  incrementAgreement(installationId: string, repoFullName: string, findingMatchKey: string): Promise<void>;

  /** FB-D — append a rejectReason entry. Idempotent at the record level; appends always extend. */
  appendRejectReason(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    reason: NonNullable<FindingDispositionRecord['rejectReasons']>[number],
  ): Promise<void>;

  /**
   * Page through all records for an installation. Used by the FB-E nightly
   * rollup. Optional limit + cursor-style pagination — implementations may
   * cap per-call to ~1000 records.
   */
  listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: FindingDispositionRecord[]; nextCursor?: string }>;
}

// ─── FB-E — InstallationFPInsight rollup store ─────────────────────────────

/**
 * Persists the per-installation rolling-window FP insight rollups computed
 * by the nightly job. Reads back to power the dashboard charts (FB-F..FB-J).
 *
 * Idempotent writes — `upsert` replaces the existing row for a given
 * (installationId, window) tuple.
 */
export interface IFPInsightStore {
  upsert(insight: InstallationFPInsight): Promise<void>;
  get(installationId: string, window: InstallationFPInsight['window']): Promise<InstallationFPInsight | null>;
  /**
   * Read the full set of rolling-window rows for one installation —
   * dashboard charts typically render all three windows side-by-side.
   * Returns the rows in `window` order ('7d', '30d', '90d').
   */
  listByInstallation(installationId: string): Promise<InstallationFPInsight[]>;
}

// ─── TTM — PR-lifecycle store (#194) ───────────────────────────────────────

/** Identity + creation data for the open-state upsert. */
export interface PRLifecycleOpenInput {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  /** ISO 8601 — PR `created_at` from GitHub. */
  prCreatedAt: string;
}

/** Identity + timestamps for a terminal (merged / closed) transition. */
export interface PRLifecycleCloseInput {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  /** ISO 8601 — PR `created_at` (authoritative from the closed payload). */
  prCreatedAt: string;
  /** ISO 8601 — `merged_at` (markMerged) or `closed_at` (markClosedUnmerged). */
  at: string;
}

/**
 * Persists one `PRLifecycleRecord` per pull request. All writes are
 * best-effort (swallow-and-log) so a lifecycle write can never block the
 * review pipeline — mirrors `IFindingDispositionStore`.
 *
 * Terminal-state discipline: once a row reaches `merged` / `closed_unmerged`,
 * `upsertOpened` / `recordPush` must not resurrect it to `open`.
 */
export interface IPRLifecycleStore {
  /**
   * Create the row on first sight (state='open', prCreatedAt set, counters 0).
   * On an existing OPEN row, only refresh `updatedAt`. No-op on a terminal row.
   */
  upsertOpened(rec: PRLifecycleOpenInput): Promise<void>;

  /**
   * Increment `totalPushes`; when `firstReviewAt` is already set, also bump
   * `pushesAfterFirstReview`. Creates the row (open) if missing.
   */
  recordPush(installationId: string, repoFullName: string, prNumber: number): Promise<void>;

  /**
   * Set `firstReviewAt` (only if currently unset) and `reviewed=true`.
   * Creates the row if missing. Idempotent — later reviews don't move the
   * first-review anchor.
   */
  markReviewed(installationId: string, repoFullName: string, prNumber: number, atIso: string): Promise<void>;

  /** Set `skipped=true` (leaves `reviewed` untouched). Creates the row if missing. */
  markSkipped(installationId: string, repoFullName: string, prNumber: number, atIso: string): Promise<void>;

  /** Terminal: PR merged. Sets `mergedAt`, `state='merged'`, authoritative `prCreatedAt`. */
  markMerged(rec: PRLifecycleCloseInput): Promise<void>;

  /** Terminal: PR closed without merge. Sets `closedAt`, `state='closed_unmerged'`. */
  markClosedUnmerged(rec: PRLifecycleCloseInput): Promise<void>;

  /**
   * Page through all lifecycle rows for an installation. Used by the nightly
   * cycle-time rollup. Optional limit + cursor pagination (cap ~1000/page).
   */
  listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: PRLifecycleRecord[]; nextCursor?: string }>;
}
