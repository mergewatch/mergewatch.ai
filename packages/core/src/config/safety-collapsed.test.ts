import { describe, it, expect } from 'vitest';
import { mergeConfig } from './defaults.js';
import { parseRepoConfigYaml } from '../github/client.js';
import { formatReviewComment, parseSafetyPayload } from '../comment-formatter.js';
import type { SafetyResult } from '../agents/safety.js';

/** #719 — `safetyScore.collapsed` puts the factor detail in a <details> block. */
const merged = (yml: string) => mergeConfig(parseRepoConfigYaml(yml) ?? {});

const SHA = 'c'.repeat(40);
const RESULT: SafetyResult = {
  score: 50, uncappedScore: 50, band: 'caution', emoji: '⛅',
  factors: {
    blastRadius: { rating: 3, label: 'caution', note: 'Touches the send path.' },
    changeSize: { rating: 5, label: 'safe', note: 'Small.' },
    testing: { rating: 3, label: 'caution', note: 'Retry path untested.' },
    errorMonitoring: { rating: 5, label: 'safe', note: 'Logged.' },
    rollback: { rating: 3, label: 'caution', note: 'Plain revert.' },
  },
  concerns: ['Retries could double-send.'],
  matchedAreas: [], appliedAreas: [], appliedNotes: [],
};
const fmt = (collapsed: boolean | undefined, emoji = '⛅') =>
  formatReviewComment({
    summary: 's', findings: [],
    safety: { result: { ...RESULT, emoji, ...(collapsed === undefined ? {} : { collapsed }) }, headSha: SHA },
  });
const OPEN = '<details><summary>Factors and concerns</summary>';

describe('safetyScore.collapsed — config (#719)', () => {
  it('collapsed: true merges cleanly; absent merges to false', () => {
    const on = merged('safetyScore:\n  enabled: true\n  collapsed: true\n');
    expect(on.safetyScoreErrors).toBeUndefined();
    expect(on.safetyScore.collapsed).toBe(true);
    expect(merged('safetyScore:\n  enabled: true\n').safetyScore.collapsed).toBe(false);
  });

  it('collapsed: "yes" gives exactly one error, naming the key', () => {
    const c = merged('safetyScore:\n  enabled: true\n  collapsed: "yes"\n');
    expect(c.safetyScoreErrors).toHaveLength(1);
    expect(c.safetyScoreErrors![0]).toMatch(/^safetyScore\.collapsed: must be true or false/);
    expect(c.safetyScore.enabled).toBe(false);
  });
});

describe('safetyScore.collapsed — rendering (#719)', () => {
  it('collapsed: the band line stays out; factors and concerns go inside one <details>', () => {
    const body = fmt(true);
    const band = body.indexOf('⛅ **Safety: Caution (50/100)**');
    const open = body.indexOf(OPEN);
    const close = body.indexOf('</details>', open);
    expect(band).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(band);
    expect(body.slice(open + OPEN.length, open + OPEN.length + 2)).toBe('\n\n');
    for (const line of ['- Blast radius: caution. Touches the send path.', '- Rollback: caution. Plain revert.', '- Retries could double-send.']) {
      const at = body.indexOf(line);
      expect(at, line).toBeGreaterThan(open);
      expect(at, line).toBeLessThan(close);
    }
    expect(body.split('<details>').length - 1).toBe(1);
  });

  it('expanded (false or absent) has no <details>, and the two are byte-identical', () => {
    expect(fmt(false)).not.toContain('<details>');
    expect(fmt(false)).toBe(fmt(undefined));
  });

  it('the mw-safety line is identical either way, and outside <details>', () => {
    const line = (b: string) => b.split('\n').find((l) => l.startsWith('<!-- mw-safety:'));
    const collapsed = fmt(true);
    expect(line(collapsed)).toBe(line(fmt(false)));
    expect(collapsed.indexOf(line(collapsed)!)).toBeLessThan(collapsed.indexOf(OPEN));
    expect(parseSafetyPayload(collapsed)).toMatchObject({ score: 50, band: 'caution', sha: SHA });
  });

  it('a custom emoji still prefixes the band line when collapsed', () => {
    const body = fmt(true, '🌥️');
    expect(body).toContain(OPEN); // non-vacuity: it really is the collapsed layout
    expect(body).toContain('🌥️ **Safety: Caution (50/100)**');
  });
});
