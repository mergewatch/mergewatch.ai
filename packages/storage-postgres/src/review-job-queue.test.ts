import { describe, it, expect, vi } from 'vitest';
import { PostgresReviewJobQueue } from './review-job-queue.js';
import type { ReviewJobPayload } from '@mergewatch/core';

const payload = { installationId: 1, owner: 'octo', repo: 'repo', prNumber: 7, mode: 'review' } as ReviewJobPayload;

/** Flatten a drizzle sql`` template into its literal text (params elided). */
function sqlText(stmt: any): string {
  return (stmt.queryChunks ?? [])
    .map((c: any) => (typeof c === 'string' ? c : Array.isArray(c?.value) ? c.value.join('') : ''))
    .join('');
}

function makeDb(result: unknown[] = []) {
  return { execute: vi.fn(async (_stmt: unknown) => result) } as any;
}

describe('PostgresReviewJobQueue (#355)', () => {
  it('enqueue inserts the payload as jsonb', async () => {
    const db = makeDb();
    await new PostgresReviewJobQueue(db).enqueue(payload);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain('INSERT INTO review_jobs');
    expect(text).toContain('::jsonb');
  });

  it('claim uses SKIP LOCKED, picks due + expired-lock rows, bumps attempts', async () => {
    const db = makeDb([{ id: 5, payload, attempts: 1 }]);
    const jobs = await new PostgresReviewJobQueue(db).claim(3, 900);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain("status = 'queued' AND next_attempt_at <= now()");
    expect(text).toContain("status = 'processing' AND locked_until < now()");
    expect(text).toContain('attempts = attempts + 1');
    expect(jobs).toEqual([{ id: '5', payload, attempts: 1 }]);
  });

  it('claim parses a string payload (driver-dependent jsonb decoding)', async () => {
    const db = makeDb([{ id: 6, payload: JSON.stringify(payload), attempts: 2 }]);
    const [job] = await new PostgresReviewJobQueue(db).claim(1, 900);
    expect(job.payload).toEqual(payload);
    expect(job.attempts).toBe(2);
  });

  it('retry re-queues with the backoff delay', async () => {
    const db = makeDb();
    await new PostgresReviewJobQueue(db).retry('5', 120);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain("status = 'queued'");
    expect(text).toContain('next_attempt_at = now() + make_interval');
  });

  it('complete and kill park the row terminally', async () => {
    const db = makeDb();
    const q = new PostgresReviewJobQueue(db);
    await q.complete('5');
    await q.kill('6');
    expect(sqlText(db.execute.mock.calls[0][0])).toContain("status = 'done'");
    expect(sqlText(db.execute.mock.calls[1][0])).toContain("status = 'dead'");
  });
});
