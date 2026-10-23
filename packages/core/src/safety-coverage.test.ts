import { describe, it, expect } from 'vitest';
import { findUncoveredTopLevelFolders as find } from './safety-coverage.js';
import { formatReviewComment, formatSafetySection } from './comment-formatter.js';
import { runReviewPipeline } from './agents/reviewer.js';
import { SAFETY_PROMPT } from './agents/prompts.js';
import { filterDiff } from './diff-filter.js';
import { renderPrompt, type PromptInput } from './llm/prompt-segment.js';
import { DEFAULT_SAFETY_SCORE_CONFIG, SAFETY_FACTORS } from './config/defaults.js';
import type { SafetyResult } from './agents/safety.js';

const SRC = [{ name: 'Source', patterns: ['src/**'] }];

describe('findUncoveredTopLevelFolders (#717)', () => {
  it('a new folder no pattern covers is flagged', () => {
    expect(find(['payments/a.ts'], ['src'], SRC)).toEqual(['payments']);
  });
  it('a folder pattern covers it', () => {
    expect(find(['payments/a.ts'], ['src'], [...SRC, { patterns: ['payments/**'] }])).toEqual([]);
  });
  it('a file-type pattern covers it', () => {
    expect(find(['payments/a.ts'], ['src'], [...SRC, { patterns: ['**/*.ts'] }])).toEqual([]);
  });
  it('a folder that already exists at the base root is not new', () => {
    expect(find(['payments/a.ts'], ['src', 'payments'], SRC)).toEqual([]);
  });
  it('root files and dot-folders are never flagged', () => {
    expect(find(['README.md', '.github/x.yml'], ['src'], SRC)).toEqual([]);
  });
  it('does not apply when no area has patterns', () => {
    expect(find(['payments/a.ts'], ['src'], [{ name: 'Billing', notes: 'n' }])).toEqual([]);
  });
  it('returns every uncovered folder, sorted', () => {
    const files = ['f/1', 'b/1', 'e/1', 'a/1', 'd/1', 'c/1'];
    expect(find(files, ['src'], SRC)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

const SHA = 'd'.repeat(40);
const RESULT: SafetyResult = {
  score: 50, uncappedScore: 50, band: 'caution', emoji: '⛅',
  factors: Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: 3, label: 'caution', note: 'n.' }])) as SafetyResult['factors'],
  concerns: ['Something could break.'], matchedAreas: [], appliedAreas: [], appliedNotes: [],
};
const section = (over: Partial<SafetyResult>) => formatSafetySection({ ...RESULT, ...over }, SHA);

describe('the Uncovered line (#717)', () => {
  it('lists the folders sorted, before Concerns', () => {
    const s = section({ uncoveredFolders: ['b', 'a'].sort() });
    expect(s).toContain('- Uncovered: `a/`, `b/` are new top-level folders no area covers.');
    expect(s.indexOf('- Uncovered:')).toBeLessThan(s.indexOf('Concerns:'));
  });

  it('caps at 5 with (+N more)', () => {
    const s = section({ uncoveredFolders: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(s).toContain('- Uncovered: `a/`, `b/`, `c/`, `d/`, `e/` (+2 more) are new top-level folders no area covers.');
  });

  it('no line for [] or undefined, and the mw-safety line is unchanged by it', () => {
    expect(section({ uncoveredFolders: [] })).not.toContain('Uncovered');
    expect(section({})).not.toContain('Uncovered');
    const line = (s: string) => s.split('\n').find((l) => l.startsWith('<!-- mw-safety:'));
    expect(line(section({ uncoveredFolders: ['a'] }))).toBe(line(section({})));
  });

  it('collapsed: the line sits inside <details>', () => {
    const body = formatReviewComment({ summary: 's', findings: [], safety: { result: { ...RESULT, collapsed: true, uncoveredFolders: ['a'] }, headSha: SHA } });
    const open = body.indexOf('<details><summary>Factors and concerns</summary>');
    const at = body.indexOf('- Uncovered:');
    expect(open).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(open);
    expect(at).toBeLessThan(body.indexOf('</details>', open));
  });
});

describe('uncovered folders in the pipeline (#717)', () => {
  const ALL_THREES = JSON.stringify({ ratings: Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: 3, note: 'n' }])) });
  const llm = {
    async invoke(_m: string, p: PromptInput) {
      const t = renderPrompt(p);
      if (t.includes(SAFETY_PROMPT.slice(0, 80))) return ALL_THREES;
      if (t.includes('You receive findings from multiple review agents')) return JSON.stringify({ findings: [], mergeScore: 5, mergeScoreReason: 'ok' });
      if (t.includes('Mermaid')) return '';
      return JSON.stringify({ findings: [], summary: 's' });
    },
  };
  const file = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

  it('uses the filtered files: an excluded vendor/ folder is never flagged', async () => {
    // The runtimes filter before the pipeline; this is the diff they hand it.
    const { filteredDiff } = filterDiff(file('payments/a.ts') + file('vendor/x.js'), ['vendor/**']);
    const base = {
      diff: filteredDiff,
      context: { owner: 'o', repo: 'r', prNumber: 1 },
      modelId: 'm', lightModelId: 'l', maxFindings: 25,
      enabledAgents: { security: false, bugs: false, style: false, summary: false, diagram: false, errorHandling: false, testCoverage: false, commentAccuracy: false },
    };
    const result = await runReviewPipeline({
      ...base,
      safetyScore: { ...DEFAULT_SAFETY_SCORE_CONFIG, enabled: true, areas: [{ patterns: ['src/**'] }], baseRootDirs: ['src'] },
    }, { llm });
    expect(result.safety?.uncoveredFolders).toEqual(['payments']);
    // (pin) advisory: the gate is what it is with the score off.
    const off = await runReviewPipeline(base, { llm });
    expect(result.gate).toEqual(off.gate);
    expect(result.mergeScore).toBe(off.mergeScore);
  });
});
