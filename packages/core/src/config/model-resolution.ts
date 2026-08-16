/**
 * #264 — Review model resolution.
 *
 * Extracted from the Lambda handler so the precedence is pinned by tests rather
 * than buried in a thousand-line function. The bug this fixes was invisible
 * precisely because nothing asserted the behavior: `.mergewatch.yml`'s
 * documented `model:` key was silently ignored on SaaS while the adjacent line
 * honored `lightModel:`.
 */

/** Inputs to model resolution, most specific first. */
export interface ModelResolutionInput {
  /**
   * Per-repo override stored on the installation row. Nothing writes this
   * today (see `InstallationItem.modelId`); read so a hand-set row keeps
   * working.
   */
  installationModelId?: string;
  /**
   * `model:` as authored in `.mergewatch.yml`.
   *
   * This must be the **raw** parsed value, never a merged config's `model`.
   * `mergeConfig` always fills `DEFAULT_CONFIG.model`, so a merged value is
   * truthy for every repository and would override the deploy-time default
   * everywhere — turning a per-repo opt-in into a global change.
   */
  repoConfigModel?: string;
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
 * Precedence: installation override → `.mergewatch.yml` → deploy default →
 * hardcoded fallback. Empty and whitespace-only values are treated as unset,
 * so a `model:` key left blank in YAML falls through instead of resolving to
 * an empty model ID.
 */
export function resolveReviewModelId(input: ModelResolutionInput): ResolvedModel {
  const candidates: Array<[ModelSource, string | undefined]> = [
    ['installation', input.installationModelId],
    ['repo-config', input.repoConfigModel],
    ['deploy-default', input.deployDefault],
  ];

  for (const [source, value] of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return { modelId: trimmed, source };
  }

  return { modelId: input.fallback, source: 'fallback' };
}
