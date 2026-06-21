/**
 * DynamoDB implementation of `IFPInsightStore` (FB-E).
 *
 * Table shape (created in infra/template.yaml):
 *   PK: installationId   (String)
 *   SK: window           (String — '7d' | '30d' | '90d')
 *
 * Three rows per installation, replaced idempotently by the nightly
 * rollup. Reads are page-load critical (dashboard FB-F..FB-J) — a single
 * Query against the PK returns all three windows in one round trip.
 */

import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IFPInsightStore, InstallationFPInsight } from '@mergewatch/core';

export const DEFAULT_FP_INSIGHTS_TABLE = 'mergewatch-installation-fp-insights';

const WINDOW_ORDER: Record<InstallationFPInsight['window'], number> = {
  '7d': 0, '30d': 1, '90d': 2,
};

export class DynamoFPInsightStore implements IFPInsightStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string = DEFAULT_FP_INSIGHTS_TABLE,
  ) {}

  async upsert(insight: InstallationFPInsight): Promise<void> {
    // Put replaces the entire row on every nightly run — idempotent by
    // design. No UpdateExpression needed since we own every attribute.
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        installationId: insight.installationId,
        window: insight.window,
        windowStart: insight.windowStart,
        windowEnd: insight.windowEnd,
        generatedAt: insight.generatedAt,
        totalFindingsSurfaced: insight.totalFindingsSurfaced,
        totalDisputes: insight.totalDisputes,
        // Stored as string for parity with the postgres shape (avoids
        // float-precision drift across re-reads); coerced back in get/list.
        disputeRate: String(insight.disputeRate),
        totalSilentDrops: insight.totalSilentDrops,
        totalAgreements: insight.totalAgreements,
        perCategory: insight.perCategory,
        perSeverity: insight.perSeverity ?? {},
        perRepo: insight.perRepo,
        topClusters: insight.topClusters,
        // TTM (#194) — null (not undefined) when absent: DynamoDB rejects
        // undefined attribute values, and null round-trips back to undefined.
        cycleTime: insight.cycleTime ?? null,
        // #195 — engagement block; same null-not-undefined discipline.
        engagement: insight.engagement ?? null,
      },
    }));
  }

  async get(installationId: string, window: InstallationFPInsight['window']): Promise<InstallationFPInsight | null> {
    const resp = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { installationId, window },
    }));
    return resp.Item ? itemToInsight(resp.Item) : null;
  }

  async listByInstallation(installationId: string): Promise<InstallationFPInsight[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'installationId = :id',
      ExpressionAttributeValues: { ':id': installationId },
    }));
    const items = (resp.Items ?? []).map(itemToInsight);
    items.sort((a, b) => WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window]);
    return items;
  }
}

function itemToInsight(it: Record<string, unknown>): InstallationFPInsight {
  return {
    installationId: String(it.installationId ?? ''),
    window: it.window as InstallationFPInsight['window'],
    windowStart: String(it.windowStart ?? ''),
    windowEnd: String(it.windowEnd ?? ''),
    generatedAt: String(it.generatedAt ?? ''),
    totalFindingsSurfaced: Number(it.totalFindingsSurfaced ?? 0),
    totalDisputes: Number(it.totalDisputes ?? 0),
    disputeRate: Number(it.disputeRate ?? 0),
    totalSilentDrops: Number(it.totalSilentDrops ?? 0),
    totalAgreements: Number(it.totalAgreements ?? 0),
    perCategory: (it.perCategory as InstallationFPInsight['perCategory']) ?? {},
    perSeverity: (it.perSeverity as InstallationFPInsight['perSeverity']) ?? {},
    perRepo: (it.perRepo as InstallationFPInsight['perRepo']) ?? {},
    topClusters: (it.topClusters as InstallationFPInsight['topClusters']) ?? [],
    // TTM (#194) — absent on pre-Stage-2 rows; null coerces back to undefined.
    ...(it.cycleTime ? { cycleTime: it.cycleTime as InstallationFPInsight['cycleTime'] } : {}),
    // #195 — absent on pre-engagement rows; null coerces back to undefined.
    ...(it.engagement ? { engagement: it.engagement as InstallationFPInsight['engagement'] } : {}),
  };
}
