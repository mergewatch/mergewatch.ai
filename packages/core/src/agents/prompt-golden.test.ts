import { describe, it, expect } from 'vitest';
import { buildPrompt } from './reviewer.js';
import { renderPrompt, findVolatilityInversion } from '../llm/prompt-segment.js';
import {
  applyConfidenceFloor, SHARED_PREAMBLE,
  SECURITY_REVIEWER_PROMPT, BUG_REVIEWER_PROMPT, STYLE_REVIEWER_PROMPT,
  ERROR_HANDLING_REVIEWER_PROMPT, TEST_COVERAGE_REVIEWER_PROMPT,
  COMMENT_ACCURACY_REVIEWER_PROMPT,
} from './prompts.js';

/**
 * #489 — the guarantee that makes this refactor safe.
 *
 * `buildPrompt` went from returning a string to returning segments, and the
 * provider interface widened to accept either. The claim is that rendered
 * output is byte-identical to before, EXCEPT the deliberately deleted
 * `Current date:` line (#488 open question 3).
 *
 * There were no prompt snapshot tests before this. Without them the claim
 * would be an assertion rather than a fact, which is exactly the kind of
 * unverifiable "no behaviour change" this repo has been bitten by.
 *
 * Reordering is NOT in this phase — see #564. That change deliberately breaks
 * byte-equality and is verified by a graded fixture run instead.
 */
const CONTEXT = {
  owner: 'octo',
  repo: 'demo',
  prNumber: 7,
  prTitle: 'Add retry policy',
  prBody: 'Adds a shared retry helper.',
} as const;

// #564 — buildPrompt splits the shared preamble off the agent body, so a test
// template must be shaped like a real one: the preamble verbatim, then the
// agent-specific text.
const TEMPLATE = `${SHARED_PREAMBLE}\nAGENT BODY\nFILE_REQUEST_PLACEHOLDER`;

const build = (over: Partial<{ agentic: boolean; conventions: string; agentAuthored: boolean }> = {}) =>
  buildPrompt(
    TEMPLATE, 'DIFF BODY', CONTEXT as never,
    over.agentic ?? false, undefined, over.conventions, over.agentAuthored ?? false,
  );

describe('#489 — buildPrompt returns segments', () => {
  it('orders shared static text first and the agent body last (#564)', () => {
    const r = renderPrompt(build());
    // Long context before specific instruction: the diff is what the model
    // reasons over, the agent body is what it is asked to do with it.
    expect(r.indexOf('--- PR Context ---')).toBeGreaterThan(r.indexOf('You are a senior'));
    expect(r.indexOf('--- Diff ---')).toBeGreaterThan(r.indexOf('--- PR Context ---'));
    expect(r.indexOf('AGENT BODY')).toBeGreaterThan(r.indexOf('DIFF BODY'));
  });

  it('has NO date line — the one deliberate difference from before', () => {
    // It invalidated any prompt cache daily and would invalidate a cassette
    // corpus every midnight, for context the review does not use.
    expect(renderPrompt(build())).not.toMatch(/Current date:/);
  });

  it('still carries the PR context the date line used to sit above', () => {
    // Guard against deleting more than intended.
    const r = renderPrompt(build());
    expect(r).toContain('Repository: octo/demo');
    expect(r).toContain('PR #7');
    expect(r).toContain('Title: Add retry policy');
  });

  it('emits segments in non-decreasing volatility', () => {
    expect(findVolatilityInversion(build())).toBeNull();
  });

  it('labels the agent body per-call, not static (#564)', () => {
    // It is frozen in source but differs on every one of the six calls, so in
    // cache terms it is per-call. Labelling it `static` would be the reading
    // under which the target order is a volatility inversion — see #564.
    const body = build().find((s) => s.id === 'agent-instructions');
    expect(body?.stability).toBe('per-call');
    expect(build().find((s) => s.id === 'shared-directives')?.stability).toBe('static');
  });

  it('every finding agent takes the shared-prefix path (#564)', () => {
    // The invariant that keeps the fallback below from silently swallowing a
    // real drift: if someone edits SHARED_PREAMBLE so a template no longer
    // starts with it, that agent quietly stops sharing a cache prefix and
    // nothing else would say so.
    for (const p of [
      SECURITY_REVIEWER_PROMPT, BUG_REVIEWER_PROMPT, STYLE_REVIEWER_PROMPT,
      ERROR_HANDLING_REVIEWER_PROMPT, TEST_COVERAGE_REVIEWER_PROMPT,
      COMMENT_ACCURACY_REVIEWER_PROMPT,
    ]) {
      const ids = buildPrompt(p, 'd', CONTEXT as never, false, undefined, undefined, false).map((x) => x.id);
      expect(ids).toContain('shared-directives');
      expect(ids).toContain('agent-instructions');
    }
  });

  it('a standalone prompt keeps the simple layout and still orders soundly', () => {
    // DIAGRAM, FINDING_VERIFICATION, TRIAGE_MAPPING and friends are single-call:
    // there is no second agent to share a prefix with, so they are left alone.
    const segs = buildPrompt('STANDALONE TEMPLATE', 'THE DIFF', CONTEXT as never, false, undefined, undefined, false);
    expect(segs.map((x) => x.id)).toEqual(['agent-template', 'pr-context', 'diff']);
    expect(findVolatilityInversion(segs)).toBeNull();
    expect(renderPrompt(segs)).toContain('STANDALONE TEMPLATE');
  });

  it('segment ids are stable and unique — cassette keys depend on them', () => {
    const ids = build({ conventions: 'HOUSE RULES' }).map((s) => s.id);
    expect(ids).toEqual(['shared-directives', 'repo-conventions', 'pr-context', 'diff', 'agent-instructions']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('omits the repo segment entirely when there is nothing repo-scoped', () => {
    // An empty segment would still be a cache boundary, and boundaries are not
    // free — a repo with no conventions should look exactly like no segment.
    expect(build().map((s) => s.id)).toEqual(
      ['shared-directives', 'pr-context', 'diff', 'agent-instructions'],
    );
  });

  it('the shared prefix is identical across agents and now contains the diff (#564)', () => {
    // The whole point. Before this, each agent's own template came first, so
    // the six shared a prefix that stopped before the diff — the part that
    // dominates input tokens.
    const a = renderPrompt(buildPrompt(`${SHARED_PREAMBLE}\nAGENT A`, 'SHARED_DIFF', CONTEXT as never, false, undefined, 'CONV', false));
    const b = renderPrompt(buildPrompt(`${SHARED_PREAMBLE}\nAGENT B`, 'SHARED_DIFF', CONTEXT as never, false, undefined, 'CONV', false));
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const prefix = a.slice(0, i);
    expect(prefix).toContain('SHARED_DIFF');
    expect(prefix).toContain('--- PR Context ---');
    expect(prefix).not.toContain('AGENT A');
  });
});

describe('#489 — applyConfidenceFloor is a segment transform', () => {
  const DIRECTIVE = 'If you are less than 75% confident';

  it('rewrites only the segment holding the directive', () => {
    const segments = [
      { id: 'head', stability: 'per-pr' as const, text: `x ${DIRECTIVE} y` },
      { id: 'diff', stability: 'per-pr' as const, text: 'UNTOUCHED DIFF' },
    ];
    const out = applyConfidenceFloor(segments, 90) as typeof segments;
    expect(out[0].text).toContain('less than 90% confident');
    // The trap this guards: as a regex over the assembled string, a non-default
    // minConfidence could rewrite anywhere, breaking prefix stability for every
    // repo that sets one — a cache AND cassette miss with no visible cause.
    expect(out[1]).toBe(segments[1]);
    expect(out[1].text).toBe('UNTOUCHED DIFF');
  });

  it('returns the input unchanged at the default floor', () => {
    const segments = [{ id: 'head', stability: 'per-pr' as const, text: DIRECTIVE }];
    expect(applyConfidenceFloor(segments, 75)).toBe(segments);
  });

  it('still works on a plain string, for unmigrated callers', () => {
    expect(applyConfidenceFloor(`a ${DIRECTIVE} b`, 60)).toContain('less than 60% confident');
  });
});
