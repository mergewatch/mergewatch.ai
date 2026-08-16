import { describe, it, expect } from "vitest";
import {
  aggregateReviews,
  type AggregatableReview,
} from "./analytics-aggregate";

/**
 * Build a review with sensible defaults so each test only states the fields it
 * actually cares about.
 */
function review(overrides: Partial<AggregatableReview> = {}): AggregatableReview {
  return {
    repoFullName: "acme/api",
    status: "complete",
    createdAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("aggregateReviews — empty input", () => {
  it("returns a fully-formed zero state rather than NaN or undefined", () => {
    const result = aggregateReviews([]);

    expect(result.totalReviews).toBe(0);
    expect(result.totalFindings).toBe(0);
    // Guards the division-by-zero paths: every average must be 0, not NaN.
    expect(result.avgMergeScore).toBe(0);
    expect(result.durationStats).toEqual({ avgMs: 0, p95Ms: 0, count: 0 });
    expect(result.costStats).toEqual({ totalCostUsd: 0, avgCostUsd: 0, costCount: 0 });
    expect(result.scoreTrend).toEqual([]);
    expect(result.findingsPerReviewTrend).toEqual([]);
    expect(result.repoBreakdown).toEqual([]);
    // Buckets are always seeded so the UI never has to null-check them.
    expect(result.severityBreakdown).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(result.categoryBreakdown).toEqual({ security: 0, bug: 0, style: 0 });
    expect(result.mergeScoreDistribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it("has no NaN anywhere in the zero state", () => {
    const json = JSON.stringify(aggregateReviews([]));
    // JSON.stringify turns NaN into null — either would be a bug here.
    expect(json).not.toContain("null");
    expect(json).not.toContain("NaN");
  });
});

describe("aggregateReviews — totals against a hand-computed fixture", () => {
  const fixture: AggregatableReview[] = [
    review({
      createdAt: "2026-08-01T09:00:00.000Z",
      mergeScore: 4,
      findingCount: 2,
      durationMs: 1000,
      estimatedCostUsd: 0.01,
      findings: [
        { severity: "critical", category: "security" },
        { severity: "info", category: "style" },
      ],
    }),
    review({
      createdAt: "2026-08-01T15:00:00.000Z",
      mergeScore: 2,
      findingCount: 1,
      durationMs: 3000,
      estimatedCostUsd: 0.03,
      findings: [{ severity: "warning", category: "bug" }],
    }),
    review({
      repoFullName: "acme/web",
      createdAt: "2026-08-02T09:00:00.000Z",
      mergeScore: 5,
      findingCount: 0,
      durationMs: 2000,
      estimatedCostUsd: 0.02,
      findings: [],
    }),
  ];

  it("counts reviews and findings", () => {
    const r = aggregateReviews(fixture);
    expect(r.totalReviews).toBe(3);
    expect(r.totalFindings).toBe(3);
  });

  it("averages merge score across reviews that have one", () => {
    // (4 + 2 + 5) / 3 = 3.666… → 3.67
    expect(aggregateReviews(fixture).avgMergeScore).toBe(3.67);
  });

  it("buckets severity and category", () => {
    const r = aggregateReviews(fixture);
    expect(r.severityBreakdown).toEqual({ critical: 1, warning: 1, info: 1 });
    expect(r.categoryBreakdown).toEqual({ security: 1, bug: 1, style: 1 });
  });

  it("distributes merge scores into integer buckets", () => {
    expect(aggregateReviews(fixture).mergeScoreDistribution).toEqual({
      1: 0, 2: 1, 3: 0, 4: 1, 5: 1,
    });
  });

  it("sums and averages cost", () => {
    const r = aggregateReviews(fixture);
    expect(r.costStats.totalCostUsd).toBe(0.06);
    expect(r.costStats.avgCostUsd).toBe(0.02);
    expect(r.costStats.costCount).toBe(3);
  });

  it("ranks repo breakdown by count descending", () => {
    expect(aggregateReviews(fixture).repoBreakdown).toEqual([
      { repo: "acme/api", count: 2 },
      { repo: "acme/web", count: 1 },
    ]);
  });

  it("averages duration", () => {
    // (1000 + 3000 + 2000) / 3 = 2000
    expect(aggregateReviews(fixture).durationStats.avgMs).toBe(2000);
    expect(aggregateReviews(fixture).durationStats.count).toBe(3);
  });
});

describe("aggregateReviews — trend series", () => {
  it("buckets by day and sorts ascending regardless of input order", () => {
    const r = aggregateReviews([
      review({ createdAt: "2026-08-03T10:00:00.000Z", mergeScore: 5 }),
      review({ createdAt: "2026-08-01T10:00:00.000Z", mergeScore: 1 }),
      review({ createdAt: "2026-08-02T10:00:00.000Z", mergeScore: 3 }),
    ]);

    expect(r.scoreTrend.map((p) => p.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });

  it("averages within a day and reports the day's review count", () => {
    const r = aggregateReviews([
      review({ createdAt: "2026-08-01T01:00:00.000Z", mergeScore: 2 }),
      review({ createdAt: "2026-08-01T23:00:00.000Z", mergeScore: 5 }),
    ]);

    expect(r.scoreTrend).toEqual([{ date: "2026-08-01", avgScore: 3.5, count: 2 }]);
  });

  it("omits days with no data rather than emitting zero-filled points", () => {
    // A gap must stay a gap — a synthesized 0 would render as a score crash.
    const r = aggregateReviews([
      review({ createdAt: "2026-08-01T10:00:00.000Z", mergeScore: 4 }),
      review({ createdAt: "2026-08-05T10:00:00.000Z", mergeScore: 4 }),
    ]);

    expect(r.scoreTrend.map((p) => p.date)).toEqual(["2026-08-01", "2026-08-05"]);
  });

  it("counts only completed reviews in the findings-per-review trend", () => {
    const r = aggregateReviews([
      review({ createdAt: "2026-08-01T10:00:00.000Z", status: "complete", findingCount: 4 }),
      review({ createdAt: "2026-08-01T11:00:00.000Z", status: "failed", findingCount: 99 }),
    ]);

    expect(r.findingsPerReviewTrend).toEqual([
      { date: "2026-08-01", avgFindings: 4, count: 1 },
    ]);
  });

  it("treats a missing findingCount on a completed review as zero", () => {
    const r = aggregateReviews([
      review({ createdAt: "2026-08-01T10:00:00.000Z", findingCount: 2 }),
      review({ createdAt: "2026-08-01T11:00:00.000Z", findingCount: undefined }),
    ]);

    expect(r.findingsPerReviewTrend).toEqual([
      { date: "2026-08-01", avgFindings: 1, count: 2 },
    ]);
  });
});

describe("aggregateReviews — status handling", () => {
  it("counts each known status", () => {
    const r = aggregateReviews([
      review({ status: "complete" }),
      review({ status: "failed" }),
      review({ status: "skipped" }),
      review({ status: "pending" }),
      review({ status: "in_progress" }),
      review({ status: "complete" }),
    ]);

    expect(r.statusCounts).toEqual({
      complete: 2, failed: 1, skipped: 1, pending: 1, in_progress: 1,
    });
  });

  it("ignores an unrecognized status instead of creating a bucket for it", () => {
    const r = aggregateReviews([review({ status: "quantum_superposition" })]);

    expect(Object.keys(r.statusCounts).sort()).toEqual([
      "complete", "failed", "in_progress", "pending", "skipped",
    ]);
    // Still counted as a review and still attributed to its repo.
    expect(r.totalReviews).toBe(1);
    expect(r.repoBreakdown).toEqual([{ repo: "acme/api", count: 1 }]);
  });

  it("excludes non-complete reviews from duration and cost", () => {
    const r = aggregateReviews([
      review({ status: "complete", durationMs: 1000, estimatedCostUsd: 0.05 }),
      review({ status: "failed", durationMs: 9999, estimatedCostUsd: 9.99 }),
      review({ status: "pending", durationMs: 8888, estimatedCostUsd: 8.88 }),
    ]);

    expect(r.durationStats.count).toBe(1);
    expect(r.durationStats.avgMs).toBe(1000);
    expect(r.costStats.costCount).toBe(1);
    expect(r.costStats.totalCostUsd).toBe(0.05);
  });
});

describe("aggregateReviews — missing and malformed optional fields", () => {
  it("skips reviews with no mergeScore without disturbing the average", () => {
    const r = aggregateReviews([
      review({ mergeScore: 4 }),
      review({ mergeScore: undefined }),
      review({ mergeScore: null }),
    ]);

    expect(r.avgMergeScore).toBe(4);
    expect(r.totalReviews).toBe(3);
  });

  it("counts a mergeScore of 0 as present, not missing", () => {
    // `!= null` rather than falsy — a 0 score is real data.
    const r = aggregateReviews([review({ mergeScore: 0 }), review({ mergeScore: 4 })]);
    expect(r.avgMergeScore).toBe(2);
    // 0 rounds outside the 1-5 distribution and is dropped from it.
    expect(r.mergeScoreDistribution[4]).toBe(1);
  });

  it("handles null and absent findings arrays", () => {
    const r = aggregateReviews([
      review({ findings: null }),
      review({ findings: undefined }),
      review({ findings: [{ severity: "critical", category: "security" }] }),
    ]);

    expect(r.totalFindings).toBe(1);
    expect(r.severityBreakdown.critical).toBe(1);
  });

  it("ignores findings with unknown or missing severity and category", () => {
    const r = aggregateReviews([
      review({
        findings: [
          { severity: "apocalyptic", category: "vibes" },
          { severity: undefined, category: undefined },
          { severity: "info", category: "style" },
        ],
      }),
    ]);

    // All three count toward the total; only the known one buckets.
    expect(r.totalFindings).toBe(3);
    expect(r.severityBreakdown).toEqual({ critical: 0, warning: 0, info: 1 });
    expect(r.categoryBreakdown).toEqual({ security: 0, bug: 0, style: 1 });
  });

  it("coerces a string cost, as the DynamoDB path can return one", () => {
    const r = aggregateReviews([
      review({ estimatedCostUsd: "0.25" }),
      review({ estimatedCostUsd: 0.25 }),
    ]);

    expect(r.costStats.totalCostUsd).toBe(0.5);
    expect(r.costStats.costCount).toBe(2);
  });

  it("counts a zero cost as priced rather than missing", () => {
    const r = aggregateReviews([review({ estimatedCostUsd: 0 })]);
    expect(r.costStats.costCount).toBe(1);
    expect(r.costStats.totalCostUsd).toBe(0);
  });

  it("skips reviews with no createdAt in the trends but still counts them", () => {
    const r = aggregateReviews([
      review({ createdAt: undefined, mergeScore: 4, findingCount: 3 }),
      review({ createdAt: "2026-08-01T10:00:00.000Z", mergeScore: 2, findingCount: 1 }),
    ]);

    expect(r.totalReviews).toBe(2);
    expect(r.scoreTrend).toEqual([{ date: "2026-08-01", avgScore: 2, count: 1 }]);
    expect(r.findingsPerReviewTrend).toHaveLength(1);
  });
});

describe("aggregateReviews — percentile behavior (see #336)", () => {
  // These assertions pin the CURRENT, KNOWN-WRONG behavior so the #333
  // extraction is provably a no-op. #336 fixes the index and must update them.
  it("currently returns the maximum for small samples (off-by-one)", () => {
    const durations = Array.from({ length: 20 }, (_, i) =>
      review({ durationMs: (i + 1) * 100 }),
    );
    const r = aggregateReviews(durations);

    // Correct nearest-rank p95 of 1..20 hundreds would be 1900; index 19 gives 2000.
    expect(r.durationStats.p95Ms).toBe(2000);
  });

  it("sorts durations numerically, not lexicographically", () => {
    // A default .sort() would order [1000, 200, 30] and corrupt every percentile.
    const r = aggregateReviews([
      review({ durationMs: 1000 }),
      review({ durationMs: 200 }),
      review({ durationMs: 30 }),
    ]);

    expect(r.durationStats.avgMs).toBe(410);
    expect(r.durationStats.p95Ms).toBe(1000);
  });
});

describe("aggregateReviews — no ceiling (#333 regression)", () => {
  /**
   * The bug this extraction exists to make testable: the route capped its fetch
   * at 500 rows and presented the result as a total. The aggregator itself must
   * have no such limit, so a fixture comfortably past the old cap and spanning
   * several months has to come back complete and fully time-covered.
   */
  const COUNT = 1234;
  const START = Date.UTC(2026, 2, 1); // 2026-03-01, ~5 months before the fixture epoch
  const DAY_MS = 24 * 60 * 60 * 1000;

  const many: AggregatableReview[] = Array.from({ length: COUNT }, (_, i) => ({
    repoFullName: i % 2 === 0 ? "acme/api" : "acme/web",
    status: "complete",
    // One review every 3 hours, walking forward across ~154 days.
    createdAt: new Date(START + i * 3 * 60 * 60 * 1000).toISOString(),
    mergeScore: (i % 5) + 1,
    findingCount: i % 4,
    durationMs: 1000 + i,
    estimatedCostUsd: 0.01,
    findings: [{ severity: "warning", category: "bug" }],
  }));

  it("counts every review past the old 500 cap", () => {
    expect(aggregateReviews(many).totalReviews).toBe(COUNT);
  });

  it("counts every finding past the old cap", () => {
    expect(aggregateReviews(many).totalFindings).toBe(COUNT);
    expect(aggregateReviews(many).severityBreakdown.warning).toBe(COUNT);
  });

  it("covers the full time span, oldest day included", () => {
    const r = aggregateReviews(many);
    const first = r.scoreTrend[0].date;
    const last = r.scoreTrend[r.scoreTrend.length - 1].date;

    expect(first).toBe("2026-03-01");
    // The oldest data is the part the truncation bug destroyed — the trend must
    // start at the beginning of the range, not 500 reviews back from the end.
    expect(new Date(last).getTime() - new Date(first).getTime()).toBeGreaterThan(
      150 * DAY_MS,
    );
  });

  it("produces a trend point for every distinct day in the span", () => {
    const r = aggregateReviews(many);
    const distinctDays = new Set(many.map((rv) => rv.createdAt!.substring(0, 10)));

    expect(r.scoreTrend).toHaveLength(distinctDays.size);
    expect(r.findingsPerReviewTrend).toHaveLength(distinctDays.size);
  });

  it("keeps the trend sorted ascending across the whole span", () => {
    const dates = aggregateReviews(many).scoreTrend.map((p) => p.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("attributes every review to a repo", () => {
    const r = aggregateReviews(many);
    const total = r.repoBreakdown.reduce((s, x) => s + x.count, 0);
    expect(total).toBe(COUNT);
  });

  it("prices every completed review", () => {
    const r = aggregateReviews(many);
    expect(r.costStats.costCount).toBe(COUNT);
    expect(r.costStats.totalCostUsd).toBeCloseTo(COUNT * 0.01, 4);
  });
});
