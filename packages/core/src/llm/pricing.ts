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
  // ── Bedrock Anthropic model IDs ────────────────────────────────────────
  //
  // These are AWS's rates for the *specific inference profile*, which is not
  // the same as the headline price. Bedrock quotes a base rate that applies to
  // `global.` profiles; the `us.` cross-region profiles cost exactly 10% more.
  // Confirmed against three rate cards (Sonnet 5, Opus 5, Fable 5), each
  // showing global -> us. at +10%:
  //
  //   USW2_input_tokens_global_standard  10   (Fable 5, matches published rate)
  //   USW2_input_tokens_standard         11   (us. profile, +10%)
  //
  // Every model MergeWatch runs uses a `us.` profile, so the `us.` rate is what
  // we are actually billed. Using the published/base number here under-bills by
  // ~10% on every review — this table feeds calculateReviewCost.
  //
  // Re-derive per region with:
  //   aws bedrock list-foundation-model-agreement-offers --model-id <base-id> \
  //     --query "offers[0].termDetails.usageBasedPricingTerm.rateCard[?contains(dimension,'USW2')]"
  // (returns empty once the model's agreement is accepted — read it before
  // accepting, or take base rate x 1.1 for a us. profile.)

  // The 5 generation
  'us.anthropic.claude-sonnet-5': { inputPer1M: 2.20, outputPer1M: 11 },
  'global.anthropic.claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'us.anthropic.claude-opus-5': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-fable-5': { inputPer1M: 11, outputPer1M: 55 },
  'global.anthropic.claude-fable-5': { inputPer1M: 10, outputPer1M: 50 },

  // Opus tier — base $5/$25
  'us.anthropic.claude-opus-4-8-v1': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'us.anthropic.claude-opus-4-6-v1': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'us.anthropic.claude-opus-4-20250514-v1:0': { inputPer1M: 16.50, outputPer1M: 82.50 },

  // Sonnet tier — base $3/$15
  'us.anthropic.claude-sonnet-4-6': { inputPer1M: 3.30, outputPer1M: 16.50 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { inputPer1M: 3.30, outputPer1M: 16.50 },

  // Haiku tier — base $1/$5. The previous $0.80/$4 matched no published rate
  // and under-billed by 27%; this is the lightModel used on every review.
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1M: 1.10, outputPer1M: 5.50 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 1.10, outputPer1M: 5.50 },

  // ── Direct Anthropic model IDs ─────────────────────────────────────────
  //
  // First-party API list prices, used by self-hosted operators on the Anthropic
  // provider. No cross-region premium applies here.
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'claude-fable-5': { inputPer1M: 10, outputPer1M: 50 },
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5 },
  'claude-3-5-haiku-20241022': { inputPer1M: 1, outputPer1M: 5 },
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
