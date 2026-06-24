/**
 * FB-E — self-hosted insight rollup scheduler.
 *
 * Lightweight `setInterval`-based runner rather than a real cron library:
 * the job is idempotent and we don't need precise wall-clock timing. The
 * first run fires `STARTUP_DELAY_MS` after server startup (to avoid
 * colliding with DB-migration work); subsequent runs at a fixed interval
 * from there.
 *
 * Cadence defaults to hourly, matching the SaaS EventBridge schedule, so the
 * dashboard's cost / cycle-time / engagement blocks stay within ~1h of fresh
 * rather than up to 24h stale. Operators can tune it via
 * INSIGHTS_ROLLUP_INTERVAL_MINUTES (raise it to reduce DB load, or run the
 * server as a one-shot Docker job behind an external cron with a large value).
 */

import { runInsightRollup } from '@mergewatch/core';
import type {
  IFindingDispositionStore,
  IFPInsightStore,
  IInstallationStore,
  IPRLifecycleStore,
  ISatisfactionStore,
  IReviewCostStore,
} from '@mergewatch/core';

/** Default rollup cadence when INSIGHTS_ROLLUP_INTERVAL_MINUTES is unset or
 *  invalid. Hourly, matching the SaaS EventBridge schedule. */
const DEFAULT_INTERVAL_MINUTES = 60;
/** Wait 60s after startup before the first run so migrations / warm-up
 *  paths complete first. */
const STARTUP_DELAY_MS = 60 * 1000;

/**
 * Resolve the rollup interval (ms) from INSIGHTS_ROLLUP_INTERVAL_MINUTES,
 * falling back to the hourly default for unset / non-numeric / non-positive
 * values. Exported for unit testing.
 */
export function resolveRollupIntervalMs(
  raw = process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES,
): number {
  const minutes = Number(raw);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES;
  return safe * 60 * 1000;
}

export interface InsightsCronStores {
  installationStore: IInstallationStore;
  dispositionStore: IFindingDispositionStore;
  fpInsightStore: IFPInsightStore;
  /** TTM (#194) — feeds the cycle-time block of each insight row. */
  prLifecycleStore?: IPRLifecycleStore;
  /** #195 Tier 2 — feeds the helpful-rate + NPS fields of each engagement block. */
  satisfactionStore?: ISatisfactionStore;
  /** #193 — feeds the cost block of each insight row. */
  costStore?: IReviewCostStore;
}

export interface InsightsCronHandle {
  /** Stop the scheduler. Used by tests + graceful shutdown. */
  stop(): void;
}

/**
 * Start the self-hosted insights rollup scheduler. Returns a handle so
 * tests + graceful-shutdown paths can stop it. Runs the rollup once at
 * startup (delayed by STARTUP_DELAY_MS) and then every
 * INSIGHTS_ROLLUP_INTERVAL_MINUTES (default hourly).
 *
 * Errors inside the rollup are caught by `runInsightRollup` and surfaced
 * via the per-installation failure list — this scheduler also wraps the
 * outer call in try/catch so a catastrophic error in the orchestrator
 * (e.g. store crash) doesn't take down the Node process.
 */
export function startInsightsCron(stores: InsightsCronStores): InsightsCronHandle {
  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  const intervalMs = resolveRollupIntervalMs();

  const runOnce = async () => {
    if (stopped) return;
    try {
      console.log('[fb-e cron] starting insights rollup (every %d min)', intervalMs / 60000);
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
    intervalHandle = setInterval(() => void runOnce(), intervalMs);
  }, STARTUP_DELAY_MS);

  return {
    stop() {
      stopped = true;
      clearTimeout(firstRunTimer);
      if (intervalHandle) clearInterval(intervalHandle);
    },
  };
}
