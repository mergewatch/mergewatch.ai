/**
 * FB-E — orchestrator for the nightly insight rollup. Pure(-ish) function
 * that runs the rollup across every installation; called by:
 *   - the EventBridge → Lambda handler on SaaS
 *   - the node-cron job in the self-hosted Express server
 *
 * Single shared entry point keeps the behaviour identical across deploy
 * shapes — and the function is testable by injecting mock stores
 * (no AWS / node-cron / Express coupling).
 */

import type {
  IFindingDispositionStore,
  IFPInsightStore,
  IInstallationStore,
} from '../storage/types.js';
import type { InstallationFPInsight } from '../types/db.js';
import { buildInsightFromDispositions } from './rollup.js';

const WINDOWS: InstallationFPInsight['window'][] = ['7d', '30d', '90d'];

export interface RollupStores {
  installationStore: Pick<IInstallationStore, 'listInstallationIds'>;
  dispositionStore: Pick<IFindingDispositionStore, 'listByInstallation'>;
  fpInsightStore: Pick<IFPInsightStore, 'upsert'>;
}

export interface RollupRunResult {
  installationsProcessed: number;
  rowsWritten: number;
  installationsFailed: string[];
  elapsedMs: number;
  windowEnd: string;
}

/**
 * Run the nightly rollup. For each installation:
 *   1. List its FindingDispositionRecord rows.
 *   2. Build a 7d / 30d / 90d insight from them.
 *   3. Upsert each insight row.
 *
 * Per-installation failure is isolated: a single broken installation
 * doesn't take down the whole job; the failing installation IDs are
 * returned for follow-up.
 *
 * Idempotent — re-running the same window-end overwrites the rows with
 * identical numbers (the rollup is a pure function of the disposition
 * records + windowEnd).
 */
export async function runInsightRollup(
  stores: RollupStores,
  /** ISO 8601 — anchor the windows to this timestamp. Defaults to `now`. */
  windowEndIso: string = new Date().toISOString(),
): Promise<RollupRunResult> {
  const startMs = Date.now();
  const installationsFailed: string[] = [];
  let installationsProcessed = 0;
  let rowsWritten = 0;

  const installationIds = await stores.installationStore.listInstallationIds().catch((err) => {
    console.warn('[fb-e] listInstallationIds failed; rollup aborted:', err);
    return [] as string[];
  });

  for (const installationId of installationIds) {
    try {
      // Page through records — listByInstallation returns up to 1000 per
      // call. For the typical installation that's a single page; for
      // outliers we'd want to extend the loop to follow nextCursor. Here
      // we take the first page (the rollup is best-effort + bounded by
      // the store's cap; pagination support belongs in a follow-up).
      const { items: records } = await stores.dispositionStore.listByInstallation(installationId, { limit: 1000 });

      for (const window of WINDOWS) {
        const insight = buildInsightFromDispositions(installationId, window, windowEndIso, records);
        await stores.fpInsightStore.upsert(insight);
        rowsWritten++;
      }
      installationsProcessed++;
    } catch (err) {
      console.warn('[fb-e] rollup failed for installation %s:', installationId, err);
      installationsFailed.push(installationId);
    }
  }

  return {
    installationsProcessed,
    rowsWritten,
    installationsFailed,
    elapsedMs: Date.now() - startMs,
    windowEnd: windowEndIso,
  };
}
