import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresReviewCostStore } from './review-cost-store';
import { reviewCosts } from './schema';
import type { ReviewCostRecord } from '@mergewatch/core';

/** Drizzle chain mock (mirrors api-key-store.test). */
function chain(result: any) {
  const p: any = {
    select: vi.fn(() => p),
    from: vi.fn(() => p),
    where: vi.fn(() => p),
    limit: vi.fn(() => Promise.resolve(result)),
    insert: vi.fn(() => p),
    values: vi.fn(() => p),
    onConflictDoUpdate: vi.fn(() => Promise.resolve(result)),
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return p;
}

function rec(over: Partial<ReviewCostRecord> = {}): ReviewCostRecord {
  return {
    installationId: '42',
    repoFullName: 'octo/repo',
    prNumber: 7,
    commitSha: 'abc1234',
    completedAt: 'iso',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 1.5,
    findingCount: 3,
    model: 'm',
    ...over,
  };
}

describe('PostgresReviewCostStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts cost as text on conflict (idempotent per review)', async () => {
    const db: any = chain(undefined);
    const store = new PostgresReviewCostStore(db);
    await store.recordCost(rec());
    expect(db.insert).toHaveBeenCalledWith(reviewCosts);
    // cost stored as text to avoid float drift.
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ costUsd: '1.5', findingCount: 3 }));
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('stores null cost for an unpriced review', async () => {
    const db: any = chain(undefined);
    const store = new PostgresReviewCostStore(db);
    await store.recordCost(rec({ costUsd: null }));
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ costUsd: null }));
  });

  it('hydrates rows and round-trips null cost as null', async () => {
    const db: any = chain([
      { installationId: '42', repoFullName: 'octo/repo', prNumber: 7, commitSha: 'a', completedAt: 'iso', inputTokens: 100, outputTokens: 20, costUsd: '1.5', findingCount: 3, model: 'm' },
      { installationId: '42', repoFullName: 'octo/repo', prNumber: 8, commitSha: 'b', completedAt: 'iso', inputTokens: 50, outputTokens: 5, costUsd: null, findingCount: 0, model: null },
    ]);
    const store = new PostgresReviewCostStore(db);
    const { items } = await store.listByInstallation('42');
    expect(items[0].costUsd).toBe(1.5);
    expect(items[1].costUsd).toBeNull();
    expect(items[0].model).toBe('m');
    expect(items[1].model).toBeUndefined();
  });
});
