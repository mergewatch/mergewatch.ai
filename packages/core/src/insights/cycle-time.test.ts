import { describe, it, expect } from 'vitest';
import { buildCycleTimeInsight, percentile, percentilesOf } from './cycle-time.js';
import type { PRLifecycleRecord } from '../types/db.js';

const WINDOW_END = '2026-05-22T00:00:00.000Z';

/** A merged PR whose timestamps default to "inside the 7d window". */
function pr(over: Partial<PRLifecycleRecord> = {}): PRLifecycleRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    prNumber: 1,
    prCreatedAt: '2026-05-20T00:00:00.000Z',
    mergedAt: '2026-05-21T00:00:00.000Z', // 24h to merge, 1d before window end
    state: 'merged',
    reviewed: true,
    skipped: false,
    totalPushes: 0,
    pushesAfterFirstReview: 0,
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...over,
  };
}

describe('percentile (R-7 linear interpolation)', () => {
  it('returns the single value for a 1-element array', () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('computes median of an odd-length sample', () => {
    expect(percentile([1, 2, 3], 0.5)).toBe(2);
  });

  it('interpolates the median of an even-length sample', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('computes p90 by interpolating between ranks', () => {
    // n=10, rank = 0.9*(9) = 8.1 → between sorted[8]=9 and sorted[9]=10
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(data, 0.9)).toBeCloseTo(9.1, 10);
  });

  it('p75 of 1..4 interpolates to 3.25', () => {
    expect(percentile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 10);
  });
});

describe('percentilesOf', () => {
  it('returns null for an empty sample', () => {
    expect(percentilesOf([])).toBeNull();
  });

  it('returns p50/p75/p90 for a non-empty sample', () => {
    expect(percentilesOf([10, 20, 30, 40])).toEqual({ p50: 25, p75: 32.5, p90: 37 });
  });
});

describe('buildCycleTimeInsight', () => {
  it('counts a merged reviewed PR and computes time-to-merge in hours', () => {
    const out = buildCycleTimeInsight('7d', WINDOW_END, [pr()]);
    expect(out.mergedCount).toBe(1);
    expect(out.reviewedMergedCount).toBe(1);
    expect(out.unreviewedMergedCount).toBe(0);
    expect(out.timeToMergeHours).toEqual({ p50: 24, p75: 24, p90: 24 });
    expect(out.timeToMergeHoursReviewed).toEqual({ p50: 24, p75: 24, p90: 24 });
    expect(out.timeToMergeHoursUnreviewed).toBeNull();
  });

  it('segments reviewed vs unreviewed merged PRs', () => {
    const records = [
      pr({ prNumber: 1, reviewed: true, prCreatedAt: '2026-05-21T00:00:00.000Z', mergedAt: '2026-05-21T12:00:00.000Z' }), // 12h
      pr({ prNumber: 2, reviewed: false, prCreatedAt: '2026-05-19T00:00:00.000Z', mergedAt: '2026-05-21T00:00:00.000Z' }), // 48h
    ];
    const out = buildCycleTimeInsight('7d', WINDOW_END, records);
    expect(out.mergedCount).toBe(2);
    expect(out.reviewedMergedCount).toBe(1);
    expect(out.unreviewedMergedCount).toBe(1);
    expect(out.timeToMergeHoursReviewed?.p50).toBe(12);
    expect(out.timeToMergeHoursUnreviewed?.p50).toBe(48);
    // The combined sample is [12, 48] → median 30.
    expect(out.timeToMergeHours?.p50).toBe(30);
  });

  it('computes time-from-first-review-to-merge and round-trips for reviewed PRs', () => {
    const out = buildCycleTimeInsight('7d', WINDOW_END, [
      pr({
        reviewed: true,
        prCreatedAt: '2026-05-20T00:00:00.000Z',
        firstReviewAt: '2026-05-20T06:00:00.000Z', // 18h before merge
        mergedAt: '2026-05-21T00:00:00.000Z',
        pushesAfterFirstReview: 3,
      }),
    ]);
    expect(out.timeToMergeFromFirstReviewHours).toEqual({ p50: 18, p75: 18, p90: 18 });
    expect(out.roundTripsBeforeMerge).toEqual({ p50: 3, p75: 3, p90: 3 });
  });

  it('excludes closed-without-merge and still-open PRs from time stats but counts them', () => {
    const records = [
      pr({ prNumber: 1 }), // merged in-window
      pr({ prNumber: 2, state: 'closed_unmerged', mergedAt: undefined, closedAt: '2026-05-21T00:00:00.000Z' }),
      pr({ prNumber: 3, state: 'open', mergedAt: undefined, prCreatedAt: '2026-05-21T00:00:00.000Z' }),
    ];
    const out = buildCycleTimeInsight('7d', WINDOW_END, records);
    expect(out.mergedCount).toBe(1);
    expect(out.closedUnmergedCount).toBe(1);
    expect(out.openCount).toBe(1);
    expect(out.timeToMergeHours).toEqual({ p50: 24, p75: 24, p90: 24 }); // only the merged PR
  });

  it('returns all-zero counts and null percentiles for an empty installation', () => {
    const out = buildCycleTimeInsight('30d', WINDOW_END, []);
    expect(out).toEqual({
      mergedCount: 0,
      reviewedMergedCount: 0,
      unreviewedMergedCount: 0,
      closedUnmergedCount: 0,
      openCount: 0,
      timeToMergeHours: null,
      timeToMergeHoursReviewed: null,
      timeToMergeHoursUnreviewed: null,
      timeToMergeFromFirstReviewHours: null,
      roundTripsBeforeMerge: null,
    });
  });

  it('windows by mergedAt — a merge before windowStart is excluded', () => {
    const old = pr({ mergedAt: '2026-05-10T00:00:00.000Z', prCreatedAt: '2026-05-09T00:00:00.000Z' }); // 12d before end
    expect(buildCycleTimeInsight('7d', WINDOW_END, [old]).mergedCount).toBe(0);
    expect(buildCycleTimeInsight('30d', WINDOW_END, [old]).mergedCount).toBe(1);
  });

  it('counts a merge with an unknown prCreatedAt sentinel but omits it from created→merged percentiles', () => {
    const out = buildCycleTimeInsight('7d', WINDOW_END, [
      pr({ prCreatedAt: '', reviewed: false }), // '' sentinel — anchor unknown
    ]);
    expect(out.mergedCount).toBe(1);
    expect(out.unreviewedMergedCount).toBe(1);
    expect(out.timeToMergeHours).toBeNull(); // no computable created→merged span
  });

  it('drops negative spans (clock skew) rather than feeding them to stats', () => {
    const out = buildCycleTimeInsight('7d', WINDOW_END, [
      pr({ prCreatedAt: '2026-05-21T12:00:00.000Z', mergedAt: '2026-05-21T00:00:00.000Z' }), // merged before created
    ]);
    expect(out.mergedCount).toBe(1);
    expect(out.timeToMergeHours).toBeNull();
  });
});
