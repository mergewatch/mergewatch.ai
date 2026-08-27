import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDashboardReviewStore, REVIEWS_BY_CREATED_AT_INDEX } from './dashboard-store.js';
import { TraceStorageNotConfiguredError } from '@mergewatch/core';

/** Build a review item; createdAt is the field under test everywhere here. */
function review(repoFullName: string, prNumber: number, createdAt: string, over: Record<string, unknown> = {}) {
  return {
    repoFullName,
    prNumberCommitSha: `${prNumber}#sha${prNumber}`,
    prNumber,
    createdAt,
    status: 'complete',
    ...over,
  };
}

/**
 * Mock DynamoDB client for the GSI path: serves time-descending pages per
 * repo, honoring KeyConditionExpression date bounds, FilterExpression status,
 * Limit, and ExclusiveStartKey — the pieces listReviews relies on. Rejects
 * with `indexError` instead when set (fallback tests).
 */
function makeGsiClient(itemsByRepo: Record<string, Record<string, unknown>[]>, opts: { indexError?: Error; pageSize?: number } = {}) {
  const send = vi.fn(async (cmd: any) => {
    if (!(cmd instanceof QueryCommand)) throw new Error('unexpected command');
    const input = cmd.input as any;
    if (input.IndexName === REVIEWS_BY_CREATED_AT_INDEX && opts.indexError) throw opts.indexError;

    const repo = input.ExpressionAttributeValues[':repo'];
    let rows = [...(itemsByRepo[repo] ?? [])].sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)));

    // Key-condition date bounds (GSI path only — legacy sends them as FilterExpression).
    const start = input.ExpressionAttributeValues[':startDate'];
    const end = input.ExpressionAttributeValues[':endDate'];
    const kc = String(input.KeyConditionExpression);
    if (kc.includes('createdAt')) {
      if (start) rows = rows.filter((r) => String(r.createdAt) >= start);
      if (end) rows = rows.filter((r) => String(r.createdAt) <= end);
    }

    // ExclusiveStartKey: resume strictly after the given position.
    const esk = input.ExclusiveStartKey;
    if (esk) {
      const idx = rows.findIndex((r) =>
        String(r.createdAt) === String(esk.createdAt) &&
        String(r.prNumberCommitSha) === String(esk.prNumberCommitSha));
      rows = idx >= 0 ? rows.slice(idx + 1) : rows;
    }

    // Limit applies to items READ; FilterExpression applies after.
    const pageSize = Math.min(input.Limit ?? Infinity, opts.pageSize ?? Infinity);
    const read = rows.slice(0, pageSize);
    const hasMore = rows.length > read.length;
    let items = read;
    if (input.FilterExpression && input.ExpressionAttributeValues[':status']) {
      items = read.filter((r) => r.status === input.ExpressionAttributeValues[':status']);
    }
    const last = read[read.length - 1];
    return {
      Items: items,
      ...(hasMore && last
        ? { LastEvaluatedKey: { repoFullName: last.repoFullName, createdAt: last.createdAt, prNumberCommitSha: last.prNumberCommitSha } }
        : {}),
    };
  });
  return { send };
}

function makeStore(client: { send: unknown }) {
  return new DynamoDashboardReviewStore(client as any, 'test-reviews');
}

/** Every GSI QueryCommand the store issued. */
function gsiQueries(client: any) {
  return client.send.mock.calls
    .map((c: any[]) => c[0].input)
    .filter((i: any) => i.IndexName === REVIEWS_BY_CREATED_AT_INDEX);
}

describe('DynamoDashboardReviewStore.listReviews — #335 GSI path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC: orders by time across PR numbers 9 / 42 / 100 / 1000, not by PR-number string', async () => {
    // Lexicographic PR-string order would yield 9 > 42 > 1000 > 100.
    const client = makeGsiClient({
      'octo/repo': [
        review('octo/repo', 9,    '2026-08-01T00:00:00Z'),
        review('octo/repo', 42,   '2026-08-04T00:00:00Z'),
        review('octo/repo', 100,  '2026-08-16T00:00:00Z'),
        review('octo/repo', 1000, '2026-08-10T00:00:00Z'),
      ],
    });
    const reviews = makeStore(client);
    const { items } = await reviews.listReviews(['octo/repo'], 10);
    expect(items.map((i: any) => i.prNumber)).toEqual([100, 1000, 42, 9]);
    expect(gsiQueries(client)[0].ScanIndexForward).toBe(false);
  });

  it('puts date bounds in the key condition, never in a FilterExpression', async () => {
    const client = makeGsiClient({ 'octo/repo': [review('octo/repo', 1, '2026-08-10T00:00:00Z')] });
    const reviews = makeStore(client);
    await reviews.listReviews(['octo/repo'], 10, undefined, undefined, '2026-08-01T00:00:00Z', '2026-08-16T00:00:00Z');
    const q = gsiQueries(client)[0];
    expect(q.KeyConditionExpression).toBe('repoFullName = :repo AND createdAt BETWEEN :startDate AND :endDate');
    expect(q.FilterExpression).toBeUndefined();
  });

  it('date-filtered queries return matches beyond the first unfiltered page (defect 3 fixture)', async () => {
    // 30 old rows would previously fill the read Limit and be filtered to
    // nothing; the 5 in-range rows sat unread past LastEvaluatedKey.
    const old = Array.from({ length: 30 }, (_, i) =>
      review('octo/repo', i + 1, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
    const recent = Array.from({ length: 5 }, (_, i) =>
      review('octo/repo', 100 + i, `2026-08-1${i}T00:00:00Z`));
    const client = makeGsiClient({ 'octo/repo': [...old, ...recent] });
    const reviews = makeStore(client);
    const { items } = await reviews.listReviews(['octo/repo'], 10, undefined, undefined, '2026-08-01T00:00:00Z');
    expect(items).toHaveLength(5);
    expect((items as any[]).every((i) => i.createdAt >= '2026-08-01')).toBe(true);
  });

  it('limit bounds the merged result across repos, and dropped rows are re-fetched next page (defect 2)', async () => {
    const client = makeGsiClient({
      'octo/api': [
        review('octo/api', 1, '2026-08-16T00:00:00Z'),
        review('octo/api', 2, '2026-08-14T00:00:00Z'),
        review('octo/api', 3, '2026-08-12T00:00:00Z'),
      ],
      'octo/web': [
        review('octo/web', 7, '2026-08-15T00:00:00Z'),
        review('octo/web', 8, '2026-08-13T00:00:00Z'),
        review('octo/web', 9, '2026-08-11T00:00:00Z'),
      ],
    });
    const reviews = makeStore(client);

    const page1 = await reviews.listReviews(['octo/api', 'octo/web'], 4);
    expect(page1.items).toHaveLength(4);
    expect(page1.items.map((i: any) => i.createdAt)).toEqual([
      '2026-08-16T00:00:00Z', '2026-08-15T00:00:00Z', '2026-08-14T00:00:00Z', '2026-08-13T00:00:00Z',
    ]);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2 must produce the two rows page 1 fetched-but-dropped.
    const page2 = await reviews.listReviews(['octo/api', 'octo/web'], 4, page1.nextCursor!);
    expect(page2.items.map((i: any) => i.createdAt)).toEqual([
      '2026-08-12T00:00:00Z', '2026-08-11T00:00:00Z',
    ]);
    expect(page2.nextCursor).toBeNull();
  });

  it('full pagination never loses or duplicates a row (6 repos × 5 rows, page size 4)', async () => {
    const itemsByRepo: Record<string, ReturnType<typeof review>[]> = {};
    for (let r = 0; r < 6; r++) {
      const repo = `octo/repo${r}`;
      itemsByRepo[repo] = Array.from({ length: 5 }, (_, i) =>
        review(repo, i + 1, `2026-08-${String(2 + ((r * 5 + i) % 27)).padStart(2, '0')}T0${r}:0${i}:00Z`));
    }
    const client = makeGsiClient(itemsByRepo);
    const reviews = makeStore(client);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await reviews.listReviews(Object.keys(itemsByRepo), 4, cursor);
      seen.push(...res.items.map((i: any) => `${i.repoFullName}:${i.prNumberCommitSha}`));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('status filter pages past filtered-out reads instead of returning a short page', async () => {
    // 12 rows, only the 3 oldest are complete; page size forces multiple
    // reads before the matches surface.
    const rows = Array.from({ length: 12 }, (_, i) =>
      review('octo/repo', i + 1, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`, {
        status: i < 3 ? 'complete' : 'failed',
      }));
    const client = makeGsiClient({ 'octo/repo': rows }, { pageSize: 4 });
    const reviews = makeStore(client);
    const { items } = await reviews.listReviews(['octo/repo'], 3, undefined, 'completed');
    expect(items).toHaveLength(3);
    expect((items as any[]).every((i) => i.status === 'complete')).toBe(true);
    // Multiple sequential GSI queries were needed to get there.
    expect(gsiQueries(client).length).toBeGreaterThan(1);
  });

  it("maps the caller's 'completed' to the stored 'complete'", async () => {
    const client = makeGsiClient({ 'octo/repo': [review('octo/repo', 1, '2026-08-10T00:00:00Z')] });
    const reviews = makeStore(client);
    await reviews.listReviews(['octo/repo'], 10, undefined, 'completed');
    const q = gsiQueries(client)[0];
    expect(q.ExpressionAttributeValues[':status']).toBe('complete');
    expect(q.FilterExpression).toBe('#s = :status');
  });

  it('returns a null cursor when every repo is exhausted', async () => {
    const client = makeGsiClient({
      'octo/api': [review('octo/api', 1, '2026-08-16T00:00:00Z')],
      'octo/web': [],
    });
    const reviews = makeStore(client);
    const { items, nextCursor } = await reviews.listReviews(['octo/api', 'octo/web'], 10);
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeNull();
  });

  it('handles an empty repo list', async () => {
    const client = makeGsiClient({});
    const reviews = makeStore(client);
    const { items, nextCursor } = await reviews.listReviews([], 10);
    expect(items).toEqual([]);
    expect(nextCursor).toBeNull();
  });
});

describe('DynamoDashboardReviewStore.listReviews — legacy fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to the base table when the GSI does not exist, and stays there (sticky)', async () => {
    const err = Object.assign(new Error('The table does not have the specified index: ByRepoCreatedAt'), {
      name: 'ValidationException',
    });
    const client = makeGsiClient({ 'octo/repo': [review('octo/repo', 1, '2026-08-10T00:00:00Z')] }, { indexError: err });
    const reviews = makeStore(client);

    const first = await reviews.listReviews(['octo/repo'], 10);
    expect(first.items).toHaveLength(1);

    await reviews.listReviews(['octo/repo'], 10);
    // One failed GSI attempt total — the flag prevents a second.
    expect(gsiQueries(client)).toHaveLength(1);
    // Every successful query hit the base table (no IndexName).
    const baseQueries = client.send.mock.calls
      .map((c: any[]) => c[0].input)
      .filter((i: any) => !i.IndexName);
    expect(baseQueries.length).toBeGreaterThanOrEqual(2);
  });

  it('rethrows non-index query errors instead of masking them with the legacy path', async () => {
    const err = Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
    const client = makeGsiClient({}, { indexError: err });
    const reviews = makeStore(client);
    await expect(reviews.listReviews(['octo/repo'], 10)).rejects.toThrow('Throughput exceeded');
  });

  it('routes a v1 cursor to the legacy path for pagination continuity', async () => {
    const client = makeGsiClient({ 'octo/repo': [review('octo/repo', 1, '2026-08-10T00:00:00Z')] });
    const reviews = makeStore(client);
    const v1Cursor = Buffer.from(JSON.stringify({ keys: {}, exhausted: [] })).toString('base64url');
    await reviews.listReviews(['octo/repo'], 10, v1Cursor);
    expect(gsiQueries(client)).toHaveLength(0);
    const q = client.send.mock.calls[0][0].input;
    expect(q.IndexName).toBeUndefined();
    // Legacy keeps dates in the FilterExpression — assert its shape survives untouched.
    expect(q.KeyConditionExpression).toBe('repoFullName = :repo');
  });

  it('starts fresh on an unparseable cursor (GSI path)', async () => {
    const client = makeGsiClient({ 'octo/repo': [review('octo/repo', 1, '2026-08-10T00:00:00Z')] });
    const reviews = makeStore(client);
    const { items } = await reviews.listReviews(['octo/repo'], 10, 'not-base64-json');
    expect(items).toHaveLength(1);
    expect(gsiQueries(client)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #494 — an unconfigured trace table must not read as "no trail"
// ---------------------------------------------------------------------------

describe('DynamoDashboardReviewStore.getReviewTrace — trace storage configuration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('throws when no trace table is configured — never returns null', async () => {
    const send = vi.fn();
    // Third constructor arg omitted: the deployment has no trace table name.
    const store = new DynamoDashboardReviewStore({ send } as any, 'test-reviews');

    await expect(store.getReviewTrace('o/r', '1#abc')).rejects.toThrow(
      TraceStorageNotConfiguredError,
    );
    // The distinction that matters: it must fail before querying, and it must
    // not quietly answer "no trace" the way it did through the whole of #494.
    expect(send).not.toHaveBeenCalled();
  });

  it('logs the cause so an operator can find it without reading the source', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new DynamoDashboardReviewStore({ send: vi.fn() } as any, 'test-reviews');

    await store.getReviewTrace('o/r', '1#abc').catch(() => {});

    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain('DYNAMODB_TABLE_REVIEW_TRACES');
  });

  it('returns null — not an error — when configured and the trace is genuinely absent', async () => {
    // The case the throw must stay distinguishable from.
    const send = vi.fn(async () => ({ Item: undefined }));
    const store = new DynamoDashboardReviewStore({ send } as any, 'test-reviews', 'test-traces');

    await expect(store.getReviewTrace('o/r', '1#abc')).resolves.toBeNull();
    expect(send).toHaveBeenCalled();
  });

  it('returns the trace when configured and present', async () => {
    const send = vi.fn(async () => ({
      Item: { repoFullName: 'o/r', prNumberCommitSha: '1#abc', outcomes: [] },
    }));
    const store = new DynamoDashboardReviewStore({ send } as any, 'test-reviews', 'test-traces');

    const trace = await store.getReviewTrace('o/r', '1#abc');
    expect(trace).toMatchObject({ repoFullName: 'o/r', outcomes: [] });
  });

  it('an empty-string table name counts as unconfigured, not as a table named ""', async () => {
    const send = vi.fn();
    const store = new DynamoDashboardReviewStore({ send } as any, 'test-reviews', '');

    await expect(store.getReviewTrace('o/r', '1#abc')).rejects.toThrow(
      TraceStorageNotConfiguredError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
