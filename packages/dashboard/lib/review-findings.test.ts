import { describe, it, expect } from "vitest";
import {
  sortFindingsBySeverity,
  severityCounts,
  findingsSummaryLine,
  mergeScoreMeta,
  confidenceVsFloor,
  groundingSummary,
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
    // Integers AND fractionals: the #481 review found the dashboard rounded
    // while core did not, and an integer-only check could never see it.
    for (const score of [1, 1.4, 2, 2.5, 3, 3.7, 4, 4.9, 5, 0, 99]) {
      expect(mergeScoreMeta(score)).toEqual(core.mergeScoreMeta(score));
    }
  });
});

describe("confidenceVsFloor (#472 Part B)", () => {
  it("shows the floor that was in force, not just the score", () => {
    // "82%" alone does not say whether it nearly missed the cut.
    expect(confidenceVsFloor(82, 75)).toBe("82% (floor 75)");
  });

  it("falls back to the bare score when no floor is known", () => {
    expect(confidenceVsFloor(82, undefined)).toBe("82%");
  });

  it("renders nothing when the finding is unscored", () => {
    expect(confidenceVsFloor(undefined, 75)).toBeNull();
  });
});

describe("groundingSummary (#472 Part B)", () => {
  it("reports a verified finding with a confirmed anchor", () => {
    expect(groundingSummary({ verification: "verified", evidence: { code: "x = 1" } }))
      .toContain("Anchor confirmed");
  });

  it("says plainly when the verifier could not confirm", () => {
    expect(groundingSummary({ verification: "unverified", evidence: { code: "x = 1" } }))
      .toContain("could not confirm");
  });

  it("does not claim an anchor when there is no cited code", () => {
    expect(groundingSummary({ verification: "verified" })).not.toContain("Anchor confirmed");
  });

  it("says nothing was recorded rather than implying a pass", () => {
    expect(groundingSummary({})).toBe("No grounding recorded");
  });

  it("treats blank cited code as no anchor", () => {
    expect(groundingSummary({ evidence: { code: "   " } })).toBe("No grounding recorded");
  });
});
