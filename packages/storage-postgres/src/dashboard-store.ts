/**
 * Postgres/Drizzle implementation of IDashboardStore.
 *
 * Uses efficient SQL queries (JOINs, GROUP BY, COUNT) instead of
 * the per-repo parallel queries needed for DynamoDB.
 */

import { eq, and, inArray, desc, sql, count, gte, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  IDashboardStore,
  IDashboardInstallationStore,
  IDashboardReviewStore,
  PaginatedResult,
  ReviewStats,
  RepoStats,
  InstallationItem,
  InstallationSettings,
  ReviewItem,
  ReviewStatus,
} from '@mergewatch/core';
import { DEFAULT_INSTALLATION_SETTINGS as DEFAULTS } from '@mergewatch/core';
import { installations, installationSettings, reviews } from './schema.js';

// ─── Helper: map a Drizzle row to ReviewItem ────────────────────────────────

function rowToReviewItem(row: typeof reviews.$inferSelect): ReviewItem {
  return {
    repoFullName: row.repoFullName,
    prNumberCommitSha: row.prNumberCommitSha,
    status: row.status as ReviewStatus,
    createdAt: row.createdAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.prTitle ? { prTitle: row.prTitle } : {}),
    ...(row.prAuthor ? { prAuthor: row.prAuthor } : {}),
    ...(row.prAuthorAvatar ? { prAuthorAvatar: row.prAuthorAvatar } : {}),
    ...(row.headBranch ? { headBranch: row.headBranch } : {}),
    ...(row.baseBranch ? { baseBranch: row.baseBranch } : {}),
    ...(row.commentId ? { commentId: row.commentId } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.durationMs ? { durationMs: row.durationMs } : {}),
    ...(row.findingCount != null ? { findingCount: row.findingCount } : {}),
    ...(row.topSeverity ? { topSeverity: row.topSeverity as any } : {}),
    ...(row.summaryText ? { summaryText: row.summaryText } : {}),
    ...(row.diagramText ? { diagramText: row.diagramText } : {}),
    ...(row.skipReason ? { skipReason: row.skipReason } : {}),
    ...(row.mergeScore != null ? { mergeScore: row.mergeScore } : {}),
    ...(row.mergeScoreReason ? { mergeScoreReason: row.mergeScoreReason } : {}),
    ...(row.findings ? { findings: row.findings as any } : {}),
    ...(row.feedback ? { feedback: row.feedback as any } : {}),
    ...(row.reactions ? { reactions: row.reactions as any } : {}),
    ...(row.installationId ? { installationId: row.installationId } : {}),
    ...(row.settingsUsed ? { settingsUsed: row.settingsUsed as any } : {}),
  };
}

// ─── Installation store ─────────────────────────────────────────────────────

class PostgresDashboardInstallationStore implements IDashboardInstallationStore {
  constructor(private db: PostgresJsDatabase) {}

  async listByInstallation(installationId: string): Promise<InstallationItem[]> {
    const rows = await this.db
      .select()
      .from(installations)
      .where(eq(installations.installationId, installationId));

    return rows.map((row) => ({
      installationId: row.installationId,
      repoFullName: row.repoFullName,
      installedAt: row.installedAt,
      config: row.config as any,
      ...(row.modelId ? { modelId: row.modelId } : {}),
      monitored: row.monitored,
    }));
  }

  async getSettings(installationId: string): Promise<InstallationSettings> {
    const rows = await this.db
      .select()
      .from(installationSettings)
      .where(eq(installationSettings.installationId, installationId))
      .limit(1);

    if (rows.length === 0) return { ...DEFAULTS };
    const row = rows[0];
    return {
      severityThreshold: row.severityThreshold as InstallationSettings['severityThreshold'],
      commentTypes: row.commentTypes as InstallationSettings['commentTypes'],
      maxComments: row.maxComments,
      summary: row.summary as InstallationSettings['summary'],
      customInstructions: row.customInstructions,
      commentHeader: row.commentHeader,
    };
  }

  async updateSettings(installationId: string, settings: InstallationSettings): Promise<void> {
    await this.db
      .insert(installationSettings)
      .values({
        installationId,
        severityThreshold: settings.severityThreshold,
        commentTypes: settings.commentTypes as any,
        maxComments: settings.maxComments,
        summary: settings.summary as any,
        customInstructions: settings.customInstructions,
        commentHeader: settings.commentHeader,
      })
      .onConflictDoUpdate({
        target: installationSettings.installationId,
        set: {
          severityThreshold: settings.severityThreshold,
          commentTypes: settings.commentTypes as any,
          maxComments: settings.maxComments,
          summary: settings.summary as any,
          customInstructions: settings.customInstructions,
          commentHeader: settings.commentHeader,
        },
      });
  }

}

// ─── Review store ───────────────────────────────────────────────────────────

class PostgresDashboardReviewStore implements IDashboardReviewStore {
  constructor(private db: PostgresJsDatabase) {}

  async listReviews(
    repos: string[],
    limit: number,
    cursor?: string,
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PaginatedResult<ReviewItem>> {
    if (repos.length === 0) return { items: [], nextCursor: null };

    // Cursor is a base64-encoded offset number
    let offset = 0;
    if (cursor) {
      try {
        offset = Number(Buffer.from(cursor, 'base64url').toString());
        if (isNaN(offset) || offset < 0) offset = 0;
      } catch {
        offset = 0;
      }
    }

    const conditions = [inArray(reviews.repoFullName, repos)];
    if (status) {
      const dbStatus = status === 'completed' ? 'complete' : status;
      conditions.push(eq(reviews.status, dbStatus));
    }
    if (startDate) {
      conditions.push(gte(reviews.createdAt, startDate));
    }
    if (endDate) {
      conditions.push(lte(reviews.createdAt, endDate));
    }

    const rows = await this.db
      .select()
      .from(reviews)
      .where(and(...conditions))
      .orderBy(desc(reviews.createdAt))
      .limit(limit + 1) // fetch one extra to detect hasMore
      .offset(offset);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToReviewItem);

    const nextCursor = hasMore
      ? Buffer.from(String(offset + limit)).toString('base64url')
      : null;

    return { items, nextCursor };
  }

  async getReview(repoFullName: string, prNumberCommitSha: string): Promise<ReviewItem | null> {
    const rows = await this.db
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.repoFullName, repoFullName),
          eq(reviews.prNumberCommitSha, prNumberCommitSha),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;
    return rowToReviewItem(rows[0]);
  }

  async updateFeedback(
    repoFullName: string,
    prNumberCommitSha: string,
    feedback: 'up' | 'down' | null,
  ): Promise<void> {
    await this.db
      .update(reviews)
      .set({ feedback })
      .where(
        and(
          eq(reviews.repoFullName, repoFullName),
          eq(reviews.prNumberCommitSha, prNumberCommitSha),
        ),
      );
  }

  async getReviewStats(repos: string[]): Promise<ReviewStats> {
    if (repos.length === 0) return { total: 0, completed: 0, findings: 0 };

    const result = await this.db
      .select({
        total: count(),
        completed: count(sql`CASE WHEN ${reviews.status} = 'complete' THEN 1 END`),
        findings: sql<number>`COALESCE(SUM(${reviews.findingCount}), 0)`,
      })
      .from(reviews)
      .where(inArray(reviews.repoFullName, repos));

    const row = result[0];
    return {
      total: Number(row?.total ?? 0),
      completed: Number(row?.completed ?? 0),
      findings: Number(row?.findings ?? 0),
    };
  }

  async getRepoStats(repos: string[]): Promise<Map<string, RepoStats>> {
    const statsMap = new Map<string, RepoStats>();
    if (repos.length === 0) return statsMap;

    const result = await this.db
      .select({
        repoFullName: reviews.repoFullName,
        reviewCount: count(),
        issueCount: sql<number>`COALESCE(SUM(${reviews.findingCount}), 0)`,
        lastReviewedAt: sql<string | null>`MAX(COALESCE(${reviews.completedAt}, ${reviews.createdAt}))`,
      })
      .from(reviews)
      .where(
        and(
          inArray(reviews.repoFullName, repos),
          eq(reviews.status, 'complete'),
        ),
      )
      .groupBy(reviews.repoFullName);

    for (const row of result) {
      statsMap.set(row.repoFullName, {
        reviewCount: Number(row.reviewCount),
        issueCount: Number(row.issueCount),
        lastReviewedAt: row.lastReviewedAt ?? null,
      });
    }

    return statsMap;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPostgresDashboardStore(databaseUrl: string): IDashboardStore {
  const client = postgres(databaseUrl);
  const db = drizzle(client);

  // FB-F..FB-J — same store instance fulfils both IFPInsightStore (pipeline
  // writes) and IDashboardFPInsightStore (dashboard reads). The dashboard
  // never exercises upsert here.
  // Lazy import to keep the module DAG simple — `./fp-insight-store` itself
  // imports schema + drizzle which are already loaded above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PostgresFPInsightStore } = require('./fp-insight-store.js');

  return {
    installations: new PostgresDashboardInstallationStore(db),
    reviews: new PostgresDashboardReviewStore(db),
    fpInsights: new PostgresFPInsightStore(db),
  };
}
