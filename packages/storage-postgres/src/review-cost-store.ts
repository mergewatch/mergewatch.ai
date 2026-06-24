/**
 * Postgres implementation of `IReviewCostStore` (#193).
 *
 * One row per (installation, repo, PR, commit). `recordCost` upserts so a
 * retried review of the same commit overwrites idempotently rather than
 * double-counting. `cost_usd` is stored as text (mirrors `dispute_rate`) to
 * avoid float drift; null marks an unpriced (unknown-model) review.
 *
 * Best-effort writes: `recordCost` swallows-and-logs so a cost write can never
 * block the review pipeline.
 */

import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { IReviewCostStore, ReviewCostRecord } from '@mergewatch/core';
import { reviewCosts } from './schema.js';

export class PostgresReviewCostStore implements IReviewCostStore {
  constructor(private db: PostgresJsDatabase) {}

  async recordCost(record: ReviewCostRecord): Promise<void> {
    try {
      const costUsd = record.costUsd == null ? null : String(record.costUsd);
      await this.db
        .insert(reviewCosts)
        .values({
          installationId: record.installationId,
          repoFullName: record.repoFullName,
          prNumber: record.prNumber,
          commitSha: record.commitSha,
          completedAt: record.completedAt,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          costUsd,
          findingCount: record.findingCount,
          model: record.model ?? null,
        })
        .onConflictDoUpdate({
          target: [reviewCosts.installationId, reviewCosts.repoFullName, reviewCosts.prNumber, reviewCosts.commitSha],
          set: {
            completedAt: record.completedAt,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            costUsd,
            findingCount: record.findingCount,
            model: record.model ?? null,
          },
        });
    } catch (err) {
      // Best-effort: don't interpolate installation / repo / PR identifiers —
      // cost-tracking patterns are business-sensitive in centralized logs. The
      // error carries enough (stack) to diagnose a write failure.
      console.warn('[fb-cost] recordCost failed for a review:', err);
    }
  }

  async listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: ReviewCostRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const rows = await this.db
      .select()
      .from(reviewCosts)
      .where(eq(reviewCosts.installationId, installationId))
      .limit(limit);
    const items: ReviewCostRecord[] = rows.map((r) => {
      const rec: ReviewCostRecord = {
        installationId: r.installationId,
        repoFullName: r.repoFullName,
        prNumber: r.prNumber,
        commitSha: r.commitSha,
        completedAt: r.completedAt,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
        findingCount: r.findingCount,
      };
      if (r.model) rec.model = r.model;
      return rec;
    });
    return { items };
  }
}
