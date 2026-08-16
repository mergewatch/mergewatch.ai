/**
 * Review model resolution (#264).
 *
 * Extracted from the Lambda handler so the precedence is pinned by tests rather
 * than buried in a thousand-line function. The original bug was invisible
 * precisely because nothing asserted the behavior: `.mergewatch.yml`'s
 * documented `model:` key was silently ignored on SaaS while the adjacent line
 * honored `lightModel:`.
 *
 * Precedence, highest first:
 *
 *   1. `.mergewatch.yml` `model:`      — the repository's committed intent
 *   2. `installation.modelId`          — per-repo override on the installation row
 *   3. `DEFAULT_BEDROCK_MODEL_ID`      — the deploy-time default
 *   4. hardcoded fallback
 *
 * The committed yml outranks stored installation state, matching the
 * configuration contract the rest of the config merge follows since #306
 * ("the .mergewatch.yml in the repository always wins") — see
 * `packages/server/src/review-processor.ts`. Before that alignment these two
 * adjacent code paths disagreed about which source won.
 *
 * Note the deploy default sits at the BOTTOM here, unlike self-hosted's
 * `LLM_MODEL`, which overrides everything including the yml. That asymmetry is
 * intentional and follows the names: `LLM_MODEL` is an operator pin ("run
 * everything on this"), while `DEFAULT_BEDROCK_MODEL_ID` is a default a
 * repository is entitled to override.
 */

/** Inputs to model resolution. Field order does not imply precedence. */
export interface ModelResolutionInput {
  /**
   * `model:` as authored in `.mergewatch.yml`. Highest precedence.
   *
   * This must be the **raw** parsed value, never a merged config's `model`.
   * `mergeConfig` always fills `DEFAULT_CONFIG.model`, so a merged value is
   * truthy for every repository and would override the deploy-time default
   * everywhere — turning a per-repo opt-in into a global change.
   */
  repoConfigModel?: string;
  /**
   * Per-repo override stored on the installation row. Nothing writes this
   * today (see `InstallationItem.modelId`); read so a hand-set row keeps
   * working. Outranked by the committed yml.
   */
  installationModelId?: string;
  /** Deploy-time default (`DEFAULT_BEDROCK_MODEL_ID`). */
  deployDefault?: string;
  /** Last-resort fallback when the deploy default is unset. */
  fallback: string;
}

export type ModelSource =
  | 'installation'
  | 'repo-config'
  | 'deploy-default'
  | 'fallback';

export interface ResolvedModel {
  modelId: string;
  /** Which input won. Logged so an unexpected model is traceable to its source. */
  source: ModelSource;
}

/**
 * Resolve the model a review should run on.
 *
 * Precedence: `.mergewatch.yml` → installation override → deploy default →
 * hardcoded fallback. Empty and whitespace-only values are treated as unset,
 * so a `model:` key left blank in YAML falls through instead of resolving to
 * an empty model ID.
 */
export function resolveReviewModelId(input: ModelResolutionInput): ResolvedModel {
  const candidates: Array<[ModelSource, string | undefined]> = [
    ['repo-config', input.repoConfigModel],
    ['installation', input.installationModelId],
    ['deploy-default', input.deployDefault],
  ];

  for (const [source, value] of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return { modelId: trimmed, source };
  }

  return { modelId: input.fallback, source: 'fallback' };
}
