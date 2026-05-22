/**
 * Postgres implementation of `IFPInsightStore` (FB-E).
 *
 * Three rows per installation (one per rolling window), replaced
 * idempotently by the nightly rollup job. Reads are page-load critical —
 * the dashboard routes call `listByInstallation(installationId)` once
 * per render to power FB-F..FB-J charts.
 *
 * `disputeRate` is stored as text (same reason `reviews.estimated_cost_usd`
 * is) to avoid float-precision drift across pg float8 ↔ js number when
 * the dashboard compares window-over-window.
 */

import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { IFPInsightStore, InstallationFPInsight } from '@mergewatch/core';
import { installationFpInsights } from './schema.js';

const WINDOW_ORDER: Record<InstallationFPInsight['window'], number> = {
  '7d': 0, '30d': 1, '90d': 2,
};

export class PostgresFPInsightStore implements IFPInsightStore {
  constructor(private db: PostgresJsDatabase) {}

  async upsert(insight: InstallationFPInsight): Promise<void> {
    await this.db
      .insert(installationFpInsights)
      .values({
        installationId: insight.installationId,
        window: insight.window,
        windowStart: insight.windowStart,
        windowEnd: insight.windowEnd,
        generatedAt: insight.generatedAt,
        totalFindingsSurfaced: insight.totalFindingsSurfaced,
        totalDisputes: insight.totalDisputes,
        disputeRate: String(insight.disputeRate),
        totalSilentDrops: insight.totalSilentDrops,
        totalAgreements: insight.totalAgreements,
        perCategory: insight.perCategory as unknown,
        perRepo: insight.perRepo as unknown,
        topClusters: insight.topClusters as unknown,
      })
      .onConflictDoUpdate({
        target: [installationFpInsights.installationId, installationFpInsights.window],
        set: {
          windowStart: insight.windowStart,
          windowEnd: insight.windowEnd,
          generatedAt: insight.generatedAt,
          totalFindingsSurfaced: insight.totalFindingsSurfaced,
          totalDisputes: insight.totalDisputes,
          disputeRate: String(insight.disputeRate),
          totalSilentDrops: insight.totalSilentDrops,
          totalAgreements: insight.totalAgreements,
          perCategory: insight.perCategory as unknown,
          perRepo: insight.perRepo as unknown,
          topClusters: insight.topClusters as unknown,
        },
      });
  }

  async get(installationId: string, window: InstallationFPInsight['window']): Promise<InstallationFPInsight | null> {
    const rows = await this.db
      .select()
      .from(installationFpInsights)
      .where(and(
        eq(installationFpInsights.installationId, installationId),
        eq(installationFpInsights.window, window),
      ));
    if (rows.length === 0) return null;
    return rowToInsight(rows[0]);
  }

  async listByInstallation(installationId: string): Promise<InstallationFPInsight[]> {
    const rows = await this.db
      .select()
      .from(installationFpInsights)
      .where(eq(installationFpInsights.installationId, installationId));
    return rows
      .map(rowToInsight)
      .sort((a, b) => WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window]);
  }
}

function rowToInsight(row: Record<string, unknown>): InstallationFPInsight {
  return {
    installationId: row.installationId as string,
    window: row.window as InstallationFPInsight['window'],
    windowStart: row.windowStart as string,
    windowEnd: row.windowEnd as string,
    generatedAt: row.generatedAt as string,
    totalFindingsSurfaced: Number(row.totalFindingsSurfaced ?? 0),
    totalDisputes: Number(row.totalDisputes ?? 0),
    disputeRate: Number(row.disputeRate ?? 0),
    totalSilentDrops: Number(row.totalSilentDrops ?? 0),
    totalAgreements: Number(row.totalAgreements ?? 0),
    perCategory: (row.perCategory as InstallationFPInsight['perCategory']) ?? {},
    perRepo: (row.perRepo as InstallationFPInsight['perRepo']) ?? {},
    topClusters: (row.topClusters as InstallationFPInsight['topClusters']) ?? [],
  };
}
