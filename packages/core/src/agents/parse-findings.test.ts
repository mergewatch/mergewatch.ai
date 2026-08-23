/**
 * #401 — suppressed-findings counter showed 1430 / 3869 on 4-line diffs.
 *
 * Diagnosis from production data: output tokens on both reviews were normal
 * (3,794 and 3,233), so nothing expensive happened. An agent had emitted
 * ~1,430 near-empty objects until `max_tokens` cut it off. The array parsed
 * fine, every entry was discarded downstream, and `suppressedCount`
 * (raw − final) faithfully reported the junk as "removed by dedup & quality
 * filters" — describing an agent malfunction as productive work.
 *
 * These tests pin the shape validation, and the distinction between a
 * malformed response and ordinary suppression.
 */
import { describe, it, expect } from 'vitest';
import { parseAgentFindings, isUsableFinding } from './reviewer.js';
import type { AgentDiagnostics } from './reviewer.js';

const diag = (): AgentDiagnostics => ({ parseFailures: 0, degenerateResponses: 0 });
const good = (title: string) => ({
  file: 'src/a.ts', line: 1, severity: 'warning' as const,
  title, description: 'd', suggestion: 's',
});

describe('isUsableFinding', () => {
  it('accepts a finding with a title', () => {
    expect(isUsableFinding(good('Null deref'))).toBe(true);
  });

  it('rejects the shapes that inflated the counter', () => {
    for (const junk of [{}, null, undefined, '', 'a string', 42, [], { title: '' }, { title: '   ' }]) {
      expect(isUsableFinding(junk)).toBe(false);
    }
  });
});

describe('parseAgentFindings', () => {
  it('returns well-formed findings unchanged', () => {
    const d = diag();
    const out = parseAgentFindings(JSON.stringify({ findings: [good('A'), good('B')] }), d);
    expect(out).toHaveLength(2);
    expect(d.degenerateResponses).toBe(0);
    expect(d.parseFailures).toBe(0);
  });

  it('reproduces #401: 1430 near-empty objects count as ZERO, not 1430', () => {
    // The production failure. Before the fix these reached totalRawFindings
    // and were reported as 1,430 suppressed findings.
    const d = diag();
    const out = parseAgentFindings(
      JSON.stringify({ findings: Array.from({ length: 1430 }, () => ({})) }), d,
    );
    expect(out).toEqual([]);
    expect(d.degenerateResponses).toBe(1);
  });

  it('flags a mostly-junk response as degenerate and discards ALL of it', () => {
    // An agent that emitted 1,428 empty objects and 2 real findings has
    // malfunctioned; keeping the 2 and reporting 1,428 suppressed would
    // describe the malfunction as routine filtering.
    const d = diag();
    const findings = [...Array.from({ length: 1428 }, () => ({})), good('A'), good('B')];
    expect(parseAgentFindings(JSON.stringify({ findings }), d)).toEqual([]);
    expect(d.degenerateResponses).toBe(1);
  });

  it('keeps the good ones when only a few are malformed', () => {
    // Above the ratio: ordinary partial junk, not a malfunction.
    const d = diag();
    const findings = [good('A'), good('B'), good('C'), {}];
    const out = parseAgentFindings(JSON.stringify({ findings }), d);
    expect(out.map((f) => f.title)).toEqual(['A', 'B', 'C']);
    expect(d.degenerateResponses).toBe(0);
  });

  it('discards a non-array `findings` rather than counting its characters', () => {
    // `.length` exists on strings, so an unchecked string would have
    // contributed its character count to the raw total.
    const d = diag();
    const prose = 'x'.repeat(1430);
    expect(parseAgentFindings(JSON.stringify({ findings: prose }), d)).toEqual([]);
    expect(d.degenerateResponses).toBe(1);
  });

  it('discards an object `findings`', () => {
    const d = diag();
    expect(parseAgentFindings(JSON.stringify({ findings: { a: 1 } }), d)).toEqual([]);
    expect(d.degenerateResponses).toBe(1);
  });

  it('treats a missing findings key as empty, not degenerate', () => {
    // A legitimately clean review — no findings is the expected happy path.
    const d = diag();
    expect(parseAgentFindings(JSON.stringify({}), d)).toEqual([]);
    expect(d.degenerateResponses).toBe(0);
  });

  it('treats an empty array as clean, not degenerate', () => {
    const d = diag();
    expect(parseAgentFindings(JSON.stringify({ findings: [] }), d)).toEqual([]);
    expect(d.degenerateResponses).toBe(0);
  });

  it('counts unparseable JSON as a parse failure, not a degenerate response', () => {
    // #382's diagnostic stays distinct from #401's — they have different causes
    // and different remedies.
    const d = diag();
    expect(parseAgentFindings('not json at all', d)).toEqual([]);
    expect(d.parseFailures).toBe(1);
    expect(d.degenerateResponses).toBe(0);
  });

  it('works without a diagnostics object', () => {
    expect(parseAgentFindings(JSON.stringify({ findings: [{}] }))).toEqual([]);
  });
});
