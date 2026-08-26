/**
 * #472 Part C — presentation logic for the filtered-findings trail.
 *
 * The types are declared here rather than imported from `@mergewatch/core`.
 * Core's index pulls `context/safe-path`, which uses `node:fs/promises`, and
 * importing it into a client component fails the webpack build with
 * `UnhandledSchemeError` (found in #481). A drift test keeps these aligned
 * with core's `FilterStage` union.
 */

export type FilterStage =
  | "fp-c-line-dedup"
  | "orchestrator"
  | "w10-clustering"
  | "confidence-floor"
  | "min-severity"
  | "w11-scope-awareness"
  | "grounding"
  | "fp-i-already-applied"
  | "finding-verify"
  | "line-proximity"
  | "custom-agent-dedup"
  | "triage-suppressed";

export type Outcome = "surfaced" | "merged" | "dropped" | "demoted";

export interface FindingOutcome {
  key: string;
  file: string;
  line: number;
  severity: "critical" | "warning" | "info";
  confidence?: number;
  title: string;
  agents: string[];
  outcome: Outcome;
  stage?: FilterStage;
  reason?: string;
  mergedInto?: string;
}

/**
 * Stages that removed a finding because a model made a judgement about it,
 * versus stages that applied a rule.
 *
 * A developer auditing a missing finding cares about the judgement calls
 * first: those are where a defensible finding can be wrongly discarded. A
 * confidence floor doing exactly what it is configured to do is far less
 * interesting, and putting it first buries the part worth reading.
 */
const JUDGEMENT_STAGES: readonly FilterStage[] = [
  "finding-verify",
  "orchestrator",
  "grounding",
];

const STAGE_ORDER: readonly FilterStage[] = [
  // Judgement-bearing, most consequential first.
  "finding-verify",
  "orchestrator",
  "grounding",
  // Consolidation — nothing was lost, it was folded together.
  "w10-clustering",
  "fp-c-line-dedup",
  // Mechanical rules.
  "confidence-floor",
  "min-severity",
  "w11-scope-awareness",
  "line-proximity",
  "fp-i-already-applied",
  "custom-agent-dedup",
  "triage-suppressed",
];

export const STAGE_LABELS: Record<FilterStage, string> = {
  "finding-verify": "Verifier verdict",
  orchestrator: "Orchestrator",
  grounding: "Grounding",
  "w10-clustering": "Clustered (same region)",
  "fp-c-line-dedup": "Merged (same line, cross-agent)",
  "confidence-floor": "Confidence floor",
  "min-severity": "Severity threshold",
  "w11-scope-awareness": "Scope awareness",
  "line-proximity": "Not near a changed line",
  "fp-i-already-applied": "Already applied",
  "custom-agent-dedup": "Custom agent dedup",
  "triage-suppressed": "Suppressed by triage",
};

export function isJudgementStage(stage: FilterStage): boolean {
  return JUDGEMENT_STAGES.includes(stage);
}

export interface StageGroup {
  stage: FilterStage;
  label: string;
  judgement: boolean;
  entries: FindingOutcome[];
}

/**
 * Group non-surfaced outcomes by stage, judgement-bearing stages first.
 *
 * Surfaced findings are excluded: they are rendered above as the review's
 * result, and repeating them here would make the trail read as a second,
 * competing list of findings.
 */
export function groupByStage(outcomes: FindingOutcome[]): StageGroup[] {
  const byStage = new Map<FilterStage, FindingOutcome[]>();
  for (const o of outcomes) {
    if (o.outcome === "surfaced") continue;
    // An outcome with no stage is a wiring gap in the recorder, not a
    // category — surface it rather than silently dropping the row.
    const stage = (o.stage ?? "orchestrator") as FilterStage;
    const list = byStage.get(stage) ?? [];
    list.push(o);
    byStage.set(stage, list);
  }

  return STAGE_ORDER.filter((s) => byStage.has(s)).map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    judgement: isJudgementStage(stage),
    entries: byStage.get(stage)!,
  }));
}

/**
 * What to show in a trail entry's reason column.
 *
 * The orchestrator cannot explain itself without a schema change (#473), so
 * its drops carry a stage and no reason. Rendering that as an empty cell would
 * read as "nothing to say" — the exact coverage illusion this whole effort
 * exists to remove. It says so explicitly instead.
 */
export function reasonText(o: FindingOutcome): string {
  if (o.reason?.trim()) return o.reason.trim();
  if (o.stage === "orchestrator") return "not explained — the orchestrator does not report why (#473)";
  return "no reason recorded";
}

export interface FunnelStep {
  label: string;
  removed: number;
  remaining: number;
}

/**
 * Raw findings → each stage's removals → surfaced.
 *
 * `remaining` counts down from the total, so the last step's `remaining`
 * equals the number of surfaced findings by construction rather than by a
 * separate count that could disagree with the list above it.
 */
export function buildFunnel(outcomes: FindingOutcome[]): {
  raw: number;
  steps: FunnelStep[];
  surfaced: number;
} {
  const raw = outcomes.length;
  const surfaced = outcomes.filter((o) => o.outcome === "surfaced").length;

  let remaining = raw;
  const steps: FunnelStep[] = [];
  for (const group of groupByStage(outcomes)) {
    // Demotions do not remove a finding — it still renders, as advisory. A
    // funnel that counted them as removals would not reconcile with the list.
    const removed = group.entries.filter((e) => e.outcome !== "demoted").length;
    if (removed === 0) continue;
    remaining -= removed;
    steps.push({ label: group.label, removed, remaining });
  }

  return { raw, steps, surfaced };
}

/** Count of demoted findings — still live concerns, not removals. */
export function demotedCount(outcomes: FindingOutcome[]): number {
  return outcomes.filter((o) => o.outcome === "demoted").length;
}
