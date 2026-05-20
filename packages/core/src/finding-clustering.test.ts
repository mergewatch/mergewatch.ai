import { describe, it, expect } from 'vitest';
import {
  clusterFindings,
  extractSignificantTokens,
  type ClusterableFinding,
} from './finding-clustering.js';

function f(
  partial: Partial<ClusterableFinding> & { line: number; title: string },
): ClusterableFinding {
  return {
    file: 'src/x.ts',
    severity: 'warning',
    description: '',
    ...partial,
  };
}

describe('extractSignificantTokens', () => {
  it('keeps lowercased alphanumeric tokens ≥ 5 chars', () => {
    const tokens = extractSignificantTokens('Missing input validation on the boundary');
    expect(tokens.has('validation')).toBe(true);
    expect(tokens.has('boundary')).toBe(true);
    // "input" is 5 chars — kept.
    expect(tokens.has('input')).toBe(true);
    // 4-char tokens are dropped (too generic).
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('on')).toBe(false);
  });

  it('drops generic finding-prose words', () => {
    const tokens = extractSignificantTokens('Potential issue: missing risk concern');
    // All four (potential / issue / missing / concern) are stop-listed.
    expect(tokens.size).toBe(0);
  });

  it('returns an empty set for blank input', () => {
    expect(extractSignificantTokens('').size).toBe(0);
    expect(extractSignificantTokens('  !@#$ ').size).toBe(0);
  });
});

describe('clusterFindings', () => {
  it('returns inputs unchanged when there are < 2 findings', () => {
    const single = [f({ line: 1, title: 'Single finding about validation' })];
    expect(clusterFindings(single)).toEqual({ findings: single, clusteredCount: 0 });
    expect(clusterFindings([])).toEqual({ findings: [], clusteredCount: 0 });
  });

  it('merges two findings when same file + close lines + shared significant token', () => {
    const findings = [
      f({ line: 10, title: 'Input validation missing on user payload' }),
      f({ line: 12, title: 'Payload validation needs schema check' }),
    ];
    const { findings: out, clusteredCount } = clusterFindings(findings);
    expect(clusteredCount).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].title).toMatch(/and 1 related concern/);
    expect(out[0].description).toMatch(/Related concerns clustered into this finding/);
    expect(out[0].description).toMatch(/Payload validation/);
  });

  it('does NOT merge findings on DIFFERENT files even with identical titles', () => {
    const findings = [
      f({ file: 'a.ts', line: 10, title: 'Input validation missing' }),
      f({ file: 'b.ts', line: 10, title: 'Input validation missing' }),
    ];
    const { clusteredCount, findings: out } = clusterFindings(findings);
    expect(clusteredCount).toBe(0);
    expect(out).toHaveLength(2);
  });

  it('does NOT merge findings on same file but lines too far apart (> maxLineSpan)', () => {
    const findings = [
      f({ line: 10,  title: 'Input validation missing on payload' }),
      f({ line: 200, title: 'Input validation missing on payload' }),
    ];
    const { clusteredCount, findings: out } = clusterFindings(findings, { maxLineSpan: 50 });
    expect(clusteredCount).toBe(0);
    expect(out).toHaveLength(2);
  });

  it('does NOT merge findings on same file + close lines but NO significant token overlap', () => {
    const findings = [
      f({ line: 10, title: 'SQL injection in dynamic query' }),
      f({ line: 12, title: 'Memory leak in event handler closure' }),
    ];
    const { clusteredCount } = clusterFindings(findings);
    expect(clusteredCount).toBe(0);
  });

  it('clusters TRANSITIVELY (A↔B↔C with no direct A↔C edge still merges all three)', () => {
    // A↔B share "validation"; B↔C share "structure"; A and C share nothing.
    // Union-find should still group them all.
    const findings = [
      f({ line: 10, title: 'Input validation missing',
          description: 'The payload validation step is skipped.' }),
      f({ line: 14, title: 'Schema validation needs structure check',
          description: 'The structure of the parsed payload is not validated.' }),
      f({ line: 18, title: 'Object structure passed unchecked',
          description: 'The object structure may contain unexpected fields.' }),
    ];
    const { clusteredCount, findings: out } = clusterFindings(findings);
    expect(clusteredCount).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('strongest severity wins the merged finding', () => {
    const findings = [
      f({ line: 10, severity: 'info',     title: 'Untrusted JSON parsing' }),
      f({ line: 12, severity: 'critical', title: 'Untrusted JSON sink runs SQL' }),
      f({ line: 14, severity: 'warning',  title: 'Untrusted JSON path' }),
    ];
    const { findings: out } = clusterFindings(findings);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical');
    // Within the same severity bucket, lowest line wins; here the only
    // critical is line 12 so that's the primary.
    expect(out[0].title).toMatch(/^Untrusted JSON sink runs SQL/);
  });

  it('respects the cluster-size cap — too-large clusters are NOT merged', () => {
    // Six findings sharing "validation" within a tight line window. Cap is 5
    // by default — the cluster is rejected and all six pass through unmerged.
    const findings = Array.from({ length: 6 }, (_, i) =>
      f({ line: 10 + i, title: `Validation issue ${i + 1} on payload structure` }),
    );
    const { findings: out, clusteredCount } = clusterFindings(findings);
    expect(clusteredCount).toBe(0);
    expect(out).toHaveLength(6);
  });

  it('caller can tune the heuristic via options', () => {
    // With a stricter line-span, the same findings no longer cluster.
    const findings = [
      f({ line: 10, title: 'Validation missing on payload' }),
      f({ line: 25, title: 'Validation missing on payload' }),
    ];
    expect(clusterFindings(findings, { maxLineSpan: 50 }).clusteredCount).toBe(1);
    expect(clusterFindings(findings, { maxLineSpan: 10 }).clusteredCount).toBe(0);
  });

  it('reproduces the #37 fragmentation: 3 angles on "validate parsed S3 chunk file" merge into one', () => {
    // Real findings (paraphrased from voice-bot PR #37):
    const findings = [
      f({ line: 82,  severity: 'warning', title: 'Type assertion without runtime validation',
          description: 'The function casts chunks to ChunkFileEntry[] without validating the structure of individual chunk objects. Malformed chunk objects could lead to runtime errors.' }),
      f({ line: 130, severity: 'info', title: 'Untrusted JSON parsing from S3 without validation',
          description: 'JSON is parsed from S3 at line 130 without schema validation. Malformed or malicious JSON could cause parsing errors or unexpected data structures.' }),
      f({ line: 150, severity: 'warning', title: 'SQL injection risk in dynamic VALUES clause construction',
          description: 'The code dynamically constructs a SQL VALUES clause by concatenating strings. While parameters are used correctly, the structure could be exploited if input validation is missing.' }),
    ];
    const { findings: out, clusteredCount } = clusterFindings(findings);
    // 82→130 line span = 48 (within 50), 130→150 = 20, so transitive cluster
    // forms even though 82↔150 directly is 68 lines apart. All three share
    // significant tokens ("validation", "structure", "chunk", "parsing").
    expect(out).toHaveLength(1);
    expect(clusteredCount).toBe(2);
    // Highest severity in the cluster is warning, line 82 wins (lowest line
    // among warnings is 82).
    expect(out[0].severity).toBe('warning');
    expect(out[0].line).toBe(82);
    expect(out[0].description).toMatch(/Untrusted JSON/);
    expect(out[0].description).toMatch(/SQL injection/);
  });
});
