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
  category: text('category'),
  topAgent: text('top_agent'),
  sigTokens: jsonb('sig_tokens'),
  rejectReasons: jsonb('reject_reasons'),
}, (t) => ({
  pk: primaryKey({ columns: [t.installationId, t.repoFullName, t.findingMatchKey] }),
  installationIdx: index('finding_dispositions_installation_idx').on(t.installationId),
}));
