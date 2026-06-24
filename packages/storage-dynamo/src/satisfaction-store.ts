/**
 * DynamoDB implementation of `ISatisfactionStore` (#195 Tier 2 / Phase 4 + 5).
 *
 * Single table, partitioned by installation so both the nightly rollup
 * (`listHelpfulVotes` / `listNpsResponses`) and the dashboard NPS route
 * (`getNpsResponse`) hit it with a Query, never a Scan:
 *   PK: installationId
 *   SK: `HV#${repoFullName}#${prNumber}`  — one helpful-vote row per summary comment
 *       `NPS#${githubUserId}`             — one NPS row per admin (latest-wins)
 *
 * Best-effort writes: every method swallows-and-logs on failure so a
 * satisfaction write can never block a review or a dashboard render.
 */

import {
  DynamoDBDocumentClient,
  UpdateCommand,
  PutCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  ISatisfactionStore,
  HelpfulVoteRecord,
  NpsResponseRecord,
} from '@mergewatch/core';

export const DEFAULT_SATISFACTION_TABLE = 'mergewatch-satisfaction';

const HV_PREFIX = 'HV#';
const NPS_PREFIX = 'NPS#';

function helpfulSk(repoFullName: string, prNumber: number): string {
  return `${HV_PREFIX}${repoFullName}#${prNumber}`;
}

function npsSk(githubUserId: string): string {
  return `${NPS_PREFIX}${githubUserId}`;
}

export class DynamoSatisfactionStore implements ISatisfactionStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string = DEFAULT_SATISFACTION_TABLE,
  ) {}

  async recordHelpfulVotes(
    installationId: string,
    repoFullName: string,
    prNumber: number,
    delta: { up?: number; down?: number },
    atIso: string,
  ): Promise<void> {
    const up = delta.up ?? 0;
    const down = delta.down ?? 0;
    if (up === 0 && down === 0) return;
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: installationId, sk: helpfulSk(repoFullName, prNumber) },
        UpdateExpression:
          'SET up = if_not_exists(up, :zero) + :u, ' +
          'down = if_not_exists(down, :zero) + :d, ' +
          'lastVoteAt = :at, repoFullName = :repo, prNumber = :pr',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':u': up,
          ':d': down,
          ':at': atIso,
          ':repo': repoFullName,
          ':pr': prNumber,
        },
      }));
    } catch (err) {
      console.warn('[fb-k] recordHelpfulVotes failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async listHelpfulVotes(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: HelpfulVoteRecord[]; nextCursor?: string }> {
    return this.queryPrefix(installationId, HV_PREFIX, opts, itemToHelpful);
  }

  async getNpsResponse(installationId: string, githubUserId: string): Promise<NpsResponseRecord | null> {
    try {
      const resp = await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: { pk: installationId, sk: npsSk(githubUserId) },
      }));
      return resp.Item ? itemToNps(resp.Item) : null;
    } catch (err) {
      console.warn('[fb-l] getNpsResponse failed (%s/%s):', installationId, githubUserId, err);
      return null;
    }
  }

  async recordNpsResponse(rec: NpsResponseRecord): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: rec.installationId,
          sk: npsSk(rec.githubUserId),
          installationId: rec.installationId,
          githubUserId: rec.githubUserId,
          score: rec.score,
          respondedAt: rec.respondedAt,
        },
      }));
    } catch (err) {
      console.warn('[fb-l] recordNpsResponse failed (%s/%s):', rec.installationId, rec.githubUserId, err);
    }
  }

  async listNpsResponses(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: NpsResponseRecord[]; nextCursor?: string }> {
    return this.queryPrefix(installationId, NPS_PREFIX, opts, itemToNps);
  }

  /** Shared Query-by-SK-prefix with cursor pagination. */
  private async queryPrefix<T>(
    installationId: string,
    prefix: string,
    opts: { limit?: number; cursor?: string } | undefined,
    decode: (it: Record<string, unknown>) => T,
  ): Promise<{ items: T[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': installationId, ':prefix': prefix },
      Limit: limit,
      ...(opts?.cursor ? { ExclusiveStartKey: JSON.parse(opts.cursor) } : {}),
    }));
    const items = (resp.Items ?? []).map(decode);
    return resp.LastEvaluatedKey
      ? { items, nextCursor: JSON.stringify(resp.LastEvaluatedKey) }
      : { items };
  }
}

function itemToHelpful(it: Record<string, unknown>): HelpfulVoteRecord {
  return {
    installationId: String(it.pk ?? ''),
    repoFullName: String(it.repoFullName ?? ''),
    prNumber: Number(it.prNumber ?? 0),
    up: Number(it.up ?? 0),
    down: Number(it.down ?? 0),
    lastVoteAt: String(it.lastVoteAt ?? ''),
  };
}

function itemToNps(it: Record<string, unknown>): NpsResponseRecord {
  return {
    installationId: String(it.installationId ?? it.pk ?? ''),
    githubUserId: String(it.githubUserId ?? ''),
    score: Number(it.score ?? 0),
    respondedAt: String(it.respondedAt ?? ''),
  };
}
