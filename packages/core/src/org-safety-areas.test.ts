import { describe, it, expect } from 'vitest';
import { sanitizeOrgSafetyAreas, selectOrgSafetyAreas, unionSafetyAreas } from './org-safety-areas.js';
import { matchAreas, computeSafetyScore, capRating } from './agents/safety.js';
import { formatSafetySection } from './comment-formatter.js';
import { DEFAULT_SAFETY_SCORE_CONFIG, SAFETY_FACTORS, type SafetyArea } from './config/defaults.js';
import type { OrgSafetyArea } from './types/db.js';
import type { SafetyResult } from './agents/safety.js';

const org = (over: Partial<OrgSafetyArea> = {}): OrgSafetyArea => ({
  id: 'a1', patterns: ['payments/**'], level: 'risky', enabled: true, scope: { mode: 'all' }, updatedAt: '', updatedBy: '',
  ...over,
});

describe('sanitizeOrgSafetyAreas (#718)', () => {
  it('drops an entry with neither patterns nor notes', () => {
    expect(sanitizeOrgSafetyAreas([{ id: 'x', name: 'Empty' }])).toEqual([]);
  });
  it('clamps an unknown level to absent, keeping the entry', () => {
    const [a] = sanitizeOrgSafetyAreas([{ id: 'x', patterns: ['p/**'], level: 'extreme' }]);
    expect(a).toBeDefined();
    expect(a).not.toHaveProperty('level');
  });
  it('defaults enabled to true and scope to all repos', () => {
    expect(sanitizeOrgSafetyAreas([{ id: 'x', patterns: ['p/**'] }])[0]).toMatchObject({ enabled: true, scope: { mode: 'all' } });
  });
  it('holds org areas to the repo-area rules (#711)', () => {
    expect(sanitizeOrgSafetyAreas([{ id: 'x', notes: 'pattern-less needs a name' }])).toEqual([]);
    expect(sanitizeOrgSafetyAreas([{ id: 'x', patterns: [] }])).toEqual([]);
  });
  it('returns [] for non-array input and never throws', () => {
    for (const raw of [undefined, null, 'x', 42, {}, [null, 'junk', 7]]) {
      expect(() => sanitizeOrgSafetyAreas(raw)).not.toThrow();
      expect(sanitizeOrgSafetyAreas(raw)).toEqual([]);
    }
  });
});

describe('selectOrgSafetyAreas (#718)', () => {
  it('honours enabled and a selected scope', () => {
    const areas = [org({ id: 'on' }), org({ id: 'off', enabled: false }), org({ id: 'other', scope: { mode: 'selected', repos: ['other/repo'] } }), org({ id: 'mine', scope: { mode: 'selected', repos: ['o/r'] } })];
    expect(selectOrgSafetyAreas(areas, 'o/r').map((a) => a.id)).toEqual(['on', 'mine']);
  });
});

describe('org ∪ repo areas through #712 matching (#718)', () => {
  const blastCap = (areas: SafetyArea[]) => {
    const matches = matchAreas(areas, ['payments/charge.ts']);
    const ratings = Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: 5 }])) as any;
    return computeSafetyScore(ratings, DEFAULT_SAFETY_SCORE_CONFIG, matches).factors.blastRadius.rating;
  };
  const risky = capRating('risky', DEFAULT_SAFETY_SCORE_CONFIG.bands);

  it('an org risky area beats a repo safe one on the same pattern — and swapping sides changes nothing', () => {
    const repoSafe: SafetyArea = { patterns: ['payments/**'], level: 'safe' };
    expect(blastCap(unionSafetyAreas([org()], [repoSafe]))).toBe(risky);
    expect(blastCap(unionSafetyAreas([org({ level: 'safe' })], [{ patterns: ['payments/**'], level: 'risky' }]))).toBe(risky);
  });

  it('org areas come first and are tagged org; the tag survives matching', () => {
    const areas = unionSafetyAreas([org()], [{ name: 'Repo', patterns: ['payments/**'] }]);
    expect(areas[0]).toMatchObject({ source: 'org', patterns: ['payments/**'] });
    expect(areas[1]).not.toHaveProperty('source');
    expect(matchAreas(areas, ['payments/a.ts']).map((m) => m.source)).toEqual(['org', undefined]);
  });

  it('an org area scoped to another repo does not apply', () => {
    const selected = selectOrgSafetyAreas([org({ scope: { mode: 'selected', repos: ['other/repo'] } })], 'o/r');
    expect(blastCap(unionSafetyAreas(selected, []))).toBe(5);
  });
});

describe('an org area in the comment (#718)', () => {
  const result = (matchedAreas: SafetyResult['matchedAreas']): SafetyResult => ({
    score: 33, uncappedScore: 33, band: 'risky', emoji: '⛈️',
    factors: Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: 2, label: 'risky', note: 'n.' }])) as SafetyResult['factors'],
    concerns: [], matchedAreas, appliedAreas: [], appliedNotes: [],
  });

  it('renders " (org)" in prose and keeps the raw name in mw-safety', () => {
    const s = formatSafetySection(result([
      { name: 'Message delivery', level: 'risky', source: 'org', matchedPatterns: ['svc/**'], files: ['svc/a.ts'] },
      { name: 'Checkout', level: 'caution', matchedPatterns: ['web/**'], files: ['web/a.ts'] },
    ]), 'e'.repeat(40));
    expect(s).toContain('- Area: Message delivery (org) (risky;');
    expect(s).toContain('- Area: Checkout (caution;');
    expect(s).not.toContain('Checkout (org)');
    const json = JSON.parse(/<!-- mw-safety:(\{.*?\}) -->/.exec(s)![1]);
    expect(json.areas).toContain('Message delivery');
    expect(json.areas).not.toContain('Message delivery (org)');
  });
});
