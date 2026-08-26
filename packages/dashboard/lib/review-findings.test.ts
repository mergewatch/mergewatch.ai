import { describe, it, expect } from "vitest";
import {
  sortFindingsBySeverity,
  severityCounts,
  findingsSummaryLine,
  mergeScoreMeta,
} from "./review-findings";

const f = (severity: string, title: string) => ({ severity, title });

describe("sortFindingsBySeverity", () => {
  it("orders critical, warning, info", () => {
    const out = sortFindingsBySeverity([f("info", "i"), f("critical", "c"), f("warning", "w")]);
    expect(out.map((x) => x.title)).toEqual(["c", "w", "i"]);
  });

  it("preserves the orchestrator's ranking within a severity", () => {
    // The orchestrator already ranked these; re-sorting within a severity
    // would discard that for no reason.
    const out = sortFindingsBySeverity([f("critical", "first"), f("critical", "second")]);
    expect(out.map((x) => x.title)).toEqual(["first", "second"]);
  });

  it("does not mutate its input", () => {
    const input = [f("info", "i"), f("critical", "c")];
    sortFindingsBySeverity(input);
    expect(input.map((x) => x.title)).toEqual(["i", "c"]);
  });

  it("treats an unknown severity as info rather than dropping it", () => {
    const out = sortFindingsBySeverity([f("bogus", "b"), f("critical", "c")]);
    expect(out.map((x) => x.title)).toEqual(["c", "b"]);
  });

  it("handles an empty list", () => {
    expect(sortFindingsBySeverity([])).toEqual([]);
  });
});

describe("severityCounts", () => {
  it("counts each severity", () => {
    expect(severityCounts([f("critical", "a"), f("critical", "b"), f("info", "c")]))
      .toEqual({ critical: 2, warning: 0, info: 1 });
  });

  it("buckets an unknown severity into info", () => {
    expect(severityCounts([f("bogus", "a")])).toEqual({ critical: 0, warning: 0, info: 1 });
  });

  it("returns all zeros for no findings", () => {
    expect(severityCounts([])).toEqual({ critical: 0, warning: 0, info: 0 });
  });
});

describe("findingsSummaryLine", () => {
  it("omits severities with no findings", () => {
    // "0 critical" reads as a result; an absence should simply not appear.
    expect(findingsSummaryLine([f("warning", "w")])).toBe("1 warning");
  });

  it("pluralises warnings", () => {
    expect(findingsSummaryLine([f("warning", "a"), f("warning", "b")])).toBe("2 warnings");
  });

  it("joins multiple severities in severity order", () => {
    expect(findingsSummaryLine([f("info", "i"), f("critical", "c"), f("warning", "w")]))
      .toBe("1 critical · 1 warning · 1 info");
  });

  it("is empty for no findings", () => {
    expect(findingsSummaryLine([])).toBe("");
  });
});

describe("mergeScoreMeta", () => {
  it("clamps out-of-range scores", () => {
    expect(mergeScoreMeta(0).score).toBe(1);
    expect(mergeScoreMeta(9).score).toBe(5);
  });

  it("agrees with the PR comment's wording for every score", async () => {
    // The dashboard copy exists because importing core into a CLIENT component
    // pulls node:fs via context/safe-path and breaks the webpack build. This
    // test runs in Node, where importing core is fine — so drift fails CI
    // instead of shipping a dashboard that contradicts the PR comment.
    const core = await import("@mergewatch/core");
    for (const score of [1, 2, 3, 4, 5]) {
      expect(mergeScoreMeta(score)).toEqual(core.mergeScoreMeta(score));
    }
  });
});
