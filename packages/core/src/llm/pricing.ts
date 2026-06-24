/**
 * LLM pricing table for cost estimation.
 *
 * Prices are in USD per 1M tokens. Covers Bedrock Anthropic IDs
 * and direct Anthropic IDs. Unknown models return null.
 */

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** Default pricing for known models (USD per 1M tokens). */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Bedrock Anthropic model IDs
  'us.anthropic.claude-opus-4-6-v1': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-20250514-v1:0': { inputPer1M: 15, outputPer1M: 75 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { inputPer1M: 3, outputPer1M: 15 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1M: 0.80, outputPer1M: 4 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 0.80, outputPer1M: 4 },

  // Direct Anthropic model IDs
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.80, outputPer1M: 4 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.80, outputPer1M: 4 },
};

/**
 * Estimate cost in USD for a given model and token counts.
 * Returns null if the model is not in the pricing table (and no custom pricing provided).
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  customPricing?: Record<string, ModelPricing>,
): number | null {
  const pricing = customPricing?.[modelId] ?? DEFAULT_PRICING[modelId];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M;
}
