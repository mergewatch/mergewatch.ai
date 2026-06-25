import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { IInstallationStore, InstallationItem, InstallationSettings, OrgCustomAgent } from '@mergewatch/core';
import { DEFAULT_INSTALLATION_SETTINGS, sanitizeOrgCustomAgents } from '@mergewatch/core';
import { installations, installationSettings } from './schema.js';

export class PostgresInstallationStore implements IInstallationStore {
  constructor(private db: PostgresJsDatabase) {}

  async get(installationId: string, repoFullName: string): Promise<InstallationItem | null> {
    const rows = await this.db
      .select()
      .from(installations)
      .where(and(
        eq(installations.installationId, installationId),
        eq(installations.repoFullName, repoFullName),
      ))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      installationId: row.installationId,
      repoFullName: row.repoFullName,
      installedAt: row.installedAt,
      config: row.config as any,
      ...(row.modelId ? { modelId: row.modelId } : {}),
      monitored: row.monitored,
    };
  }

  async getSettings(installationId: string): Promise<InstallationSettings> {
    const rows = await this.db
      .select()
      .from(installationSettings)
      .where(eq(installationSettings.installationId, installationId))
      .limit(1);
    if (rows.length === 0) return { ...DEFAULT_INSTALLATION_SETTINGS };
    const row = rows[0];
    return {
      severityThreshold: row.severityThreshold as InstallationSettings['severityThreshold'],
      commentTypes: row.commentTypes as InstallationSettings['commentTypes'],
      maxComments: row.maxComments,
      summary: row.summary as InstallationSettings['summary'],
      customInstructions: row.customInstructions,
      commentHeader: row.commentHeader,
    };
  }

  async upsert(item: InstallationItem): Promise<void> {
    await this.db
      .insert(installations)
      .values({
        installationId: item.installationId,
        repoFullName: item.repoFullName,
        installedAt: item.installedAt,
        config: item.config as any,
        modelId: item.modelId ?? null,
        monitored: item.monitored ?? true,
      })
      .onConflictDoUpdate({
        target: [installations.installationId, installations.repoFullName],
        set: {
          installedAt: item.installedAt,
          config: item.config as any,
          modelId: item.modelId ?? null,
          monitored: item.monitored ?? true,
        },
      });
  }

  async getCustomAgents(installationId: string): Promise<OrgCustomAgent[]> {
    const rows = await this.db
      .select({ customAgents: installationSettings.customAgents })
      .from(installationSettings)
      .where(eq(installationSettings.installationId, installationId))
      .limit(1);
    if (rows.length === 0) return [];
    return sanitizeOrgCustomAgents(rows[0].customAgents);
  }

  async upsertCustomAgents(installationId: string, agents: OrgCustomAgent[]): Promise<void> {
    const sanitized = sanitizeOrgCustomAgents(agents);
    // The other settings columns are NOT NULL with defaults, so a bare insert
    // creates a valid settings row when one doesn't exist yet.
    await this.db
      .insert(installationSettings)
      .values({ installationId, customAgents: sanitized as any })
      .onConflictDoUpdate({
        target: installationSettings.installationId,
        set: { customAgents: sanitized as any },
      });
  }

  async listInstallationIds(): Promise<string[]> {
    // Composite PK includes (installation_id, repo_full_name) so the same
    // installation appears N times — one per monitored repo. DISTINCT
    // gives us each installation once. Bounded result set (we're well
    // under the 1k row limit even at SaaS scale).
    const rows = await this.db
      .selectDistinct({ installationId: installations.installationId })
      .from(installations);
    return rows.map((r) => r.installationId);
  }
}
