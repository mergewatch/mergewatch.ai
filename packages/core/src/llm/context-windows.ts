/**
 * #423 — model context windows, and the input budget derived from them.
 *
 * The review path had no input-size guard at all: the diff was passed through
 * unbounded, and whichever context window the configured model happened to have
 * was the only thing standing between a large PR and a hard failure. That held
 * as long as the default was a 1M-context model. When #414 moved the default to
 * a 200K one, large PRs began failing with a raw Bedrock error
 * (`ValidationException: Input is too long for requested model`) after every
 * fallback layer collapsed — no findings, no partial result, no guidance.
 *
 * This module makes the limit explicit and checkable *before* the call, so an
 * oversized diff produces an actionable skip instead of an opaque failure.
 *
 * It is deliberately a bound, not a solution. A large enough diff overflows any
 * window; the durable answer is retrieval over a checkout rather than shipping
 * the whole diff (#424).
 */

/**
 * Input context window per model, in tokens.
 *
 * Keys mirror `llm/pricing.ts` — Bedrock inference-profile IDs (`us.` /
 * `global.` prefixed) and the bare first-party IDs a self-hosted operator would
 * use. Keep the two tables in step: a model worth pricing is a model worth
 * bounding.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  // ── 1M-context models ────────────────────────────────────────────────────
  'us.anthropic.claude-sonnet-4-6': 1_000_000,
  'us.anthropic.claude-sonnet-5': 1_000_000,
  'global.anthropic.claude-sonnet-5': 1_000_000,
  'us.anthropic.claude-opus-4-6-v1': 1_000_000,
  'us.anthropic.claude-opus-4-8-v1': 1_000_000,
  'us.anthropic.claude-opus-5': 1_000_000,
  'global.anthropic.claude-opus-5': 1_000_000,
  'us.anthropic.claude-fable-5': 1_000_000,
  'global.anthropic.claude-fable-5': 1_000_000,

  // ── 200K-context models ──────────────────────────────────────────────────
  // Sonnet 4.5 is the one that surfaced #423: #414 moved the default here from
  // a 1M model, a 5x reduction, and nothing noticed until PRs started failing.
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 200_000,
  'us.anthropic.claude-sonnet-4-20250514-v1:0': 200_000,
  'us.anthropic.claude-opus-4-20250514-v1:0': 200_000,
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 200_000,
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': 200_000,

  // ── Direct Anthropic model IDs (self-hosted) ─────────────────────────────
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
};

/**
 * Window assumed for a model we don't recognise.
 *
 * Deliberately the **smaller** tier. The two ways to be wrong are not
 * symmetric: guessing too small produces a visible, actionable skip ("diff too
 * large"), while guessing too large reproduces exactly the opaque hard failure
 * this module exists to prevent. A self-hosted operator on an exotic model or a
 * Bedrock inference-profile ARN gets the safe side of that trade.
 */
export const UNKNOWN_MODEL_CONTEXT_WINDOW = 200_000;

/** Context window for a model ID, falling back conservatively. */
export function contextWindowFor(modelId: string | undefined): number {
  if (!modelId) return UNKNOWN_MODEL_CONTEXT_WINDOW;
  return CONTEXT_WINDOWS[modelId] ?? UNKNOWN_MODEL_CONTEXT_WINDOW;
}

/** Whether we actually know this model, as opposed to falling back. */
export function isKnownModel(modelId: string | undefined): boolean {
  return !!modelId && modelId in CONTEXT_WINDOWS;
}

/**
 * Rough token count for a string.
 *
 * Four characters per token is the usual English/code approximation. It is
 * deliberately not `count_tokens`: that is a network round-trip, and this runs
 * per review before eight agents fan out — paying for exactness here would cost
 * more than the guard saves. The safety margin below absorbs the error.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fraction of the window reserved for everything that is not the diff: system
 * prompt, conventions, PR metadata, fetched file context, and the estimate's
 * own inaccuracy.
 *
 * 35% is deliberately generous. Being wrong in the tight direction means a
 * skip; being wrong in the loose direction means the hard failure we are
 * trying to eliminate.
 */
export const INPUT_OVERHEAD_FRACTION = 0.35;

export interface InputBudget {
  /** Tokens the diff may occupy. */
  budgetTokens: number;
  /** Estimated tokens the diff actually occupies. */
  estimatedTokens: number;
  fits: boolean;
  /** The model's full window, for reporting. */
  contextWindow: number;
  /** True when the window was assumed rather than known. */
  assumedWindow: boolean;
}

/**
 * Decide whether a diff fits the configured model's window.
 *
 * `maxTokensPerAgent` is subtracted because generated output shares the window
 * with input — a request whose input plus `max_tokens` exceeds the context is
 * rejected even when the input alone would have fit.
 */
export function checkInputBudget(
  diff: string,
  modelId: string | undefined,
  maxTokensPerAgent: number,
): InputBudget {
  const contextWindow = contextWindowFor(modelId);
  const budgetTokens = Math.max(
    0,
    Math.floor(contextWindow * (1 - INPUT_OVERHEAD_FRACTION)) - maxTokensPerAgent,
  );
  const estimatedTokens = estimateTokens(diff);

  return {
    budgetTokens,
    estimatedTokens,
    fits: estimatedTokens <= budgetTokens,
    contextWindow,
    assumedWindow: !isKnownModel(modelId),
  };
}

/**
 * Operator-facing explanation for an over-budget diff.
 *
 * Says what happened, how far over it is, and what to do — the raw
 * `ValidationException: Input is too long for requested model` said none of
 * those things.
 */
export function describeOverBudget(budget: InputBudget, modelId: string | undefined): string {
  const k = (n: number) => `${Math.round(n / 1000)}K`;
  return (
    `Diff is too large to review: ~${k(budget.estimatedTokens)} tokens against a `
    + `~${k(budget.budgetTokens)} budget (${modelId ?? 'unknown model'}, `
    + `${k(budget.contextWindow)} context${budget.assumedWindow ? ', assumed' : ''}). `
    + 'Split the PR, or exclude generated files via `excludePatterns` in .mergewatch.yml.'
  );
}
