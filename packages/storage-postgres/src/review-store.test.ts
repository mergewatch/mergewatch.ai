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
    const execute = vi.fn(async (_stmt: unknown) => [] as unknown[]);
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

describe('PostgresReviewStore — safety score and band (#713)', () => {
  it("the 'complete' write reaches real SQL with safety_score and safety_band", async () => {
    // Capture what updateStatus hands to set(), then build it with a real
    // drizzle builder (no connection): set() drops keys that have no column,
    // so this is what proves the columns exist.
    let captured: Record<string, unknown> | undefined;
    const chain = { set: vi.fn((s: Record<string, unknown>) => { captured = s; return chain; }), where: vi.fn(async () => undefined) };
    const store = new PostgresReviewStore({ update: vi.fn(() => chain) } as any);
    await store.updateStatus('octo/repo', '7#abc1234', 'complete', { safetyScore: 33, safetyBand: 'risky' });

    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { reviews } = await import('./schema.js');
    const { eq } = await import('drizzle-orm');
    const q = drizzle.mock().update(reviews).set(captured as any).where(eq(reviews.repoFullName, 'octo/repo')).toSQL();
    expect(q.sql).toContain('"safety_score"');
    expect(q.sql).toContain('"safety_band"');
    expect(q.params).toContain(33);
    expect(q.params).toContain('risky');
  });

  it('queryByPR reads them back', async () => {
    const { db, rows } = makeMockDb();
    rows.push({ repoFullName: 'octo/repo', prNumberCommitSha: '7#abc1234', status: 'complete', createdAt: 't', safetyScore: 33, safetyBand: 'risky' });
    const [r] = await new PostgresReviewStore(db).queryByPR('octo/repo', '7#');
    expect(r).toMatchObject({ safetyScore: 33, safetyBand: 'risky' });
  });

  it('a re-claim resets the safety fields in DO UPDATE SET', async () => {
    const execute = vi.fn(async (_stmt: unknown) => [] as unknown[]);
    await new PostgresReviewStore({ execute } as any).claimReview({
      repoFullName: 'octo/repo', prNumberCommitSha: '7#abc1234', status: 'pending', createdAt: 't',
    } as ReviewItem);
    const sqlArg = execute.mock.calls[0][0] as any;
    const text = (sqlArg.queryChunks ?? [])
      .map((c: any) => (typeof c === 'string' ? c : Array.isArray(c?.value) ? c.value.join('') : ''))
      .join('');
    const doUpdate = text.slice(text.indexOf('DO UPDATE SET'), text.indexOf('WHERE reviews.status'));
    expect(doUpdate).toContain('safety_score = NULL');
    expect(doUpdate).toContain('safety_band = NULL');
  });
});

describe('PostgresReviewStore — safety feedback (#716)', () => {
  it('appendSafetyFeedback reaches real SQL on safety_feedback with a jsonb concat', async () => {
    let captured: Record<string, unknown> | undefined;
    const chain = { set: vi.fn((s: Record<string, unknown>) => { captured = s; return chain; }), where: vi.fn(async () => undefined) };
    await new PostgresReviewStore({ update: vi.fn(() => chain) } as any)
      .appendSafetyFeedback('octo/repo', '7#abc', { band: 'risky', user: 'alice', at: 't' });
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { reviews } = await import('./schema.js');
    const { eq } = await import('drizzle-orm');
    const q = drizzle.mock().update(reviews).set(captured as any).where(eq(reviews.repoFullName, 'octo/repo')).toSQL();
    expect(q.sql).toContain('"safety_feedback"');
    expect(q.sql).toContain('||');
    expect(q.params.some((p) => typeof p === 'string' && p.includes('"band":"risky"'))).toBe(true);
  });

  it('queryByPR returns safetyFeedback from a row that has it', async () => {
    const { db, rows } = makeMockDb();
    const entry = { band: 'caution', user: 'bob', at: 't' };
    rows.push({ repoFullName: 'octo/repo', prNumberCommitSha: '7#abc', status: 'complete', createdAt: 't', safetyFeedback: [entry] });
    const [r] = await new PostgresReviewStore(db).queryByPR('octo/repo', '7#');
    expect(r.safetyFeedback).toEqual([entry]);
  });

  it("a re-claim resets safety_feedback to '[]' in DO UPDATE SET", async () => {
    const execute = vi.fn(async (_stmt: unknown) => [] as unknown[]);
    await new PostgresReviewStore({ execute } as any).claimReview({
      repoFullName: 'octo/repo', prNumberCommitSha: '7#abc', status: 'pending', createdAt: 't',
    } as ReviewItem);
    const sqlArg = execute.mock.calls[0][0] as any;
    const text = (sqlArg.queryChunks ?? [])
      .map((c: any) => (typeof c === 'string' ? c : Array.isArray(c?.value) ? c.value.join('') : ''))
      .join('');
    const doUpdate = text.slice(text.indexOf('DO UPDATE SET'), text.indexOf('WHERE reviews.status'));
    expect(doUpdate).toContain("safety_feedback = '[]'::jsonb");
  });
});
