import { describe, it, expect } from 'vitest';
import { computeReviewDelta, fingerprintFromCode, findingMatchKeys } from './review-delta.js';

function finding(file: string, title: string, line = 1) {
  return { file, title, line };
}

function fp(file: string, title: string, fingerprint: string, line = 1) {
  return { file, title, line, fingerprint };
}

describe('computeReviewDelta', () => {
  it('returns null when previous findings is null', () => {
    const result = computeReviewDelta([finding('a.ts', 'Bug')], null);
    expect(result).toBeNull();
  });

  it('returns null when previous findings is undefined', () => {
    const result = computeReviewDelta([finding('a.ts', 'Bug')], undefined);
    expect(result).toBeNull();
  });

  it('returns null when previous findings is an empty array', () => {
    const result = computeReviewDelta([finding('a.ts', 'Bug')], []);
    expect(result).toBeNull();
  });

  it('marks all findings as carried over when identical', () => {
    const findings = [finding('a.ts', 'Bug'), finding('b.ts', 'Typo')];
    const result = computeReviewDelta(findings, findings);
    expect(result).toMatchObject({ resolvedCount: 0, newCount: 0, carriedOverCount: 2 });
    expect(result!.resolved).toEqual([]);
    expect(result!.new).toEqual([]);
    expect(result!.carriedOver).toHaveLength(2);
  });

  it('marks all as resolved when current is empty and previous has findings', () => {
    const prev = [finding('a.ts', 'Bug'), finding('b.ts', 'Typo')];
    const result = computeReviewDelta([], prev);
    expect(result).toMatchObject({ resolvedCount: 2, newCount: 0, carriedOverCount: 0 });
    expect(result!.resolved).toHaveLength(2);
    expect(result!.resolved[0].title).toBe('Bug');
  });

  it('marks all as new when previous has different findings', () => {
    const prev = [finding('a.ts', 'Old bug')];
    const curr = [finding('x.ts', 'New bug')];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 1, newCount: 1, carriedOverCount: 0 });
    expect(result!.resolved[0].title).toBe('Old bug');
    expect(result!.new[0].title).toBe('New bug');
  });

  it('computes a mix of carried, resolved, and new findings', () => {
    const prev = [finding('a.ts', 'Bug'), finding('b.ts', 'Typo'), finding('c.ts', 'Leak')];
    const curr = [finding('a.ts', 'Bug'), finding('d.ts', 'New issue')];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 2, newCount: 1, carriedOverCount: 1 });
    expect(result!.carriedOver[0].title).toBe('Bug');
    expect(result!.resolved.map((f) => f.title).sort()).toEqual(['Leak', 'Typo']);
    expect(result!.new[0].title).toBe('New issue');
  });

  it('treats same file+title with different line numbers as carried over', () => {
    const prev = [finding('a.ts', 'Bug', 10)];
    const curr = [finding('a.ts', 'Bug', 25)];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 0, newCount: 0, carriedOverCount: 1 });
    expect(result!.carriedOver[0].line).toBe(25); // takes the current line number
  });

  it('handles one resolved and one new finding correctly', () => {
    const prev = [finding('a.ts', 'Old bug')];
    const curr = [finding('a.ts', 'New bug')];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 1, newCount: 1, carriedOverCount: 0 });
    expect(result!.resolved[0].title).toBe('Old bug');
    expect(result!.new[0].title).toBe('New bug');
  });
});

// ─── W9: stable fingerprint identity (convergence guard) ────────────────────

describe('computeReviewDelta — W9 fingerprint union-matching', () => {
  it('the whack-a-mole case: title drifts but code is unchanged → carried, NOT resolved+new', () => {
    // PR #145 round 2 on tape: same `} catch (err) {` line, line number
    // shifted, LLM re-titled the finding.
    const prev = [fp('reviewer.ts', 'Broad exception catching', '} catch (err) {', 1225)];
    const curr = [fp('reviewer.ts', 'Catch-and-continue pattern', '} catch (err) {', 1207)];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 0, newCount: 0, carriedOverCount: 1 });
  });

  it('genuinely different code AND title → resolved + new (real progress still shows)', () => {
    const prev = [fp('a.ts', 'Missing await', 'doThing()', 10)];
    const curr = [fp('a.ts', 'Null deref', 'x.y.z', 40)];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 1, newCount: 1, carriedOverCount: 0 });
  });

  it('back-compat: prev has no fingerprint, curr does, same title → carried via title key', () => {
    const prev = [finding('a.ts', 'Race condition', 89)]; // pre-W9 stored record
    const curr = [fp('a.ts', 'Race condition', 'await save()', 92)];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 0, newCount: 0, carriedOverCount: 1 });
  });

  it('union is conservative: same title, changed code → still carried (never phantom resolved+new)', () => {
    const prev = [fp('a.ts', 'Broad catch', 'catch (a) {', 5)];
    const curr = [fp('a.ts', 'Broad catch', 'catch (b) {', 5)];
    const result = computeReviewDelta(curr, prev);
    expect(result).toMatchObject({ resolvedCount: 0, newCount: 0, carriedOverCount: 1 });
  });

  it('different titles but same fingerprint still match (fingerprint key wins)', () => {
    const prev = [fp('a.ts', 'A', 'const r = await f(x)', 3)];
    const curr = [fp('a.ts', 'Z', 'const r = await f(x)', 9)];
    const result = computeReviewDelta(curr, prev);
    expect(result!.carriedOverCount).toBe(1);
  });
});

describe('fingerprintFromCode', () => {
  it('collapses whitespace and is line-number independent', () => {
    expect(fingerprintFromCode('   const   x =  await  f(  )  ')).toBe('const x = await f( )');
  });

  it('strips a trailing line comment so adding/removing one keeps identity', () => {
    expect(fingerprintFromCode('doThing(); // TODO later')).toBe('doThing();');
  });

  it('returns "" for too-generic anchors (closers, blank)', () => {
    expect(fingerprintFromCode('}')).toBe('');
    expect(fingerprintFromCode('  });')).toBe('');
    expect(fingerprintFromCode('   ')).toBe('');
    expect(fingerprintFromCode(undefined)).toBe('');
  });

  it('caps length at 200 chars', () => {
    expect(fingerprintFromCode('a'.repeat(500)).length).toBe(200);
  });
});

describe('findingMatchKeys', () => {
  it('always yields a title key; adds a fingerprint key only when present', () => {
    expect(findingMatchKeys({ file: 'a.ts', line: 1, title: 'T' })).toEqual(['a.ts::T::T']);
    expect(findingMatchKeys({ file: 'a.ts', line: 1, title: 'T', fingerprint: 'code' })).toEqual([
      'a.ts::T::T',
      'a.ts::F::code',
    ]);
  });
});
