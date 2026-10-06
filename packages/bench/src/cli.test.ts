import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { assertExpectations, findRepoRoot, parseArgs } from './cli.js';
import type { BenchResult } from './types.js';

describe('parseArgs', () => {
  it('ignores the bare -- that pnpm forwards', () => {
    // `pnpm --filter ... run bench -- --corpus x` arrives with a literal `--`.
    const args = parseArgs(['--', '--corpus', 'a.json', '--stub']);
    expect(args.corpus).toBe('a.json');
    expect(args.stub).toBe(true);
  });

  it('defaults to requiring the model echo', () => {
    expect(parseArgs([]).requireModelEcho).toBe(true);
    expect(parseArgs(['--no-require-model-echo']).requireModelEcho).toBe(false);
  });

  it('parses the cap and the expectations as numbers', () => {
    const args = parseArgs([
      '--max-spend-usd', '0',
      '--expect-precision', '1',
      '--expect-recall', '0.5',
      '--expect-f1', '0.6666666666666666',
      '--arm', 'arm-a',
      '--out', 'out/r.json',
    ]);
    expect(args.maxSpendUsd).toBe(0);
    expect(args.expect).toEqual({ precision: 1, recall: 0.5, f1: 0.6666666666666666 });
    expect(args.arm).toBe('arm-a');
    expect(args.out).toBe('out/r.json');
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--not-a-flag'])).toThrow(/Unknown argument/);
  });
});

function result(totals: Partial<BenchResult['totals']>): BenchResult {
  return {
    corpus: 'c',
    startedAt: new Date().toISOString(),
    totals: {
      precision: 1, recall: 0.5, f1: 0.6666666666666666,
      truePositives: 1, falsePositives: 0, falseNegatives: 1,
      casesAttempted: 2, casesGraded: 2, casesSkipped: 0, spendUsd: 0,
      ...totals,
    },
    cases: [],
  };
}

describe('assertExpectations', () => {
  it('passes when every stated metric matches', () => {
    expect(
      assertExpectations(result({}), { precision: 1, recall: 0.5, f1: 0.6666666666666666 }),
    ).toEqual([]);
  });

  it('reports each metric that does not match', () => {
    const failures = assertExpectations(result({}), { precision: 0.9, recall: 1 });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/precision: expected 0.9/);
    expect(failures[1]).toMatch(/recall: expected 1/);
  });

  it('ignores metrics that were not asserted', () => {
    expect(assertExpectations(result({}), {})).toEqual([]);
  });

  it('is tight enough to catch a 4dp difference', () => {
    expect(assertExpectations(result({ recall: 0.5001 }), { recall: 0.5 })).toHaveLength(1);
  });
});

describe('findRepoRoot', () => {
  it('finds the workspace root from inside a package', () => {
    const root = findRepoRoot(resolve(__dirname));
    expect(root).toMatch(/mergewatch\.ai$/);
  });

  it('throws rather than guessing when there is no workspace above', () => {
    expect(() => findRepoRoot('/')).toThrow(/Could not find pnpm-workspace.yaml/);
  });
});
