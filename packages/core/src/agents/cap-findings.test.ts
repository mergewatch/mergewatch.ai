import { describe, it, expect } from 'vitest';
import { capFindings } from './reviewer.js';

/**
 * #569 — `maxFindings` was only ever substituted into the orchestrator prompt
 * as `MAX_FINDINGS_PLACEHOLDER`. It was a REQUEST to the model, never a cap, so
 * a repo configured `maxFindings: 3` could receive four findings with no signal
 * that anything had been ignored. `minSeverity`, in the same config block and
 * documented alike, has always been a real code filter.
 */
const f = (title: string, category?: string) => ({ title, category, file: 'a.ts', line: 1 });
const NO_CUSTOM = new Set<string>();

describe('capFindings', () => {
  it('caps the model set at maxFindings, keeping the highest-ranked', () => {
    // Order is the orchestrator's ranking, preserved through the filters, so
    // taking the first N keeps the strongest rather than an arbitrary slice.
    const { kept, dropped } = capFindings([f('1'), f('2'), f('3'), f('4')], 3, NO_CUSTOM);
    expect(kept.map((x) => x.title)).toEqual(['1', '2', '3']);
    expect(dropped.map((x) => x.title)).toEqual(['4']);
  });

  it('passes through unchanged when under the cap', () => {
    const input = [f('1'), f('2')];
    const { kept, dropped } = capFindings(input, 5, NO_CUSTOM);
    expect(kept).toEqual(input);
    expect(dropped).toEqual([]);
  });

  it('NEVER drops a custom-agent finding', () => {
    // The important one. Custom findings bypass model filtering by design
    // (#385) because they are user-legislated policy, and a blocking agent's
    // finding failing the check is the entire point. Dropping one to satisfy a
    // noise cap would silently discard exactly what #385 protects.
    const custom = new Set(['no-todo']);
    const { kept, dropped } = capFindings(
      [f('m1'), f('m2'), f('c1', 'no-todo'), f('m3'), f('c2', 'no-todo')],
      1,
      custom,
    );
    expect(kept.map((x) => x.title)).toEqual(['m1', 'c1', 'c2']);
    expect(dropped.map((x) => x.title)).toEqual(['m2', 'm3']);
  });

  it('custom findings do not consume the model budget', () => {
    // A repo with custom agents still gets its full model allowance.
    const custom = new Set(['policy']);
    const { kept } = capFindings([f('c', 'policy'), f('m1'), f('m2')], 2, custom);
    expect(kept.map((x) => x.title)).toEqual(['c', 'm1', 'm2']);
  });

  it('a builtin category is not mistaken for a custom agent', () => {
    // Builtin findings carry categories too (security, bug, style…). Only a
    // name in the enabled custom-agent set is exempt.
    const { kept, dropped } = capFindings([f('a', 'security'), f('b', 'bug')], 1, new Set(['no-todo']));
    expect(kept.map((x) => x.title)).toEqual(['a']);
    expect(dropped.map((x) => x.title)).toEqual(['b']);
  });

  it('treats a non-positive or non-finite cap as no cap', () => {
    // Absent config must not silently suppress every finding.
    const input = [f('1'), f('2')];
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(capFindings(input, bad, NO_CUSTOM).kept).toEqual(input);
      expect(capFindings(input, bad, NO_CUSTOM).dropped).toEqual([]);
    }
  });

  it('handles an empty finding set', () => {
    expect(capFindings([], 3, NO_CUSTOM)).toEqual({ kept: [], dropped: [] });
  });

  it('a cap of 1 with only custom findings keeps them all', () => {
    const custom = new Set(['policy']);
    const { kept, dropped } = capFindings([f('c1', 'policy'), f('c2', 'policy')], 1, custom);
    expect(kept).toHaveLength(2);
    expect(dropped).toEqual([]);
  });
});
