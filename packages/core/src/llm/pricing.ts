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
  // The 5 generation (#262). Bedrock inference-profile IDs carry no version
  // suffix.
  //
  // These are AWS's rates, NOT Anthropic's first-party list prices, and the two
  // differ: Anthropic lists Sonnet 5 at $3/$15, while Bedrock in us-west-2
  // charges $2.20/$11 for the `us.` cross-region profile and $2/$10 for
  // `global.`. Since this table feeds calculateReviewCost and therefore what
  // customers are charged, using the first-party numbers would have overcharged
  // by ~36%.
  //
  // Source of truth, per region:
  //   aws bedrock list-foundation-model-agreement-offers \
  //     --model-id anthropic.claude-sonnet-5 \
  //     --query "offers[0].termDetails.usageBasedPricingTerm.rateCard[?contains(dimension,'USW2')]"
  'us.anthropic.claude-sonnet-5': { inputPer1M: 2.20, outputPer1M: 11 },
  'global.anthropic.claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'us.anthropic.claude-opus-5': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-8-v1': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-6-v1': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-20250514-v1:0': { inputPer1M: 15, outputPer1M: 75 },
  'us.anthropic.claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { inputPer1M: 3, outputPer1M: 15 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1M: 0.80, outputPer1M: 4 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 0.80, outputPer1M: 4 },

  // Direct Anthropic model IDs
  'claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
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
  // Blank/whitespace counts as "not provided" — guards against Number('') === 0
  // and Number('  ') === 0. The trim is applied to both the blank check and the
  // numeric conversion so a whitespace-only value can never slip through as 0.
  const inputTrimmed = inputPer1M?.trim();
  const outputTrimmed = outputPer1M?.trim();
  if (!inputTrimmed || !outputTrimmed) return undefined;

  const input = Number(inputTrimmed);
  const output = Number(outputTrimmed);
  if (!Number.isFinite(input) || input < 0) return undefined;
  if (!Number.isFinite(output) || output < 0) return undefined;

  return { [modelId]: { inputPer1M: input, outputPer1M: output } };
}
