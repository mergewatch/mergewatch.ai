import { describe, it, expect, vi } from 'vitest';
import type { ReviewItem } from '@mergewatch/core';
import { PostgresReviewStore } from './review-store.js';

type Row = Record<string, any>;

/**
 * Build a minimal mock drizzle client that captures upsert payloads into an
 * in-memory rows array and serves them back through the select chain used by
 * queryByPR. Only covers the code paths exercised by these tests.
 */
function makeMockDb() {
  const rows: Row[] = [];

  const onConflictDoUpdate = vi.fn(async () => undefined);
  const insertValues = vi.fn((row: Row) => {
    // Upsert semantics: replace any existing row with same PK.
    const idx = rows.findIndex(
      (r) =>
        r.repoFullName === row.repoFullName &&
        r.prNumberCommitSha === row.prNumberCommitSha,
    );
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    return { onConflictDoUpdate };
  });

  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));

  const db = {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({ from })),
  } as any;

  return { db, rows, insertValues };
}

const base: ReviewItem = {
  repoFullName: 'acme/widgets',
  prNumberCommitSha: '42#abc123',
  status: 'complete',
  createdAt: '2026-04-19T00:00:00.000Z',
};

describe('PostgresReviewStore source + agentKind round-trip', () => {
  it('persists and returns both fields when supplied', async () => {
    const { db, insertValues } = makeMockDb();
    const store = new PostgresReviewStore(db);

    await store.upsert({ ...base, source: 'agent', agentKind: 'claude' });

    const inserted = insertValues.mock.calls[0][0];
    expect(inserted.source).toBe('agent');
    expect(inserted.agentKind).toBe('claude');

    const [got] = await store.queryByPR('acme/widgets', '42#');
    expect(got.source).toBe('agent');
    expect(got.agentKind).toBe('claude');
  });

  it('leaves both fields undefined on round-trip when omitted', async () => {
    const { db, insertValues } = makeMockDb();
    const store = new PostgresReviewStore(db);

    await store.upsert({ ...base });

    const inserted = insertValues.mock.calls[0][0];
    expect(inserted.source).toBeNull();
    expect(inserted.agentKind).toBeNull();

    const [got] = await store.queryByPR('acme/widgets', '42#');
    expect(got.source).toBeUndefined();
    expect(got.agentKind).toBeUndefined();
  });

  it("persists source='human' with agentKind null when agentKind omitted", async () => {
    const { db, insertValues } = makeMockDb();
    const store = new PostgresReviewStore(db);

    await store.upsert({ ...base, source: 'human' });

    const inserted = insertValues.mock.calls[0][0];
    expect(inserted.source).toBe('human');
    expect(inserted.agentKind).toBeNull();

    const [got] = await store.queryByPR('acme/widgets', '42#');
    expect(got.source).toBe('human');
    expect(got.agentKind).toBeUndefined();
  });
});

describe('PostgresReviewStore.claimReview (#355)', () => {
  it("includes 'pending' in the retriable claim set so a parked throttled review can be re-claimed", async () => {
    // claimReview goes through raw sql`` — capture the statement text.
    const execute = vi.fn(async () => [] as unknown[]);
    const store = new PostgresReviewStore({ execute } as any);
    await store.claimReview({
      repoFullName: 'octo/repo',
      prNumberCommitSha: '7#abc1234',
      status: 'pending',
      createdAt: '2026-08-16T00:00:00.000Z',
    } as ReviewItem);

    const sqlArg = execute.mock.calls[0][0] as any;
    const text = (sqlArg.queryChunks ?? [])
      .map((c: any) => (typeof c === 'string' ? c : Array.isArray(c?.value) ? c.value.join('') : ''))
      .join('');
    expect(text).toContain("IN ('failed', 'skipped', 'complete', 'pending')");
  });
});
