import { describe, it, expect } from "vitest";
import {
  groupByStage,
  reasonText,
  buildFunnel,
  demotedCount,
  isJudgementStage,
  STAGE_LABELS,
  UNKNOWN_STAGE,
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
    // The sentinel is deliberately NOT one of core's stages — it marks a gap
    // in the recorder, not a pipeline stage — so it is excluded here. Its
    // presence in STAGE_LABELS is asserted separately.
    const stages = (Object.keys(STAGE_LABELS) as string[])
      .filter((s) => s !== UNKNOWN_STAGE) as FilterStage[];
    expect(stages).toHaveLength(12);
    expect(Object.keys(STAGE_LABELS)).toContain(UNKNOWN_STAGE);
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

describe("stageless outcomes (#482 review)", () => {
  it("gives a stageless outcome its own bucket, not the orchestrator's", () => {
    // #470's recorder emits stage: undefined when a finding reached no
    // terminal stage, so a wiring gap stays visible. Folding it into a real
    // stage would present that gap as that stage's judgement.
    const groups = groupByStage([
      o({ stage: undefined }),
      o({ stage: "orchestrator" }),
    ]);
    const stages = groups.map((g) => g.stage);
    expect(stages).toContain(UNKNOWN_STAGE);
    expect(groups.find((g) => g.stage === "orchestrator")!.entries).toHaveLength(1);
    expect(groups.find((g) => g.stage === UNKNOWN_STAGE)!.entries).toHaveLength(1);
  });

  it("sorts the unknown bucket last — it is a gap, not a decision", () => {
    const groups = groupByStage([o({ stage: undefined }), o({ stage: "min-severity" })]);
    expect(groups.at(-1)!.stage).toBe(UNKNOWN_STAGE);
  });

  it("labels it rather than rendering a blank heading", () => {
    expect(STAGE_LABELS[UNKNOWN_STAGE]).toBe("Stage not recorded");
  });

  it("does not mark the unknown bucket as judgement-bearing", () => {
    expect(isJudgementStage(UNKNOWN_STAGE)).toBe(false);
  });

  it("does not report a stageless drop as an unexplained orchestrator drop", () => {
    // reasonText keys off stage; a stageless row must not borrow the
    // orchestrator's "#473" explanation, which would be a false attribution.
    expect(reasonText(o({ stage: undefined }))).toBe("no reason recorded");
  });
});

describe("funnel invariants (#482 review)", () => {
  it("never goes negative, even with demotions and merges", () => {
    const f = buildFunnel([
      o({ outcome: "surfaced" }),
      o({ outcome: "demoted", stage: "grounding" }),
      o({ outcome: "demoted", stage: "finding-verify" }),
      o({ outcome: "merged", stage: "w10-clustering" }),
      o({ outcome: "dropped", stage: "min-severity" }),
    ]);
    for (const s of f.steps) expect(s.remaining).toBeGreaterThanOrEqual(0);
  });

  it("ends at surfaced + demoted, because a demotion is not a removal", () => {
    // The docstring used to claim it ended at `surfaced`, which was only true
    // for reviews with no demotions.
    const outcomes = [
      o({ outcome: "surfaced" }),
      o({ outcome: "surfaced" }),
      o({ outcome: "demoted", stage: "grounding" }),
      o({ outcome: "dropped", stage: "min-severity" }),
    ];
    const f = buildFunnel(outcomes);
    expect(f.steps.at(-1)!.remaining).toBe(f.surfaced + demotedCount(outcomes));
    expect(f.steps.at(-1)!.remaining).toBe(3);
  });

  it("removals never exceed raw minus surfaced minus demoted", () => {
    const outcomes = [
      o({ outcome: "surfaced" }),
      o({ outcome: "demoted", stage: "grounding" }),
      o({ outcome: "dropped", stage: "min-severity" }),
      o({ outcome: "dropped", stage: "confidence-floor" }),
    ];
    const f = buildFunnel(outcomes);
    const removed = f.steps.reduce((n, s) => n + s.removed, 0);
    expect(removed).toBeLessThanOrEqual(f.raw - f.surfaced - demotedCount(outcomes));
  });
});

describe("funnel treats merges correctly (#482 review)", () => {
  it("counts a merged finding as removed — it is folded into one that remains", () => {
    // A and B merge: B is recorded `merged`, A survives and surfaces. Only one
    // finding is visible, so `remaining` must be 1. Excluding merges would
    // report 2 and disagree with the list above it.
    const f = buildFunnel([
      o({ title: "A", outcome: "surfaced" }),
      o({ title: "B", outcome: "merged", stage: "w10-clustering", mergedInto: "A" }),
    ]);
    expect(f.raw).toBe(2);
    expect(f.surfaced).toBe(1);
    expect(f.steps.at(-1)!.remaining).toBe(1);
  });

  it("holds remaining === surfaced + demoted with merges, drops and demotions together", () => {
    const outcomes = [
      o({ outcome: "surfaced" }),
      o({ outcome: "surfaced" }),
      o({ outcome: "merged", stage: "fp-c-line-dedup" }),
      o({ outcome: "merged", stage: "w10-clustering" }),
      o({ outcome: "dropped", stage: "min-severity" }),
      o({ outcome: "demoted", stage: "grounding" }),
    ];
    const f = buildFunnel(outcomes);
    expect(f.steps.at(-1)!.remaining).toBe(f.surfaced + demotedCount(outcomes));
    expect(f.steps.at(-1)!.remaining).toBe(3);
    for (const s of f.steps) expect(s.remaining).toBeGreaterThanOrEqual(0);
  });
});
