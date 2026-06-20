/**
 * Postgres implementation of `IPRLifecycleStore` (TTM / #194).
 *
 * One row per (installation, repo, pr_number). Lifecycle transitions are
 * expressed as `INSERT … ON CONFLICT DO UPDATE` so each entry point is
 * race-free and idempotent. Terminal-state discipline (a merged row never
 * downgrades to closed; an open touch never resurrects a terminal row) is
 * enforced with `WHERE` guards on the conflict-update.
 *
 * `pr_created_at` is NOT NULL; rows created by a non-`opened` entry point
 * (e.g. a push or review that arrived before we recorded the open) seed it
 * with '' — the same "unknown" sentinel the DynamoDB store yields — and a
 * later upsertOpened / markMerged repairs it. The cycle-time rollup excludes
 * '' rows from time-to-merge stats.
 *
 * Best-effort: every method swallows-and-logs so a lifecycle write can never
 * block the review pipeline.
 */

import { eq, sql, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  IPRLifecycleStore,
  PRLifecycleOpenInput,
  PRLifecycleCloseInput,
  PRLifecycleRecord,
} from '@mergewatch/core';
import { prLifecycle } from './schema.js';

export class PostgresPRLifecycleStore implements IPRLifecycleStore {
  constructor(private db: PostgresJsDatabase) {}

  async upsertOpened(rec: PRLifecycleOpenInput): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.db.execute(sql`
        INSERT INTO pr_lifecycle (installation_id, repo_full_name, pr_number, pr_created_at, state, updated_at)
        VALUES (${rec.installationId}, ${rec.repoFullName}, ${rec.prNumber}, ${rec.prCreatedAt}, 'open', ${now})
        ON CONFLICT (installation_id, repo_full_name, pr_number)
        DO UPDATE SET
          pr_created_at = CASE WHEN pr_lifecycle.pr_created_at = '' THEN ${rec.prCreatedAt} ELSE pr_lifecycle.pr_created_at END,
          updated_at = ${now}
        WHERE pr_lifecycle.state = 'open'
      `);
    } catch (err) {
      console.warn('[ttm] upsertOpened failed (%s/%s#%d):', rec.installationId, rec.repoFullName, rec.prNumber, err);
    }
  }

  async recordPush(installationId: string, repoFullName: string, prNumber: number): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.db.execute(sql`
        INSERT INTO pr_lifecycle (installation_id, repo_full_name, pr_number, pr_created_at, state, updated_at, total_pushes, pushes_after_first_review)
        VALUES (${installationId}, ${repoFullName}, ${prNumber}, '', 'open', ${now}, 1, 0)
        ON CONFLICT (installation_id, repo_full_name, pr_number)
        DO UPDATE SET
          total_pushes = pr_lifecycle.total_pushes + 1,
          pushes_after_first_review = pr_lifecycle.pushes_after_first_review
            + (CASE WHEN pr_lifecycle.first_review_at IS NOT NULL THEN 1 ELSE 0 END),
          updated_at = ${now}
      `);
    } catch (err) {
      console.warn('[ttm] recordPush failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async markReviewed(installationId: string, repoFullName: string, prNumber: number, atIso: string): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO pr_lifecycle (installation_id, repo_full_name, pr_number, pr_created_at, first_review_at, reviewed, state, updated_at)
        VALUES (${installationId}, ${repoFullName}, ${prNumber}, '', ${atIso}, true, 'open', ${atIso})
        ON CONFLICT (installation_id, repo_full_name, pr_number)
        DO UPDATE SET
          first_review_at = COALESCE(pr_lifecycle.first_review_at, ${atIso}),
          reviewed = true,
          updated_at = ${atIso}
      `);
    } catch (err) {
      console.warn('[ttm] markReviewed failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async markSkipped(installationId: string, repoFullName: string, prNumber: number, atIso: string): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO pr_lifecycle (installation_id, repo_full_name, pr_number, pr_created_at, skipped, state, updated_at)
        VALUES (${installationId}, ${repoFullName}, ${prNumber}, '', true, 'open', ${atIso})
        ON CONFLICT (installation_id, repo_full_name, pr_number)
        DO UPDATE SET skipped = true, updated_at = ${atIso}
      `);
    } catch (err) {
      console.warn('[ttm] markSkipped failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async markMerged(rec: PRLifecycleCloseInput): Promise<void> {
    try {
      // Merge is authoritative — overwrite state + pr_created_at unconditionally.
      await this.db.execute(sql`
        INSERT INTO pr_lifecycle (installation_id, repo_full_name, pr_number, pr_created_at, merged_at, state, updated_at)
        VALUES (${rec.installationId}, ${rec.repoFullName}, ${rec.prNumber}, ${rec.prCreatedAt}, ${rec.at}, 'merged', ${rec.at})
        ON CONFLICT (installation_id, repo_full_name, pr_number)
        DO UPDATE SET
          state = 'merged',
          merged_at = ${rec.at},
          pr_created_at = ${rec.prCreatedAt},
          updated_at = ${rec.at}
      `);
    } catch (err) {
      console.warn('[ttm] markMerged failed (%s/%s#%d):', rec.installationId, rec.repoFullName, rec.prNumber, err);
    }
  }

  async markClosedUnmerged(rec: PRLifecycleCloseInput): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO pr_lifecycle (installation_id, repo_full_name, pr_number, pr_created_at, closed_at, state, updated_at)
        VALUES (${rec.installationId}, ${rec.repoFullName}, ${rec.prNumber}, ${rec.prCreatedAt}, ${rec.at}, 'closed_unmerged', ${rec.at})
        ON CONFLICT (installation_id, repo_full_name, pr_number)
        DO UPDATE SET
          state = 'closed_unmerged',
          closed_at = ${rec.at},
          pr_created_at = CASE WHEN pr_lifecycle.pr_created_at = '' THEN ${rec.prCreatedAt} ELSE pr_lifecycle.pr_created_at END,
          updated_at = ${rec.at}
        WHERE pr_lifecycle.state <> 'merged'
      `);
    } catch (err) {
      console.warn('[ttm] markClosedUnmerged failed (%s/%s#%d):', rec.installationId, rec.repoFullName, rec.prNumber, err);
    }
  }

  async listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: PRLifecycleRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const rows = await this.db
      .select()
      .from(prLifecycle)
      .where(eq(prLifecycle.installationId, installationId))
      .orderBy(desc(prLifecycle.updatedAt))
      .limit(limit);
    const items: PRLifecycleRecord[] = rows.map((r) => ({
      installationId: r.installationId,
      repoFullName: r.repoFullName,
      prNumber: r.prNumber,
      prCreatedAt: r.prCreatedAt,
      state: r.state as PRLifecycleRecord['state'],
      reviewed: r.reviewed,
      skipped: r.skipped,
      totalPushes: r.totalPushes,
      pushesAfterFirstReview: r.pushesAfterFirstReview,
      updatedAt: r.updatedAt,
      ...(r.firstReviewAt ? { firstReviewAt: r.firstReviewAt } : {}),
      ...(r.mergedAt ? { mergedAt: r.mergedAt } : {}),
      ...(r.closedAt ? { closedAt: r.closedAt } : {}),
    }));
    // Single-page for now — the rollup can extend to cursor paging if any
    // installation exceeds the 1000-row cap.
    return { items };
  }
}
