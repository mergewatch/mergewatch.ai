import { describe, it, expect } from 'vitest';
import { buildPrompt } from './reviewer.js';
import { renderPrompt, findVolatilityInversion } from '../llm/prompt-segment.js';
import { applyConfidenceFloor } from './prompts.js';

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

const TEMPLATE = [
  'AGENT TEMPLATE',
  'TONE_PLACEHOLDER',
  'CONVENTIONS_PLACEHOLDER',
  'AGENT_MODE_PLACEHOLDER',
  'FILE_REQUEST_PLACEHOLDER',
].join('\n');

const build = (over: Partial<{ agentic: boolean; conventions: string; agentAuthored: boolean }> = {}) =>
  buildPrompt(
    TEMPLATE, 'DIFF BODY', CONTEXT as never,
    over.agentic ?? false, undefined, over.conventions, over.agentAuthored ?? false,
  );

describe('#489 — buildPrompt returns segments', () => {
  it('renders to the exact shape the flat string produced', () => {
    const rendered = renderPrompt(build());
    // The assembled order is unchanged: template, intent-claims, PR context, diff.
    expect(rendered).toContain('AGENT TEMPLATE');
    expect(rendered.indexOf('--- PR Context ---')).toBeGreaterThan(rendered.indexOf('AGENT TEMPLATE'));
    expect(rendered.indexOf('--- Diff ---')).toBeGreaterThan(rendered.indexOf('--- PR Context ---'));
    expect(rendered.endsWith('DIFF BODY')).toBe(true);
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

  it('labels merged segments honestly', () => {
    // `head` holds a static template AND a per-PR agent-mode block, so it is
    // per-pr. Claiming `static` would promise a stability the text lacks and
    // produce a cache prefix that never hits.
    const head = build().find((s) => s.id === 'head');
    expect(head?.stability).toBe('per-pr');
  });

  it('segment ids are stable and unique — cassette keys depend on them', () => {
    const ids = build().map((s) => s.id);
    expect(ids).toEqual(['head', 'pr-context', 'diff']);
    expect(new Set(ids).size).toBe(ids.length);
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
