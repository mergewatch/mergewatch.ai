/**
 * DynamoDB implementation of IInstallationStore.
 *
 * Extracted from src/handlers/review-agent.ts — loadInstallationConfig
 * and loadInstallationSettings functions.
 */

import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { IInstallationStore } from '@mergewatch/core';
import type { InstallationItem, InstallationSettings, OrgCustomAgent, OrgSafetyArea } from '@mergewatch/core';
import { DEFAULT_INSTALLATION_SETTINGS as DEFAULTS, sanitizeOrgCustomAgents, sanitizeOrgSafetyAreas } from '@mergewatch/core';

export class DynamoInstallationStore implements IInstallationStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(installationId: string, repoFullName: string): Promise<InstallationItem | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          installationId,
          repoFullName,
        },
      }),
    );

    return (result.Item as InstallationItem) ?? null;
  }

  async getSettings(installationId: string): Promise<InstallationSettings> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            installationId,
            repoFullName: '#SETTINGS',
          },
        }),
      );

      const saved = (result.Item?.settings ?? {}) as Partial<InstallationSettings>;
      return {
        ...DEFAULTS,
        ...saved,
        commentTypes: { ...DEFAULTS.commentTypes, ...(saved.commentTypes ?? {}) },
        summary: { ...DEFAULTS.summary, ...(saved.summary ?? {}) },
        safetyScore: { ...DEFAULTS.safetyScore!, ...(saved.safetyScore ?? {}) },
      };
    } catch {
      return DEFAULTS;
    }
  }

  async upsert(item: InstallationItem): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );
  }

  /**
   * A missing row is `[]`: no org agents. A read error is thrown (#664) — the
   * review runtimes treat it as a failed review, since reading it as `[]`
   * would silently skip every org policy, blocking ones included.
   */
  async getCustomAgents(installationId: string): Promise<OrgCustomAgent[]> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { installationId, repoFullName: '#AGENTS' },
      }),
    );
    return sanitizeOrgCustomAgents(result.Item?.agents);
  }

  async upsertCustomAgents(installationId: string, agents: OrgCustomAgent[]): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          installationId,
          repoFullName: '#AGENTS',
          agents: sanitizeOrgCustomAgents(agents),
        },
      }),
    );
  }

  /**
   * #718 — a missing row is `[]`. A read error is thrown, like
   * getCustomAgents: the runtime then omits the safety section rather than
   * scoring without the org's areas.
   */
  async getSafetyAreas(installationId: string): Promise<OrgSafetyArea[]> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { installationId, repoFullName: '#SAFETY_AREAS' },
      }),
    );
    return sanitizeOrgSafetyAreas(result.Item?.areas);
  }

  async listInstallationIds(): Promise<string[]> {
    // ProjectionExpression keeps only the PK so the Scan is as cheap as
    // possible. Page until LastEvaluatedKey is absent. Installation
    // counts are bounded (low hundreds at scale) — a Scan beats a GSI
    // for read cost on a once-a-day rollup workload.
    const ids = new Set<string>();
    let cursor: Record<string, unknown> | undefined;
    do {
      const resp = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        ProjectionExpression: 'installationId',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      for (const it of resp.Items ?? []) {
        const id = it.installationId;
        if (typeof id === 'string' || typeof id === 'number') ids.add(String(id));
      }
      cursor = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return Array.from(ids);
  }
}
