/**
 * FB-L — load the org's top disputed clusters and filter them to the
 * thresholds the pipeline injects as "be cautious here" guidance.
 *
 * Shared helper called by both handlers (server/review-processor.ts +
 * lambda/handlers/review-agent.ts) so the threshold logic stays
 * identical across deploy shapes.
 *
 * Best-effort: any store error returns an empty array. The pipeline
 * then renders the empty-state directive (i.e. strips the placeholder)
 * — same behaviour as if `feedback.learnFromDisputes` was off.
 */

import type { IFPInsightStore } from '../storage/types.js';
import type { KnownFPPattern } from '../agents/prompts.js';
import type { InstallationFPInsight } from '../types/db.js';
import type { FeedbackConfig } from '../config/defaults.js';
import {
  DEFAULT_KNOWN_FP_TOP_K,
  DEFAULT_KNOWN_FP_MIN_SURFACE_COUNT,
  DEFAULT_KNOWN_FP_MIN_DISPUTE_RATE,
} from '../config/defaults.js';

/** Window to read for the FB-L injection. 90d gives the broadest signal —
 *  more samples per cluster, less noise from a single recent dispute. */
const FB_L_WINDOW: InstallationFPInsight['window'] = '90d';

export interface FetchKnownFPPatternsOptions {
  feedback?: FeedbackConfig;
}

/**
 * Read the latest 90d InstallationFPInsight for the installation, filter
 * topClusters to those meeting the configured thresholds, and return the
 * top-K as `KnownFPPattern[]`. When `feedback.learnFromDisputes` is false
 * (the default), skips the store read entirely and returns `[]` — the
 * placeholder strips and the prompt is byte-identical to the pre-FB-L shape.
 */
export async function loadKnownFPPatterns(
  store: IFPInsightStore | undefined,
  installationId: string | number | undefined,
  opts: FetchKnownFPPatternsOptions = {},
): Promise<KnownFPPattern[]> {
  const feedback = opts.feedback;
  if (!feedback?.learnFromDisputes) return [];
  if (!store || installationId == null) return [];

  const topK = feedback.knownFPPatternsTopK ?? DEFAULT_KNOWN_FP_TOP_K;
  const minSurface = feedback.knownFPPatternsMinSurfaceCount ?? DEFAULT_KNOWN_FP_MIN_SURFACE_COUNT;
  const minRate = feedback.knownFPPatternsMinDisputeRate ?? DEFAULT_KNOWN_FP_MIN_DISPUTE_RATE;

  let insight: InstallationFPInsight | null;
  try {
    insight = await store.get(String(installationId), FB_L_WINDOW);
  } catch (err) {
    console.warn('[fb-l] failed to read InstallationFPInsight for %s:', installationId, err);
    return [];
  }
  if (!insight) return [];

  const qualifying = insight.topClusters
    .filter((c) => c.surfaceCount >= minSurface && c.rate >= minRate)
    // The rollup already sorts by leverage desc; re-sort defensively in
    // case the storage layer didn't preserve order (DynamoDB scan + JSON
    // round-trip can shuffle on some paths).
    .sort((a, b) => (b.rate * b.surfaceCount) - (a.rate * a.surfaceCount))
    .slice(0, topK);

  return qualifying.map((c) => ({
    representativeTitle: c.representativeTitle,
    sigTokens: c.sigTokens,
    rate: c.rate,
    surfaceCount: c.surfaceCount,
  }));
}
