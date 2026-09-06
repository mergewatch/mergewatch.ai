import { describe, it, expect } from 'vitest';
import { estimateCost, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from './pricing.js';
import { TokenAccumulator } from './token-accumulator.js';

/**
 * #490 Phase A — cache-aware accounting.
 *
 * `estimatedCostUsd` is metered spend, not a label: it drives Stripe charges,
 * OSS grant drawdown and auto-reload. The API reports `input_tokens` as
 * UNCACHED input only, with cache traffic in separate fields. Reading none of
 * them means cached tokens vanish from the bill — reported cost falls FURTHER
 * than true cost, which is under-billing arriving through a door the
 * `REVENUE LEAK` alarm does not watch.
 *
 * This lands BEFORE any breakpoints are placed, so the meter is correct before
 * anything starts using the cache.
 */
const MODEL = 'test-model';
const PRICING = { [MODEL]: { inputPer1M: 3, outputPer1M: 15 } };

describe('estimateCost with cache traffic', () => {
  it('prices reads and writes at their own rates, not at zero', () => {
    const cost = estimateCost(MODEL, 1_000_000, 0, PRICING, {
      readTokens: 1_000_000,
      writeTokens: 1_000_000,
    });
    // uncached 3.00 + read 0.30 + write 3.75
    expect(cost).toBeCloseTo(3 + 3 * CACHE_READ_MULTIPLIER + 3 * CACHE_WRITE_MULTIPLIER, 10);
    expect(cost).toBeCloseTo(7.05, 10);
  });

  it('a cached review costs MORE than counting uncached input alone', () => {
    // The under-billing failure stated directly: if cache traffic were ignored,
    // this review would be billed 0.30 when it actually cost 0.60 —
    // 100k uncached at $3/1M = $0.30, plus 1M cache-read at $3/1M x 0.1 = $0.30.
    const ignored = estimateCost(MODEL, 100_000, 0, PRICING)!;
    const actual = estimateCost(MODEL, 100_000, 0, PRICING, { readTokens: 1_000_000, writeTokens: 0 })!;
    expect(ignored).toBeCloseTo(0.3, 10);
    expect(actual).toBeCloseTo(0.6, 10);
    expect(actual).toBeGreaterThan(ignored);
  });

  it('is unchanged when there is no cache traffic', () => {
    // Every existing call site keeps its exact meaning; a provider with no
    // cache API reports nothing and the arithmetic is what it always was.
    expect(estimateCost(MODEL, 1000, 500, PRICING))
      .toBe(estimateCost(MODEL, 1000, 500, PRICING, { readTokens: 0, writeTokens: 0 }));
    expect(estimateCost(MODEL, 1000, 500, PRICING))
      .toBe(estimateCost(MODEL, 1000, 500, PRICING, {}));
  });

  it('an existing TWO-KEY customPricing override still prices cache traffic', () => {
    // The reason rates are multipliers rather than pricing fields. A
    // self-hosted `.mergewatch.yml` pricing block carries inputPer1M and
    // outputPer1M today. Adding cacheReadPer1M/cacheWritePer1M would leave
    // every un-updated override silently pricing cache traffic at ZERO.
    const twoKeyOverride = { [MODEL]: { inputPer1M: 10, outputPer1M: 40 } };
    const cost = estimateCost(MODEL, 0, 0, twoKeyOverride, { readTokens: 1_000_000, writeTokens: 0 })!;
    expect(cost).toBeCloseTo(10 * CACHE_READ_MULTIPLIER, 10);
    expect(cost).toBeGreaterThan(0);
  });

  it('still returns null for an unknown model', () => {
    expect(estimateCost('nope', 1, 1, PRICING, { readTokens: 100 })).toBeNull();
  });
});

describe('TokenAccumulator with cache traffic', () => {
  it('tracks cached and uncached input separately', () => {
    const acc = new TokenAccumulator();
    acc.add(MODEL, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheWriteInputTokens: 50 });
    acc.add(MODEL, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheWriteInputTokens: 0 });
    expect(acc.totalInputTokens).toBe(200);
    expect(acc.totalCacheReadInputTokens).toBe(1800);
    expect(acc.totalCacheWriteInputTokens).toBe(50);
  });

  it('treats a provider without a cache API as zero, not as missing', () => {
    // litellm and ollama omit these fields entirely.
    const acc = new TokenAccumulator();
    acc.add(MODEL, { inputTokens: 100, outputTokens: 10 });
    expect(acc.totalCacheReadInputTokens).toBe(0);
    expect(acc.estimateTotalCost(PRICING)).toBeCloseTo(estimateCost(MODEL, 100, 10, PRICING)!, 12);
  });

  it('feeds cache traffic into the total cost', () => {
    const acc = new TokenAccumulator();
    acc.add(MODEL, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheWriteInputTokens: 0 });
    expect(acc.estimateTotalCost(PRICING)).toBeCloseTo(3 * CACHE_READ_MULTIPLIER, 10);
  });
});
