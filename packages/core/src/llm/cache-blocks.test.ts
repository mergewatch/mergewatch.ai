import { describe, it, expect } from 'vitest';
import { toCacheableBlocks, hasCacheableBoundary, MAX_CACHE_BREAKPOINTS } from './cache-blocks.js';
import { renderPrompt, type PromptSegment } from './prompt-segment.js';

const seg = (id: string, stability: PromptSegment['stability'], text: string): PromptSegment =>
  ({ id, stability, text });

const REVIEW = [
  seg('shared', 'static', 'DIRECTIVES'),
  seg('conv', 'per-repo', '\n\nCONVENTIONS'),
  seg('ctx', 'per-pr', '\n\nCONTEXT'),
  seg('diff', 'per-pr', '\n\nDIFF'),
  seg('agent', 'per-call', '\n\nAGENT'),
];

describe('toCacheableBlocks', () => {
  it('never loses or reorders text — the wire content is the rendered prompt', () => {
    // The property that matters most: caching must not change what the model
    // reads. If this ever fails, cost is the least of the problems.
    expect(toCacheableBlocks(REVIEW).map((b) => b.text).join('')).toBe(renderPrompt(REVIEW));
  });

  it('collapses consecutive same-stability segments into one block', () => {
    // ctx and diff are both per-pr; a breakpoint between them would buy
    // nothing and spend one of the four.
    const blocks = toCacheableBlocks(REVIEW);
    expect(blocks).toHaveLength(4);
    expect(blocks[2].text).toBe('\n\nCONTEXT\n\nDIFF');
  });

  it('marks every boundary except the last', () => {
    const blocks = toCacheableBlocks(REVIEW);
    expect(blocks.slice(0, -1).every((b) => b.cache_control?.type === 'ephemeral')).toBe(true);
    // Caching a prefix that includes the MOST volatile segment writes an entry
    // nothing can ever read — paying the 1.25x write premium for no read.
    expect(blocks[blocks.length - 1].cache_control).toBeUndefined();
  });

  it('never exceeds the 4-breakpoint API limit', () => {
    const many = (['static', 'per-repo', 'per-pr', 'per-call'] as const)
      .flatMap((s, i) => [seg(`a${i}`, s, `A${i}`)]);
    // Six distinct groups would want five marks; the API allows four.
    const wide = [...many, seg('x', 'per-call', 'X'), seg('y', 'per-call', 'Y')];
    const marked = toCacheableBlocks(wide).filter((b) => b.cache_control).length;
    expect(marked).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it('passes a plain string through as a single unmarked block', () => {
    // Unmigrated callers must be byte-identical and must not pay a write premium.
    const blocks = toCacheableBlocks('just a string');
    expect(blocks).toEqual([{ type: 'text', text: 'just a string' }]);
  });

  it('handles an empty segment list without emitting a broken body', () => {
    expect(toCacheableBlocks([])).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('hasCacheableBoundary', () => {
  it('is false for a string, and for segments that are all one stability', () => {
    // No boundary means no reason to switch to block form — so the request
    // stays exactly the shape it was before #490.
    expect(hasCacheableBoundary('x')).toBe(false);
    expect(hasCacheableBoundary([seg('a', 'per-pr', 'A'), seg('b', 'per-pr', 'B')])).toBe(false);
  });

  it('is true once stabilities differ', () => {
    expect(hasCacheableBoundary(REVIEW)).toBe(true);
  });
});

describe('the verifier shape (#490)', () => {
  it('caches head+file so every finding in one file reuses the prefix', () => {
    // The biggest single saving: this used to send head + finding + FILE, so
    // ten findings in one file re-sent that file ten times at full price.
    const forFinding = (title: string) => [
      seg('verifier-head', 'static', 'HEAD'),
      seg('verifier-file', 'per-pr', '\n\nFILE CONTENT'),
      seg('verifier-finding', 'per-call', `\n\n${title}`),
    ];
    const a = toCacheableBlocks(forFinding('FINDING A'));
    const b = toCacheableBlocks(forFinding('FINDING B'));
    // The cached prefix is identical across findings...
    const prefix = (bs: typeof a) => bs.filter((x) => x.cache_control).map((x) => x.text).join('');
    expect(prefix(a)).toBe(prefix(b));
    expect(prefix(a)).toContain('FILE CONTENT');
    // ...and the part that differs is not inside it.
    expect(prefix(a)).not.toContain('FINDING A');
  });
});
