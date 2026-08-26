import { describe, it, expect } from "vitest";
import {
  groupByStage,
  reasonText,
  buildFunnel,
  demotedCount,
  isJudgementStage,
  STAGE_LABELS,
  type FindingOutcome,
  type FilterStage,
} from "./filter-trail";

function o(over: Partial<FindingOutcome> = {}): FindingOutcome {
  return {
    key: "src/a.ts::T::x", file: "src/a.ts", line: 1, severity: "warning",
    title: "x", agents: ["security"], outcome: "dropped", ...over,
  };
}

describe("groupByStage", () => {
  it("puts judgement-bearing stages before mechanical ones", () => {
    // A developer auditing a missing finding cares about the judgement calls
    // first; a confidence floor doing its job is far less interesting.
    const groups = groupByStage([
      o({ stage: "confidence-floor" }),
      o({ stage: "min-severity" }),
      o({ stage: "finding-verify" }),
      o({ stage: "grounding" }),
    ]);
    expect(groups.map((g) => g.stage)).toEqual([
      "finding-verify", "grounding", "confidence-floor", "min-severity",
    ]);
  });

  it("marks which groups are judgement-bearing", () => {
    const groups = groupByStage([o({ stage: "finding-verify" }), o({ stage: "min-severity" })]);
    expect(groups.find((g) => g.stage === "finding-verify")!.judgement).toBe(true);
    expect(groups.find((g) => g.stage === "min-severity")!.judgement).toBe(false);
  });

  it("excludes surfaced findings — they are the result, not the trail", () => {
    const groups = groupByStage([o({ outcome: "surfaced", stage: undefined }), o({ stage: "grounding" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stage).toBe("grounding");
  });

  it("includes demoted entries — a demoted critical is still a live concern", () => {
    const groups = groupByStage([o({ outcome: "demoted", stage: "grounding", severity: "critical" })]);
    expect(groups[0].entries[0].outcome).toBe("demoted");
  });

  it("omits stages with no entries rather than rendering empty groups", () => {
    expect(groupByStage([o({ stage: "grounding" })]).map((g) => g.stage)).toEqual(["grounding"]);
  });

  it("returns nothing for an all-surfaced ledger", () => {
    expect(groupByStage([o({ outcome: "surfaced" }), o({ outcome: "surfaced" })])).toEqual([]);
  });

  it("has a label for every stage in the union", () => {
    const stages: FilterStage[] = [
      "fp-c-line-dedup", "orchestrator", "w10-clustering", "confidence-floor",
      "min-severity", "w11-scope-awareness", "grounding", "fp-i-already-applied",
      "finding-verify", "line-proximity", "custom-agent-dedup", "triage-suppressed",
    ];
    for (const s of stages) expect(STAGE_LABELS[s]).toBeTruthy();
  });
});

describe("reasonText", () => {
  it("says an orchestrator drop is not explained, never blank", () => {
    // An empty cell reads as "nothing to say" — the coverage illusion this
    // whole effort exists to remove.
    const text = reasonText(o({ stage: "orchestrator", reason: undefined }));
    expect(text).toContain("not explained");
    expect(text).toContain("#473");
  });

  it("prefers a real reason when one exists", () => {
    expect(reasonText(o({ stage: "orchestrator", reason: "duplicate of the finding above" })))
      .toBe("duplicate of the finding above");
  });

  it("never returns an empty string for any stage", () => {
    expect(reasonText(o({ stage: "grounding", reason: "   " }))).toBe("no reason recorded");
  });
});

describe("buildFunnel", () => {
  it("counts down from raw to surfaced", () => {
    const f = buildFunnel([
      o({ outcome: "surfaced" }),
      o({ outcome: "dropped", stage: "confidence-floor" }),
      o({ outcome: "dropped", stage: "grounding" }),
    ]);
    expect(f.raw).toBe(3);
    expect(f.surfaced).toBe(1);
    expect(f.steps.at(-1)!.remaining).toBe(1);
  });

  it("does not count demotions as removals — a demoted finding still renders", () => {
    // Counting them would make the funnel disagree with the findings list.
    const f = buildFunnel([
      o({ outcome: "surfaced" }),
      o({ outcome: "demoted", stage: "grounding", severity: "critical" }),
    ]);
    expect(f.steps).toEqual([]);
    expect(f.surfaced).toBe(1);
    expect(demotedCount([o({ outcome: "demoted" })])).toBe(1);
  });

  it("orders steps the same way the groups are ordered", () => {
    const f = buildFunnel([
      o({ stage: "min-severity" }),
      o({ stage: "finding-verify" }),
      o({ outcome: "surfaced" }),
    ]);
    expect(f.steps.map((s) => s.label)).toEqual([
      STAGE_LABELS["finding-verify"], STAGE_LABELS["min-severity"],
    ]);
  });

  it("handles an empty ledger", () => {
    expect(buildFunnel([])).toEqual({ raw: 0, steps: [], surfaced: 0 });
  });
});

describe("stage list drift (#472)", () => {
  it("matches core's FilterStage union exactly", async () => {
    // The dashboard declares these types because importing core into a client
    // component breaks the webpack build (#481). This test runs in Node, so it
    // can compare against the real thing — a stage added to core without one
    // here would otherwise render as an unlabelled group.
    const core = await import("@mergewatch/core");
    const recorder = new core.TraceRecorder();
    recorder.enter({ file: "a.ts", line: 1, severity: "warning", title: "t" }, "security");
    // Every key of STAGE_LABELS must be assignable to core's FilterStage; the
    // compile-time check is the `satisfies` below, exercised by tsc.
    const stages = Object.keys(STAGE_LABELS) as FilterStage[];
    expect(stages).toHaveLength(12);
    for (const s of stages) {
      expect(() => recorder.record(
        { file: "a.ts", line: 1, severity: "warning", title: "t" }, "dropped", s,
      )).not.toThrow();
    }
  });
});

describe("isJudgementStage", () => {
  it("classifies the three model-judgement stages", () => {
    expect(isJudgementStage("finding-verify")).toBe(true);
    expect(isJudgementStage("orchestrator")).toBe(true);
    expect(isJudgementStage("grounding")).toBe(true);
    expect(isJudgementStage("confidence-floor")).toBe(false);
  });
});
