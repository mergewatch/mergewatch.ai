import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { DEFAULT_SAFETY_SCORE_CONFIG, SAFETY_FACTORS, mergeConfig } from './defaults.js';
import { parseRepoConfigYaml } from '../github/client.js';
import { formatSafetySection, parseSafetyPayload } from '../comment-formatter.js';
import { computeSafetyScore, type SafetyResult } from '../agents/safety.js';

/**
 * #715 — the `## Safety score` docs are checked against the code, so they
 * cannot drift: every example parses and validates through #711's real
 * parser and merge, the defaults block equals DEFAULT_SAFETY_SCORE_CONFIG,
 * and the comment example is the #713 renderer's output for a committed
 * fixture.
 */
const REPO_ROOT = resolve(process.cwd(), '..', '..');
const DOC = readFileSync(join(REPO_ROOT, 'docs-site/configuration/mergewatch-yml.mdx'), 'utf8');
const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/safety-result.json', import.meta.url), 'utf8')) as SafetyResult;
const FIXTURE_SHA = '3f2c9a1e7b4d6c8a0e5f1b2d3c4a5e6f7a8b9c0d';

const section = (() => {
  const start = DOC.indexOf('\n## Safety score\n');
  const end = DOC.indexOf('\n## ', start + 1);
  return DOC.slice(start, end === -1 ? undefined : end);
})();

/** Every fenced block in the section: its info string and body. */
const fences = [...section.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)].map((m) => ({ info: m[1], body: m[2] }));
const yamlFences = fences.filter((f) => /^ya?ml\b/.test(f.info));

const isSafetyMapping = (body: string) => {
  const doc = yaml.load(body) as Record<string, unknown> | null;
  const ss = doc?.safetyScore;
  return typeof ss === 'object' && ss !== null && !Array.isArray(ss);
};
const merged = (body: string) => mergeConfig(parseRepoConfigYaml(body) ?? {});
/** The fence that follows an MDX marker comment. */
const fenceAfter = (marker: string) => {
  const at = section.indexOf(`{/* ${marker} */}`);
  expect(at, `marker ${marker}`).toBeGreaterThan(-1);
  const m = /^```[^\n]*\n([\s\S]*?)^```/m.exec(section.slice(at));
  return m![1];
};

describe('docs: ## Safety score (#715)', () => {
  it('exists once', () => {
    expect(DOC.match(/^## Safety score$/gm)).toHaveLength(1);
  });

  it('every yaml fence in the section is a full safetyScore mapping — no fragments — and there are at least 3', () => {
    expect(yamlFences.length).toBeGreaterThanOrEqual(3);
    for (const f of yamlFences) expect(isSafetyMapping(f.body), f.body).toBe(true);
  });

  it('every example parses and validates through the real parser and merge, keeping its enabled', () => {
    for (const f of yamlFences) {
      const written = (yaml.load(f.body) as { safetyScore: { enabled?: boolean } }).safetyScore.enabled;
      const c = merged(f.body);
      expect(c.safetyScoreErrors, f.body).toBeUndefined();
      expect(c.safetyScore.enabled, f.body).toBe(written ?? false);
    }
  });

  it('negative controls: a broken reference block is rejected, so the extraction reaches validation', () => {
    const reference = yamlFences.find((f) => f.body.includes('Message delivery'))!.body;
    expect(reference).toMatch(/risky: 33/);
    const badBand = merged(reference.replace('risky: 33', 'risky: 80'));
    expect(badBand.safetyScoreErrors?.some((e) => e.startsWith('safetyScore.bands'))).toBe(true);
    expect(badBand.safetyScore.enabled).toBe(false);
    const unknownKey = merged(reference.replace('safetyScore:\n', 'safetyScore:\n  area: []\n'));
    expect(unknownKey.safetyScoreErrors?.length).toBeGreaterThan(0);
  });

  it('the defaults block equals DEFAULT_SAFETY_SCORE_CONFIG, before any merge', () => {
    expect(parseRepoConfigYaml(fenceAfter('safety-defaults'))!.safetyScore).toEqual(DEFAULT_SAFETY_SCORE_CONFIG);
  });

  it('the comment example is the renderer’s output for the committed fixture', () => {
    expect(fenceAfter('safety-comment-example').trimEnd()).toBe(formatSafetySection(FIXTURE, FIXTURE_SHA));
  });

  it('the fixture’s numbers are generated, not hand-written', () => {
    const ratings = Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: FIXTURE.factors[f].cappedFrom ?? FIXTURE.factors[f].rating }]));
    const c = computeSafetyScore(ratings as any, DEFAULT_SAFETY_SCORE_CONFIG, FIXTURE.matchedAreas);
    expect([c.score, c.uncappedScore, c.band, c.clampedBy]).toEqual([FIXTURE.score, FIXTURE.uncappedScore, FIXTURE.band, FIXTURE.clampedBy]);
    for (const f of SAFETY_FACTORS) expect(FIXTURE.factors[f]).toMatchObject({ rating: c.factors[f].rating, label: c.factors[f].label });
  });

  it('the mw-safety example line parses', () => {
    const m = /<!-- mw-safety:(\{.*?\}) -->/.exec(section);
    expect(m).not.toBeNull();
    const p = parseSafetyPayload(m![0]);
    expect(p).toMatchObject({ score: expect.any(Number), band: expect.any(String), sha: expect.any(String) });
  });
});
