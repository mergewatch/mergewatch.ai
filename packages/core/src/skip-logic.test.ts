import { describe, it, expect } from 'vitest';
import { shouldSkipPR, shouldSkipByRules, isAutoReviewOff, extractIncludePatterns, SKIP_PATTERNS } from './skip-logic.js';
import { DEFAULT_RULES_CONFIG } from './config/defaults.js';
import type { RulesConfig } from './config/defaults.js';

describe('shouldSkipPR', () => {
  // ─── Empty input ──────────────────────────────────────────────────────────
  it('returns skip reason for empty file array', () => {
    const result = shouldSkipPR([]);
    expect(result).toBe('No changed files');
  });

  // ─── Single trivial files ────────────────────────────────────────────────
  it('skips a single doc file (README.md)', () => {
    const result = shouldSkipPR(['README.md']);
    expect(result).not.toBeNull();
    expect(result).toContain('docs');
  });

  it('skips a single lock file (package-lock.json)', () => {
    const result = shouldSkipPR(['package-lock.json']);
    expect(result).not.toBeNull();
    expect(result).toContain('lock files');
  });

  // #455 — this test previously asserted the OPPOSITE, that a workflow-only PR
  // is skipped. It was inverted deliberately, not relaxed: a GitHub Actions
  // workflow is executable configuration running with repository credentials,
  // and treating it as a "CI tweak" meant the file that deploys to production
  // was the one file never reviewed.
  it('REVIEWS a workflow-only PR — executable config is not trivial (#455)', () => {
    expect(shouldSkipPR(['.github/workflows/ci.yml'])).toBeNull();
    expect(shouldSkipPR(['.github/workflows/deploy.yml'])).toBeNull();
    expect(shouldSkipPR(['.github/actions/setup/action.yml'])).toBeNull();
  });

  it('REVIEWS other automation config that decides what runs or merges (#455)', () => {
    // dependabot can enable automerge; CODEOWNERS decides who must approve;
    // renovate.json can turn on automerge for dependency PRs.
    expect(shouldSkipPR(['.github/dependabot.yml'])).toBeNull();
    expect(shouldSkipPR(['.github/CODEOWNERS'])).toBeNull();
    expect(shouldSkipPR(['renovate.json'])).toBeNull();
    expect(shouldSkipPR(['.renovaterc.json'])).toBeNull();
  });

  it('still skips inert GitHub metadata — prose and forms (#455)', () => {
    expect(shouldSkipPR(['.github/ISSUE_TEMPLATE/bug.md'])).not.toBeNull();
    expect(shouldSkipPR(['.github/PULL_REQUEST_TEMPLATE.md'])).not.toBeNull();
    expect(shouldSkipPR(['.github/FUNDING.yml'])).not.toBeNull();
  });

  // ─── Non-trivial files ───────────────────────────────────────────────────
  it('returns null for a single source file (review needed)', () => {
    const result = shouldSkipPR(['src/index.ts']);
    expect(result).toBeNull();
  });

  it('returns null for a mix of doc + source files', () => {
    const result = shouldSkipPR(['README.md', 'src/index.ts']);
    expect(result).toBeNull();
  });

  // ─── Multiple trivial file types ─────────────────────────────────────────
  it('skips when only lock + docs files changed', () => {
    const result = shouldSkipPR(['package-lock.json', 'CHANGELOG.md']);
    expect(result).not.toBeNull();
    expect(result).toContain('lock files');
    expect(result).toContain('docs');
  });

  it('skips generated files (dist/bundle.js)', () => {
    const result = shouldSkipPR(['dist/bundle.js']);
    expect(result).not.toBeNull();
    expect(result).toContain('generated/trivial files');
  });

  it('skips .gitignore as a generated/trivial file', () => {
    const result = shouldSkipPR(['.gitignore']);
    expect(result).not.toBeNull();
  });

  // #455 — also inverted. tsconfig.json changes compilation semantics: turning
  // off `strict`, or repointing `paths`, weakens type safety across every file
  // in the repo while showing up as a one-line diff in none of them.
  it('REVIEWS tsconfig.json — it changes what the compiler enforces (#455)', () => {
    expect(shouldSkipPR(['tsconfig.json'])).toBeNull();
    expect(shouldSkipPR(['packages/core/tsconfig.json'])).toBeNull();
  });

  it('still skips editor and formatter preferences (#455)', () => {
    // The surviving test for "trivial": changing one cannot change what
    // executes, what CI enforces, or what merges without review.
    expect(shouldSkipPR(['.editorconfig'])).not.toBeNull();
    expect(shouldSkipPR(['.vscode/settings.json'])).not.toBeNull();
    expect(shouldSkipPR(['.prettierrc'])).not.toBeNull();
  });

  it('skips prettierrc config files', () => {
    const result = shouldSkipPR(['.prettierrc.json']);
    expect(result).not.toBeNull();
    expect(result).toContain('config');
  });

  it('skips minified files (app.min.js)', () => {
    const result = shouldSkipPR(['assets/app.min.js']);
    expect(result).not.toBeNull();
  });

  it('skips multiple lock file types (yarn.lock, go.sum)', () => {
    const result = shouldSkipPR(['yarn.lock', 'go.sum']);
    expect(result).not.toBeNull();
    expect(result).toContain('lock files');
  });

  it('skips deep docs path (docs/api/reference.md)', () => {
    const result = shouldSkipPR(['docs/api/reference.md']);
    expect(result).not.toBeNull();
    expect(result).toContain('docs');
  });

  it('skips CHANGELOG files', () => {
    const result = shouldSkipPR(['CHANGELOG.md']);
    expect(result).not.toBeNull();
    expect(result).toContain('docs');
  });

  it('skips LICENSE files', () => {
    const result = shouldSkipPR(['LICENSE']);
    expect(result).not.toBeNull();
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────
  it('does not skip when at least one non-trivial file is present', () => {
    const result = shouldSkipPR([
      'package-lock.json',
      'README.md',
      '.github/workflows/ci.yml',
      'src/server.ts',
    ]);
    expect(result).toBeNull();
  });

  it('SKIP_PATTERNS array is exported and non-empty', () => {
    expect(SKIP_PATTERNS).toBeDefined();
    expect(SKIP_PATTERNS.length).toBeGreaterThan(0);
  });

  // ─── includePatterns override ────────────────────────────────────────────
  it('reviews a docs-only PR when includePatterns matches', () => {
    const result = shouldSkipPR(['docs/architecture.md'], ['docs/**']);
    expect(result).toBeNull();
  });

  it('still skips docs that do not match any includePatterns entry', () => {
    const result = shouldSkipPR(['CHANGELOG.md'], ['docs/critical/**']);
    expect(result).not.toBeNull();
    expect(result).toContain('docs');
  });

  it('reviews a mixed lock + matching-include PR', () => {
    const result = shouldSkipPR(
      ['package-lock.json', 'docs/runbooks/oncall.md'],
      ['docs/runbooks/**'],
    );
    expect(result).toBeNull();
  });

  it('empty includePatterns falls back to default skip behaviour', () => {
    const result = shouldSkipPR(['README.md'], []);
    expect(result).not.toBeNull();
  });

  it('omitted includePatterns argument falls back to default skip behaviour', () => {
    const result = shouldSkipPR(['README.md']);
    expect(result).not.toBeNull();
  });
});

describe('extractIncludePatterns', () => {
  it('returns [] when yamlConfig is null', () => {
    expect(extractIncludePatterns(null)).toEqual([]);
  });

  it('returns [] when yamlConfig is undefined', () => {
    expect(extractIncludePatterns(undefined)).toEqual([]);
  });

  it('returns [] when includePatterns field is missing', () => {
    expect(extractIncludePatterns({})).toEqual([]);
  });

  it('returns [] when includePatterns is not an array (string)', () => {
    expect(extractIncludePatterns({ includePatterns: 'docs/**' } as never)).toEqual([]);
  });

  it('returns [] when includePatterns is not an array (number)', () => {
    expect(extractIncludePatterns({ includePatterns: 42 } as never)).toEqual([]);
  });

  it('returns the array unchanged when all entries are strings', () => {
    expect(
      extractIncludePatterns({ includePatterns: ['docs/**', '**/SECURITY.md'] }),
    ).toEqual(['docs/**', '**/SECURITY.md']);
  });

  it('filters out non-string entries from a mixed array', () => {
    const out = extractIncludePatterns({
      includePatterns: ['docs/**', 42, null, true, '**/RUNBOOK.md'] as never,
    });
    expect(out).toEqual(['docs/**', '**/RUNBOOK.md']);
  });
});

describe('shouldSkipByRules', () => {
  const defaults: RulesConfig = { ...DEFAULT_RULES_CONFIG };

  // ─── skipDrafts ───────────────────────────────────────────────────────────
  it('skips draft PRs when skipDrafts is true (default)', () => {
    const result = shouldSkipByRules(defaults, { isDraft: true });
    expect(result?.kind).toBe('draft');
    expect(result?.reason).toContain('Draft PR');
  });

  it('does not skip draft PRs when skipDrafts is false', () => {
    const result = shouldSkipByRules({ ...defaults, skipDrafts: false }, { isDraft: true });
    expect(result).toBeNull();
  });

  it('does not skip non-draft PRs regardless of skipDrafts', () => {
    expect(shouldSkipByRules(defaults, { isDraft: false })).toBeNull();
    expect(shouldSkipByRules(defaults, {})).toBeNull();
  });

  // ─── maxFiles ─────────────────────────────────────────────────────────────
  it('skips PRs exceeding maxFiles', () => {
    const result = shouldSkipByRules({ ...defaults, maxFiles: 10 }, { changedFileCount: 15 });
    expect(result?.kind).toBe('maxFiles');
    expect(result?.reason).toContain('15');
    expect(result?.reason).toContain('max: 10');
  });

  it('does not skip PRs at or below maxFiles', () => {
    expect(shouldSkipByRules({ ...defaults, maxFiles: 10 }, { changedFileCount: 10 })).toBeNull();
    expect(shouldSkipByRules({ ...defaults, maxFiles: 10 }, { changedFileCount: 5 })).toBeNull();
  });

  it('does not skip when changedFileCount is undefined', () => {
    expect(shouldSkipByRules({ ...defaults, maxFiles: 10 }, {})).toBeNull();
  });

  // ─── ignoreLabels ────────────────────────────────────────────────────────
  it('skips PRs with a matching ignore label', () => {
    const result = shouldSkipByRules(defaults, { labels: ['skip-review'] });
    expect(result?.kind).toBe('labelIgnored');
    expect(result?.reason).toContain('skip-review');
  });

  it('matches labels case-insensitively', () => {
    const result = shouldSkipByRules(
      { ...defaults, ignoreLabels: ['WIP'] },
      { labels: ['wip'] },
    );
    expect(result?.kind).toBe('labelIgnored');
    expect(result?.reason).toContain('wip');
  });

  it('does not skip when no labels match', () => {
    const result = shouldSkipByRules(defaults, { labels: ['enhancement', 'bug'] });
    expect(result).toBeNull();
  });

  it('does not skip when PR has no labels', () => {
    expect(shouldSkipByRules(defaults, { labels: [] })).toBeNull();
    expect(shouldSkipByRules(defaults, {})).toBeNull();
  });

  it('does not skip when ignoreLabels is empty', () => {
    const result = shouldSkipByRules(
      { ...defaults, ignoreLabels: [] },
      { labels: ['skip-review'] },
    );
    expect(result).toBeNull();
  });

  // ─── autoReview ──────────────────────────────────────────────────────────
  it('skips auto-triggered reviews when autoReview is false', () => {
    const result = shouldSkipByRules({ ...defaults, autoReview: false }, { mode: 'review' });
    expect(result?.kind).toBe('autoReviewOff');
    expect(result?.reason).toContain('Automatic reviews disabled');
  });

  it('does not skip mention-triggered reviews when autoReview is false', () => {
    expect(shouldSkipByRules({ ...defaults, autoReview: false }, { mode: 'review', mentionTriggered: true })).toBeNull();
    expect(shouldSkipByRules({ ...defaults, autoReview: false }, { mode: 'summary', mentionTriggered: true })).toBeNull();
  });

  // ─── reviewOnMention ─────────────────────────────────────────────────────
  it('skips mention-triggered reviews when reviewOnMention is false', () => {
    const result = shouldSkipByRules({ ...defaults, reviewOnMention: false }, { mode: 'summary', mentionTriggered: true });
    expect(result?.kind).toBe('reviewOnMentionOff');
    expect(result?.reason).toContain('Mention-triggered reviews disabled');
  });

  it('skips respond mode when reviewOnMention is false', () => {
    const result = shouldSkipByRules({ ...defaults, reviewOnMention: false }, { mode: 'respond', mentionTriggered: true });
    expect(result?.kind).toBe('reviewOnMentionOff');
  });

  it('does not skip auto-triggered reviews when reviewOnMention is false', () => {
    const result = shouldSkipByRules({ ...defaults, reviewOnMention: false }, { mode: 'review' });
    expect(result).toBeNull();
  });

  // ─── mentionTriggered bypasses shouldSkipPR-style gates ──────────────────
  it('force-reviews when mentionTriggered even with mode=review', () => {
    // When user comments "@mergewatch review", mode is 'review' but mentionTriggered is true
    // This should NOT be blocked by autoReview: false
    const result = shouldSkipByRules({ ...defaults, autoReview: false }, { mode: 'review', mentionTriggered: true });
    expect(result).toBeNull();
  });

  // ─── Combined rules ──────────────────────────────────────────────────────
  it('returns first matching rule (autoReview checked before skipDrafts)', () => {
    const result = shouldSkipByRules(
      { ...defaults, autoReview: false },
      { isDraft: true, mode: 'review' },
    );
    expect(result?.kind).toBe('autoReviewOff');
    expect(result?.reason).toContain('Automatic reviews disabled');
  });

  it('returns null when all rules pass', () => {
    const result = shouldSkipByRules(defaults, {
      isDraft: false,
      labels: ['enhancement'],
      changedFileCount: 5,
      mode: 'review',
    });
    expect(result).toBeNull();
  });
});

describe('isAutoReviewOff', () => {
  it('returns true when rules.autoReview is explicitly false', () => {
    expect(isAutoReviewOff({ rules: { autoReview: false } as never }, false)).toBe(true);
  });

  it('returns false when mentionTriggered is true (explicit user request bypasses silence)', () => {
    expect(isAutoReviewOff({ rules: { autoReview: false } as never }, true)).toBe(false);
  });

  it('returns false when autoReview is true', () => {
    expect(isAutoReviewOff({ rules: { autoReview: true } as never }, false)).toBe(false);
  });

  it('returns false when YAML lacks a rules block (defaults to autoReview=true)', () => {
    expect(isAutoReviewOff({}, false)).toBe(false);
  });

  it('returns false when yamlConfig is null (fetch failed)', () => {
    expect(isAutoReviewOff(null, false)).toBe(false);
  });

  it('returns false when yamlConfig is undefined', () => {
    expect(isAutoReviewOff(undefined, false)).toBe(false);
  });

  it('treats undefined mentionTriggered like false (auto-triggered)', () => {
    expect(isAutoReviewOff({ rules: { autoReview: false } as never }, undefined)).toBe(true);
  });
});
