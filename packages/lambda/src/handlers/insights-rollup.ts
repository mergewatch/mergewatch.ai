/**
 * FB-E — scheduled Lambda that runs the nightly insight rollup across
 * every installation. Triggered by an EventBridge rule (see
 * infra/template.yaml `InsightsRollupScheduleRule`). Runs unattended;
 * the only observability is CloudWatch logs.
 *
 * Re-uses the shared `runInsightRollup` orchestrator from
 * `@mergewatch/core`. This handler is intentionally thin — it wires
 * stores, runs the rollup, logs the result, returns. No business logic.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { runInsightRollup } from '@mergewatch/core';
import {
  DynamoInstallationStore,
  DynamoFindingDispositionStore,
  DynamoFPInsightStore,
  DEFAULT_FINDING_DISPOSITIONS_TABLE,
  DEFAULT_FP_INSIGHTS_TABLE,
} from '@mergewatch/storage-dynamo';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INSTALLATIONS_TABLE = process.env.INSTALLATIONS_TABLE ?? 'mergewatch-installations';
const FINDING_DISPOSITIONS_TABLE = process.env.FINDING_DISPOSITIONS_TABLE ?? DEFAULT_FINDING_DISPOSITIONS_TABLE;
const FP_INSIGHTS_TABLE = process.env.FP_INSIGHTS_TABLE ?? DEFAULT_FP_INSIGHTS_TABLE;

const installationStore = new DynamoInstallationStore(dynamodb, INSTALLATIONS_TABLE);
const dispositionStore = new DynamoFindingDispositionStore(dynamodb, FINDING_DISPOSITIONS_TABLE);
const fpInsightStore = new DynamoFPInsightStore(dynamodb, FP_INSIGHTS_TABLE);

export async function handler(): Promise<{ statusCode: number; body: string }> {
  console.log('[fb-e] insights rollup starting');
  const result = await runInsightRollup({
    installationStore,
    dispositionStore,
    fpInsightStore,
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
