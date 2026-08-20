import { describe, it, expect } from 'vitest';
import { estimateCost, DEFAULT_PRICING, parseEnvModelPricing } from './pricing.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

describe('estimateCost', () => {
  it('returns correct cost for a known Bedrock model', () => {
    // us.anthropic.claude-sonnet-4: the `us.` cross-region profile is billed at
    // $3.30/$16.50, not the $3/$15 published base rate (see below).
    const cost = estimateCost(
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      1000,
      500,
    );
    // (1000 / 1_000_000) * 3.30 + (500 / 1_000_000) * 16.50 = 0.0033 + 0.00825
    expect(cost).toBeCloseTo(0.01155, 6);
  });

  it('returns correct cost for a known direct Anthropic model', () => {
    // claude-opus-4-20250514: input $15/1M, output $75/1M
    const cost = estimateCost('claude-opus-4-20250514', 2000, 1000);
    // (2000 / 1_000_000) * 15 + (1000 / 1_000_000) * 75 = 0.03 + 0.075 = 0.105
    expect(cost).toBeCloseTo(0.105, 6);
  });

  // ── The `us.` cross-region premium ──────────────────────────────────────
  //
  // Bedrock's published rate applies to `global.` inference profiles. The `us.`
  // profiles — which every model MergeWatch runs uses — cost exactly 10% more.
  // Verified against three rate cards (Sonnet 5, Opus 5, Fable 5).
  //
  // These assertions exist because the obvious "fix" when they fail is to set
  // the Bedrock rows back to the published price, which silently under-bills
  // every SaaS review by ~10%. If a rate genuinely changes, re-derive it with:
  //   aws bedrock list-foundation-model-agreement-offers --model-id <base-id>
  describe('Bedrock us. profiles carry a 10% premium over the published rate', () => {
    const M = 1_000_000;

    it('Opus 4.6 — the deployment default — bills at $5.50/$27.50, not $5/$25', () => {
      expect(estimateCost('us.anthropic.claude-opus-4-6-v1', M, M)).toBeCloseTo(33, 6);
      // The published rate would have produced 30.
      expect(estimateCost('claude-opus-4-6', M, M)).toBeCloseTo(30, 6);
    });

    it('Sonnet 4.5 — the deployment default — bills at $3.30/$16.50 on Bedrock, $3/$15 direct', () => {
      expect(estimateCost('us.anthropic.claude-sonnet-4-5-20250929-v1:0', M, M)).toBeCloseTo(19.8, 6);
      expect(estimateCost('claude-sonnet-4-5-20250929', M, M)).toBeCloseTo(18, 6);
    });

    it('Sonnet 4.6 bills at $3.30/$16.50 on Bedrock, $3/$15 direct', () => {
      expect(estimateCost('us.anthropic.claude-sonnet-4-6', M, M)).toBeCloseTo(19.8, 6);
      expect(estimateCost('claude-sonnet-4-6', M, M)).toBeCloseTo(18, 6);
    });

    it('Opus 4.8 bills at $5.50/$27.50 on Bedrock, $5/$25 direct', () => {
      expect(estimateCost('us.anthropic.claude-opus-4-8-v1', M, M)).toBeCloseTo(33, 6);
      expect(estimateCost('claude-opus-4-8', M, M)).toBeCloseTo(30, 6);
    });

    it('Sonnet 5 global. is the published rate; us. is 10% above it', () => {
      expect(estimateCost('global.anthropic.claude-sonnet-5', M, M)).toBeCloseTo(12, 6);
      expect(estimateCost('us.anthropic.claude-sonnet-5', M, M)).toBeCloseTo(13.2, 6);
    });

    it('Haiku 4.5 — the lightModel on every review — bills at $1.10/$5.50', () => {
      // Previously $0.80/$4, which matched no published rate and under-billed
      // by 27% on a model used in every single review.
      expect(estimateCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', M, M))
        .toBeCloseTo(6.6, 6);
      expect(estimateCost('claude-haiku-4-5-20251001', M, M)).toBeCloseTo(6, 6);
    });

    it('every us. row is exactly 1.1x its global/direct counterpart', () => {
      const pairs: Array<[string, string]> = [
        ['us.anthropic.claude-sonnet-5', 'global.anthropic.claude-sonnet-5'],
        ['us.anthropic.claude-opus-5', 'global.anthropic.claude-opus-5'],
        ['us.anthropic.claude-fable-5', 'global.anthropic.claude-fable-5'],
        ['us.anthropic.claude-opus-4-6-v1', 'claude-opus-4-6'],
        ['us.anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'],
        ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
      ];
      for (const [usId, baseId] of pairs) {
        const us = estimateCost(usId, M, M);
        const base = estimateCost(baseId, M, M);
        expect(us, `${usId} priced`).not.toBeNull();
        expect(base, `${baseId} priced`).not.toBeNull();
        expect(us! / base!, `${usId} vs ${baseId}`).toBeCloseTo(1.1, 6);
      }
    });
  });

  it('the retired claude-3-5-sonnet is no longer priced (returns null)', () => {
    expect(estimateCost('us.anthropic.claude-3-5-sonnet-20241022-v2:0', 100, 100)).toBeNull();
    expect(estimateCost('claude-3-5-sonnet-20241022', 100, 100)).toBeNull();
  });

  it('returns null for an unknown model', () => {
    expect(estimateCost('gpt-4o', 100, 100)).toBeNull();
  });

  it('returns 0 for zero tokens', () => {
    const cost = estimateCost('claude-sonnet-4-20250514', 0, 0);
    expect(cost).toBe(0);
  });

  it('custom pricing overrides DEFAULT_PRICING for a known model', () => {
    const custom = {
      'claude-sonnet-4-20250514': { inputPer1M: 10, outputPer1M: 50 },
    };
    const cost = estimateCost('claude-sonnet-4-20250514', 1_000_000, 1_000_000, custom);
    // 10 + 50 = 60
    expect(cost).toBe(60);
  });

  it('custom pricing works for an unknown model', () => {
    const custom = {
      'my-custom-model': { inputPer1M: 1, outputPer1M: 2 },
    };
    const cost = estimateCost('my-custom-model', 500_000, 500_000, custom);
    // (500_000/1M) * 1 + (500_000/1M) * 2 = 0.5 + 1.0 = 1.5
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it('all models in DEFAULT_PRICING have positive input and output rates', () => {
    for (const [modelId, pricing] of Object.entries(DEFAULT_PRICING)) {
      expect(pricing.inputPer1M, `${modelId} inputPer1M`).toBeGreaterThan(0);
      expect(pricing.outputPer1M, `${modelId} outputPer1M`).toBeGreaterThan(0);
    }
  });

  it('haiku costs less than sonnet for the same token counts', () => {
    const tokens = { input: 10_000, output: 5_000 };
    const haikuCost = estimateCost(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      tokens.input,
      tokens.output,
    )!;
    const sonnetCost = estimateCost(
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      tokens.input,
      tokens.output,
    )!;
    expect(haikuCost).toBeLessThan(sonnetCost);
  });
});

describe('parseEnvModelPricing (#233)', () => {
  const ARN = 'arn:aws:bedrock:us-west-2:029800430051:application-inference-profile/hwswp7wpd6c5';

  it('builds a single-entry map for a model + both prices', () => {
    expect(parseEnvModelPricing(ARN, '5', '25')).toEqual({
      [ARN]: { inputPer1M: 5, outputPer1M: 25 },
    });
  });

  it('parses decimal prices', () => {
    expect(parseEnvModelPricing('gpt-4o', '2.5', '10')).toEqual({
      'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
    });
  });

  it('allows 0/0 (priced $0 for a local model)', () => {
    expect(parseEnvModelPricing('llama3', '0', '0')).toEqual({
      llama3: { inputPer1M: 0, outputPer1M: 0 },
    });
  });

  it('returns undefined when the model ID is missing', () => {
    expect(parseEnvModelPricing(undefined, '5', '25')).toBeUndefined();
    expect(parseEnvModelPricing('', '5', '25')).toBeUndefined();
  });

  it('returns undefined when either price is missing or blank', () => {
    expect(parseEnvModelPricing('m', undefined, '25')).toBeUndefined();
    expect(parseEnvModelPricing('m', '5', undefined)).toBeUndefined();
    expect(parseEnvModelPricing('m', '', '25')).toBeUndefined();
    expect(parseEnvModelPricing('m', '  ', '25')).toBeUndefined(); // whitespace-only input
    expect(parseEnvModelPricing('m', '5', '  ')).toBeUndefined(); // whitespace-only output
  });

  it('trims surrounding whitespace around a valid number', () => {
    expect(parseEnvModelPricing('m', ' 5 ', '  25 ')).toEqual({
      m: { inputPer1M: 5, outputPer1M: 25 },
    });
  });

  it('returns undefined for non-numeric, negative, or non-finite prices', () => {
    expect(parseEnvModelPricing('m', 'abc', '25')).toBeUndefined();
    expect(parseEnvModelPricing('m', '5', 'NaN')).toBeUndefined();
    expect(parseEnvModelPricing('m', '-1', '25')).toBeUndefined();
    expect(parseEnvModelPricing('m', 'Infinity', '25')).toBeUndefined();
  });

  it('feeds estimateCost as customPricing for an otherwise-unknown model', () => {
    const pricing = parseEnvModelPricing(ARN, '5', '25');
    expect(estimateCost(ARN, 1_000_000, 1_000_000, pricing)).toBeCloseTo(30, 6);
    // ...and without it the same model is unpriced.
    expect(estimateCost(ARN, 1_000_000, 1_000_000)).toBeNull();
  });
});

/**
 * The failure this guards against is silent: `estimateCost` returns null for an
 * unpriced model, so switching the default to one that isn't in the table
 * records every review at zero cost — no error, no log line. That figure feeds
 * calculateReviewCost, the OSS sponsored-spend counters, and Stripe billing.
 */
describe('the configured default model is always priced', () => {
  it('DEFAULT_CONFIG.model has a pricing entry', () => {
    expect(estimateCost(DEFAULT_CONFIG.model, 1_000_000, 1_000_000)).not.toBeNull();
  });

  it('DEFAULT_CONFIG.lightModel has a pricing entry', () => {
    expect(estimateCost(DEFAULT_CONFIG.lightModel, 1_000_000, 1_000_000)).not.toBeNull();
  });
});
