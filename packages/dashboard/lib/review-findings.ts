/**
 * #472 Part A — presentation helpers for the review detail page.
 *
 * The review detail page rendered no findings, no summary and no merge score,
 * not because the data was missing but because `page.tsx` fetched the review
 * and passed a subset of it to the component. These helpers hold the ordering
 * and counting logic so it is testable without rendering — matching how the
 * rest of the dashboard's logic is tested (pure functions in `lib/`).
 */

export type Severity = "critical" | "warning" | "info";

export interface FindingEvidence {
  code?: string;
  codeStartLine?: number;
  reason?: string;
  agents?: string[];
}

export interface DetailFinding {
  file: string;
  line: number;
  severity: Severity;
  confidence?: number;
  category?: string;
  title: string;
  description?: string;
  suggestion?: string;
  verification?: "verified" | "unverified";
  /** #469 — per-finding proof, rendered in full here (#472 Part B). */
  evidence?: FindingEvidence;
}

/**
 * #472 Part B — confidence against the floor that was actually in force.
 *
 * Deliberately cut from the PR comment as too jargon-heavy for that surface,
 * but exactly what someone auditing a finding on the dashboard wants: "82%"
 * alone does not say whether it nearly missed the cut.
 */
export function confidenceVsFloor(
  confidence: number | undefined,
  floor: number | undefined,
): string | null {
  if (confidence == null) return null;
  if (floor == null) return `${confidence}%`;
  return `${confidence}% (floor ${floor})`;
}

/**
 * #472 Part B — the grounding result in words.
 *
 * "anchor confirmed" is internal jargon nobody can act on in a PR comment,
 * which is why #469 kept it out. On the dashboard, where the reader has
 * deliberately opened the evidence, it is the answer to "did anything check
 * that this line exists?".
 */
export function groundingSummary(f: {
  verification?: "verified" | "unverified";
  evidence?: FindingEvidence;
}): string {
  const anchored = Boolean(f.evidence?.code?.trim());
  if (f.verification === "verified") {
    return anchored ? "Anchor confirmed · verified against the file" : "Verified against the file";
  }
  if (f.verification === "unverified") {
    return anchored
      ? "Anchor confirmed · the verifier could not confirm the defect"
      : "The verifier could not confirm the defect";
  }
  return anchored ? "Anchor confirmed · not verified" : "No grounding recorded";
}

/**
 * Severity order, matching the PR comment's SEVERITY_META. The dashboard and
 * the comment describe the same review, so they order findings the same way.
 */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Strongest severity first, original order preserved within a severity.
 *
 * Stability matters: the orchestrator already ranked findings, so re-sorting
 * within a severity would discard that ranking for no reason.
 */
export function sortFindingsBySeverity<T extends { severity?: string }>(findings: T[]): T[] {
  return [...findings]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ra = SEVERITY_ORDER[a.f.severity as Severity] ?? SEVERITY_ORDER.info;
      const rb = SEVERITY_ORDER[b.f.severity as Severity] ?? SEVERITY_ORDER.info;
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .map(({ f }) => f);
}

/** Count findings per severity. Unknown severities fall into `info`. */
export function severityCounts(findings: Array<{ severity?: string }>): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) {
    const s = (f.severity as Severity) in counts ? (f.severity as Severity) : "info";
    counts[s] += 1;
  }
  return counts;
}

/**
 * A one-line summary of what the review found, e.g. "2 critical · 1 warning".
 * Severities with no findings are omitted rather than rendered as "0 critical",
 * which reads as a result rather than an absence.
 */
export function findingsSummaryLine(findings: Array<{ severity?: string }>): string {
  const counts = severityCounts(findings);
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
  if (counts.info) parts.push(`${counts.info} info`);
  return parts.join(" · ");
}

/**
 * Verdict wording for a merge score, clamped to 1–5.
 *
 * Duplicated from `@mergewatch/core`'s `mergeScoreMeta` on purpose. Importing
 * core into a **client** component pulls its whole index — including
 * `context/safe-path.js`, which uses `node:fs/promises` — and the webpack
 * build fails with `UnhandledSchemeError`. Core stays server-side.
 *
 * The copy is kept honest by a test that imports the real `mergeScoreMeta` and
 * asserts both agree for every score, so drift fails CI rather than shipping a
 * dashboard whose verdict disagrees with the PR comment.
 */
const MERGE_SCORE_LABELS: Record<number, { emoji: string; label: string }> = {
  5: { emoji: "🟢", label: "Safe to merge" },
  4: { emoji: "🟢", label: "Generally safe" },
  3: { emoji: "🟡", label: "Review recommended" },
  2: { emoji: "🟠", label: "Needs fixes" },
  1: { emoji: "🔴", label: "Do not merge" },
};

export function mergeScoreMeta(score: number): { emoji: string; label: string; score: number } {
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  return { ...MERGE_SCORE_LABELS[clamped], score: clamped };
}
