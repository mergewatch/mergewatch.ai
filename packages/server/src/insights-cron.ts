/**
 * FB-E — self-hosted insight rollup scheduler.
 *
 * Lightweight `setInterval`-based runner rather than a real cron library:
 * the job is once-a-day, idempotent, and we don't need precise wall-clock
 * timing. The first run fires `STARTUP_DELAY_MS` after server startup (to
 * avoid colliding with DB-migration work); subsequent runs at 24h
 * intervals from there. Operators who want precise 03:00 UTC scheduling
 * can run the server as a Docker job triggered by an external cron.
 */

import { runInsightRollup } from '@mergewatch/core';
import type {
  IFindingDispositionStore,
  IFPInsightStore,
  IInstallationStore,
} from '@mergewatch/core';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Wait 60s after startup before the first run so migrations / warm-up
 *  paths complete first. */
const STARTUP_DELAY_MS = 60 * 1000;

export interface InsightsCronStores {
  installationStore: IInstallationStore;
  dispositionStore: IFindingDispositionStore;
  fpInsightStore: IFPInsightStore;
}

export interface InsightsCronHandle {
  /** Stop the scheduler. Used by tests + graceful shutdown. */
  stop(): void;
}

/**
 * Start the self-hosted insights rollup scheduler. Returns a handle so
 * tests + graceful-shutdown paths can stop it. Runs the rollup once at
 * startup (delayed by STARTUP_DELAY_MS) and then every 24 hours.
 *
 * Errors inside the rollup are caught by `runInsightRollup` and surfaced
 * via the per-installation failure list — this scheduler also wraps the
 * outer call in try/catch so a catastrophic error in the orchestrator
 * (e.g. store crash) doesn't take down the Node process.
 */
export function startInsightsCron(stores: InsightsCronStores): InsightsCronHandle {
  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  const runOnce = async () => {
    if (stopped) return;
    try {
      console.log('[fb-e cron] starting nightly insights rollup');
      const result = await runInsightRollup(stores);
      console.log(
        '[fb-e cron] rollup complete — processed=%d, rows=%d, failed=[%s], elapsed=%dms',
        result.installationsProcessed,
        result.rowsWritten,
        result.installationsFailed.join(', '),
        result.elapsedMs,
      );
    } catch (err) {
      console.warn('[fb-e cron] rollup threw — skipping this cycle:', err);
    }
  };

  // First-run delay so migrations have a chance to finish.
  const firstRunTimer = setTimeout(() => {
    if (stopped) return;
    void runOnce();
    intervalHandle = setInterval(() => void runOnce(), ONE_DAY_MS);
  }, STARTUP_DELAY_MS);

  return {
    stop() {
      stopped = true;
      clearTimeout(firstRunTimer);
      if (intervalHandle) clearInterval(intervalHandle);
    },
  };
}
