import { describe, it, expect } from 'vitest';
import { buildEngagementInsight } from './engagement.js';
import type { FindingDispositionRecord, PRLifecycleRecord } from '../types/db.js';

// 7d window ends here; "in window" means lastSeen/at/firstReviewAt ≥ 2026-05-15.
const WINDOW_END = '2026-05-22T00:00:00.000Z';
const IN_WINDOW = '2026-05-20T00:00:00.000Z'; // 2d before end
const OUT_OF_WINDOW = '2026-05-01T00:00:00.000Z'; // 21d before end (outside 7d)

/** A disposition record with every counter at 0; override as needed. */
function disp(over: Partial<FindingDispositionRecord> = {}): FindingDispositionRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    findingMatchKey: 'src/a.ts::T::X',
    firstSeen: IN_WINDOW,
    lastSeen: IN_WINDOW,
    surfaceCount: 0,
    disputeCount: 0,
    verifiedCount: 0,
    unverifiedCount: 0,
    silentDropCount: 0,
    agreementCount: 0,
    resolveCount: 0,
    ...over,
  };
}

/** A reviewed, in-window PR-lifecycle record; override as needed. */
function pr(over: Partial<PRLifecycleRecord> = {}): PRLifecycleRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    prNumber: 1,
    prCreatedAt: IN_WINDOW,
    firstReviewAt: IN_WINDOW,
    state: 'open',
    reviewed: true,
    skipped: false,
    totalPushes: 0,
    pushesAfterFirstReview: 0,
    updatedAt: IN_WINDOW,
    ...over,
  };
}

describe('buildEngagementInsight (#195)', () => {
  describe('empty / low-volume', () => {
    it('returns null rates and zero counts when there are no records', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [], []);
      expect(e).toEqual({
        acceptanceRate: null,
        totalResolves: 0,
        totalRejectCommands: 0,
        commandUsageCount: 0,
        findingActionRateApprox: null,
        reReviewRate: null,
        reviewedPrCount: 0,
        activeInstallation: false,
      });
    });

    it('action rate is null when findings were acted on but none surfaced', () => {
      // A record with agreements but surfaceCount 0 (defensive against bad data).
      const e = buildEngagementInsight('7d', WINDOW_END, [disp({ agreementCount: 1 })], []);
      expect(e.findingActionRateApprox).toBeNull();
      expect(e.acceptanceRate).toBe(1); // 1 agreement / (1 acted-on) = 1
    });
  });

  describe('acceptanceRate', () => {
    it('is agreements / (agreements + disputes + silentDrops)', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({ agreementCount: 6, disputeCount: 2, silentDropCount: 2 }),
      ], []);
      expect(e.acceptanceRate).toBe(0.6); // 6 / 10
    });

    it('is null when nothing was acted on in the window', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [disp({ surfaceCount: 5 })], []);
      expect(e.acceptanceRate).toBeNull();
    });
  });

  describe('command usage', () => {
    it('sums resolveCount across in-window records', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({ resolveCount: 2 }),
        disp({ resolveCount: 3 }),
      ], []);
      expect(e.totalResolves).toBe(5);
    });

    it('counts /mergewatch reject entries by their own `at` timestamp', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({
          // record itself drifted out of window, but a reject lands in-window
          lastSeen: OUT_OF_WINDOW,
          rejectReasons: [
            { category: 'out-of-scope', at: IN_WINDOW },
            { category: 'other', at: OUT_OF_WINDOW }, // excluded
          ],
        }),
      ], []);
      expect(e.totalRejectCommands).toBe(1);
    });

    it('commandUsageCount is resolves + reject commands', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({ resolveCount: 2, rejectReasons: [{ category: 'other', at: IN_WINDOW }] }),
      ], []);
      expect(e.commandUsageCount).toBe(3);
    });
  });

  describe('findingActionRateApprox (proxy)', () => {
    it('is (agreements + resolves) / surfaced', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({ surfaceCount: 10, agreementCount: 2, resolveCount: 3 }),
      ], []);
      expect(e.findingActionRateApprox).toBe(0.5); // 5 / 10
    });

    it('is capped at 1 when a finding carries both a 👍 and a /resolve', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({ surfaceCount: 1, agreementCount: 1, resolveCount: 1 }),
      ], []);
      expect(e.findingActionRateApprox).toBe(1); // min(1, 2/1)
    });
  });

  describe('re-review rate', () => {
    it('is the share of reviewed PRs with a push after first review', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [], [
        pr({ prNumber: 1, pushesAfterFirstReview: 2 }),
        pr({ prNumber: 2, pushesAfterFirstReview: 0 }),
        pr({ prNumber: 3, pushesAfterFirstReview: 1 }),
        pr({ prNumber: 4, pushesAfterFirstReview: 0 }),
      ]);
      expect(e.reviewedPrCount).toBe(4);
      expect(e.reReviewRate).toBe(0.5); // 2 of 4
      expect(e.activeInstallation).toBe(true);
    });

    it('excludes unreviewed PRs and PRs reviewed outside the window', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [], [
        pr({ prNumber: 1, reviewed: false, firstReviewAt: undefined }),
        pr({ prNumber: 2, firstReviewAt: OUT_OF_WINDOW }),
        pr({ prNumber: 3, firstReviewAt: IN_WINDOW, pushesAfterFirstReview: 1 }),
      ]);
      expect(e.reviewedPrCount).toBe(1);
      expect(e.reReviewRate).toBe(1); // the one in-window reviewed PR was re-pushed
    });

    it('reReviewRate is null and activeInstallation false with no reviewed PRs', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [], [pr({ reviewed: false, firstReviewAt: undefined })]);
      expect(e.reReviewRate).toBeNull();
      expect(e.activeInstallation).toBe(false);
    });
  });

  describe('windowing', () => {
    it('excludes counters from records whose lastSeen is out of window', () => {
      const e = buildEngagementInsight('7d', WINDOW_END, [
        disp({ lastSeen: OUT_OF_WINDOW, surfaceCount: 100, agreementCount: 50, resolveCount: 9 }),
        disp({ lastSeen: IN_WINDOW, surfaceCount: 4, agreementCount: 1 }),
      ], []);
      expect(e.totalResolves).toBe(0); // the 9 resolves are out of window
      expect(e.findingActionRateApprox).toBe(0.25); // 1 / 4 (only in-window record)
    });

    it('honours the 30d window length', () => {
      // OUT_OF_WINDOW is 21d before end — inside 30d, outside 7d.
      const recs = [disp({ lastSeen: OUT_OF_WINDOW, surfaceCount: 4, resolveCount: 2 })];
      expect(buildEngagementInsight('7d', WINDOW_END, recs, []).totalResolves).toBe(0);
      expect(buildEngagementInsight('30d', WINDOW_END, recs, []).totalResolves).toBe(2);
    });
  });
});
