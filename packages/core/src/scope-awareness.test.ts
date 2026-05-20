import { describe, it, expect } from 'vitest';
import type { AgentFinding } from './agents/reviewer.js';
import { detectNoTestHarness, suppressTestCoverageFindings } from './scope-awareness.js';

describe('detectNoTestHarness', () => {
  it('matches the canonical phrases used by the example repos in the plan', () => {
    // The exact wording observed in real conventions docs (voice-bot / orca).
    expect(detectNoTestHarness('No unit test suite currently')).toBe(true);
    expect(detectNoTestHarness('# Repo notes\n\n- No test harness yet — coverage is deferred')).toBe(true);
    expect(detectNoTestHarness('Tests are out of scope for this phase.')).toBe(true);
    expect(detectNoTestHarness('No tests yet; tracking in #FOLLOWUP.')).toBe(true);
    expect(detectNoTestHarness('Tests are not implemented for this repo.')).toBe(true);
    expect(detectNoTestHarness('Note: no co-located tests.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectNoTestHarness('NO UNIT TEST SUITE')).toBe(true);
    expect(detectNoTestHarness('No Test Harness')).toBe(true);
  });

  it('does NOT match casual mentions of tests', () => {
    // Conservative direction: under-match (keep nagging) rather than
    // over-match (silently hide real coverage gaps).
    expect(detectNoTestHarness('Run `pnpm test` before pushing.')).toBe(false);
    expect(detectNoTestHarness('Tests live in `tests/` and run on CI.')).toBe(false);
    expect(detectNoTestHarness('Please add tests for new public functions.')).toBe(false);
    expect(detectNoTestHarness('We use vitest. See AGENTS.md for the test pattern.')).toBe(false);
  });

  it('returns false for empty / undefined input', () => {
    expect(detectNoTestHarness(undefined)).toBe(false);
    expect(detectNoTestHarness('')).toBe(false);
    expect(detectNoTestHarness('   \n  \t  ')).toBe(false);
  });
});

describe('suppressTestCoverageFindings', () => {
  function f(over: Partial<AgentFinding> & { category: string }): AgentFinding & { category: string } {
    return {
      file: 'src/x.ts', line: 1, severity: 'warning',
      title: 'T', description: 'D', suggestion: '',
      ...over,
    };
  }

  it('collapses every test-coverage finding into a single info-level note', () => {
    const findings = [
      f({ category: 'test-coverage', title: 'foo() lacks coverage' }),
      f({ category: 'test-coverage', title: 'bar() lacks coverage' }),
      f({ category: 'test-coverage', title: 'baz() lacks coverage' }),
      f({ category: 'security', title: 'Real warning' }),
    ];
    const { findings: out, suppressedCount } = suppressTestCoverageFindings(findings);

    expect(suppressedCount).toBe(3);

    const coverage = out.filter((x) => x.category === 'test-coverage');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe('info');
    expect(coverage[0].title).toMatch(/suppressed.*no test harness/i);
    expect(coverage[0].description).toMatch(/^3 test-coverage finding/);

    // Non-coverage findings pass through unchanged.
    expect(out.filter((x) => x.category === 'security')).toHaveLength(1);
  });

  it('is a no-op when there are no test-coverage findings', () => {
    const findings = [
      f({ category: 'security', title: 'A' }),
      f({ category: 'bug', title: 'B' }),
    ];
    const { findings: out, suppressedCount } = suppressTestCoverageFindings(findings);
    expect(suppressedCount).toBe(0);
    expect(out).toEqual(findings); // no aggregate note added
  });

  it('handles a single test-coverage finding (1 → 1 note, not 0)', () => {
    const findings = [f({ category: 'test-coverage', title: 'only one' })];
    const { findings: out, suppressedCount } = suppressTestCoverageFindings(findings);
    expect(suppressedCount).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('info');
    expect(out[0].description).toMatch(/^1 test-coverage finding /); // singular
  });

  it('preserves the original file path on the aggregate note', () => {
    // So the aggregate note anchors somewhere meaningful in the rendered comment.
    const findings = [
      f({ category: 'test-coverage', file: 'packages/voice-bot/src/kb-migrate.ts', line: 27 }),
      f({ category: 'test-coverage', file: 'packages/voice-bot/src/kb-store.ts',   line: 35 }),
    ];
    const { findings: out } = suppressTestCoverageFindings(findings);
    const note = out[out.length - 1];
    expect(note.file).toBe('packages/voice-bot/src/kb-migrate.ts');
    expect(note.line).toBe(1);
  });
});
