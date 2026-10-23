import { describe, it, expect, vi, afterEach } from 'vitest';
import { bandFor, labelFor, capRating, matchAreas, computeSafetyScore, type SafetyAreaMatch } from './safety.js';
import { runReviewPipeline, type ReviewPipelineOptions, type ReviewPipelineResult } from './reviewer.js';
import { SAFETY_PROMPT, SHARED_PREAMBLE } from './prompts.js';
import { buildCheckOutcome, reviewEventForGate } from '../gate.js';
import { renderPrompt, type PromptInput } from '../llm/prompt-segment.js';
import {
  DEFAULT_SAFETY_SCORE_CONFIG,
  SAFETY_FACTORS,
  type SafetyFactor,
  type SafetyScoreConfig,
} from '../config/defaults.js';
import type { ILLMProvider } from '../llm/types.js';

const D = DEFAULT_SAFETY_SCORE_CONFIG;
const ratings = (r: number[]) =>
  Object.fromEntries(SAFETY_FACTORS.map((f, i) => [f, { rating: r[i] }])) as Record<SafetyFactor, { rating: number }>;
const area = (level?: 'safe' | 'caution' | 'risky', name = 'A'): SafetyAreaMatch =>
  ({ name, ...(level ? { level } : {}), matchedPatterns: ['x/**'], files: ['x/a.ts'] });
const score = (r: number[], matches: SafetyAreaMatch[] = [], config: Pick<SafetyScoreConfig, 'bands' | 'factors'> = D) =>
  computeSafetyScore(ratings(r), config, matches);

describe('safety score — pure functions (#712)', () => {
  it('labelFor maps 1..5 to risky, risky, caution, safe, safe', () => {
    expect([1, 2, 3, 4, 5].map((r) => labelFor(r, D.bands))).toEqual(['risky', 'risky', 'caution', 'safe', 'safe']);
  });

  it('capRating: 2/3/5 on the default bands, 1/4 on bands {10, 80}', () => {
    expect([capRating('risky', D.bands), capRating('caution', D.bands), capRating('safe', D.bands)]).toEqual([2, 3, 5]);
    const b = { risky: 10, caution: 80 };
    expect([capRating('risky', b), capRating('caution', b)]).toEqual([1, 4]);
  });

  it('bandFor: 33/34/67/68 are risky/caution/caution/safe', () => {
    expect([33, 34, 67, 68].map((s) => bandFor(s, D.bands))).toEqual(['risky', 'caution', 'caution', 'safe']);
  });

  // Decision 5's table, row by row. Ratings are the MODEL's; the cap is applied inside.
  it.each([
    ['no area', [4, 5, 3, 4, 3], [], D, [4, 5, 3, 4, 3], 68, 68, 'safe'],
    ['same diff, risky area (blast 4→2)', [4, 5, 3, 4, 3], [area('risky')], D, [2, 5, 3, 4, 3], 53, 33, 'risky'],
    ['clean migration, risky area', [5, 5, 5, 5, 5], [area('risky')], D, [2, 5, 5, 5, 5], 78, 33, 'risky'],
    ['caution area (blast →3)', [5, 5, 5, 5, 5], [area('caution')], D, [3, 5, 5, 5, 5], 85, 67, 'caution'],
    ['safe area, all 1s (never raised)', [1, 1, 1, 1, 1], [area('safe')], D, [1, 1, 1, 1, 1], 1, 1, 'risky'],
    ['bands {10, 80}, risky area', [5, 5, 5, 5, 5], [area('risky')], { ...D, bands: { risky: 10, caution: 80 } }, [1, 5, 5, 5, 5], 70, 10, 'risky'],
  ] as const)('%s', (_, model, matches, config, capped, w, s, band) => {
    const r = score([...model], [...matches], config);
    expect(SAFETY_FACTORS.map((f) => r.factors[f].rating)).toEqual(capped);
    expect(r.uncappedScore).toBe(w);
    expect(r.score).toBe(s);
    expect(r.band).toBe(band);
  });

  it('weights {testing: 1, others: 0} with testing = 2 → 26', () => {
    const factors = Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { weight: f === 'testing' ? 1 : 0 }])) as SafetyScoreConfig['factors'];
    expect(score([5, 5, 2, 5, 5], [], { bands: D.bands, factors }).score).toBe(26);
  });

  it('records cappedFrom and clampedBy only when they changed something', () => {
    const r = score([4, 5, 3, 4, 3], [area('risky', 'Billing')]);
    expect(r.factors.blastRadius).toMatchObject({ rating: 2, cappedFrom: 4 });
    expect(r.clampedBy).toBe('Billing');
    const free = score([4, 5, 3, 4, 3]);
    expect(free.factors.blastRadius.cappedFrom).toBeUndefined();
    expect(free.clampedBy).toBeUndefined();
  });
});

describe('safety score — area matching (#712)', () => {
  const caution = { name: 'Services', patterns: ['services/**'], level: 'caution' as const };
  const risky = { name: 'Notifications', patterns: ['services/notifications/**'], level: 'risky' as const };

  it('the riskiest matched area wins, both are recorded, and it is the one that clamps', () => {
    const matches = matchAreas([caution, risky], ['services/notifications/a.ts']);
    expect(matches.map((m) => m.name)).toEqual(['Services', 'Notifications']);
    const r = score([5, 5, 5, 5, 5], matches);
    expect(r.factors.blastRadius.rating).toBe(2);
    expect(r.clampedBy).toBe('Notifications');
    expect(r.band).toBe('risky');
  });

  it('dot files match: services/notifications/.env against services/**', () => {
    expect(matchAreas([caution], ['services/notifications/.env'])).toHaveLength(1);
  });

  it('a migration under a hidden directory matches **/migrations/**', () => {
    expect(matchAreas([{ patterns: ['**/migrations/**'], level: 'risky' }], ['src/.hidden/migrations/1.sql'])).toHaveLength(1);
  });

  it('a deleted file matches by its old path', () => {
    // extractChangedLines keys a deletion by its old path; matching sees that key.
    expect(matchAreas([caution], ['services/old.ts'])[0].files).toEqual(['services/old.ts']);
  });

  it('a safe match leaves a rating of 1 at 1 and a score of 1 at 1', () => {
    const matches = matchAreas([{ patterns: ['internal/**'], level: 'safe' }], ['internal/x.ts']);
    const r = score([1, 1, 1, 1, 1], matches);
    expect(r.factors.blastRadius.rating).toBe(1);
    expect(r.score).toBe(1);
  });

  it('a pattern-less area is never a match', () => {
    expect(matchAreas([{ name: 'Billing', notes: 'n' }], ['billing/x.ts'])).toEqual([]);
  });

  it('(pin) .github/workflows/x.yml matches .github/** (true even without dot)', () => {
    expect(matchAreas([{ patterns: ['.github/**'] }], ['.github/workflows/x.yml'])).toHaveLength(1);
  });
});

// ─── The pipeline ────────────────────────────────────────────────────────────

const SAFETY_MARKER = SAFETY_PROMPT.slice(0, 80);
const CONFIG: SafetyScoreConfig = {
  ...D,
  enabled: true,
  factors: { ...D.factors, rollback: { weight: 20, notes: 'Sensitive features belong behind a feature flag' } },
  areas: [
    { name: 'Notifications', patterns: ['services/notifications/**'], level: 'risky', notes: 'Every customer message goes through here' },
    { name: 'Billing', notes: 'Anything that changes what we charge' },
  ],
  notes: ['Queued jobs run with the old arguments', "Cost is $& per call, see $'"],
};
const DIFF = `diff --git a/services/notifications/send.ts b/services/notifications/send.ts
--- a/services/notifications/send.ts
+++ b/services/notifications/send.ts
@@ -1,3 +1,4 @@
 export function send() {
-  return 1;
+  retry();
+  return 2;
 }`;
const ALL_ONES = JSON.stringify({
  ratings: Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: 1, note: `${f} note` }])),
  concerns: ['Retries could double-send'],
  appliedAreas: ['Billing'],
  appliedNotes: [1],
});

type SafetyAnswer = string | Error | ((n: number) => string);

/**
 * Implements only `invoke`, so every structured call throws
 * StructuredOutputUnsupportedError before reaching it and the call count is
 * deterministic. Routes the safety call on its prompt's opening.
 */
function routingLlm(safety: SafetyAnswer = ALL_ONES, usage?: { inputTokens: number; outputTokens: number }) {
  const calls: { modelId: string; prompt: string; safety: boolean }[] = [];
  let n = 0;
  const llm: ILLMProvider = {
    async invoke(modelId: string, prompt: PromptInput) {
      const text = renderPrompt(prompt);
      const isSafety = text.includes(SAFETY_MARKER);
      calls.push({ modelId, prompt: text, safety: isSafety });
      if (isSafety) {
        n++;
        if (safety instanceof Error) throw safety;
        const out = typeof safety === 'function' ? safety(n) : safety;
        return usage ? { text: out, usage } : out;
      }
      if (text.includes('Mermaid')) return '';
      if (text.includes('Write a 2-3 sentence prose summary')) return JSON.stringify({ summary: 'Adds a retry.' });
      if (text.includes('You receive findings from multiple review agents')) {
        return JSON.stringify({ findings: [], mergeScore: 5, mergeScoreReason: 'Looks good.' });
      }
      return JSON.stringify({ findings: [] });
    },
  };
  return { llm, calls, safetyCalls: () => calls.filter((c) => c.safety) };
}

const BASE: ReviewPipelineOptions = {
  diff: DIFF,
  context: { owner: 'o', repo: 'r', prNumber: 7, prTitle: 'Retry sends', prBody: 'Adds a retry. Tested manually on staging.' },
  modelId: 'heavy-model',
  lightModelId: 'light-model',
  maxFindings: 25,
  enabledAgents: {
    security: true, bugs: true, style: true, summary: true, diagram: true,
    errorHandling: true, testCoverage: true, commentAccuracy: true,
  },
};

const run = async (safety: SafetyAnswer | undefined, opts: Partial<ReviewPipelineOptions> = {}, usage?: { inputTokens: number; outputTokens: number }) => {
  const stub = routingLlm(safety, usage);
  const result = await runReviewPipeline({ ...BASE, ...opts }, { llm: stub.llm });
  return { result, ...stub };
};

/** Everything but the fields a safety call is allowed to change. */
const sansCost = ({ inputTokens: _i, outputTokens: _o, estimatedCostUsd: _c, safety: _s, ...rest }: ReviewPipelineResult) => rest;

describe('safety agent in the pipeline (#712)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no call when the option is absent or disabled; exactly one extra, on the main model, when enabled', async () => {
    const absent = await run(ALL_ONES);
    const off = await run(ALL_ONES, { safetyScore: { ...CONFIG, enabled: false } });
    const on = await run(ALL_ONES, { safetyScore: CONFIG });
    expect(absent.safetyCalls()).toHaveLength(0);
    expect(off.safetyCalls()).toHaveLength(0);
    expect(off.calls).toHaveLength(absent.calls.length);
    expect(on.calls).toHaveLength(absent.calls.length + 1);
    expect(on.safetyCalls().map((c) => c.modelId)).toEqual(['heavy-model']);
    expect(absent.result.safety).toBeUndefined();
    expect(on.result.safety).toBeDefined();
  });

  it('builds the result: the area clamps, the agent picks applied areas and notes', async () => {
    const { result } = await run(ALL_ONES, { safetyScore: CONFIG });
    expect(result.safety).toMatchObject({
      score: 1,
      band: 'risky',
      concerns: ['Retries could double-send'],
      appliedAreas: ['Billing'],
      appliedNotes: ["Cost is $& per call, see $'"],
    });
    expect(result.safety!.matchedAreas.map((m) => m.name)).toEqual(['Notifications']);
  });

  const valid = (over: Record<string, unknown>) =>
    JSON.stringify({ ratings: { ...Object.fromEntries(SAFETY_FACTORS.map((f) => [f, { rating: 3, note: 'n' }])), ...over } });
  const throttle = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });

  it.each([
    ['a missing factor', JSON.stringify({ ratings: { blastRadius: { rating: 3, note: 'n' } } })],
    ['rating 6', valid({ testing: { rating: 6, note: 'n' } })],
    ['rating 2.5', valid({ testing: { rating: 2.5, note: 'n' } })],
    ['non-JSON', 'I would rate this fairly safe overall.'],
    ['a throwing provider', new Error('boom')],
    ['a throttle error', throttle],
  ] as Array<[string, SafetyAnswer]>)('%s → no section, a [safety] warning, and an otherwise identical review', async (_, answer) => {
    const warn = vi.spyOn(console, 'warn');
    const off = await run(answer);
    const on = await run(answer, { safetyScore: CONFIG });
    expect(on.result.safety).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith('[safety] agent failed'))).toBe(true);
    expect(sansCost(on.result)).toEqual(sansCost(off.result));
    for (const k of ['gate', 'findings', 'agentFailures', 'parseFailureCount', 'degenerateResponseCount'] as const) {
      expect(on.result[k], k).toEqual(off.result[k]);
    }
  });

  it('opens a requested file: two safety calls, the second carrying its content', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn(async () => ({
          data: { type: 'file', content: Buffer.from('TEST_BODY_9f3e').toString('base64'), encoding: 'base64' },
        })),
      },
    } as any;
    const { safetyCalls, result } = await run(
      (n) => (n === 1 ? JSON.stringify({ requestFiles: ['src/a.test.ts'] }) : ALL_ONES),
      { safetyScore: CONFIG, fileFetchOptions: { octokit, owner: 'o', repo: 'r', ref: 'sha', maxContextKB: 256, maxRounds: 3 } },
    );
    expect(safetyCalls()).toHaveLength(2);
    expect(safetyCalls()[1].prompt).toContain('TEST_BODY_9f3e');
    expect(result.safety).toBeDefined();
  });

  it('sends the real prompt: PR body, areas, notes and stats, repo text verbatim, no preamble', async () => {
    // Positive control: the preamble really does carry these phrases.
    expect(SHARED_PREAMBLE).toContain('Restraint principles');
    expect(SHARED_PREAMBLE).toContain('Senior-reviewer gut check');

    const { safetyCalls } = await run(ALL_ONES, { safetyScore: CONFIG });
    const p = safetyCalls()[0].prompt;
    for (const s of [
      'Adds a retry. Tested manually on staging.',
      'Notifications', 'Every customer message goes through here',
      'Billing',
      'Queued jobs run with the old arguments',
      "Cost is $& per call, see $'",
      'Sensitive features belong behind a feature flag',
      'services/notifications/send.ts',
      '+2/−1',
    ]) {
      expect(p, s).toContain(s);
    }
    expect(p).not.toContain('Restraint principles');
    expect(p).not.toContain('Senior-reviewer gut check');
  });

  it('the gate is identical with the safety score on or off — even a risky score on a 5/5 review', async () => {
    for (const answer of [ALL_ONES, new Error('boom')] as SafetyAnswer[]) {
      const off = (await run(answer)).result;
      const on = (await run(answer, { safetyScore: CONFIG })).result;
      expect(on.gate).toEqual(off.gate);
      expect(on.mergeScore).toBe(off.mergeScore);
      expect(on.mergeScoreReason).toBe(off.mergeScoreReason);
      expect(on.findings).toEqual(off.findings);
      const outcome = (r: ReviewPipelineResult) => {
        const o = buildCheckOutcome(r.gate, {
          mergeScore: r.mergeScore,
          findingCount: r.findings.length,
          warningCount: r.findings.filter((f) => f.severity === 'warning').length,
          infoCount: r.findings.filter((f) => f.severity === 'info').length,
          suppressedCount: r.suppressedCount,
          agentFailures: r.agentFailures,
        });
        return [o.conclusion, o.title];
      };
      expect(outcome(on)).toEqual(outcome(off));
      expect(reviewEventForGate(on.gate, on.mergeScore, true)).toBe(reviewEventForGate(off.gate, off.mergeScore, true));
      if (answer === ALL_ONES) {
        // Non-vacuity: a risky safety score really did sit beside a 4-5 review.
        expect(on.safety!.band).toBe('risky');
        expect(on.mergeScore).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('counts the safety call in tokens and cost', async () => {
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const customPricing = { 'heavy-model': { inputPer1M: 3, outputPer1M: 15 }, 'light-model': { inputPer1M: 1, outputPer1M: 5 } };
    const off = (await run(ALL_ONES, { customPricing }, usage)).result;
    const on = (await run(ALL_ONES, { customPricing, safetyScore: CONFIG }, usage)).result;
    expect(on.inputTokens - off.inputTokens).toBe(1000);
    expect(on.outputTokens - off.outputTokens).toBe(100);
    expect(on.estimatedCostUsd!).toBeGreaterThan(off.estimatedCostUsd!);
  });
});
