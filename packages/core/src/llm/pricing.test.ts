import { describe, it, expect } from 'vitest';
import { estimateCost, DEFAULT_PRICING, parseEnvModelPricing } from './pricing.js';

describe('estimateCost', () => {
  it('returns correct cost for a known Bedrock model', () => {
    // us.anthropic.claude-sonnet-4: input $3/1M, output $15/1M
    // 1000 input tokens, 500 output tokens
    const cost = estimateCost(
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      1000,
      500,
    );
    // (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('returns correct cost for a known direct Anthropic model', () => {
    // claude-opus-4-20250514: input $15/1M, output $75/1M
    const cost = estimateCost('claude-opus-4-20250514', 2000, 1000);
    // (2000 / 1_000_000) * 15 + (1000 / 1_000_000) * 75 = 0.03 + 0.075 = 0.105
    expect(cost).toBeCloseTo(0.105, 6);
  });

  it('prices the Opus 4.6 default (Bedrock) at $5/$25 per 1M', () => {
    // us.anthropic.claude-opus-4-6-v1: input $5/1M, output $25/1M
    const cost = estimateCost('us.anthropic.claude-opus-4-6-v1', 1000, 500);
    // (1000 / 1_000_000) * 5 + (500 / 1_000_000) * 25 = 0.005 + 0.0125 = 0.0175
    expect(cost).toBeCloseTo(0.0175, 6);
  });

  it('prices current-gen Sonnet 4.6 (Bedrock + direct) at $3/$15 per 1M', () => {
    // (1_000_000/1M)*3 + (1_000_000/1M)*15 = 18
    expect(estimateCost('us.anthropic.claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    expect(estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
  });

  it('prices current-gen Opus 4.8 (Bedrock + direct) at $5/$25 per 1M', () => {
    // (1_000_000/1M)*5 + (1_000_000/1M)*25 = 30
    expect(estimateCost('us.anthropic.claude-opus-4-8-v1', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
    expect(estimateCost('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
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
