/**
 * Smart skip logic for MergeWatch.
 *
 * Determines whether a PR should be skipped because all changed files
 * are trivial (docs-only, lock files, config, etc.). This avoids
 * unnecessary Bedrock costs on PRs that don't need AI review.
 *
 * Deployment-agnostic — no AWS or platform-specific dependencies.
 */

import { minimatch } from 'minimatch';
import type { MergeWatchConfig, RulesConfig } from './config/defaults.js';

/**
 * File patterns that indicate a trivial PR not worth reviewing.
 * If ALL changed files match these patterns, the PR is skipped.
 */
export const SKIP_PATTERNS = [
  // Lock files and dependency manifests
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Gemfile.lock',
  '**/Pipfile.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/go.sum',
  // Documentation
  '**/*.md',
  '**/*.mdx',
  '**/*.txt',
  '**/*.rst',
  '**/docs/**',
  '**/CHANGELOG*',
  '**/CHANGES*',
  '**/LICENSE*',
  '**/NOTICE*',
  // Generated / build artifacts
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/.gitignore',
  '**/.gitattributes',
  // Editor and formatting preferences.
  //
  // These are the only config files still treated as trivial, and the test is
  // narrow: changing one cannot change what executes, what is enforced in CI,
  // or what merges without review. They alter how a human's editor behaves.
  '**/.vscode/**',
  '**/.idea/**',
  '**/.editorconfig',
  '**/.eslintignore',
  '**/.prettierignore',
  '**/.prettierrc*',
  '**/.eslintrc*',

  // Inert GitHub metadata — prose and forms, not automation.
  //
  // `.github/**` as a whole used to be here under the heading "version bumps,
  // CI tweaks". That comment described the intent; the pattern was far wider,
  // and it exempted `.github/workflows/**` — executable configuration that runs
  // with repository credentials, and the single most valuable file in most
  // repositories to review. See #455.
  '**/.github/ISSUE_TEMPLATE/**',
  '**/.github/PULL_REQUEST_TEMPLATE*',
  '**/.github/FUNDING.yml',
];

/**
 * Check if a PR should be skipped because all changed files are trivial.
 * Returns a skip reason string if skipped, or null if the PR should be reviewed.
 *
 * `includePatterns` is the user-configured override list: any file matching
 * one of these patterns is treated as non-trivial regardless of whether it
 * also matches SKIP_PATTERNS. This is how a docs-only PR can opt itself
 * back into review — set `includePatterns: ["docs/architecture/star-star"]`
 * (real glob `**` star-star) and a PR that only touches that path will be
 * reviewed even though all-markdown is otherwise considered trivial.
 */
/**
 * Extract a sanitized `includePatterns` list from a possibly-null parsed
 * YAML config. Centralized here so the Lambda and Express transports share
 * one defensive parse — string-only entries, empty fallback when the field
 * is missing or malformed.
 */
export function extractIncludePatterns(
  yamlConfig: Partial<MergeWatchConfig> | null | undefined,
): string[] {
  const raw = (yamlConfig as { includePatterns?: unknown } | null | undefined)?.includePatterns;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string');
}

export function shouldSkipPR(
  files: string[],
  includePatterns: string[] = [],
): string | null {
  if (files.length === 0) return 'No changed files';

  const isForceIncluded = (file: string) =>
    includePatterns.some((pattern) => minimatch(file, pattern));

  const nonTrivialFiles = files.filter(
    (file) =>
      isForceIncluded(file) ||
      !SKIP_PATTERNS.some((pattern) => minimatch(file, pattern)),
  );

  if (nonTrivialFiles.length === 0) {
    // Categorize what the PR contains for the skip reason
    const hasLockFiles = files.some((f) => /\.lock$|lock\.json$|lock\.yaml$|go\.sum$/.test(f));
    const hasDocs = files.some((f) => /\.(md|mdx|txt|rst)$/i.test(f) || /docs\//i.test(f));
    const hasConfig = files.some((f) => /^\.|tsconfig|renovate|eslint|prettier/i.test(f.split('/').pop() ?? ''));

    const reasons: string[] = [];
    if (hasLockFiles) reasons.push('lock files');
    if (hasDocs) reasons.push('docs');
    if (hasConfig) reasons.push('config');
    if (reasons.length === 0) reasons.push('generated/trivial files');

    return `Only ${reasons.join(' + ')} changed`;
  }

  return null;
}

/**
 * Discriminator for the kind of rule-based skip. Callers branch on this when
 * they want category-specific UX (e.g. posting a "how to enable" check run
 * for `autoReviewOff` only) without string-matching the human-readable reason.
 */
export type RulesSkipKind =
  | 'autoReviewOff'
  | 'reviewOnMentionOff'
  | 'draft'
  | 'maxFiles'
  | 'labelIgnored';

export interface RulesSkipResult {
  kind: RulesSkipKind;
  /** Human-readable reason, used for logging and stored on the review record. */
  reason: string;
}

/**
 * Predicate for the *silent* skip path: returns true when the repo has
 * `rules.autoReview: false` in `.mergewatch.yml` AND the review wasn't
 * mention-triggered. The runtime handlers consult this BEFORE any GitHub
 * side effect (eyes reaction, check run, PR review) so a parked install
 * leaves no trace on the PR. Other skip kinds (draft, maxFiles, labels)
 * still surface a check run via `shouldSkipByRules`; only autoReviewOff
 * goes silent.
 *
 * Accepts the partial YAML shape directly (no DEFAULT merge needed) since
 * we only care about the explicit user opt-out signal — a missing
 * `rules.autoReview` falls back to the default `true` and returns false here.
 */
export function isAutoReviewOff(
  yamlConfig: Partial<MergeWatchConfig> | null | undefined,
  mentionTriggered: boolean | undefined,
): boolean {
  if (mentionTriggered === true) return false;
  return yamlConfig?.rules?.autoReview === false;
}

/**
 * Check whether a PR should be skipped based on the rules config.
 * Returns a result object describing the skip kind + reason if skipped, or
 * null if the PR should be reviewed.
 */
export function shouldSkipByRules(
  rules: RulesConfig,
  pr: { isDraft?: boolean; labels?: string[]; changedFileCount?: number; mode?: string; mentionTriggered?: boolean },
): RulesSkipResult | null {
  // mentionTriggered is the authoritative signal for whether a user explicitly
  // requested this review via an @mergewatch comment.  When true, the review
  // is treated as a force-review that bypasses autoReview/reviewOnMention gates.
  const isMentionTriggered = pr.mentionTriggered === true;

  if (!rules.autoReview && !isMentionTriggered) {
    return {
      kind: 'autoReviewOff',
      reason: 'Automatic reviews disabled — use @mergewatch to trigger manually',
    };
  }

  if (!rules.reviewOnMention && isMentionTriggered) {
    return {
      kind: 'reviewOnMentionOff',
      reason: 'Mention-triggered reviews disabled via reviewOnMention: false',
    };
  }

  if (rules.skipDrafts && pr.isDraft) {
    return {
      kind: 'draft',
      reason: 'Draft PR — set rules.skipDrafts: false to review drafts',
    };
  }

  if (pr.changedFileCount != null && pr.changedFileCount > rules.maxFiles) {
    return {
      kind: 'maxFiles',
      reason: `PR has ${pr.changedFileCount} changed files (max: ${rules.maxFiles})`,
    };
  }

  if (pr.labels && rules.ignoreLabels.length > 0) {
    const ignoreLabelSet = new Set(rules.ignoreLabels.map((l) => l.toLowerCase()));
    const matchedLabel = pr.labels.find((l) => ignoreLabelSet.has(l.toLowerCase()));
    if (matchedLabel) {
      return {
        kind: 'labelIgnored',
        reason: `PR has label "${matchedLabel}" which is in ignoreLabels`,
      };
    }
  }

  return null;
}
