import { describe, it, expect } from 'vitest';
import { TokenAccumulator, TrackingLLMProvider } from './token-accumulator.js';
import type { ILLMProvider, LLMInvokeResult } from './types.js';

describe('TokenAccumulator', () => {
  it('fresh accumulator has zero totals', () => {
    const acc = new TokenAccumulator();
    expect(acc.totalInputTokens).toBe(0);
    expect(acc.totalOutputTokens).toBe(0);
  });

  it('add() with undefined usage is a no-op', () => {
    const acc = new TokenAccumulator();
    acc.add('some-model', undefined);
    expect(acc.totalInputTokens).toBe(0);
    expect(acc.totalOutputTokens).toBe(0);
  });

  it('single add records correct totals', () => {
    const acc = new TokenAccumulator();
    acc.add('model-a', { inputTokens: 100, outputTokens: 50 });
    expect(acc.totalInputTokens).toBe(100);
    expect(acc.totalOutputTokens).toBe(50);
  });

  it('multiple adds to same model accumulate', () => {
    const acc = new TokenAccumulator();
    acc.add('model-a', { inputTokens: 100, outputTokens: 50 });
    acc.add('model-a', { inputTokens: 200, outputTokens: 75 });
    expect(acc.totalInputTokens).toBe(300);
    expect(acc.totalOutputTokens).toBe(125);
  });

  it('multiple models: totals are sum of all', () => {
    const acc = new TokenAccumulator();
    acc.add('model-a', { inputTokens: 100, outputTokens: 50 });
    acc.add('model-b', { inputTokens: 200, outputTokens: 75 });
    expect(acc.totalInputTokens).toBe(300);
    expect(acc.totalOutputTokens).toBe(125);
  });

  it('estimateTotalCost() with known model returns number', () => {
    const acc = new TokenAccumulator();
    acc.add('claude-sonnet-4-20250514', { inputTokens: 1000, outputTokens: 500 });
    const cost = acc.estimateTotalCost();
    expect(cost).toBeTypeOf('number');
    expect(cost).toBeGreaterThan(0);
  });

  it('estimateTotalCost() with unknown model returns null', () => {
    const acc = new TokenAccumulator();
    acc.add('unknown-model', { inputTokens: 1000, outputTokens: 500 });
    expect(acc.estimateTotalCost()).toBeNull();
  });

  it('estimateTotalCost() with custom pricing', () => {
    const acc = new TokenAccumulator();
    acc.add('my-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const cost = acc.estimateTotalCost({
      'my-model': { inputPer1M: 2, outputPer1M: 4 },
    });
    expect(cost).toBe(6);
  });

  it('unpricedModels() is empty when every model is priced (#231)', () => {
    const acc = new TokenAccumulator();
    acc.add('claude-sonnet-4-20250514', { inputTokens: 10, outputTokens: 5 });
    expect(acc.unpricedModels()).toEqual([]);
  });

  it('unpricedModels() lists models with no known pricing (#231)', () => {
    const acc = new TokenAccumulator();
    acc.add('claude-sonnet-4-20250514', { inputTokens: 10, outputTokens: 5 }); // priced
    acc.add('llama3-local', { inputTokens: 10, outputTokens: 5 }); // unknown
    expect(acc.unpricedModels()).toEqual(['llama3-local']);
  });

  it('unpricedModels() respects custom pricing, incl. a 0/0 priced model (#231)', () => {
    const acc = new TokenAccumulator();
    acc.add('llama3-local', { inputTokens: 10, outputTokens: 5 });
    // Unpriced without an override...
    expect(acc.unpricedModels()).toEqual(['llama3-local']);
    // ...but a 0/0 override makes it priced ($0), not unpriced.
    expect(acc.unpricedModels({ 'llama3-local': { inputPer1M: 0, outputPer1M: 0 } })).toEqual([]);
  });
});

describe('TrackingLLMProvider', () => {
  it('wraps inner provider and returns text string', async () => {
    const inner: ILLMProvider = {
      invoke: async () => ({ text: 'hello', usage: { inputTokens: 10, outputTokens: 5 } }),
    };
    const acc = new TokenAccumulator();
    const tracking = new TrackingLLMProvider(inner, acc);
    const result = await tracking.invoke('model', 'prompt');
    expect(result).toBe('hello');
  });

  it('accumulates usage from LLMInvokeResult', async () => {
    const inner: ILLMProvider = {
      invoke: async () => ({ text: 'hi', usage: { inputTokens: 100, outputTokens: 50 } }),
    };
    const acc = new TokenAccumulator();
    const tracking = new TrackingLLMProvider(inner, acc);
    await tracking.invoke('model-x', 'prompt');
    expect(acc.totalInputTokens).toBe(100);
    expect(acc.totalOutputTokens).toBe(50);
  });

  it('handles plain string return from inner (no usage to track)', async () => {
    const inner: ILLMProvider = {
      invoke: async () => 'plain string',
    };
    const acc = new TokenAccumulator();
    const tracking = new TrackingLLMProvider(inner, acc);
    const result = await tracking.invoke('model-x', 'prompt');
    expect(result).toBe('plain string');
    expect(acc.totalInputTokens).toBe(0);
    expect(acc.totalOutputTokens).toBe(0);
  });

  it('multiple calls accumulate correctly', async () => {
    const inner: ILLMProvider = {
      invoke: async () => ({ text: 'ok', usage: { inputTokens: 50, outputTokens: 25 } }),
    };
    const acc = new TokenAccumulator();
    const tracking = new TrackingLLMProvider(inner, acc);
    await tracking.invoke('model-x', 'p1');
    await tracking.invoke('model-x', 'p2');
    await tracking.invoke('model-y', 'p3');
    expect(acc.totalInputTokens).toBe(150);
    expect(acc.totalOutputTokens).toBe(75);
  });
});
