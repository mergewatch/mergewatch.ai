import { describe, it, expect } from 'vitest';
import { estimateCost, DEFAULT_PRICING } from './pricing.js';

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
