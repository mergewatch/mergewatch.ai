import { describe, it, expect } from 'vitest';
import {
  renderPrompt,
  findVolatilityInversion,
  assertNonDecreasingVolatility,
  mostVolatile,
  type PromptSegment,
} from './prompt-segment.js';

const seg = (id: string, stability: PromptSegment['stability'], text = id): PromptSegment =>
  ({ id, stability, text });

describe('renderPrompt', () => {
  it('joins with NO separator, so rendering is pure concatenation', () => {
    // Segments carry their own leading whitespace. A separator here would
    // silently reflow every prompt in the product.
    expect(renderPrompt([seg('a', 'static', 'A'), seg('b', 'per-pr', '\n\nB')])).toBe('A\n\nB');
  });

  it('passes a string through untouched, so unmigrated callers are unaffected', () => {
    expect(renderPrompt('already assembled')).toBe('already assembled');
  });

  it('renders an empty segment list to an empty string', () => {
    expect(renderPrompt([])).toBe('');
  });
});

describe('volatility ordering', () => {
  it('accepts a non-decreasing sequence', () => {
    expect(findVolatilityInversion([
      seg('directives', 'static'), seg('conventions', 'per-repo'),
      seg('diff', 'per-pr'), seg('files', 'per-call'),
    ])).toBeNull();
  });

  it('accepts equal neighbours', () => {
    expect(findVolatilityInversion([seg('a', 'per-pr'), seg('b', 'per-pr')])).toBeNull();
  });

  it('rejects a static segment sitting after a volatile one', () => {
    // The failure that matters: one static segment after a per-pr one makes
    // the WHOLE prefix unstable, so the cache never hits and nothing says why.
    const bad = findVolatilityInversion([seg('diff', 'per-pr'), seg('directives', 'static')]);
    expect(bad).not.toBeNull();
    expect(bad!.offending.id).toBe('directives');
    expect(bad!.previous.id).toBe('diff');
  });

  it('throws with both segment ids and stabilities named', () => {
    // A build failure is only useful if it says which pair is wrong.
    expect(() => assertNonDecreasingVolatility(
      [seg('diff', 'per-pr'), seg('directives', 'static')], 'review prompt',
    )).toThrow(/review prompt.*directives.*static.*diff.*per-pr/s);
  });

  it('does not throw on a sound order', () => {
    expect(() => assertNonDecreasingVolatility([seg('a', 'static'), seg('b', 'per-call')], 'x'))
      .not.toThrow();
  });
});

describe('mostVolatile', () => {
  it('is what a merged segment must be labelled', () => {
    // Merging a static template with a per-pr block yields per-pr. Labelling
    // the result `static` would claim a stability the text does not have.
    expect(mostVolatile('static', 'per-pr', 'per-repo')).toBe('per-pr');
    expect(mostVolatile('static')).toBe('static');
    expect(mostVolatile()).toBe('static');
  });
});
