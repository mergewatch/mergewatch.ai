import { describe, it, expect, vi } from 'vitest';
import type { ReviewTraceItem } from '@mergewatch/core';
import { PostgresReviewTraceStore } from './review-trace-store.js';

type Row = Record<string, any>;

/** Minimal drizzle mock: captures upserts and serves them back through select. */
function makeMockDb() {
  const rows: Row[] = [];
  const onConflictDoUpdate = vi.fn(async (_args: unknown) => undefined);
  const insertValues = vi.fn((row: Row) => {
    const i = rows.findIndex(
      (r) => r.repoFullName === row.repoFullName
        && r.prNumberCommitSha === row.prNumberCommitSha,
    );
    if (i >= 0) rows[i] = row; else rows.push(row);
    return { onConflictDoUpdate };
  });

  const db = {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => rows.slice(0, 1)) })),
      })),
    })),
  };
  return { db: db as any, rows };
}

const TRACE: ReviewTraceItem = {
  repoFullName: 'o/r',
  prNumberCommitSha: '42#abc123',
  outcomes: [{
    key: 'src/a.ts::T::x', file: 'src/a.ts', line: 1, severity: 'critical',
    title: 'x', agents: ['security'], outcome: 'dropped', stage: 'confidence-floor',
  }],
  createdAt: '2026-08-25T12:00:00.000Z',
  ttl: 1_800_000_000,
};

describe('PostgresReviewTraceStore', () => {
  it('stores the trace under the review key, unsuffixed', async () => {
    const { db, rows } = makeMockDb();
    await new PostgresReviewTraceStore(db).put(TRACE);
    expect(rows[0].prNumberCommitSha).toBe('42#abc123');
    expect(rows[0].truncated).toBe(false);
  });

  it('converts the Dynamo epoch TTL to a prunable timestamp', async () => {
    // Postgres has no native TTL; expires_at exists so an operator can prune
    // with a one-liner rather than computing dates over created_at.
    const { db, rows } = makeMockDb();
    await new PostgresReviewTraceStore(db).put(TRACE);
    expect(rows[0].expiresAt).toEqual(new Date(1_800_000_000 * 1000));
  });

  it('round-trips a trace, preserving outcomes', async () => {
    const { db } = makeMockDb();
    const store = new PostgresReviewTraceStore(db);
    await store.put(TRACE);
    const got = await store.get('o/r', '42#abc123');
    expect(got?.outcomes).toHaveLength(1);
    expect(got?.outcomes[0].stage).toBe('confidence-floor');
    expect(got?.prNumberCommitSha).toBe('42#abc123');
  });

  it('carries truncation through the round trip', async () => {
    const { db } = makeMockDb();
    const store = new PostgresReviewTraceStore(db);
    await store.put({ ...TRACE, truncated: true, totalOutcomes: 1430 });
    const got = await store.get('o/r', '42#abc123');
    expect(got?.truncated).toBe(true);
    expect(got?.totalOutcomes).toBe(1430);
  });

  it('returns null when there is no trace', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
      })),
    } as any;
    expect(await new PostgresReviewTraceStore(db).get('o/r', 'nope')).toBeNull();
  });
});
