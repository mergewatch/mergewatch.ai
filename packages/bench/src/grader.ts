/**
 * #699 — grade pipeline findings against a case's ground truth.
 *
 * The match is two-stage and both stages are explicit, because the thing this
 * grader exists to distinguish is "found the defect" from "said something
 * about the right line":
 *
 *   1. LOCATION — same file, and within `lineTolerance` lines.
 *   2. CAUSE    — the finding's title+description contains one of the ground
 *                 truth's `causeKeywords`.
 *
 * Location without cause is `right-line-wrong-reason`, which is NOT a catch.
 *
 * Counting, stated plainly because the denominators are what make the
 * published numbers checkable:
 *   TP = ground truths graded `caught`
 *   FN = ground truths graded `missed` OR `right-line-wrong-reason`
 *   FP = findings not credited as a TP for any ground truth
 *
 * So a right-line-wrong-reason finding costs twice: it fails to credit its
 * ground truth AND counts against precision. That is deliberate — it reported
 * something that is not the real defect.
 */
import type { OrchestratedFinding } from '@mergewatch/core';
import type { CaseGrade, GradedGroundTruth, GroundTruth } from './types.js';

/** Split text into lowercased word tokens for whole-token keyword matching. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Does this finding describe the ground truth's cause?
 *
 * Whole-token containment, so `sql` does not match `sqlite` and a keyword
 * cannot be satisfied by an unrelated substring. A multi-word keyword
 * ("race condition") requires every one of its tokens to be present.
 */
export function causeMatches(finding: OrchestratedFinding, gt: GroundTruth): boolean {
  if (gt.causeKeywords.length === 0) return false;
  const tokens = tokenize(`${finding.title} ${finding.description}`);
  return gt.causeKeywords.some((keyword) => {
    const needed = [...tokenize(keyword)];
    return needed.length > 0 && needed.every((t) => tokens.has(t));
  });
}

/** Same file, and within tolerance lines. */
export function locationMatches(
  finding: OrchestratedFinding,
  gt: GroundTruth,
  lineTolerance: number,
): boolean {
  if (finding.file !== gt.file) return false;
  return Math.abs(finding.line - gt.line) <= lineTolerance;
}

/**
 * A finding is "inline" when it carries a real file and line. A summary-only
 * finding is a materially different product behaviour from an inline one —
 * #647 exists because a reviewer judged us on what they saw.
 */
function isInline(finding: OrchestratedFinding): boolean {
  return Boolean(finding.file) && finding.line > 0;
}

/**
 * Grade one case.
 *
 * Each ground truth is credited by at most one finding, and each finding
 * credits at most one ground truth, so neither count can be inflated by a
 * single finding that happens to straddle two defects.
 */
export function gradeCase(
  findings: OrchestratedFinding[],
  groundTruths: GroundTruth[],
  lineTolerance: number,
): CaseGrade {
  /**
   * Findings credited as a CATCH. Drives the false-positive count, so only
   * true positives may ever go in here.
   */
  const creditedFindings = new Set<number>();
  /**
   * Findings already attached to some ground truth, as a catch OR as a
   * right-line-wrong-reason. Kept separate from `creditedFindings` because
   * the two answer different questions: this one stops a single finding being
   * re-used by a second ground truth, while that one decides precision.
   *
   * Collapsing them would under-count false positives — a
   * right-line-wrong-reason finding would be treated as credited and vanish
   * from the FP total, which contradicts the counting rule in this file's
   * header (such a finding is meant to cost twice).
   */
  const consumedFindings = new Set<number>();
  const graded: GradedGroundTruth[] = [];

  for (const gt of groundTruths) {
    // Prefer a finding that matches BOTH location and cause. Only if none
    // does, fall back to recording a location-only match, so one correct
    // finding is never masked by an earlier wrong one on the same line.
    let caughtIdx = -1;
    let locationOnlyIdx = -1;

    for (let i = 0; i < findings.length; i++) {
      if (consumedFindings.has(i)) continue;
      if (!locationMatches(findings[i], gt, lineTolerance)) continue;
      if (causeMatches(findings[i], gt)) {
        caughtIdx = i;
        break;
      }
      if (locationOnlyIdx === -1) locationOnlyIdx = i;
    }

    if (caughtIdx !== -1) {
      creditedFindings.add(caughtIdx);
      consumedFindings.add(caughtIdx);
      const f = findings[caughtIdx];
      graded.push({
        id: gt.id,
        outcome: 'caught',
        matchedFindingTitle: f.title,
        reportedSeverity: f.severity,
        inline: isInline(f),
      });
    } else if (locationOnlyIdx !== -1) {
      consumedFindings.add(locationOnlyIdx);
      const f = findings[locationOnlyIdx];
      graded.push({
        id: gt.id,
        outcome: 'right-line-wrong-reason',
        matchedFindingTitle: f.title,
        reportedSeverity: f.severity,
        inline: isInline(f),
      });
    } else {
      graded.push({ id: gt.id, outcome: 'missed' });
    }
  }

  const truePositives = graded.filter((g) => g.outcome === 'caught').length;
  const falseNegatives = graded.length - truePositives;
  const falsePositives = findings.length - creditedFindings.size;

  return { truePositives, falsePositives, falseNegatives, groundTruths: graded };
}

/**
 * A skipped case: every ground truth is a miss and there are no findings, so
 * it contributes zero recall and no false positives. This is what production
 * does — the review never runs, so nothing is reported.
 */
export function gradeSkippedCase(groundTruths: GroundTruth[]): CaseGrade {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: groundTruths.length,
    groundTruths: groundTruths.map((gt) => ({ id: gt.id, outcome: 'missed' as const })),
  };
}

/** Precision, recall and F1 — reported separately, never F1 alone. */
export function computeMetrics(tp: number, fp: number, fn: number): {
  precision: number;
  recall: number;
  f1: number;
} {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}
