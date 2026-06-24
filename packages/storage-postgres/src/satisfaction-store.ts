/**
 * Postgres implementation of `ISatisfactionStore` (#195 Tier 2 / Phase 4 + 5).
 *
 * Two tables:
 *   - helpful_votes — one row per summary comment; 👍/👎 counters updated via
 *     atomic SQL increments (`up + N` in the SET clause) so concurrent polls
 *     stay race-free.
 *   - nps_responses — one row per (installation, GitHub user); latest-wins on
 *     re-submit via onConflictDoUpdate.
 *
 * Best-effort writes: every method swallows-and-logs (the pipeline / dashboard
 * must never block on analytics). Reads surface errors to the caller, which is
 * already wrapped in a try/catch on the route.
 */

import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  ISatisfactionStore,
  HelpfulVoteRecord,
  NpsResponseRecord,
} from '@mergewatch/core';
import { helpfulVotes, npsResponses } from './schema.js';

export class PostgresSatisfactionStore implements ISatisfactionStore {
  constructor(private db: PostgresJsDatabase) {}

  async recordHelpfulVotes(
    installationId: string,
    repoFullName: string,
    prNumber: number,
    delta: { up?: number; down?: number },
    atIso: string,
  ): Promise<void> {
    const up = delta.up ?? 0;
    const down = delta.down ?? 0;
    if (up === 0 && down === 0) return;
    try {
      await this.db
        .insert(helpfulVotes)
        .values({ installationId, repoFullName, prNumber, up, down, lastVoteAt: atIso })
        .onConflictDoUpdate({
          target: [helpfulVotes.installationId, helpfulVotes.repoFullName, helpfulVotes.prNumber],
          set: {
            up: sql`${helpfulVotes.up} + ${up}`,
            down: sql`${helpfulVotes.down} + ${down}`,
            lastVoteAt: atIso,
          },
        });
    } catch (err) {
      console.warn('[fb-k] recordHelpfulVotes failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async listHelpfulVotes(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: HelpfulVoteRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const rows = await this.db
      .select()
      .from(helpfulVotes)
      .where(eq(helpfulVotes.installationId, installationId))
      .limit(limit);
    const items: HelpfulVoteRecord[] = rows.map((r) => ({
      installationId: r.installationId,
      repoFullName: r.repoFullName,
      prNumber: r.prNumber,
      up: r.up,
      down: r.down,
      lastVoteAt: r.lastVoteAt,
    }));
    return { items };
  }

  async getNpsResponse(installationId: string, githubUserId: string): Promise<NpsResponseRecord | null> {
    const rows = await this.db
      .select()
      .from(npsResponses)
      .where(and(
        eq(npsResponses.installationId, installationId),
        eq(npsResponses.githubUserId, githubUserId),
      ))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      installationId: r.installationId,
      githubUserId: r.githubUserId,
      score: r.score,
      respondedAt: r.respondedAt,
    };
  }

  async recordNpsResponse(rec: NpsResponseRecord): Promise<void> {
    try {
      await this.db
        .insert(npsResponses)
        .values({
          installationId: rec.installationId,
          githubUserId: rec.githubUserId,
          score: rec.score,
          respondedAt: rec.respondedAt,
        })
        .onConflictDoUpdate({
          target: [npsResponses.installationId, npsResponses.githubUserId],
          set: { score: rec.score, respondedAt: rec.respondedAt },
        });
    } catch (err) {
      console.warn('[fb-l] recordNpsResponse failed (%s/%s):', rec.installationId, rec.githubUserId, err);
    }
  }

  async listNpsResponses(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: NpsResponseRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const rows = await this.db
      .select()
      .from(npsResponses)
      .where(eq(npsResponses.installationId, installationId))
      .limit(limit);
    const items: NpsResponseRecord[] = rows.map((r) => ({
      installationId: r.installationId,
      githubUserId: r.githubUserId,
      score: r.score,
      respondedAt: r.respondedAt,
    }));
    return { items };
  }
}
