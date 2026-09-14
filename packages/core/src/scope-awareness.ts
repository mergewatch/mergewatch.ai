/**
 * W11 — scope & architecture awareness.
 *
 * Concrete sub-feature: **context-aware test-coverage suppression.** When
 * the target repository's conventions document (AGENTS.md / CLAUDE.md /
 * the configured conventions file) explicitly declares that the repo has
 * no test harness — e.g. *"No unit test suite currently"* — the review
 * pipeline collapses the test-coverage agent's N "lacks tests" findings
 * into a single non-blocking info note. Otherwise the pipeline used to
 * nag with five "X lacks test coverage" warnings on infra/enablement PRs
 * in repos that explicitly weren't going to have tests yet — exactly the
 * P5 wave the plan called out from voice-bot #31, orca #37, and #39.
 *
 * The detection is deliberately conservative: a documented "no tests"
 * declaration is the signal, NOT absence of test files. Many repos have
 * non-co-located tests, deferred coverage, or are mid-migration. We only
 * suppress when the maintainer wrote it down.
 */

import type { AgentFinding } from './agents/reviewer.js';

/**
 * Phrases that signal the repo deliberately has no test harness today.
 * Case-insensitive; matched against the conventions text. False negatives
 * are acceptable here (under-detection means we keep nagging, which is
 * the legacy behavior) — false positives are NOT (we'd hide real coverage
 * findings), so the patterns are written to require an explicit
 * declaration, not a casual mention of "tests".
 */
const NO_TEST_HARNESS_SIGNALS: RegExp[] = [
  /\bno\s+(unit\s+)?test\s+(suite|harness|infrastructure|framework)\b/i,
  /\b(unit\s+)?tests?\s+(are\s+)?(not\s+(present|implemented|available|set\s+up)|out\s+of\s+scope)\b/i,
  /\bno\s+co-?located\s+tests?\b/i,
  /\bno\s+tests?\s+(yet|currently)\b/i,
];

/**
 * Returns true when the conventions text explicitly documents the absence
 * of a test harness. Empty / undefined conventions return false (no signal
 * → preserve legacy nagging behavior; the test-coverage suppression must
 * be opt-in via an explicit declaration).
 */
export function detectNoTestHarness(conventions: string | undefined): boolean {
  if (!conventions || !conventions.trim()) return false;
  return NO_TEST_HARNESS_SIGNALS.some((re) => re.test(conventions));
}

/**
 * Replace every `category: 'test-coverage'` finding with a single info-
 * level aggregate note. The note carries the count and a pointer back to
 * the conventions document so a reader can see WHY the per-function nag
 * was suppressed and how to re-enable it (remove the no-harness
 * declaration from AGENTS.md / CLAUDE.md / etc.).
 *
 * Returns the post-suppression finding set plus the number of suppressed
 * findings (so the pipeline can roll them into its `suppressedCount`).
 * No-op when there are zero test-coverage findings — never emits a note
 * just for the sake of it.
 */
/**
 * Coverage-nag wording the model emits under a category that is NOT
 * `test-coverage`.
 *
 * W11 keyed on the category alone, which assumes the orchestrator labels every
 * coverage nag correctly. It does not: on mergewatch/fixtures#3164 a finding
 * titled "Postgres startup function lacks test coverage for high-consequence
 * path" arrived under another category, so W11 suppressed nothing, W10 absorbed
 * it into an unrelated critical, and its wording rendered in that finding's
 * audit trail — on a repo whose AGENTS.md declares no test suite.
 *
 * Matched only when the repo has explicitly declared no harness, so the cost of
 * a false positive is suppressing a coverage complaint on a repo that already
 * said coverage complaints are not actionable. Deliberately narrow: it requires
 * the words *test coverage*, not a passing mention of "tests".
 */
const COVERAGE_NAG_TITLE = /\b(lacks?|missing|no|without|insufficient|inadequate)\b[^.]{0,40}\btest coverage\b/i;

/** Is this a per-function coverage nag, however the orchestrator labelled it? */
export function isTestCoverageNag(f: { category?: string; title?: string }): boolean {
  if (f.category === 'test-coverage') return true;
  return COVERAGE_NAG_TITLE.test(f.title ?? '');
}

export function suppressTestCoverageFindings<T extends AgentFinding & { category?: string }>(
  findings: T[],
): { findings: T[]; suppressedCount: number } {
  const testCoverage = findings.filter((f) => isTestCoverageNag(f));
  if (testCoverage.length === 0) return { findings, suppressedCount: 0 };

  const others = findings.filter((f) => !isTestCoverageNag(f));
  const anchor = testCoverage[0];
  const note = {
    ...anchor,
    severity: 'info' as const,
    title: 'Test-coverage findings suppressed — repo documents no test harness',
    description: `${testCoverage.length} test-coverage finding${testCoverage.length === 1 ? '' : 's'} rolled up into this note. The repository's conventions document (AGENTS.md / CLAUDE.md / .mergewatch/conventions.md) declares that this repo currently has no test harness, so per-function "lacks coverage" warnings are not actionable on this PR.`,
    suggestion: 'To re-enable per-PR test-coverage findings, remove the "no test harness" declaration from the conventions document.',
    line: 1,
  } as T;

  return { findings: [...others, note], suppressedCount: testCoverage.length };
}
