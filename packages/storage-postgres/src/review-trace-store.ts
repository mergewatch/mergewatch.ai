/**
 * Postgres implementation of `IReviewTraceStore` (#471).
 *
 * Mirrors the Dynamo store so a self-hosted deployment can serve the same
 * dashboard feature (#472). Separate table for the same reason as Dynamo: the
 * review key space must not be shared, or a trace row is returned as a review.
 *
 * Latest-wins on conflict — a re-run of the same commit overwrites its trace
 * rather than accumulating rows, matching how `reviews` behaves for the same key.
 */

import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IReviewTraceStore, ReviewTraceItem, FindingOutcome } from '@mergewatch/core';
import { reviewTraces } from './schema.js';

export class PostgresReviewTraceStore implements IReviewTraceStore {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async put(trace: ReviewTraceItem): Promise<void> {
    const row = {
      repoFullName: trace.repoFullName,
      prNumberCommitSha: trace.prNumberCommitSha,
      outcomes: trace.outcomes,
      truncated: trace.truncated ?? false,
      totalOutcomes: trace.totalOutcomes ?? null,
      createdAt: trace.createdAt,
      // The Dynamo TTL is epoch seconds; Postgres has no TTL, so it is stored
      // as a timestamp an operator can prune on.
      expiresAt: trace.ttl != null ? new Date(trace.ttl * 1000) : null,
    };
    await this.db
      .insert(reviewTraces)
      .values(row)
      .onConflictDoUpdate({
        target: [reviewTraces.repoFullName, reviewTraces.prNumberCommitSha],
        set: row,
      });
  }

  async get(
    repoFullName: string,
    prNumberCommitSha: string,
  ): Promise<ReviewTraceItem | null> {
    const rows = await this.db
      .select()
      .from(reviewTraces)
      .where(and(
        eq(reviewTraces.repoFullName, repoFullName),
        eq(reviewTraces.prNumberCommitSha, prNumberCommitSha),
      ))
      .limit(1);

    const r = rows[0];
    if (!r) return null;
    return {
      repoFullName: r.repoFullName,
      prNumberCommitSha: r.prNumberCommitSha,
      outcomes: (r.outcomes ?? []) as FindingOutcome[],
      ...(r.truncated ? { truncated: true } : {}),
      ...(r.totalOutcomes != null ? { totalOutcomes: r.totalOutcomes } : {}),
      createdAt: r.createdAt,
      ...(r.expiresAt ? { ttl: Math.floor(r.expiresAt.getTime() / 1000) } : {}),
    };
  }
}
