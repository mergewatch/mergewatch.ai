import { eq, and, like, desc, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { IReviewStore, ReviewItem, ReviewStatus } from '@mergewatch/core';
import { reviews } from './schema.js';

export class PostgresReviewStore implements IReviewStore {
  constructor(private db: PostgresJsDatabase) {}

  async upsert(review: ReviewItem): Promise<void> {
    await this.db
      .insert(reviews)
      .values({
        repoFullName: review.repoFullName,
        prNumberCommitSha: review.prNumberCommitSha,
        status: review.status,
        createdAt: review.createdAt,
        completedAt: review.completedAt ?? null,
        prTitle: review.prTitle ?? null,
        prAuthor: review.prAuthor ?? null,
        prAuthorAvatar: review.prAuthorAvatar ?? null,
        source: review.source ?? null,
        agentKind: review.agentKind ?? null,
        headBranch: review.headBranch ?? null,
        baseBranch: review.baseBranch ?? null,
        commentId: review.commentId ?? null,
        model: review.model ?? null,
        durationMs: review.durationMs ?? null,
        findingCount: review.findingCount ?? null,
        topSeverity: review.topSeverity ?? null,
        summaryText: review.summaryText ?? null,
        diagramText: review.diagramText ?? null,
        skipReason: review.skipReason ?? null,
        mergeScore: review.mergeScore ?? null,
        mergeScoreReason: review.mergeScoreReason ?? null,
        findings: (review.findings as any) ?? [],
        feedback: review.feedback ?? null,
        reactions: (review.reactions as any) ?? {},
        installationId: review.installationId ?? null,
        settingsUsed: (review.settingsUsed as any) ?? null,
      })
      .onConflictDoUpdate({
        target: [reviews.repoFullName, reviews.prNumberCommitSha],
        set: {
          status: review.status,
          completedAt: review.completedAt ?? null,
          prTitle: review.prTitle ?? null,
          prAuthor: review.prAuthor ?? null,
          prAuthorAvatar: review.prAuthorAvatar ?? null,
          source: review.source ?? null,
          agentKind: review.agentKind ?? null,
          headBranch: review.headBranch ?? null,
          baseBranch: review.baseBranch ?? null,
          commentId: review.commentId ?? null,
          model: review.model ?? null,
          durationMs: review.durationMs ?? null,
          findingCount: review.findingCount ?? null,
          topSeverity: review.topSeverity ?? null,
          summaryText: review.summaryText ?? null,
          diagramText: review.diagramText ?? null,
          skipReason: review.skipReason ?? null,
          mergeScore: review.mergeScore ?? null,
          mergeScoreReason: review.mergeScoreReason ?? null,
          findings: (review.findings as any) ?? [],
          feedback: review.feedback ?? null,
          reactions: (review.reactions as any) ?? {},
          installationId: review.installationId ?? null,
          settingsUsed: (review.settingsUsed as any) ?? null,
        },
      });
  }

  async claimReview(review: ReviewItem): Promise<boolean> {
    // INSERT only if no row exists, or existing row is in a retriable state
    const result = await this.db.execute(sql`
      INSERT INTO reviews (repo_full_name, pr_number_commit_sha, status, created_at,
        pr_title, pr_author, pr_author_avatar, head_branch, base_branch, installation_id)
      VALUES (
        ${review.repoFullName}, ${review.prNumberCommitSha}, 'in_progress', ${review.createdAt},
        ${review.prTitle ?? null}, ${review.prAuthor ?? null}, ${review.prAuthorAvatar ?? null},
        ${review.headBranch ?? null}, ${review.baseBranch ?? null}, ${review.installationId ?? null}
      )
      ON CONFLICT (repo_full_name, pr_number_commit_sha)
      DO UPDATE SET status = 'in_progress', created_at = ${review.createdAt}
      WHERE reviews.status IN ('failed', 'skipped', 'complete')
      RETURNING repo_full_name
    `);
    return (result as any[]).length > 0;
  }

  async updateStatus(
    repoFullName: string,
    prNumberCommitSha: string,
    status: ReviewStatus,
    extra?: Partial<ReviewItem>,
  ): Promise<void> {
    const set: Record<string, any> = { status };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (k !== 'repoFullName' && k !== 'prNumberCommitSha' && v !== undefined) {
          set[k] = v;
        }
      }
    }
    await this.db
      .update(reviews)
      .set(set)
      .where(and(
        eq(reviews.repoFullName, repoFullName),
        eq(reviews.prNumberCommitSha, prNumberCommitSha),
      ));
  }

  async queryByPR(repoFullName: string, prPrefix: string, limit = 5): Promise<ReviewItem[]> {
    const rows = await this.db
      .select()
      .from(reviews)
      .where(and(
        eq(reviews.repoFullName, repoFullName),
        like(reviews.prNumberCommitSha, `${prPrefix}%`),
      ))
      .orderBy(desc(reviews.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      repoFullName: row.repoFullName,
      prNumberCommitSha: row.prNumberCommitSha,
      status: row.status as ReviewStatus,
      createdAt: row.createdAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      ...(row.prTitle ? { prTitle: row.prTitle } : {}),
      ...(row.prAuthor ? { prAuthor: row.prAuthor } : {}),
      ...(row.prAuthorAvatar ? { prAuthorAvatar: row.prAuthorAvatar } : {}),
      ...(row.source ? { source: row.source as any } : {}),
      ...(row.agentKind ? { agentKind: row.agentKind as any } : {}),
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
      ...(Array.isArray(row.inlineResolvedKeys) && row.inlineResolvedKeys.length > 0
        ? { inlineResolvedKeys: row.inlineResolvedKeys as string[] }
        : {}),
    }));
  }
}
