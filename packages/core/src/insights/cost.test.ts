import { describe, it, expect } from 'vitest';
import { buildCostInsight } from './cost.js';
import type { ReviewCostRecord } from '../types/db.js';

// 7d window ends here; "in window" means completedAt ≥ 2026-05-15.
const WINDOW_END = '2026-05-22T00:00:00.000Z';
const IN_WINDOW = '2026-05-20T00:00:00.000Z'; // 2d before end
const OUT_OF_WINDOW = '2026-05-01T00:00:00.000Z'; // 21d before end (outside 7d)

function cost(over: Partial<ReviewCostRecord> = {}): ReviewCostRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    prNumber: 1,
    commitSha: 'abc1234',
    completedAt: IN_WINDOW,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    findingCount: 0,
    ...over,
  };
}

describe('buildCostInsight (#193)', () => {
  describe('empty / windowing', () => {
    it('returns zeros and null averages with no records', () => {
      expect(buildCostInsight('7d', WINDOW_END, [])).toEqual({
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        reviewCount: 0,
        pricedReviewCount: 0,
        unpricedReviewCount: 0,
        avgCostPerReview: null,
        findingCount: 0,
        avgCostPerFinding: null,
        perRepo: {},
      });
    });

    it('excludes records whose completedAt is out of window', () => {
      const c = buildCostInsight('7d', WINDOW_END, [
        cost({ completedAt: OUT_OF_WINDOW, costUsd: 9.99, inputTokens: 1000 }),
        cost({ completedAt: IN_WINDOW, costUsd: 1, inputTokens: 10, findingCount: 2 }),
      ]);
      expect(c.reviewCount).toBe(1);
      expect(c.totalCostUsd).toBe(1);
      expect(c.totalInputTokens).toBe(10);
    });

    it('honours the 30d window length', () => {
      const recs = [cost({ completedAt: OUT_OF_WINDOW, costUsd: 2 })];
      expect(buildCostInsight('7d', WINDOW_END, recs).totalCostUsd).toBe(0);
      expect(buildCostInsight('30d', WINDOW_END, recs).totalCostUsd).toBe(2);
    });
  });

  describe('aggregation', () => {
    it('sums cost + tokens and averages over priced reviews', () => {
      const c = buildCostInsight('7d', WINDOW_END, [
        cost({ commitSha: 'a', costUsd: 1.5, inputTokens: 100, outputTokens: 20, findingCount: 3 }),
        cost({ commitSha: 'b', costUsd: 0.5, inputTokens: 50, outputTokens: 10, findingCount: 1 }),
      ]);
      expect(c.totalCostUsd).toBe(2);
      expect(c.totalInputTokens).toBe(150);
      expect(c.totalOutputTokens).toBe(30);
      expect(c.reviewCount).toBe(2);
      expect(c.pricedReviewCount).toBe(2);
      expect(c.avgCostPerReview).toBe(1); // 2 / 2
      expect(c.findingCount).toBe(4);
      expect(c.avgCostPerFinding).toBe(0.5); // 2 / 4
    });

    it('buckets spend per repo', () => {
      const c = buildCostInsight('7d', WINDOW_END, [
        cost({ repoFullName: 'org/a', commitSha: 'a', costUsd: 2 }),
        cost({ repoFullName: 'org/a', commitSha: 'b', costUsd: 1 }),
        cost({ repoFullName: 'org/b', commitSha: 'c', costUsd: 4 }),
      ]);
      expect(c.perRepo).toEqual({
        'org/a': { costUsd: 3, reviewCount: 2 },
        'org/b': { costUsd: 4, reviewCount: 1 },
      });
    });
  });

  describe('null-pricing path (unknown model)', () => {
    it('counts unpriced reviews separately and excludes them from money totals', () => {
      const c = buildCostInsight('7d', WINDOW_END, [
        cost({ commitSha: 'a', costUsd: 2, inputTokens: 100, findingCount: 2 }),
        cost({ commitSha: 'b', costUsd: null, inputTokens: 80, findingCount: 5 }), // unpriced
      ]);
      expect(c.reviewCount).toBe(2);
      expect(c.pricedReviewCount).toBe(1);
      expect(c.unpricedReviewCount).toBe(1);
      // Money totals + finding denominator ignore the unpriced review...
      expect(c.totalCostUsd).toBe(2);
      expect(c.findingCount).toBe(2);
      expect(c.avgCostPerReview).toBe(2); // 2 / 1 priced
      expect(c.avgCostPerFinding).toBe(1); // 2 / 2 priced-review findings
      // ...but tokens are summed across ALL reviews (tokens are known regardless).
      expect(c.totalInputTokens).toBe(180);
      // The unpriced review still contributes to its repo's reviewCount, not cost.
      expect(c.perRepo['org/repo']).toEqual({ costUsd: 2, reviewCount: 2 });
    });

    it('averages are null when every in-window review is unpriced', () => {
      const c = buildCostInsight('7d', WINDOW_END, [
        cost({ commitSha: 'a', costUsd: null, findingCount: 3 }),
      ]);
      expect(c.pricedReviewCount).toBe(0);
      expect(c.unpricedReviewCount).toBe(1);
      expect(c.totalCostUsd).toBe(0);
      expect(c.avgCostPerReview).toBeNull();
      expect(c.avgCostPerFinding).toBeNull();
    });

    it('avgCostPerFinding is null when priced reviews surfaced zero findings', () => {
      const c = buildCostInsight('7d', WINDOW_END, [
        cost({ costUsd: 1.25, findingCount: 0 }),
      ]);
      expect(c.totalCostUsd).toBe(1.25);
      expect(c.avgCostPerReview).toBe(1.25);
      expect(c.avgCostPerFinding).toBeNull();
    });
  });
});
