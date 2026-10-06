/**
 * #699 — corpus manifest and result shapes for the offline benchmark harness.
 *
 * The harness drives `runReviewPipeline` directly with an injected
 * ILLMProvider, so it needs no GitHub App installation, no open PR and no
 * billing headroom (the gate lives in the webhook and MCP paths, not in the
 * pipeline). What it DOES need is to be explicit about the two places an
 * offline run differs from production: the skip layer, and grounding.
 */

/** One expected defect in a case, with the key the grader matches on. */
export interface GroundTruth {
  /** Stable id, used in the per-case table. */
  id: string;
  /** Repo-relative path the defect lives in. */
  file: string;
  /** 1-indexed line the defect lives on. */
  line: number;
  /** Human-readable cause, for the report. NOT used for matching. */
  cause: string;
  /**
   * THE MATCH KEY. A finding counts as describing this defect only if its
   * title+description contains at least one of these keywords (normalized,
   * case-insensitive, whole-token).
   *
   * This is deliberately an explicit per-case contract rather than a cause
   * taxonomy derived from the finding: `OrchestratedFinding` carries only
   * title/description/category/evidence, so a grader that inferred the cause
   * would be asserting the constant it had just computed. The keywords come
   * from the corpus author, so the test can fail.
   */
  causeKeywords: string[];
  /** Expected severity, when the corpus records one. */
  severity?: 'info' | 'warning' | 'critical';
}

/** One case: a diff plus what a good review should say about it. */
export interface BenchCase {
  id: string;
  /** `owner/repo` of the public source repo, for grounding. */
  repo: string;
  /**
   * The REAL upstream PR number. Not a sentinel: `context.prNumber` renders
   * into every agent prompt (`reviewer.ts:252`), so a 0 would make every
   * graded prompt differ from production's.
   */
  prNumber: number;
  prTitle?: string;
  prBody?: string;
  /** Commit the diff applies to, used as the grounding `ref`. */
  headRef: string;
  /** Path to the diff, relative to the manifest file. */
  diffPath: string;
  /**
   * Changed-file count as GitHub reports it. Fed to the skip layer, which is
   * where `maxFiles` lives — so a case can legitimately be skipped.
   */
  changedFileCount?: number;
  isDraft?: boolean;
  labels?: string[];
  groundTruth: GroundTruth[];
  /**
   * Findings a STUB provider should emit for this case. Used only by
   * `--stub` runs; a real provider ignores it.
   *
   * This is what makes the smoke corpus a real control rather than a
   * formality: one case declares findings that match its ground truth (a
   * positive control) and another declares none (a negative control), so the
   * expected precision/recall/F1 are fixed by the corpus and the run can
   * fail. A stub that returned [] for everything would grade "cleanly" as
   * all-misses and exit 0 — a smoke test that cannot fail.
   */
  stubFindings?: StubFinding[];
}

/** A finding the stub emits, in the shape the agents return. */
export interface StubFinding {
  file: string;
  line: number;
  severity: 'info' | 'warning' | 'critical';
  confidence?: number;
  title: string;
  description: string;
  suggestion?: string;
}

export interface BenchManifest {
  /** Corpus name, recorded in the artifact. */
  name: string;
  /** Lines of tolerance when matching a finding's line to a ground truth. */
  lineTolerance: number;
  cases: BenchCase[];
}

/** Why a ground truth was or was not credited. */
export type GroundTruthOutcome = 'caught' | 'right-line-wrong-reason' | 'missed';

export interface GradedGroundTruth {
  id: string;
  outcome: GroundTruthOutcome;
  /** Title of the finding credited (or location-matched), when there was one. */
  matchedFindingTitle?: string;
  /** Severity the finding reported, for the severity breakdown. */
  reportedSeverity?: string;
  /** Whether the finding was reported inline (has file+line) or summary-only. */
  inline?: boolean;
}

export interface CaseGrade {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  groundTruths: GradedGroundTruth[];
}

/**
 * Per-case grounding outcomes. NOT a boolean: `file-fetcher.ts:67` swallows
 * every fetch error, so a 403 rate-limit, a 404 and an oversized file are
 * indistinguishable from "no such file". A run can therefore report itself
 * grounded while having fetched nothing, which is why `filesFetched` is
 * recorded alongside — a wrongly-set boolean cannot fake a count.
 */
export interface GroundingReport {
  enabled: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  filesFetched: number;
}

export interface CaseResult {
  id: string;
  /**
   * Set when the skip layer declined the case, carrying the skip kind
   * (`maxFiles`, `draft`, `labelIgnored`, `autoReviewOff`, …). A skipped case
   * is scored as ZERO RECALL, exactly as production behaves: a skipped PR
   * contributes no comments, so it is a recall failure rather than a
   * "correctly declined to review".
   */
  skip?: string;
  grade: CaseGrade;
  grounding: GroundingReport;
  /** Models requested from config: [model, lightModel]. */
  requestedModels: string[];
  /**
   * Every model id the provider echoed in its own response metadata. Empty
   * when the provider does not echo one, which reads as unattributable
   * rather than as a match.
   */
  reportedModels: string[];
  inputTokens: number;
  outputTokens: number;
  /** From `result.estimatedCostUsd`. Null when any model is unpriced. */
  estimatedCostUsd: number | null;
  findingCount: number;
}

export interface BenchTotals {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  casesAttempted: number;
  casesGraded: number;
  casesSkipped: number;
  spendUsd: number;
}

export interface BenchResult {
  corpus: string;
  /** Commit the harness ran at. */
  commitSha?: string;
  arm?: string;
  startedAt: string;
  totals: BenchTotals;
  cases: CaseResult[];
}
