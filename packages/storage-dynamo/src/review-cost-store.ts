/**
 * DynamoDB implementation of `IReviewCostStore` (#193).
 *
 * Table shape (created in infra/template.yaml):
 *   PK: installationId
 *   SK: `${repoFullName}#${prNumber}#${commitSha}`  — one row per review run
 *
 * Per-installation partition so the nightly cost rollup reads with a single
 * Query (no Scan), and one row per (repo, PR, commit) so a re-review on a new
 * commit accrues cost while a retried review of the same commit overwrites
 * idempotently. Rows carry a TTL ~90 days past completion — long enough for the
 * 90d window — so the table self-prunes.
 *
 * Best-effort writes: `recordCost` swallows-and-logs so a cost write can never
 * block the review pipeline.
 */

import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IReviewCostStore, ReviewCostRecord } from '@mergewatch/core';

export const DEFAULT_REVIEW_COSTS_TABLE = 'mergewatch-review-costs';

/** Retain rows ~90 days past completion — long enough for the 90d window. */
const TTL_DAYS = 90;

function sk(repoFullName: string, prNumber: number, commitSha: string): string {
  return `${repoFullName}#${prNumber}#${commitSha}`;
}

/** Unix epoch seconds, TTL_DAYS past the given ISO timestamp. */
function ttlFrom(iso: string): number {
  const ms = Date.parse(iso);
  const base = Number.isNaN(ms) ? Date.now() : ms;
  return Math.floor(base / 1000) + TTL_DAYS * 24 * 60 * 60;
}

export class DynamoReviewCostStore implements IReviewCostStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string = DEFAULT_REVIEW_COSTS_TABLE,
  ) {}

  async recordCost(record: ReviewCostRecord): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: record.installationId,
          sk: sk(record.repoFullName, record.prNumber, record.commitSha),
          installationId: record.installationId,
          repoFullName: record.repoFullName,
          prNumber: record.prNumber,
          commitSha: record.commitSha,
          completedAt: record.completedAt,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          // DynamoDB rejects `undefined`; persist null so the unpriced signal
          // round-trips. `removeUndefinedValues` isn't enabled on every client.
          costUsd: record.costUsd ?? null,
          findingCount: record.findingCount,
          ...(record.model ? { model: record.model } : {}),
          ttl: ttlFrom(record.completedAt),
        },
      }));
    } catch (err) {
      // Best-effort: don't interpolate installation / repo / PR identifiers —
      // cost-tracking patterns are business-sensitive in centralized logs. The
      // error carries enough (table, stack) to diagnose a write failure.
      console.warn('[fb-cost] recordCost failed for a review:', err);
    }
  }

  async listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: ReviewCostRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': installationId },
      Limit: limit,
      ...(opts?.cursor ? { ExclusiveStartKey: JSON.parse(opts.cursor) } : {}),
    }));
    const items = (resp.Items ?? []).map(itemToRecord);
    return resp.LastEvaluatedKey
      ? { items, nextCursor: JSON.stringify(resp.LastEvaluatedKey) }
      : { items };
  }
}

function itemToRecord(it: Record<string, unknown>): ReviewCostRecord {
  const r: ReviewCostRecord = {
    installationId: String(it.installationId ?? it.pk ?? ''),
    repoFullName: String(it.repoFullName ?? ''),
    prNumber: Number(it.prNumber ?? 0),
    commitSha: String(it.commitSha ?? ''),
    completedAt: String(it.completedAt ?? ''),
    inputTokens: Number(it.inputTokens ?? 0),
    outputTokens: Number(it.outputTokens ?? 0),
    // null (unpriced) must survive the round-trip — only coerce a genuine
    // number; leave null/absent as null.
    costUsd: it.costUsd == null ? null : Number(it.costUsd),
    findingCount: Number(it.findingCount ?? 0),
  };
  if (it.model) r.model = String(it.model);
  return r;
}
