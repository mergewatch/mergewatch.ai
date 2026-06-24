/**
 * FB-E — scheduled Lambda that runs the nightly insight rollup across
 * every installation. Triggered by an EventBridge schedule attached to
 * the `InsightsRollupFunction` itself (see `Events.NightlyRollup` in
 * `infra/template.yaml`). Runs unattended; the only observability is
 * CloudWatch logs + the Lambda invocation status (200 / 207 / failed).
 *
 * Re-uses the shared `runInsightRollup` orchestrator from
 * `@mergewatch/core`. This handler is intentionally thin — it wires
 * stores, runs the rollup, logs the result, returns. No business logic.
 *
 * Error semantics:
 *   • Per-installation failures isolated by the orchestrator → 207
 *     Multi-Status return; CloudWatch can alarm on non-200.
 *   • CATASTROPHIC enumeration failure (listInstallationIds) → the
 *     orchestrator re-throws by design (see PR #169 review thread). We
 *     intentionally do NOT wrap that in try/catch here: a thrown
 *     exception fails the Lambda invocation, which is the strongest
 *     possible signal to CloudWatch / on-call. Adding a catch here
 *     would re-introduce the visibility gap MW's own round-1 review
 *     asked us to fix.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { runInsightRollup } from '@mergewatch/core';
import {
  DynamoInstallationStore,
  DynamoFindingDispositionStore,
  DynamoFPInsightStore,
  DynamoPRLifecycleStore,
  DynamoSatisfactionStore,
  DEFAULT_FINDING_DISPOSITIONS_TABLE,
  DEFAULT_FP_INSIGHTS_TABLE,
  DEFAULT_PR_LIFECYCLE_TABLE,
  DEFAULT_SATISFACTION_TABLE,
} from '@mergewatch/storage-dynamo';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INSTALLATIONS_TABLE = process.env.INSTALLATIONS_TABLE ?? 'mergewatch-installations';
const FINDING_DISPOSITIONS_TABLE = process.env.FINDING_DISPOSITIONS_TABLE ?? DEFAULT_FINDING_DISPOSITIONS_TABLE;
const FP_INSIGHTS_TABLE = process.env.FP_INSIGHTS_TABLE ?? DEFAULT_FP_INSIGHTS_TABLE;
const PR_LIFECYCLE_TABLE = process.env.PR_LIFECYCLE_TABLE ?? DEFAULT_PR_LIFECYCLE_TABLE;
const SATISFACTION_TABLE = process.env.SATISFACTION_TABLE ?? DEFAULT_SATISFACTION_TABLE;

const installationStore = new DynamoInstallationStore(dynamodb, INSTALLATIONS_TABLE);
const dispositionStore = new DynamoFindingDispositionStore(dynamodb, FINDING_DISPOSITIONS_TABLE);
const fpInsightStore = new DynamoFPInsightStore(dynamodb, FP_INSIGHTS_TABLE);
// TTM (#194) — feeds the cycle-time block of each insight row.
const prLifecycleStore = new DynamoPRLifecycleStore(dynamodb, PR_LIFECYCLE_TABLE);
// #195 Tier 2 — feeds the helpful-rate + NPS fields of each engagement block.
const satisfactionStore = new DynamoSatisfactionStore(dynamodb, SATISFACTION_TABLE);

export async function handler(): Promise<{ statusCode: number; body: string }> {
  console.log('[fb-e] insights rollup starting');
  const result = await runInsightRollup({
    installationStore,
    dispositionStore,
    fpInsightStore,
    prLifecycleStore,
    satisfactionStore,
  });
  console.log(
    '[fb-e] rollup complete — processed=%d, rows=%d, failed=[%s], elapsed=%dms, windowEnd=%s',
    result.installationsProcessed,
    result.rowsWritten,
    result.installationsFailed.join(', '),
    result.elapsedMs,
    result.windowEnd,
  );
  if (result.installationsFailed.length > 0) {
    // Soft-fail: return non-200 so EventBridge / CloudWatch can alarm
    // on the metric, but don't throw — partial success is preserved.
    return {
      statusCode: 207,
      body: JSON.stringify(result),
    };
  }
  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
}
