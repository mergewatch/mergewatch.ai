import { describe, it, expect } from 'vitest';
import { DEFAULT_SAFETY_SCORE_CONFIG, mergeConfig } from './defaults.js';
import { parseRepoConfigYaml } from '../github/client.js';

/** yml → the merged config, exactly as a runtime builds it. */
const merged = (yml: string) => mergeConfig(parseRepoConfigYaml(yml) ?? {});

// The epic's (#710) full example, verbatim.
const EPIC_EXAMPLE = `
safetyScore:
  enabled: true
  bands:
    risky: 33
    caution: 67
  emoji:
    safe: "☀️"
    caution: "⛅"
    risky: "⛈️"
  factors:
    blastRadius:     { weight: 30 }
    changeSize:      { weight: 15 }
    testing:         { weight: 25, notes: "Manual testing evidence in the PR description counts" }
    errorMonitoring: { weight: 10 }
    rollback:        { weight: 20, notes: "Sensitive features should be behind a feature flag" }
  areas:
    - name: Message delivery
      patterns: ["services/notifications/**", "workers/messaging/**"]
      level: risky
      notes: "Every customer message goes through here"
    - name: Billing
      notes: "Anything that changes what or when we charge customers is risky"
    - patterns: ["**/migrations/**"]
      level: risky
      notes: "Schema change; check it can be rolled back"
    - patterns: ["internal-tools/**"]
      level: safe
      notes: "Staff-only tooling; missing tests are acceptable"
  notes:
    - "Changing a background job's signature is risky: queued jobs run with the old arguments"
`;

describe('safetyScore config (#711)', () => {
  it('defaults: no block parses to no safetyScore keys, and merges to the defaults', () => {
    const parsed = parseRepoConfigYaml('model: x\n')!;
    expect('safetyScore' in parsed).toBe(false);
    expect('safetyScoreErrors' in parsed).toBe(false);
    // Literal values, not just DEFAULT_SAFETY_SCORE_CONFIG: before #711 both
    // sides of that comparison were undefined, and it passed.
    const c = mergeConfig({});
    expect(c.safetyScore).toEqual(DEFAULT_SAFETY_SCORE_CONFIG);
    expect(c.safetyScore.enabled).toBe(false);
    expect(c.safetyScore.bands).toEqual({ risky: 33, caution: 67 });
    expect(c.safetyScore.factors.blastRadius).toEqual({ weight: 30 });
    expect('safetyScoreErrors' in c).toBe(false);
  });

  it('a partial block merges key by key over the defaults', () => {
    const c = merged(`
safetyScore:
  enabled: true
  bands: { risky: 20 }
  factors:
    testing: { weight: 40, notes: "x" }
`);
    expect(c.safetyScoreErrors).toBeUndefined();
    expect(c.safetyScore.enabled).toBe(true);
    expect(c.safetyScore.bands).toEqual({ risky: 20, caution: 67 });
    expect(c.safetyScore.factors.testing).toEqual({ weight: 40, notes: 'x' });
    expect(c.safetyScore.factors.blastRadius).toEqual(DEFAULT_SAFETY_SCORE_CONFIG.factors.blastRadius);
    expect(c.safetyScore.factors.rollback).toEqual(DEFAULT_SAFETY_SCORE_CONFIG.factors.rollback);
    expect(c.safetyScore.emoji).toEqual(DEFAULT_SAFETY_SCORE_CONFIG.emoji);
  });

  it('merging never mutates the shared defaults', () => {
    merged('safetyScore: { enabled: true, bands: { risky: 70 } }');
    expect(DEFAULT_SAFETY_SCORE_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SAFETY_SCORE_CONFIG.bands).toEqual({ risky: 33, caution: 67 });
  });

  it('control: the epic example is valid and stays enabled', () => {
    const c = merged(EPIC_EXAMPLE);
    expect(c.safetyScoreErrors).toBeUndefined();
    expect(c.safetyScore.enabled).toBe(true);
    expect(c.safetyScore.areas).toHaveLength(4);
    expect(c.safetyScore.areas[1]).toEqual({ name: 'Billing', notes: 'Anything that changes what or when we charge customers is risky' });
    expect(c.safetyScore.notes).toHaveLength(1);
  });

  const area = (i: number) => `    - { name: "A${i}", patterns: ["a${i}/**"] }`;
  // Every row but `enabled: "yes"` sets enabled: true, so "disabled" can only
  // come from the error, not from the default.
  const rows: Array<[string, string, string]> = [
    ['risky above the default caution (cross-field)', 'bands: { risky: 70 }', 'safetyScore.bands'],
    ['risky 0', 'bands: { risky: 0 }', 'safetyScore.bands.risky'],
    ['caution 100', 'bands: { caution: 100 }', 'safetyScore.bands.caution'],
    ['a fractional band', 'bands: { risky: 33.5 }', 'safetyScore.bands.risky'],
    ['all weights zero (cross-field)', 'factors: { blastRadius: { weight: 0 }, changeSize: { weight: 0 }, testing: { weight: 0 }, errorMonitoring: { weight: 0 }, rollback: { weight: 0 } }', 'safetyScore.factors'],
    ['a negative weight', 'factors: { testing: { weight: -1 } }', 'safetyScore.factors.testing.weight'],
    ['a huge weight', 'factors: { testing: { weight: 1e308 } }', 'safetyScore.factors.testing.weight'],
    ['an unknown factor', 'factors: { tesing: { weight: 5 } }', 'safetyScore.factors.tesing'],
    ['an unknown top-level key', 'area: []', 'safetyScore.area'],
    ['an unknown level', 'areas: [{ name: X, patterns: ["x/**"], level: high }]', 'safetyScore.areas[0].level'],
    ['an area with notes but no name or patterns', 'areas: [{ notes: "n" }]', 'safetyScore.areas[0].name'],
    ['area names that differ only by case', 'areas: [{ name: Billing, notes: "a" }, { name: billing, notes: "b" }]', 'safetyScore.areas[1].name'],
    ['51 areas', `areas:\n${Array.from({ length: 51 }, (_, i) => area(i)).join('\n')}`, 'safetyScore.areas'],
  ];

  it.each(rows)('rejects %s: disabled, error names the path', (_, body, path) => {
    const indented = body.split('\n').map((l, i) => (i === 0 ? `  ${l}` : l)).join('\n');
    const c = merged(`safetyScore:\n  enabled: true\n${indented}\n`);
    expect(c.safetyScore.enabled).toBe(false);
    expect(c.safetyScoreErrors?.[0]?.startsWith(path), String(c.safetyScoreErrors)).toBe(true);
  });

  it('rejects enabled: "yes": disabled, error names the path', () => {
    const c = merged('safetyScore:\n  enabled: "yes"\n');
    expect(c.safetyScore.enabled).toBe(false);
    expect(c.safetyScoreErrors?.[0]).toMatch(/^safetyScore\.enabled/);
  });

  it('rejects an emoji with a newline, and a non-mapping block', () => {
    expect(merged('safetyScore:\n  enabled: true\n  emoji: { safe: "a\\nb" }\n').safetyScoreErrors?.[0]).toMatch(/^safetyScore\.emoji\.safe/);
    expect(merged('safetyScore: true\n').safetyScoreErrors?.[0]).toMatch(/^safetyScore:/);
  });
});
