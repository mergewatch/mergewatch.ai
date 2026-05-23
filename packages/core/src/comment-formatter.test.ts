import { describe, it, expect } from 'vitest';
import { formatReviewComment, buildWorkDoneSection, type Finding } from './comment-formatter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: 'src/db.ts',
    line: 15,
    severity: 'critical',
    confidence: 90,
    category: 'security',
    title: 'SQL injection risk',
    description: 'User input is not sanitized.',
    suggestion: 'Use parameterized queries.',
    ...overrides,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'This PR adds input validation to the Express server.',
    findings: [] as Finding[],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('formatReviewComment', () => {
  // Header
  it('contains the mergewatch header image', () => {
    const result = formatReviewComment(baseOptions());
    expect(result).toContain('mergewatch-wordmark.svg');
  });

  // Zero findings
  it('shows all-clear message when there are zero findings', () => {
    const result = formatReviewComment(baseOptions());
    expect(result).toContain('All clear!');
    expect(result).toContain('looks good to go');
  });

  // Custom footer
  it('includes custom commentFooter in output', () => {
    const result = formatReviewComment(baseOptions({ commentFooter: 'Powered by ACME Corp' }));
    expect(result).toContain('Powered by ACME Corp');
  });

  // showSummary: false
  it('omits summary text when showSummary is false', () => {
    const result = formatReviewComment(baseOptions({ showSummary: false }));
    expect(result).not.toContain('input validation');
  });

  // Critical findings in attention table
  it('renders critical findings in "Requires your attention" table', () => {
    const findings = [makeFinding({ severity: 'critical' })];
    const result = formatReviewComment(baseOptions({ findings }));
    expect(result).toContain('Requires your attention');
    expect(result).toContain('SQL injection risk');
  });

  // Warning findings in collapsed section
  it('renders warning findings in collapsed details section', () => {
    const findings = [makeFinding({ severity: 'warning', title: 'Unused variable' })];
    const result = formatReviewComment(baseOptions({ findings }));
    expect(result).toContain('<details><summary>');
    expect(result).toContain('Warnings (1)');
    expect(result).toContain('Unused variable');
  });

  // Info findings in collapsed section
  it('renders info findings in collapsed details section', () => {
    const findings = [makeFinding({ severity: 'info', title: 'Consider refactoring' })];
    const result = formatReviewComment(baseOptions({ findings }));
    expect(result).toContain('<details><summary>');
    expect(result).toContain('Info (1)');
    expect(result).toContain('Consider refactoring');
  });

  // Severity ordering — critical section appears before warning section
  it('renders critical section before warning section', () => {
    const findings = [
      makeFinding({ severity: 'warning', title: 'Style issue', file: 'src/style.ts' }),
      makeFinding({ severity: 'critical', title: 'Buffer overflow', file: 'src/buf.ts' }),
    ];
    const result = formatReviewComment(baseOptions({ findings }));
    const criticalSectionIdx = result.indexOf('Critical (1)');
    const warningSectionIdx = result.indexOf('Warnings (1)');
    expect(criticalSectionIdx).toBeGreaterThan(-1);
    expect(warningSectionIdx).toBeGreaterThan(-1);
    expect(criticalSectionIdx).toBeLessThan(warningSectionIdx);
  });

  // showConfidence: true shows confidence badge
  it('shows confidence percentage when showConfidence is true', () => {
    const findings = [makeFinding({ confidence: 85 })];
    const result = formatReviewComment(baseOptions({ findings, showConfidence: true }));
    expect(result).toContain('85%');
  });

  // showConfidence: false hides confidence badge
  it('hides confidence percentage when showConfidence is false', () => {
    const findings = [makeFinding({ confidence: 85 })];
    const result = formatReviewComment(baseOptions({ findings, showConfidence: false }));
    expect(result).not.toContain('85%');
  });

  // Merge score rendering
  it('renders merge score badge with score 5 as green safe-to-merge', () => {
    const result = formatReviewComment(baseOptions({ mergeScore: 5 }));
    expect(result).toContain('5/5');
    expect(result).toContain('Safe to merge');
  });

  it('renders merge score badge with score 1 as do-not-merge', () => {
    const result = formatReviewComment(baseOptions({ mergeScore: 1 }));
    expect(result).toContain('1/5');
    expect(result).toContain('Do not merge');
  });

  // mergeScoreReason
  it('includes mergeScoreReason after the badge', () => {
    const result = formatReviewComment(baseOptions({
      mergeScore: 3,
      mergeScoreReason: 'Several warnings need attention',
    }));
    expect(result).toContain('Several warnings need attention');
  });

  // Diagram in mermaid code fence
  it('embeds valid diagram in mermaid code fence', () => {
    const diagram = 'graph LR\n  A --> B';
    const result = formatReviewComment(baseOptions({ diagram, showDiagram: true }));
    expect(result).toContain('```mermaid');
    expect(result).toContain('graph LR');
    expect(result).toContain('A --> B');
  });

  // showDiagram: false
  it('omits diagram when showDiagram is false', () => {
    const diagram = 'graph LR\n  A --> B';
    const result = formatReviewComment(baseOptions({ diagram, showDiagram: false }));
    expect(result).not.toContain('```mermaid');
  });

  // Review details section
  it('shows review details with tokens, cost, duration, and model', () => {
    const result = formatReviewComment(baseOptions({
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.0123,
      durationMs: 4500,
      model: 'claude-sonnet-4-20250514',
    }));
    expect(result).toContain('Review details');
    expect(result).toContain('1,500 tokens');
    expect(result).toContain('$0.0123');
    expect(result).toContain('4.5s');
    expect(result).toContain('claude-sonnet-4-20250514');
  });

  // workDone section
  it('renders workDone section stats', () => {
    const result = formatReviewComment(baseOptions({
      workDone: {
        filesScanned: 10,
        linesScanned: 500,
        agentsRan: 4,
        hasDependencyFiles: true,
      },
    }));
    expect(result).toContain('10');
    expect(result).toContain('500');
    expect(result).toContain('4');
    expect(result).toContain('dependency files detected');
  });

  // Delta section
  it('renders delta section with resolved and new counts', () => {
    const result = formatReviewComment(baseOptions({
      delta: {
        resolvedCount: 3, newCount: 1, carriedOverCount: 2,
        resolved: [], new: [], carriedOver: [],
      },
    }));
    expect(result).toContain('3');
    expect(result).toContain('resolved');
    expect(result).toContain('1');
    expect(result).toContain('new');
    expect(result).toContain('2');
    expect(result).toContain('carried over');
  });

  it('renders the collapsed "Previously reported findings" section with resolved and carried-over items', () => {
    const result = formatReviewComment(baseOptions({
      delta: {
        resolvedCount: 2,
        newCount: 0,
        carriedOverCount: 1,
        resolved: [
          { file: 'a.ts', line: 10, title: 'Stale comment' },
          { file: 'b.ts', line: 22, title: 'Missing test' },
        ],
        new: [],
        carriedOver: [
          { file: 'c.ts', line: 42, title: 'Prompt injection concern' },
        ],
      },
    }));
    expect(result).toContain('Previously reported findings');
    expect(result).toContain('Resolved on this commit');
    expect(result).toContain('Still present');
    expect(result).toContain('a.ts:10');
    expect(result).toContain('Stale comment');
    expect(result).toContain('c.ts:42');
    expect(result).toContain('Prompt injection concern');
  });

  it('omits the "Previously reported findings" section when there are no prior findings', () => {
    const result = formatReviewComment(baseOptions({ delta: null }));
    expect(result).not.toContain('Previously reported findings');
  });

  // reviewDetailUrl
  it('renders reviewDetailUrl as a link', () => {
    const url = 'https://mergewatch.ai/reviews/123';
    const result = formatReviewComment(baseOptions({ reviewDetailUrl: url }));
    expect(result).toContain(`[View full details](${url})`);
  });

  // suppressedCount
  it('shows suppressed count when provided', () => {
    const result = formatReviewComment(baseOptions({
      suppressedCount: 5,
      inputTokens: 100,
      outputTokens: 50,
    }));
    expect(result).toContain('5 findings removed by dedup');
  });

  // showIssuesTable: false
  it('shows issue count but no table when showIssuesTable is false', () => {
    const findings = [makeFinding()];
    const result = formatReviewComment(baseOptions({ findings, showIssuesTable: false }));
    expect(result).toContain('1 issue found');
    expect(result).not.toContain('Requires your attention');
  });

  // deltaCaption — re-review summary line
  it('renders deltaCaption with the 📝 lead between delta strip and merge score', () => {
    const result = formatReviewComment(baseOptions({
      deltaCaption: 'Resolved 2 prior style findings; introduced 1 new logic bug.',
      mergeScore: 3,
    }));
    expect(result).toContain('📝 Resolved 2 prior style findings; introduced 1 new logic bug.');
    // The caption appears before the merge-score line
    const captionIdx = result.indexOf('📝 Resolved');
    const scoreIdx = result.indexOf('3/5');
    expect(captionIdx).toBeGreaterThan(-1);
    expect(scoreIdx).toBeGreaterThan(captionIdx);
  });

  it('omits the deltaCaption block when caption is null', () => {
    const result = formatReviewComment(baseOptions({ deltaCaption: null }));
    expect(result).not.toContain('📝');
  });

  it('omits the deltaCaption block when caption is empty whitespace', () => {
    const result = formatReviewComment(baseOptions({ deltaCaption: '   ' }));
    expect(result).not.toContain('📝');
  });

  // ─── FP-L — verification-aware rendering ────────────────────────────────
  describe('FP-L verification propagation', () => {
    it('omits unverified critical from the "Requires your attention" action-items table', () => {
      const findings = [
        makeFinding({ title: 'Unverified SQL', verification: 'unverified' }),
      ];
      const result = formatReviewComment(baseOptions({ findings }));
      // The action-items table header is suppressed when no action findings remain
      expect(result).not.toContain('Requires your attention');
      // But the finding still appears below in the Unverified concerns section
      expect(result).toContain('Unverified SQL');
    });

    it('keeps verified criticals in the "Requires your attention" action-items table', () => {
      const findings = [
        makeFinding({ title: 'Confirmed SQL', verification: 'verified' }),
      ];
      const result = formatReviewComment(baseOptions({ findings }));
      expect(result).toContain('Requires your attention');
      expect(result).toContain('Confirmed SQL');
    });

    it('keeps criticals with no verification field in the action-items table (pre-W2 back-compat)', () => {
      const findings = [makeFinding({ title: 'Legacy critical' })]; // no verification
      const result = formatReviewComment(baseOptions({ findings }));
      expect(result).toContain('Requires your attention');
      expect(result).toContain('Legacy critical');
    });

    it('renders a separate "Unverified concerns" section for unverified criticals with the advisory subtitle', () => {
      const findings = [
        makeFinding({ title: 'Maybe-leak', verification: 'unverified' }),
      ];
      const result = formatReviewComment(baseOptions({ findings }));
      expect(result).toContain('Unverified concerns (1)');
      expect(result).toContain("verifier couldn't confirm");
      expect(result).toContain('PR is not blocked');
      expect(result).toContain('Maybe-leak');
      // And the standard Critical (N) header is NOT emitted for an unverified-only batch
      expect(result).not.toContain('Critical (1)');
    });

    it('renders both sections side by side when verified + unverified criticals coexist', () => {
      const findings = [
        makeFinding({ file: 'a.ts', title: 'Confirmed', verification: 'verified' }),
        makeFinding({ file: 'b.ts', title: 'Maybe',     verification: 'unverified' }),
      ];
      const result = formatReviewComment(baseOptions({ findings }));
      expect(result).toContain('Critical (1)');
      expect(result).toContain('Unverified concerns (1)');
      // Critical header appears before Unverified concerns
      const criticalIdx = result.indexOf('Critical (1)');
      const unverifiedIdx = result.indexOf('Unverified concerns');
      expect(criticalIdx).toBeLessThan(unverifiedIdx);
    });

    it('omits the "Unverified concerns" sub-section entirely when there are no unverified criticals', () => {
      const findings = [
        makeFinding({ title: 'Confirmed', verification: 'verified' }),
      ];
      const result = formatReviewComment(baseOptions({ findings }));
      expect(result).not.toContain('Unverified concerns');
    });

    it('does not coerce unverified warnings into the Unverified concerns section (warnings keep their own collapsed surface)', () => {
      const findings = [
        makeFinding({ severity: 'warning', title: 'Maybe-warning', verification: 'unverified' }),
      ];
      const result = formatReviewComment(baseOptions({ findings }));
      // Sub-section is critical-only by design (issue spec — Layer 3)
      expect(result).not.toContain('Unverified concerns');
      // Warning still renders normally in the collapsed Warnings section + the action table
      expect(result).toContain('Warnings (1)');
      expect(result).toContain('Requires your attention');
    });
  });

  // ─── FP-J L3 — dispute-rate disclosure ─────────────────────────────────
  describe('FP-J L3 disputeDisclosure', () => {
    it('renders the disclosure as a quieter sub-line beneath the merge-score badge', () => {
      const result = formatReviewComment(baseOptions({
        mergeScore: 3,
        mergeScoreReason: 'Review recommended',
        disputeDisclosure: '2 of 3 action findings are from a category disputed ≥ 75% of the time',
      }));
      expect(result).toContain('📊');
      expect(result).toContain('2 of 3 action findings');
      // The disclosure renders inside a <sub> wrapper so it visually defers to the verdict
      expect(result).toMatch(/<sub>.*📊.*<\/sub>/);
    });

    it('renders BELOW the merge-score line', () => {
      const result = formatReviewComment(baseOptions({
        mergeScore: 3,
        mergeScoreReason: 'Review recommended',
        disputeDisclosure: 'historically noisy categories',
      }));
      const scoreIdx = result.indexOf('Review recommended');
      const disclosureIdx = result.indexOf('historically noisy');
      expect(scoreIdx).toBeGreaterThan(-1);
      expect(disclosureIdx).toBeGreaterThan(scoreIdx);
    });

    it('omits the disclosure entirely when disputeDisclosure is undefined', () => {
      const result = formatReviewComment(baseOptions({
        mergeScore: 3,
        mergeScoreReason: 'Review recommended',
      }));
      expect(result).not.toContain('📊');
    });

    it('omits the disclosure when disputeDisclosure is empty whitespace', () => {
      const result = formatReviewComment(baseOptions({
        mergeScore: 3,
        mergeScoreReason: 'Review recommended',
        disputeDisclosure: '   ',
      }));
      expect(result).not.toContain('📊');
    });

    it('does NOT render the disclosure when mergeScore itself is omitted (the score line is the anchor)', () => {
      // Without a merge score, there's no badge to anchor the disclosure under
      // — skip rendering rather than dangle the sub-line.
      const result = formatReviewComment(baseOptions({
        disputeDisclosure: 'something',
      }));
      expect(result).not.toContain('📊');
    });
  });
});

describe('buildWorkDoneSection', () => {
  it('returns correct stats for given files and counts', () => {
    const result = buildWorkDoneSection(
      ['src/index.ts', 'package.json', 'README.md'],
      100,
      20,
      5,
    );
    expect(result.filesScanned).toBe(3);
    expect(result.linesScanned).toBe(120);
    expect(result.agentsRan).toBe(5);
    expect(result.hasDependencyFiles).toBe(true);
  });

  it('sets hasDependencyFiles to false when no dependency files present', () => {
    const result = buildWorkDoneSection(
      ['src/index.ts', 'README.md'],
      50,
      10,
      3,
    );
    expect(result.hasDependencyFiles).toBe(false);
  });
});
