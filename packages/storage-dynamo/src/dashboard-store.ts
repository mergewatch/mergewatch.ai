/**
 * DynamoDB implementation of IDashboardStore.
 *
 * Logic extracted from dashboard API routes (packages/dashboard/app/api/).
 * This is a code move — same DynamoDB queries, now behind the dashboard interface.
 */

import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  IDashboardStore,
  IDashboardInstallationStore,
  IDashboardReviewStore,
  PaginatedResult,
  ReviewStats,
  RepoStats,
  InstallationItem,
  InstallationSettings,
  ReviewItem,
  OrgCustomAgent,
} from '@mergewatch/core';
import { DEFAULT_INSTALLATION_SETTINGS as DEFAULTS, sanitizeOrgCustomAgents } from '@mergewatch/core';

// ─── Installation store ─────────────────────────────────────────────────────

class DynamoDashboardInstallationStore implements IDashboardInstallationStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async listByInstallation(installationId: string): Promise<InstallationItem[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'installationId = :iid',
        ExpressionAttributeValues: { ':iid': installationId },
      }),
    );
    // Filter out the sentinel rows (#SETTINGS, #AGENTS) — they aren't repos.
    return ((result.Items ?? []) as InstallationItem[]).filter(
      (item) => item.repoFullName !== '#SETTINGS' && item.repoFullName !== '#AGENTS',
    );
  }

  async getSettings(installationId: string): Promise<InstallationSettings> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { installationId, repoFullName: '#SETTINGS' },
        }),
      );

      const saved = (result.Item?.settings ?? {}) as Partial<InstallationSettings>;
      return {
        ...DEFAULTS,
        ...saved,
        commentTypes: { ...DEFAULTS.commentTypes, ...(saved.commentTypes ?? {}) },
        summary: { ...DEFAULTS.summary, ...(saved.summary ?? {}) },
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async updateSettings(installationId: string, settings: InstallationSettings): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { installationId, repoFullName: '#SETTINGS' },
        UpdateExpression: 'SET settings = :settings, updatedAt = :now',
        ExpressionAttributeValues: {
          ':settings': settings,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }

  async getCustomAgents(installationId: string): Promise<OrgCustomAgent[]> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { installationId, repoFullName: '#AGENTS' },
        }),
      );
      return sanitizeOrgCustomAgents(result.Item?.agents);
    } catch (err) {
      console.error('[dashboard-store] getCustomAgents failed:', err);
      return [];
    }
  }

  async updateCustomAgents(installationId: string, agents: OrgCustomAgent[]): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          installationId,
          repoFullName: '#AGENTS',
          agents: sanitizeOrgCustomAgents(agents),
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

}

// ─── Review store ───────────────────────────────────────────────────────────

class DynamoDashboardReviewStore implements IDashboardReviewStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async listReviews(
    repos: string[],
    limit: number,
    cursor?: string,
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PaginatedResult<ReviewItem>> {
    // Decode cursor: { keys: { [repo]: LastEvaluatedKey }, exhausted: string[] }
    let cursorState: {
      keys: Record<string, Record<string, unknown>>;
      exhausted: string[];
    } = { keys: {}, exhausted: [] };

    if (cursor) {
      try {
        cursorState = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        // Invalid cursor — start fresh
      }
    }

    const allReviews: Record<string, unknown>[] = [];
    const nextCursorState: typeof cursorState = {
      keys: {},
      exhausted: [...cursorState.exhausted],
    };

    for (const repoFullName of repos) {
      if (cursorState.exhausted.includes(repoFullName)) continue;

      const params: Record<string, unknown> = {
        TableName: this.tableName,
        KeyConditionExpression: 'repoFullName = :repo',
        ExpressionAttributeValues: { ':repo': repoFullName } as Record<string, unknown>,
        ScanIndexForward: false,
        Limit: limit,
      };

      const filterParts: string[] = [];

      if (status) {
        filterParts.push('#s = :status');
        if (!params.ExpressionAttributeNames) params.ExpressionAttributeNames = {};
        (params.ExpressionAttributeNames as Record<string, string>)['#s'] = 'status';
        (params.ExpressionAttributeValues as Record<string, unknown>)[':status'] =
          status === 'completed' ? 'complete' : status;
      }

      if (startDate) {
        filterParts.push('createdAt >= :startDate');
        (params.ExpressionAttributeValues as Record<string, unknown>)[':startDate'] = startDate;
      }
      if (endDate) {
        filterParts.push('createdAt <= :endDate');
        (params.ExpressionAttributeValues as Record<string, unknown>)[':endDate'] = endDate;
      }

      if (filterParts.length > 0) {
        params.FilterExpression = filterParts.join(' AND ');
      }

      if (cursorState.keys[repoFullName]) {
        params.ExclusiveStartKey = cursorState.keys[repoFullName];
      }

      const result = await this.client.send(new QueryCommand(params as any));
      allReviews.push(...(result.Items ?? []));

      if (result.LastEvaluatedKey) {
        nextCursorState.keys[repoFullName] = result.LastEvaluatedKey as Record<string, unknown>;
      } else {
        nextCursorState.exhausted.push(repoFullName);
      }
    }

    // Sort all results by createdAt descending
    allReviews.sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    );

    const paged = allReviews.slice(0, limit) as unknown as ReviewItem[];

    const hasMore =
      allReviews.length > limit ||
      Object.keys(nextCursorState.keys).length > 0 ||
      nextCursorState.exhausted.length < repos.length;

    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify(nextCursorState)).toString('base64url')
      : null;

    return { items: paged, nextCursor };
  }

  async getReview(repoFullName: string, prNumberCommitSha: string): Promise<ReviewItem | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { repoFullName, prNumberCommitSha },
      }),
    );
    return (result.Item as ReviewItem) ?? null;
  }

  async updateFeedback(
    repoFullName: string,
    prNumberCommitSha: string,
    feedback: 'up' | 'down' | null,
  ): Promise<void> {
    if (feedback === null) {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { repoFullName, prNumberCommitSha },
          UpdateExpression: 'REMOVE feedback',
        }),
      );
    } else {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { repoFullName, prNumberCommitSha },
          UpdateExpression: 'SET feedback = :fb',
          ExpressionAttributeValues: { ':fb': feedback },
        }),
      );
    }
  }

  async getReviewStats(repos: string[]): Promise<ReviewStats> {
    let total = 0;
    let completed = 0;
    let findings = 0;

    const promises = repos.map(async (repoFullName) => {
      try {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'repoFullName = :repo',
            ExpressionAttributeValues: { ':repo': repoFullName },
            ProjectionExpression: '#s, findingCount',
            ExpressionAttributeNames: { '#s': 'status' },
          }),
        );
        for (const item of result.Items ?? []) {
          total++;
          if (item.status === 'complete') completed++;
          if (typeof item.findingCount === 'number') findings += item.findingCount;
        }
      } catch {
        // skip
      }
    });
    await Promise.all(promises);

    return { total, completed, findings };
  }

  async getRepoStats(repos: string[]): Promise<Map<string, RepoStats>> {
    const statsMap = new Map<string, RepoStats>();

    const promises = repos.map(async (repoFullName) => {
      try {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'repoFullName = :repo',
            ExpressionAttributeValues: { ':repo': repoFullName },
            ScanIndexForward: false,
            Limit: 100,
          }),
        );

        let reviewCount = 0;
        let issueCount = 0;
        let lastReviewedAt: string | null = null;

        for (const item of result.Items ?? []) {
          if (item.status === 'complete') {
            reviewCount++;
            if (!lastReviewedAt) {
              lastReviewedAt =
                (item.completedAt as string) ?? (item.createdAt as string) ?? null;
            }
            const fc = item.findingCount;
            if (typeof fc === 'number') issueCount += fc;
          }
        }

        if (reviewCount > 0) {
          statsMap.set(repoFullName, { reviewCount, issueCount, lastReviewedAt });
        }
      } catch {
        // skip
      }
    });

    await Promise.all(promises);
    return statsMap;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface DynamoDashboardStoreOptions {
  installationsTable: string;
  reviewsTable: string;
  region?: string;
  /**
   * FB-F..FB-J — optional. When set, the dashboard store exposes an
   * `fpInsights` member backed by the named table. When unset the
   * dashboard chart routes render zero-state (no table provisioned).
   */
  fpInsightsTable?: string;
  /**
   * #195 Phase 5 — optional. When set, the dashboard store exposes a
   * `satisfaction` member backed by the named table (NPS read/write). When
   * unset the NPS route reports "ineligible" and never prompts.
   */
  satisfactionTable?: string;
}

export function createDynamoDashboardStore(options: DynamoDashboardStoreOptions): IDashboardStore {
  // Lazy-import to avoid pulling AWS SDK at module scope for non-DynamoDB callers.
  // The client is created once per factory call.
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  const { DynamoFPInsightStore } = require('./fp-insight-store.js');
  const { DynamoSatisfactionStore } = require('./satisfaction-store.js');

  const raw = new DynamoDBClient({ region: options.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });

  // FB-F..FB-J — the FP insight store implements both the pipeline
  // `IFPInsightStore` (upsert / get) AND the dashboard surface
  // (listByInstallation), so we just hand the same instance to the
  // dashboard layer. The dashboard only calls listByInstallation —
  // upsert is never exercised from this path.
  const fpInsights = options.fpInsightsTable
    ? new DynamoFPInsightStore(client, options.fpInsightsTable)
    : undefined;

  // #195 Phase 5 — the satisfaction store implements the full pipeline
  // `ISatisfactionStore`; the dashboard only calls getNpsResponse /
  // recordNpsResponse (the `IDashboardSatisfactionStore` subset).
  const satisfaction = options.satisfactionTable
    ? new DynamoSatisfactionStore(client, options.satisfactionTable)
    : undefined;

  return {
    installations: new DynamoDashboardInstallationStore(client, options.installationsTable),
    reviews: new DynamoDashboardReviewStore(client, options.reviewsTable),
    ...(fpInsights ? { fpInsights } : {}),
    ...(satisfaction ? { satisfaction } : {}),
  };
}
