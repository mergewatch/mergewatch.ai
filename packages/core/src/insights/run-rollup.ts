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
  IPRLifecycleStore,
  ISatisfactionStore,
} from '../storage/types.js';
import type {
  FindingDispositionRecord,
  InstallationFPInsight,
  PRLifecycleRecord,
  HelpfulVoteRecord,
  NpsResponseRecord,
} from '../types/db.js';
import { buildInsightFromDispositions } from './rollup.js';
import { buildCycleTimeInsight } from './cycle-time.js';
import { buildEngagementInsight } from './engagement.js';

const WINDOWS: InstallationFPInsight['window'][] = ['7d', '30d', '90d'];

export interface RollupStores {
  installationStore: Pick<IInstallationStore, 'listInstallationIds'>;
  dispositionStore: Pick<IFindingDispositionStore, 'listByInstallation'>;
  fpInsightStore: Pick<IFPInsightStore, 'upsert'>;
  /**
   * TTM (#194) — optional. When wired, each insight row gains a `cycleTime`
   * block built from this installation's PR-lifecycle records. When absent
   * (e.g. a deploy that hasn't provisioned the table yet) the rollup behaves
   * exactly as before and `cycleTime` stays undefined.
   */
  prLifecycleStore?: Pick<IPRLifecycleStore, 'listByInstallation'>;
  /**
   * #195 Tier 2 — optional. When wired, each insight row's `engagement` block
   * gains the explicit-satisfaction signals (helpful 👍/👎 rate + NPS) built
   * from this installation's helpful-vote and NPS-response rows. When absent
   * those fields read `0` / `null` and the rollup behaves exactly as in Phase
   * 1–3.
   */
  satisfactionStore?: Pick<ISatisfactionStore, 'listHelpfulVotes' | 'listNpsResponses'>;
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

  // Re-throw on catastrophic enumeration failure so the operator sees it:
  //   • Lambda → throws → invocation marked failed → CloudWatch alarm.
  //   • Self-hosted cron → outer try/catch in `runOnce` swallows + logs.
  // The PRIOR behaviour returned [] which made a complete failure look
  // identical to "no installations to process" — invisible to ops.
  let installationIds: string[];
  try {
    installationIds = await stores.installationStore.listInstallationIds();
  } catch (err) {
    console.warn('[fb-e] listInstallationIds failed; rollup aborted:', err);
    throw err;
  }

  for (const installationId of installationIds) {
    try {
      // Page through every disposition record for this installation. Earlier
      // versions stopped after the first 1000-row page — fine for typical
      // installations but a silent truncation hazard for the long tail.
      // Cursor pagination keeps us correct across any record volume; each
      // page is bounded by the store's `limit` so memory stays predictable.
      const records: FindingDispositionRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await stores.dispositionStore.listByInstallation(installationId, { limit: 1000, cursor });
        records.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);

      // TTM (#194) — page the PR-lifecycle rows the same way (when the store
      // is wired). Same cursor-pagination discipline so we never silently
      // truncate a high-volume installation.
      const prRecords: PRLifecycleRecord[] = [];
      if (stores.prLifecycleStore) {
        let prCursor: string | undefined;
        do {
          const page = await stores.prLifecycleStore.listByInstallation(installationId, { limit: 1000, cursor: prCursor });
          prRecords.push(...page.items);
          prCursor = page.nextCursor;
        } while (prCursor);
      }

      // #195 Tier 2 — page helpful-vote + NPS rows when the satisfaction store
      // is wired. Same cursor discipline; left empty otherwise so the Tier-2
      // engagement fields read 0 / null.
      const helpfulVotes: HelpfulVoteRecord[] = [];
      const npsResponses: NpsResponseRecord[] = [];
      if (stores.satisfactionStore) {
        let hvCursor: string | undefined;
        do {
          const page = await stores.satisfactionStore.listHelpfulVotes(installationId, { limit: 1000, cursor: hvCursor });
          helpfulVotes.push(...page.items);
          hvCursor = page.nextCursor;
        } while (hvCursor);
        let npsCursor: string | undefined;
        do {
          const page = await stores.satisfactionStore.listNpsResponses(installationId, { limit: 1000, cursor: npsCursor });
          npsResponses.push(...page.items);
          npsCursor = page.nextCursor;
        } while (npsCursor);
      }

      for (const window of WINDOWS) {
        const insight = buildInsightFromDispositions(installationId, window, windowEndIso, records);
        if (stores.prLifecycleStore) {
          insight.cycleTime = buildCycleTimeInsight(window, windowEndIso, prRecords);
        }
        // #195 — engagement always computes: it only needs the (mandatory)
        // disposition records; PR-lifecycle records refine the re-review KPIs
        // and satisfaction records add the Tier-2 helpful/NPS signals when
        // their stores are wired (empty otherwise).
        insight.engagement = buildEngagementInsight(window, windowEndIso, records, prRecords, {
          helpfulVotes,
          npsResponses,
        });
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
