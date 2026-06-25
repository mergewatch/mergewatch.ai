/**
 * Token usage accumulator and tracking LLM provider wrapper.
 *
 * TrackingLLMProvider wraps any ILLMProvider, intercepts invoke() calls,
 * extracts token usage from LLMInvokeResult, and accumulates totals.
 * The wrapped provider is transparent to callers — agents still receive strings.
 */

import type { ILLMProvider, TokenUsage, LLMInvokeResult } from './types.js';
import { normalizeLLMResult } from './types.js';
import { estimateCost } from './pricing.js';

/** Per-model token usage entry. */
interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  invocations: number;
}

/** Accumulates token usage across multiple LLM invocations. */
export class TokenAccumulator {
  private usage = new Map<string, ModelUsage>();

  /** Record token usage for a model invocation. */
  add(modelId: string, tokenUsage?: TokenUsage): void {
    if (!tokenUsage) return;
    const existing = this.usage.get(modelId) ?? { inputTokens: 0, outputTokens: 0, invocations: 0 };
    existing.inputTokens += tokenUsage.inputTokens;
    existing.outputTokens += tokenUsage.outputTokens;
    existing.invocations += 1;
    this.usage.set(modelId, existing);
  }

  /** Total input tokens across all models. */
  get totalInputTokens(): number {
    let total = 0;
    for (const u of this.usage.values()) total += u.inputTokens;
    return total;
  }

  /** Total output tokens across all models. */
  get totalOutputTokens(): number {
    let total = 0;
    for (const u of this.usage.values()) total += u.outputTokens;
    return total;
  }

  /** Estimate total cost in USD across all models. Returns null if any model has unknown pricing. */
  estimateTotalCost(customPricing?: Record<string, { inputPer1M: number; outputPer1M: number }>): number | null {
    let total = 0;
    for (const [modelId, u] of this.usage.entries()) {
      const cost = estimateCost(modelId, u.inputTokens, u.outputTokens, customPricing);
      if (cost === null) return null;
      total += cost;
    }
    return total;
  }

  /**
   * Model IDs used during this review that have no known pricing (after
   * applying any custom overrides). Empty when every model is priced. Lets the
   * caller surface an actionable "set a `pricing:` override" hint instead of a
   * silent unpriced cost. A `0`/`0` priced model is NOT unpriced.
   */
  unpricedModels(customPricing?: Record<string, { inputPer1M: number; outputPer1M: number }>): string[] {
    const unpriced: string[] = [];
    for (const modelId of this.usage.keys()) {
      if (estimateCost(modelId, 0, 0, customPricing) === null) unpriced.push(modelId);
    }
    return unpriced;
  }
}

/**
 * Wraps an ILLMProvider to transparently track token usage.
 * Returns the text string from invoke() so callers are unaffected,
 * while accumulating usage in the provided TokenAccumulator.
 */
export class TrackingLLMProvider implements ILLMProvider {
  constructor(
    private inner: ILLMProvider,
    private accumulator: TokenAccumulator,
  ) {}

  async invoke(modelId: string, prompt: string, maxTokens?: number): Promise<string> {
    const raw = await this.inner.invoke(modelId, prompt, maxTokens);
    const result = normalizeLLMResult(raw);
    this.accumulator.add(modelId, result.usage);
    return result.text;
  }
}
