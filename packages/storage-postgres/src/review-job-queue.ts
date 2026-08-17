/**
 * #355 — Postgres implementation of `IReviewJobQueue`.
 *
 * The self-hosted admission-control queue: webhooks INSERT, the in-process
 * worker claims with `SELECT … FOR UPDATE SKIP LOCKED` so concurrent
 * replicas never double-deliver, and a `processing` row whose lock expired
 * is reclaimable (crash recovery — at-least-once, made safe by the review
 * store's idempotent `claimReview`). Postgres is already part of the
 * self-hosted deployment contract, so this adds zero infrastructure.
 *
 * Lifecycle: queued → processing → done (delivered, terminal outcome
 * recorded by the processor) | dead (retries exhausted — the DLQ analogue,
 * kept for operator inspection).
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { IReviewJobQueue, ClaimedReviewJob, ReviewJobPayload } from '@mergewatch/core';

export class PostgresReviewJobQueue implements IReviewJobQueue {
  constructor(private db: PostgresJsDatabase) {}

  async enqueue(payload: ReviewJobPayload): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO review_jobs (payload) VALUES (${JSON.stringify(payload)}::jsonb)
    `);
  }

  async claim(max: number, lockSeconds: number): Promise<ClaimedReviewJob[]> {
    // One atomic statement: pick due rows (fresh, backoff-elapsed, or
    // expired-lock crash leftovers) with SKIP LOCKED, mark them processing,
    // bump attempts, and return them. The inner SELECT's row locks make the
    // claim race-free across replicas without an advisory-lock dance.
    const rows = await this.db.execute(sql`
      UPDATE review_jobs SET
        status = 'processing',
        attempts = attempts + 1,
        locked_until = now() + make_interval(secs => ${lockSeconds}),
        updated_at = now()
      WHERE id IN (
        SELECT id FROM review_jobs
        WHERE (status = 'queued' AND next_attempt_at <= now())
           OR (status = 'processing' AND locked_until < now())
        ORDER BY id
        LIMIT ${max}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, payload, attempts
    `);
    return (rows as unknown as Array<{ id: number; payload: unknown; attempts: number }>).map((r) => ({
      id: String(r.id),
      payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as ReviewJobPayload,
      attempts: Number(r.attempts),
    }));
  }

  async complete(id: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE review_jobs SET status = 'done', locked_until = NULL, updated_at = now()
      WHERE id = ${Number(id)}
    `);
  }

  async retry(id: string, delaySeconds: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE review_jobs SET
        status = 'queued',
        next_attempt_at = now() + make_interval(secs => ${delaySeconds}),
        locked_until = NULL,
        updated_at = now()
      WHERE id = ${Number(id)}
    `);
  }

  async kill(id: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE review_jobs SET status = 'dead', locked_until = NULL, updated_at = now()
      WHERE id = ${Number(id)}
    `);
  }
}
