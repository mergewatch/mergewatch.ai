import { describe, expect, it } from 'vitest';
import { resolveInCorpus, validateManifest } from './manifest.js';

const CASE = {
  id: 'c1',
  repo: 'owner/name',
  prNumber: 1,
  headRef: 'sha',
  diffPath: 'diffs/a.diff',
  groundTruth: [
    { id: 'gt', file: 'a.ts', line: 3, cause: 'because', causeKeywords: ['sql injection'] },
  ],
};
const GOOD = { name: 'c', lineTolerance: 2, cases: [CASE] };

describe('validateManifest', () => {
  it('accepts a well-formed manifest and returns it', () => {
    const m = validateManifest(GOOD);
    expect(m.name).toBe('c');
    expect(m.lineTolerance).toBe(2);
    expect(m.cases[0].groundTruth[0].causeKeywords).toEqual(['sql injection']);
  });

  it('REQUIRES lineTolerance, because a missing one silently zeroes recall', () => {
    // undefined tolerance => Math.abs(d) <= undefined is always false =>
    // nothing ever location-matches => recall 0 on a corpus that looks fine.
    const { lineTolerance, ...noTolerance } = GOOD;
    void lineTolerance;
    expect(() => validateManifest(noTolerance)).toThrow(/lineTolerance.*finite number/s);
  });

  it('rejects a negative lineTolerance', () => {
    expect(() => validateManifest({ ...GOOD, lineTolerance: -1 })).toThrow(/must not be negative/);
  });

  it('REQUIRES non-empty causeKeywords, because empty ones downgrade every catch', () => {
    const bad = { ...GOOD, cases: [{ ...CASE, groundTruth: [{ ...CASE.groundTruth[0], causeKeywords: [] }] }] };
    expect(() => validateManifest(bad)).toThrow(/causeKeywords.*non-empty/s);
  });

  it('rejects a diffPath that escapes the corpus directory', () => {
    const bad = { ...GOOD, cases: [{ ...CASE, diffPath: '../../../../etc/passwd' }] };
    expect(() => validateManifest(bad, '/corpus')).toThrow(/stay inside the corpus/);
  });

  it('rejects a malformed repo', () => {
    expect(() => validateManifest({ ...GOOD, cases: [{ ...CASE, repo: 'owner' }] })).toThrow(
      /expected "owner\/name"/,
    );
  });

  it('rejects duplicate case ids', () => {
    expect(() => validateManifest({ ...GOOD, cases: [CASE, CASE] })).toThrow(/duplicate case ids: c1/);
  });

  it('rejects an empty or missing cases array', () => {
    expect(() => validateManifest({ ...GOOD, cases: [] })).toThrow(/non-empty array/);
    expect(() => validateManifest({ name: 'c', lineTolerance: 2 })).toThrow(/non-empty array/);
  });

  it('names the exact field that is wrong', () => {
    const bad = { ...GOOD, cases: [{ ...CASE, groundTruth: [{ ...CASE.groundTruth[0], line: 'three' }] }] };
    expect(() => validateManifest(bad)).toThrow(/cases\[0\].groundTruth\[0\].line/);
  });

  it('rejects a non-object root', () => {
    expect(() => validateManifest(null)).toThrow(/expected an object/);
    expect(() => validateManifest('a string')).toThrow(/expected an object/);
  });

  it('validates stubFindings when present', () => {
    const bad = {
      ...GOOD,
      cases: [{ ...CASE, stubFindings: [{ file: 'a.ts', line: 1, severity: 'nope', title: 't', description: 'd' }] }],
    };
    expect(() => validateManifest(bad)).toThrow(/stubFindings\[0\].severity/);
  });

  it('accepts a valid severity on ground truth and rejects an invalid one', () => {
    expect(() =>
      validateManifest({ ...GOOD, cases: [{ ...CASE, groundTruth: [{ ...CASE.groundTruth[0], severity: 'critical' }] }] }),
    ).not.toThrow();
    expect(() =>
      validateManifest({ ...GOOD, cases: [{ ...CASE, groundTruth: [{ ...CASE.groundTruth[0], severity: 'urgent' }] }] }),
    ).toThrow(/severity/);
  });
});

describe('resolveInCorpus', () => {
  it('resolves a path inside the corpus', () => {
    expect(resolveInCorpus('/corpus', 'diffs/a.diff')).toBe('/corpus/diffs/a.diff');
  });

  it.each(['../a.diff', '/etc/passwd', 'diffs/../../a.diff'])('refuses %o', (bad) => {
    expect(() => resolveInCorpus('/corpus', bad)).toThrow(/stay inside the corpus/);
  });

  it('does not admit a sibling directory sharing a prefix', () => {
    expect(() => resolveInCorpus('/corpus', '../corpus-other/a.diff')).toThrow(/stay inside/);
  });
});

describe('the committed smoke corpora validate', () => {
  it.each(['smoke.json', 'smoke-skip.json'])('%s', async (file) => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const path = resolve(__dirname, '..', 'fixtures', file);
    const dir = resolve(__dirname, '..', 'fixtures');
    expect(() => validateManifest(JSON.parse(readFileSync(path, 'utf-8')), dir)).not.toThrow();
  });
});
