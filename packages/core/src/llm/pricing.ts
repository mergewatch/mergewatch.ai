/**
 * LLM pricing table for cost estimation.
 *
 * Prices are in USD per 1M tokens. Covers Bedrock Anthropic IDs
 * and direct Anthropic IDs. Unknown models return null.
 */

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /**
   * #722 — cache-read rate, where it is not `inputPer1M x CACHE_READ_MULTIPLIER`.
   * Optional so every two-key `pricing:` override stays valid.
   */
  cacheReadPer1M?: number;
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
  // the same as the headline price. The rule (#722):
  //
  //   - bare first-party id and `global.` profile = list price
  //   - `us.` profile, Claude 4.5 and later      = list x 1.10
  //   - `us.` profile, before Claude 4.5          = list (no premium: Opus 4.1's
  //     rate card has a single rate and no regional dimension)
  //
  // Confirmed against the rate cards (Sonnet 5, Opus 5, Fable 5, Opus 4.7),
  // each showing global -> us. at +10%:
  //
  //   USW2_input_tokens_global_standard  10   (Fable 5, matches published rate)
  //   USW2_input_tokens_standard         11   (us. profile, +10%)
  //
  // Every model MergeWatch runs uses a `us.` profile, so the `us.` rate is what
  // we are actually billed. Using the published/base number here under-bills by
  // ~10% on every review — this table feeds calculateReviewCost.
  //
  // Sources: platform.claude.com/docs/en/about-claude/pricing, and per region:
  //   aws bedrock list-foundation-model-agreement-offers --model-id <base-id> \
  //     --query "offers[0].termDetails.usageBasedPricingTerm.rateCard[?contains(dimension,'USW2')]"
  // The rate card is still returned after the agreement is accepted: Sonnet 4.6
  // (agreement AVAILABLE) returned 1008 entries on 2026-10-17.
  //
  // Every `us.`/`global.` key here must be a live profile, and every live
  // profile must be here and in CONTEXT_WINDOWS: profiles-coverage.test.ts
  // checks both against bedrock-profiles.us-west-2.json, which
  // scripts/check-bedrock-profiles.mjs regenerates and the release gate checks.

  // The 5.5 generation. Cache reads are 0.05x input on Sonnet 5.5 and Opus 5.5
  // and 0.025x on Fable 5.1 (page footnotes; rate cards agree), not the 0.1x
  // CACHE_READ_MULTIPLIER, so they are set explicitly.
  'us.anthropic.claude-sonnet-5-5': { inputPer1M: 2.20, outputPer1M: 11, cacheReadPer1M: 0.11 },
  'global.anthropic.claude-sonnet-5-5': { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.10 },
  'us.anthropic.claude-opus-5-5': { inputPer1M: 4.40, outputPer1M: 22, cacheReadPer1M: 0.22 },
  'global.anthropic.claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.20 },
  'us.anthropic.claude-fable-5-1': { inputPer1M: 11, outputPer1M: 55, cacheReadPer1M: 0.275 },
  'global.anthropic.claude-fable-5-1': { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 0.25 },
  // Haiku 5.5 is tiered per request: $0.10/$0.50 list up to a 100k-token prompt
  // (cache reads and writes count toward it), $0.50/$2.50 above. The tier is
  // decided per request, but the accumulator sums tokens per model and cannot
  // see it, so this pins the >100k rate: it can over-bill a short prompt by up
  // to 5x and never under-bills. Model the tier before making it the lightModel.
  'us.anthropic.claude-haiku-5-5': { inputPer1M: 0.55, outputPer1M: 2.75, cacheReadPer1M: 0.055 },
  'global.anthropic.claude-haiku-5-5': { inputPer1M: 0.50, outputPer1M: 2.50, cacheReadPer1M: 0.05 },

  // The 5 generation
  'us.anthropic.claude-sonnet-5': { inputPer1M: 2.20, outputPer1M: 11 },
  'global.anthropic.claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'us.anthropic.claude-opus-5': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-fable-5': { inputPer1M: 11, outputPer1M: 55 },
  'global.anthropic.claude-fable-5': { inputPer1M: 10, outputPer1M: 50 },

  // Opus tier — base $5/$25
  'us.anthropic.claude-opus-4-8': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-7': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-6-v1': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-4-6-v1': { inputPer1M: 5, outputPer1M: 25 },
  'us.anthropic.claude-opus-4-5-20251101-v1:0': { inputPer1M: 5.50, outputPer1M: 27.50 },
  'global.anthropic.claude-opus-4-5-20251101-v1:0': { inputPer1M: 5, outputPer1M: 25 },
  // Legacy Opus — $15/$75, before 4.5, so no `us.` premium.
  'us.anthropic.claude-opus-4-1-20250805-v1:0': { inputPer1M: 15, outputPer1M: 75 },

  // Sonnet tier — base $3/$15
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { inputPer1M: 3.30, outputPer1M: 16.50 },
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0': { inputPer1M: 3, outputPer1M: 15 },
  'us.anthropic.claude-sonnet-4-6': { inputPer1M: 3.30, outputPer1M: 16.50 },
  'global.anthropic.claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },

  // Haiku tier — base $1/$5. The previous $0.80/$4 matched no published rate
  // and under-billed by 27%; this is the lightModel used on every review.
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1M: 1.10, outputPer1M: 5.50 },
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1M: 1, outputPer1M: 5 },

  // ── Direct Anthropic model IDs ─────────────────────────────────────────
  //
  // First-party API list prices, used by self-hosted operators on the Anthropic
  // provider. No cross-region premium applies here.
  'claude-sonnet-5-5': { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.10 },
  'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.20 },
  'claude-fable-5-1': { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 0.25 },
  // Haiku 5.5: pinned at the >100k tier, as for the Bedrock ids above.
  'claude-haiku-5-5': { inputPer1M: 0.50, outputPer1M: 2.50, cacheReadPer1M: 0.05 },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25 },
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'claude-fable-5': { inputPer1M: 10, outputPer1M: 50 },
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-5-20250929': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5 },
  'claude-3-5-haiku-20241022': { inputPer1M: 1, outputPer1M: 5 },
};

/**
 * Estimate cost in USD for a given model and token counts.
 * Returns null if the model is not in the pricing table (and no custom pricing provided).
 */
/**
 * #490 — cache rates as MULTIPLIERS of the input rate, not as pricing fields.
 *
 * Adding `cacheReadPer1M` / `cacheWritePer1M` would mean editing ~40 rows AND
 * breaking every `customPricing` override: a self-hosted `.mergewatch.yml`
 * `pricing:` block carries two keys today, so any override not updated would
 * silently price cache traffic at ZERO. Deriving keeps every existing
 * two-key override correct by construction.
 *
 * Anthropic's published ratios. The write ratio holds on every model. The read
 * ratio does not hold for the 5.5 generation (#722), so a model can carry its
 * own `cacheReadPer1M`; this multiplier is the fallback when it does not. A
 * two-key `pricing:` override therefore prices reads at 0.1x even for a 5.5
 * model. That over-reports, the safe side, and the default's rate is
 * deliberately not merged in: the override may be a negotiated rate.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  customPricing?: Record<string, ModelPricing>,
  /**
   * Cache traffic. Optional so every existing call site keeps its meaning:
   * absent means "no cache involved", which is what a provider without a
   * cache API reports.
   */
  cache?: { readTokens?: number; writeTokens?: number },
): number | null {
  const pricing = customPricing?.[modelId] ?? DEFAULT_PRICING[modelId];
  if (!pricing) return null;
  const cacheRead = (cache?.readTokens ?? 0) / 1_000_000
    * (pricing.cacheReadPer1M ?? pricing.inputPer1M * CACHE_READ_MULTIPLIER);
  const cacheWrite = (cache?.writeTokens ?? 0) / 1_000_000 * pricing.inputPer1M * CACHE_WRITE_MULTIPLIER;
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M
       + cacheRead + cacheWrite;
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
