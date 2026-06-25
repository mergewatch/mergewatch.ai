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

/**
 * Default pricing for known models (USD per 1M tokens). Covers the Anthropic
 * models MergeWatch ships/recommends, by both Bedrock and direct-Anthropic ID.
 * Self-hosted operators on any other model (Ollama, LiteLLM, a newer alias)
 * should set a `pricing:` override in `.mergewatch.yml`; unknown models return
 * null (counted but excluded from spend). Tiers: Opus $5/$25, legacy Opus
 * $15/$75, Sonnet $3/$15, Haiku $0.80/$4 per 1M.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Bedrock Anthropic model IDs
  'us.anthropic.claude-opus-4-8-v1': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-6-v1': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-20250514-v1:0': { inputPer1M: 15, outputPer1M: 75 },
  'us.anthropic.claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { inputPer1M: 3, outputPer1M: 15 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1M: 0.80, outputPer1M: 4 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 0.80, outputPer1M: 4 },

  // Direct Anthropic model IDs
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
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

/**
 * #233 — build a custom-pricing entry for a single model from raw env-var
 * strings (`LLM_MODEL` + `LLM_MODEL_INPUT_PRICE_PER_1M` /
 * `LLM_MODEL_OUTPUT_PRICE_PER_1M`). Lets a self-hosted operator price whatever
 * `LLM_MODEL` is set to — including an opaque Bedrock inference-profile ARN —
 * without a per-repo `.mergewatch.yml` entry.
 *
 * Pure + env-agnostic (the caller reads `process.env`). Returns a single-entry
 * `{ [modelId]: { inputPer1M, outputPer1M } }` map, or `undefined` when it can't
 * form a valid price: no model ID, either price missing/blank, or a price that
 * isn't a finite, non-negative number. `0`/`0` is valid → a real priced $0.
 */
export function parseEnvModelPricing(
  modelId: string | undefined,
  inputPer1M: string | undefined,
  outputPer1M: string | undefined,
): Record<string, ModelPricing> | undefined {
  if (!modelId) return undefined;
  // Blank/whitespace counts as "not provided" — guards against Number('') === 0.
  if (inputPer1M == null || inputPer1M.trim() === '') return undefined;
  if (outputPer1M == null || outputPer1M.trim() === '') return undefined;

  const input = Number(inputPer1M);
  const output = Number(outputPer1M);
  if (!Number.isFinite(input) || input < 0) return undefined;
  if (!Number.isFinite(output) || output < 0) return undefined;

  return { [modelId]: { inputPer1M: input, outputPer1M: output } };
}
