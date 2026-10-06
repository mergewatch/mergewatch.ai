import { describe, expect, it } from 'vitest';
import type { OrchestratedFinding } from '@mergewatch/core';
import { causeMatches, computeMetrics, gradeCase, gradeSkippedCase, locationMatches } from './grader.js';
import type { GroundTruth } from './types.js';

function finding(over: Partial<OrchestratedFinding> = {}): OrchestratedFinding {
  return {
    file: 'src/db.ts',
    line: 3,
    severity: 'critical',
    title: 'SQL injection via string concatenation',
    description: 'The id is concatenated into the query.',
    suggestion: 'Parameterize.',
    category: 'security',
    ...over,
  };
}

const SQLI: GroundTruth = {
  id: 'gt-sqli',
  file: 'src/db.ts',
  line: 3,
  cause: 'User input concatenated into SQL',
  causeKeywords: ['sql injection'],
};

describe('locationMatches', () => {
  it('requires the same file', () => {
    expect(locationMatches(finding({ file: 'src/other.ts' }), SQLI, 2)).toBe(false);
  });

  it('accepts a line within tolerance and rejects one outside it', () => {
    expect(locationMatches(finding({ line: 5 }), SQLI, 2)).toBe(true);
    expect(locationMatches(finding({ line: 6 }), SQLI, 2)).toBe(false);
  });
});

describe('causeMatches', () => {
  it('matches on whole tokens, not substrings', () => {
    const gt: GroundTruth = { ...SQLI, causeKeywords: ['sql'] };
    expect(causeMatches(finding({ title: 'Problem with sql here', description: '' }), gt)).toBe(true);
    // `sqlite` must NOT satisfy the keyword `sql`.
    expect(causeMatches(finding({ title: 'Problem with sqlite here', description: '' }), gt)).toBe(false);
  });

  it('requires every token of a multi-word keyword', () => {
    // "injection" alone does not satisfy the keyword "sql injection".
    expect(causeMatches(finding({ title: 'An injection bug', description: '' }), SQLI)).toBe(false);
    expect(causeMatches(finding({ title: 'An SQL injection bug', description: '' }), SQLI)).toBe(true);
  });

  it('never matches when the ground truth lists no keywords', () => {
    expect(causeMatches(finding(), { ...SQLI, causeKeywords: [] })).toBe(false);
  });
});

describe('gradeCase', () => {
  it('credits a finding that matches location and cause', () => {
    const grade = gradeCase([finding()], [SQLI], 2);
    expect(grade.truePositives).toBe(1);
    expect(grade.falseNegatives).toBe(0);
    expect(grade.falsePositives).toBe(0);
    expect(grade.groundTruths[0].outcome).toBe('caught');
    expect(grade.groundTruths[0].reportedSeverity).toBe('critical');
    expect(grade.groundTruths[0].inline).toBe(true);
  });

  it('grades the right line with the wrong reason distinctly from a catch', () => {
    // Same file and line, completely unrelated cause.
    const wrong = finding({
      title: 'Variable name could be clearer',
      description: 'Consider renaming id to userId for readability.',
    });
    const grade = gradeCase([wrong], [SQLI], 2);

    expect(grade.groundTruths[0].outcome).toBe('right-line-wrong-reason');
    // It is NOT a catch...
    expect(grade.truePositives).toBe(0);
    // ...it fails its ground truth...
    expect(grade.falseNegatives).toBe(1);
    // ...and it counts against precision, because it reported something that
    // is not the real defect.
    expect(grade.falsePositives).toBe(1);
  });

  it('scores a ground truth with no matching finding as a miss (recall 0)', () => {
    const grade = gradeCase([], [SQLI], 2);
    expect(grade.groundTruths[0].outcome).toBe('missed');
    expect(grade.truePositives).toBe(0);
    expect(grade.falseNegatives).toBe(1);
    const { recall } = computeMetrics(
      grade.truePositives,
      grade.falsePositives,
      grade.falseNegatives,
    );
    expect(recall).toBe(0);
  });

  it('prefers a correct finding over an earlier wrong one on the same line', () => {
    const wrong = finding({ title: 'Rename this variable', description: 'readability' });
    const right = finding();
    const grade = gradeCase([wrong, right], [SQLI], 2);
    expect(grade.groundTruths[0].outcome).toBe('caught');
    // The wrong one is left uncredited, so it is a false positive.
    expect(grade.falsePositives).toBe(1);
  });

  it('does not let one finding credit two ground truths', () => {
    const second: GroundTruth = { ...SQLI, id: 'gt-sqli-2' };
    const grade = gradeCase([finding()], [SQLI, second], 2);
    expect(grade.truePositives).toBe(1);
    expect(grade.falseNegatives).toBe(1);
  });

  it('counts an unrelated finding as a false positive', () => {
    const unrelated = finding({ file: 'src/elsewhere.ts', line: 99, title: 'Unused import' });
    const grade = gradeCase([finding(), unrelated], [SQLI], 2);
    expect(grade.truePositives).toBe(1);
    expect(grade.falsePositives).toBe(1);
  });

  it('marks a finding with no file or line as not inline', () => {
    const grade = gradeCase([finding({ file: '', line: 0 })], [{ ...SQLI, file: '', line: 0 }], 0);
    expect(grade.groundTruths[0].inline).toBe(false);
  });
});

describe('gradeSkippedCase', () => {
  it('scores every ground truth as missed, with no false positives', () => {
    const grade = gradeSkippedCase([SQLI, { ...SQLI, id: 'b' }]);
    expect(grade.truePositives).toBe(0);
    expect(grade.falseNegatives).toBe(2);
    expect(grade.falsePositives).toBe(0);
    expect(grade.groundTruths.every((g) => g.outcome === 'missed')).toBe(true);
  });
});

describe('computeMetrics', () => {
  // Hand-computed, not asserted as "a number between 0 and 1".
  it('computes precision, recall and F1 for a fixed confusion matrix', () => {
    // TP 3, FP 1, FN 2
    //   precision = 3/4         = 0.75
    //   recall    = 3/5         = 0.6
    //   f1        = 2*.75*.6/1.35 = 0.9/1.35 = 0.666666...
    const m = computeMetrics(3, 1, 2);
    expect(m.precision).toBeCloseTo(0.75, 10);
    expect(m.recall).toBeCloseTo(0.6, 10);
    expect(m.f1).toBeCloseTo(0.6666666666666666, 10);
  });

  it('matches the smoke corpus exactly: TP 1, FP 0, FN 1', () => {
    const m = computeMetrics(1, 0, 1);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(0.5);
    expect(m.f1).toBeCloseTo(0.6666666666666666, 10);
  });

  it('returns zeros rather than NaN when there is nothing to score', () => {
    expect(computeMetrics(0, 0, 0)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });

  it('gives perfect scores only when there are no FPs and no FNs', () => {
    expect(computeMetrics(4, 0, 0)).toEqual({ precision: 1, recall: 1, f1: 1 });
  });
});
