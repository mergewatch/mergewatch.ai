import { pgTable, text, integer, jsonb, boolean, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

export const installations = pgTable('installations', {
  installationId: text('installation_id').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  installedAt: text('installed_at').notNull(),
  config: jsonb('config').notNull().default({}),
  modelId: text('model_id'),
  monitored: boolean('monitored').notNull().default(true),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.repoFullName] }),
}));

export const installationSettings = pgTable('installation_settings', {
  installationId: text('installation_id').primaryKey(),
  severityThreshold: text('severity_threshold').notNull().default('Low'),
  commentTypes: jsonb('comment_types').notNull().default({ syntax: true, logic: true, style: true }),
  maxComments: integer('max_comments').notNull().default(25),
  summary: jsonb('summary').notNull().default({ prSummary: true, confidenceScore: true, issuesTable: true, diagram: true }),
  customInstructions: text('custom_instructions').notNull().default(''),
  commentHeader: text('comment_header').notNull().default(''),
  // #235 — org custom agents (dashboard-defined, enforced in reviews).
  customAgents: jsonb('custom_agents').notNull().default([]),
});

export const reviews = pgTable('reviews', {
  repoFullName: text('repo_full_name').notNull(),
  prNumberCommitSha: text('pr_number_commit_sha').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  prTitle: text('pr_title'),
  prAuthor: text('pr_author'),
  prAuthorAvatar: text('pr_author_avatar'),
  source: text('source'),
  agentKind: text('agent_kind'),
  headBranch: text('head_branch'),
  baseBranch: text('base_branch'),
  commentId: integer('comment_id'),
  model: text('model'),
  durationMs: integer('duration_ms'),
  findingCount: integer('finding_count'),
  topSeverity: text('top_severity'),
  summaryText: text('summary_text'),
  diagramText: text('diagram_text'),
  skipReason: text('skip_reason'),
  mergeScore: integer('merge_score'),
  mergeScoreReason: text('merge_score_reason'),
  findings: jsonb('findings').default([]),
  feedback: text('feedback'),
  reactions: jsonb('reactions').default({}),
  installationId: text('installation_id'),
  settingsUsed: jsonb('settings_used'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  estimatedCostUsd: text('estimated_cost_usd'),
  // FP-F — keys for findings the author resolved on inline comment threads.
  // Union'd with the live W3 disputedKeys on subsequent reviews.
  inlineResolvedKeys: jsonb('inline_resolved_keys').default([]),
  // FB-C — last-observed reaction counts per inline bot comment, keyed by
  // commentId. Drives the reaction-delta → dispute/agreement increments
  // on subsequent reviews.
  inlineReactionsSnapshot: jsonb('inline_reactions_snapshot').default({}),
}, (t) => ({
  pk: primaryKey({ columns: [t.repoFullName, t.prNumberCommitSha] }),
  installationIdx: index('reviews_installation_idx').on(t.installationId),
  prIdx: index('reviews_pr_idx').on(t.repoFullName),
}));

export const apiKeys = pgTable('api_keys', {
  keyHash: text('key_hash').primaryKey(),
  installationId: text('installation_id').notNull(),
  label: text('label').notNull(),
  scope: jsonb('scope').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => ({
  installationIdx: index('api_keys_installation_idx').on(t.installationId),
}));

export const mcpSessions = pgTable('mcp_sessions', {
  sessionId: text('session_id').primaryKey(),
  installationId: text('installation_id').notNull(),
  firstBilledAt: timestamp('first_billed_at', { withTimezone: true }).notNull(),
  maxBilledCents: integer('max_billed_cents').notNull(),
  iteration: integer('iteration').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// FB-E — per-installation rolling-window FP insight rollups. Computed
// nightly by the scheduled job; read by dashboard charts. See
// InstallationFPInsight in @mergewatch/core for the typed shape.
export const installationFpInsights = pgTable('installation_fp_insights', {
  installationId: text('installation_id').notNull(),
  // '7d' | '30d' | '90d' — typed at the application layer.
  window: text('window').notNull(),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  generatedAt: text('generated_at').notNull(),
  totalFindingsSurfaced: integer('total_findings_surfaced').notNull().default(0),
  totalDisputes: integer('total_disputes').notNull().default(0),
  // Stored as text to avoid float-precision drift across pg float8 ↔ js number.
  disputeRate: text('dispute_rate').notNull().default('0'),
  totalSilentDrops: integer('total_silent_drops').notNull().default(0),
  totalAgreements: integer('total_agreements').notNull().default(0),
  perCategory: jsonb('per_category').notNull().default({}),
  // FB-I — severity-shopping detector bucket (critical / warning / info /
  // uncategorized). Populated by the nightly rollup once finding_dispositions
  // rows carry the severity column. Defaults to `{}` so pre-FB-I rollups
  // remain valid.
  perSeverity: jsonb('per_severity').notNull().default({}),
  perRepo: jsonb('per_repo').notNull().default({}),
  topClusters: jsonb('top_clusters').notNull().default([]),
  // TTM (#194) — cycle-time block (merge counts + time-to-merge percentiles).
  // Nullable: pre-Stage-2 rows and rollups run without a PR-lifecycle store
  // simply leave it NULL, which maps back to `undefined` on the typed shape.
  cycleTime: jsonb('cycle_time'),
  // #195 — developer-engagement block (acceptance / command-usage / re-review
  // KPIs). Nullable: pre-engagement rollups leave it NULL → `undefined`.
  engagement: jsonb('engagement'),
  // #193 — LLM-cost block (spend / cost-per-review / cost-per-finding).
  // Nullable: pre-cost rollups (or rollups run without a cost store) leave it
  // NULL → `undefined`.
  cost: jsonb('cost'),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.window] }),
}));

// FB-A — per-finding cross-PR identity records (one row per distinct
// findingMatchKey per repo per installation). See FindingDispositionRecord
// in @mergewatch/core for the typed shape and lifecycle semantics.
export const findingDispositions = pgTable('finding_dispositions', {
  installationId: text('installation_id').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  findingMatchKey: text('finding_match_key').notNull(),
  firstSeen: text('first_seen').notNull(),
  lastSeen: text('last_seen').notNull(),
  surfaceCount: integer('surface_count').notNull().default(0),
  disputeCount: integer('dispute_count').notNull().default(0),
  verifiedCount: integer('verified_count').notNull().default(0),
  unverifiedCount: integer('unverified_count').notNull().default(0),
  silentDropCount: integer('silent_drop_count').notNull().default(0),
  agreementCount: integer('agreement_count').notNull().default(0),
  // #195 — `/resolve` command invocations (engagement signal). Default 0 so
  // rows written before this counter existed need no backfill.
  resolveCount: integer('resolve_count').notNull().default(0),
  category: text('category'),
  topAgent: text('top_agent'),
  // FB-I — severity for the severity-shopping detector rollup. Optional
  // (nullable) so rows written before FB-I shipped don't need a backfill;
  // they flow into the `uncategorized` bucket in the per-severity rollup.
  severity: text('severity'),
  sigTokens: jsonb('sig_tokens'),
  rejectReasons: jsonb('reject_reasons'),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.repoFullName, t.findingMatchKey] }),
  installationIdx: index('finding_dispositions_installation_idx').on(t.installationId),
}));

// TTM (#194) — one row per pull request MergeWatch saw, independent of the
// per-commit `reviews` table. Drives the nightly cycle-time rollup. See
// PRLifecycleRecord in @mergewatch/core for the typed shape and lifecycle
// semantics. installation_id is indexed for the rollup's per-install scan.
export const prLifecycle = pgTable('pr_lifecycle', {
  installationId: text('installation_id').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  prNumber: integer('pr_number').notNull(),
  prCreatedAt: text('pr_created_at').notNull(),
  firstReviewAt: text('first_review_at'),
  mergedAt: text('merged_at'),
  closedAt: text('closed_at'),
  state: text('state').notNull().default('open'),
  reviewed: boolean('reviewed').notNull().default(false),
  skipped: boolean('skipped').notNull().default(false),
  totalPushes: integer('total_pushes').notNull().default(0),
  pushesAfterFirstReview: integer('pushes_after_first_review').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.repoFullName, t.prNumber] }),
  installationIdx: index('pr_lifecycle_installation_idx').on(t.installationId),
}));

// #195 Phase 4 — one row per summary comment tracking 👍/👎 helpful votes on
// the "Was this review helpful?" prompt. See HelpfulVoteRecord in
// @mergewatch/core. installation_id is indexed for the rollup's per-install scan.
export const helpfulVotes = pgTable('helpful_votes', {
  installationId: text('installation_id').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  prNumber: integer('pr_number').notNull(),
  up: integer('up').notNull().default(0),
  down: integer('down').notNull().default(0),
  lastVoteAt: text('last_vote_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.repoFullName, t.prNumber] }),
  installationIdx: index('helpful_votes_installation_idx').on(t.installationId),
}));

// #195 Phase 5 — one row per (installation, GitHub user) carrying that admin's
// most recent NPS survey response. See NpsResponseRecord in @mergewatch/core.
export const npsResponses = pgTable('nps_responses', {
  installationId: text('installation_id').notNull(),
  githubUserId: text('github_user_id').notNull(),
  score: integer('score').notNull(),
  respondedAt: text('responded_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.githubUserId] }),
  installationIdx: index('nps_responses_installation_idx').on(t.installationId),
}));

// #193 — one row per completed review denormalizing its cost/token figures so
// the nightly rollup can aggregate spend per installation. See ReviewCostRecord
// in @mergewatch/core. `cost_usd` is nullable — null marks an unpriced
// (unknown-model) review, excluded from money totals.
export const reviewCosts = pgTable('review_costs', {
  installationId: text('installation_id').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  prNumber: integer('pr_number').notNull(),
  commitSha: text('commit_sha').notNull(),
  completedAt: text('completed_at').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  // Stored as text to avoid float precision drift (mirrors dispute_rate); null = unpriced.
  costUsd: text('cost_usd'),
  findingCount: integer('finding_count').notNull().default(0),
  model: text('model'),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.repoFullName, t.prNumber, t.commitSha] }),
  installationIdx: index('review_costs_installation_idx').on(t.installationId),
}));
