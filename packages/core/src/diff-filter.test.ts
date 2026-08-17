import { describe, it, expect } from 'vitest';
import { filterDiff, extractChangedLines, isLineNearChange, computeDiffStats } from './diff-filter.js';

const makeDiff = (...files: string[]) =>
  files
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\nindex abc..def 100644\n--- a/${f}\n+++ b/${f}\n@@ -1,3 +1,4 @@\n+added line\n`,
    )
    .join('');

describe('filterDiff', () => {
  it('returns the diff unchanged when excludePatterns is empty', () => {
    const diff = makeDiff('src/index.ts');
    const { filteredDiff, excludedFiles } = filterDiff(diff, []);
    expect(filteredDiff).toBe(diff);
    expect(excludedFiles).toEqual([]);
  });

  it('returns the diff unchanged when diff is empty', () => {
    const { filteredDiff, excludedFiles } = filterDiff('', ['**/*.lock']);
    expect(filteredDiff).toBe('');
    expect(excludedFiles).toEqual([]);
  });

  it('excludes files matching a glob pattern', () => {
    const diff = makeDiff('src/index.ts', 'package-lock.json');
    const { filteredDiff, excludedFiles } = filterDiff(diff, ['package-lock.json']);
    expect(excludedFiles).toEqual(['package-lock.json']);
    expect(filteredDiff).toContain('src/index.ts');
    expect(filteredDiff).not.toContain('package-lock.json');
  });

  it('excludes files matching wildcard patterns', () => {
    const diff = makeDiff('src/app.ts', 'yarn.lock', 'pnpm-lock.yaml');
    const { filteredDiff, excludedFiles } = filterDiff(diff, ['*.lock', '*.yaml']);
    expect(excludedFiles).toEqual(['yarn.lock', 'pnpm-lock.yaml']);
    expect(filteredDiff).toContain('src/app.ts');
  });

  it('excludes files matching glob star patterns', () => {
    const diff = makeDiff('src/index.ts', 'dist/bundle.js', 'dist/styles.css');
    const { filteredDiff, excludedFiles } = filterDiff(diff, ['dist/**']);
    expect(excludedFiles).toEqual(['dist/bundle.js', 'dist/styles.css']);
    expect(filteredDiff).toContain('src/index.ts');
  });

  it('excludes all files when all match', () => {
    const diff = makeDiff('package-lock.json', 'yarn.lock');
    const { filteredDiff, excludedFiles } = filterDiff(diff, ['*.lock', 'package-lock.json']);
    expect(excludedFiles).toEqual(['package-lock.json', 'yarn.lock']);
    expect(filteredDiff).toBe('');
  });

  it('keeps all files when none match', () => {
    const diff = makeDiff('src/index.ts', 'src/utils.ts');
    const { filteredDiff, excludedFiles } = filterDiff(diff, ['*.lock']);
    expect(excludedFiles).toEqual([]);
    expect(filteredDiff).toBe(diff);
  });

  it('handles file paths containing spaces', () => {
    const diff = makeDiff('src/my file.ts', 'docs/read me.md');
    const { filteredDiff, excludedFiles } = filterDiff(diff, ['docs/**']);
    expect(excludedFiles).toEqual(['docs/read me.md']);
    expect(filteredDiff).toContain('src/my file.ts');
    expect(filteredDiff).not.toContain('docs/read me.md');
  });

  it('works correctly when called multiple times (regex lastIndex reset)', () => {
    const diff = makeDiff('src/index.ts', 'dist/out.js');
    const result1 = filterDiff(diff, ['dist/**']);
    const result2 = filterDiff(diff, ['dist/**']);
    expect(result1.excludedFiles).toEqual(['dist/out.js']);
    expect(result2.excludedFiles).toEqual(['dist/out.js']);
    expect(result1.filteredDiff).toBe(result2.filteredDiff);
  });
});

// ---------------------------------------------------------------------------
// extractChangedLines
// ---------------------------------------------------------------------------

describe('extractChangedLines', () => {
  it('returns empty map for empty diff', () => {
    expect(extractChangedLines('')).toEqual(new Map());
  });

  it('extracts added lines from a simple diff', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index abc..def 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '+const b = 2;',
      ' const c = 3;',
      ' const d = 4;',
    ].join('\n');

    const result = extractChangedLines(diff);
    expect(result.get('src/index.ts')).toEqual(new Set([2]));
  });

  it('handles multiple hunks in one file', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc..def 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' line 1',
      '+added at line 2',
      ' line 3',
      ' line 4',
      '@@ -10,3 +11,4 @@',
      ' line 11',
      '+added at line 12',
      ' line 13',
      ' line 14',
    ].join('\n');

    const result = extractChangedLines(diff);
    expect(result.get('src/app.ts')).toEqual(new Set([2, 12]));
  });

  it('returns empty set for deleted-only file', () => {
    const diff = [
      'diff --git a/old.ts b/old.ts',
      'index abc..def 100644',
      '--- a/old.ts',
      '+++ b/old.ts',
      '@@ -1,3 +1,2 @@',
      ' line 1',
      '-removed line',
      ' line 2',
    ].join('\n');

    const result = extractChangedLines(diff);
    expect(result.get('old.ts')).toEqual(new Set());
  });

  it('marks all lines as changed for new file', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n');

    const result = extractChangedLines(diff);
    expect(result.get('new.ts')).toEqual(new Set([1, 2, 3]));
  });

  it('does not include context lines', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index abc..def 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,5 +1,6 @@',
      ' context line 1',
      ' context line 2',
      '+added line 3',
      ' context line 4',
      ' context line 5',
      ' context line 6',
    ].join('\n');

    const result = extractChangedLines(diff);
    const changed = result.get('src/index.ts')!;
    // Only line 3 is changed, context lines 1,2,4,5,6 are not
    expect(changed).toEqual(new Set([3]));
    expect(changed.has(1)).toBe(false);
    expect(changed.has(2)).toBe(false);
    expect(changed.has(4)).toBe(false);
  });

  it('handles multiple files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index abc..def 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' line 1',
      '+added in a',
      ' line 2',
      'diff --git a/b.ts b/b.ts',
      'index abc..def 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,2 +5,3 @@',
      ' line 5',
      '+added in b',
      ' line 6',
    ].join('\n');

    const result = extractChangedLines(diff);
    expect(result.get('a.ts')).toEqual(new Set([2]));
    expect(result.get('b.ts')).toEqual(new Set([6]));
  });
});

// ---------------------------------------------------------------------------
// isLineNearChange
// ---------------------------------------------------------------------------

describe('isLineNearChange', () => {
  const changedLines = new Map([
    ['src/index.ts', new Set([10, 20])],
  ]);

  it('returns true for exact match', () => {
    expect(isLineNearChange(changedLines, 'src/index.ts', 10, 0)).toBe(true);
  });

  it('returns true within tolerance', () => {
    expect(isLineNearChange(changedLines, 'src/index.ts', 12, 3)).toBe(true);
    expect(isLineNearChange(changedLines, 'src/index.ts', 8, 3)).toBe(true);
  });

  it('returns false outside tolerance', () => {
    expect(isLineNearChange(changedLines, 'src/index.ts', 14, 3)).toBe(false);
    expect(isLineNearChange(changedLines, 'src/index.ts', 6, 3)).toBe(false);
  });

  it('returns false for file not in diff', () => {
    expect(isLineNearChange(changedLines, 'other.ts', 10, 3)).toBe(false);
  });

  it('returns false for empty changed set', () => {
    const empty = new Map([['src/index.ts', new Set<number>()]]);
    expect(isLineNearChange(empty, 'src/index.ts', 10, 3)).toBe(false);
  });
});

// ─── #358 — computeDiffStats ─────────────────────────────────────────────────

describe('computeDiffStats (#358)', () => {
  const twoFileDiff = [
    'diff --git a/src/handler.ts b/src/handler.ts',
    'index 111..222 100644',
    '--- a/src/handler.ts',
    '+++ b/src/handler.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '+const sql = `SELECT * FROM users WHERE id = ${id}`;',
    '+run(sql);',
    '-const old = true;',
    'diff --git a/src/api.generated.ts b/src/api.generated.ts',
    'index 333..444 100644',
    '--- a/src/api.generated.ts',
    '+++ b/src/api.generated.ts',
    '@@ -1,2 +1,3 @@',
    '+// generated',
    '+export const x = 1;',
  ].join('\n');

  it('counts files and +/- lines, excluding the +++/--- file headers', () => {
    const stats = computeDiffStats(twoFileDiff);
    expect(stats.files).toEqual(['src/handler.ts', 'src/api.generated.ts']);
    expect(stats.additions).toBe(4);
    expect(stats.deletions).toBe(1);
  });

  it('reflects the filter: stats of a filtered diff omit the excluded file entirely', () => {
    // The E2E-77 regression: raw PR totals counted excluded files as scanned.
    const { filteredDiff } = filterDiff(twoFileDiff, ['**/*.generated.ts']);
    const stats = computeDiffStats(filteredDiff);
    expect(stats.files).toEqual(['src/handler.ts']);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });

  it('a fully-excluded diff yields zero everything (77b: no more "2 files scanned")', () => {
    const { filteredDiff } = filterDiff(twoFileDiff, ['**/*.ts']);
    expect(computeDiffStats(filteredDiff)).toEqual({ files: [], additions: 0, deletions: 0 });
  });

  it('handles empty input and binary-file sections', () => {
    expect(computeDiffStats('')).toEqual({ files: [], additions: 0, deletions: 0 });
    const binary = 'diff --git a/logo.png b/logo.png\nindex 111..222 100644\nBinary files a/logo.png and b/logo.png differ\n';
    expect(computeDiffStats(binary)).toEqual({ files: ['logo.png'], additions: 0, deletions: 0 });
  });
});
