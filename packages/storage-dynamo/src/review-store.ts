/**
 * DynamoDB implementation of IReviewStore.
 *
 * Extracted from src/handlers/review-agent.ts — upsertReviewRecord,
 * updateReviewStatus, and QueryCommand calls.
 */

import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { IReviewStore } from '@mergewatch/core';
import type { ReviewItem, ReviewStatus } from '@mergewatch/core';

export class DynamoReviewStore implements IReviewStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async upsert(review: ReviewItem): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: review,
      }),
    );
  }

  async claimReview(review: ReviewItem): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...review, status: 'in_progress' },
          // #355 — 'pending' is claimable: a throttled review is parked back
          // at 'pending' before the retry redelivers, and the retry must be
          // able to re-claim it. 'in_progress' stays unclaimable (dedup).
          ConditionExpression:
            'attribute_not_exists(repoFullName) OR #s IN (:failed, :skipped, :complete, :pending)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':failed': 'failed',
            ':skipped': 'skipped',
            ':complete': 'complete',
            ':pending': 'pending',
          },
        }),
      );
      return true;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  }

  async updateStatus(
    repoFullName: string,
    prNumberCommitSha: string,
    status: ReviewStatus,
    extra: Partial<Omit<ReviewItem, 'repoFullName' | 'prNumberCommitSha' | 'status' | 'createdAt'>> = {},
  ): Promise<void> {
    const updateParts: string[] = ['#s = :status'];
    const names: Record<string, string> = { '#s': 'status' };
    const values: Record<string, unknown> = { ':status': status };

    // Dynamically add all extra fields to the update expression.
    // Reserved words (model, status) use expression attribute names.
    const reserved = new Set(['model', 'status']);
    let idx = 0;
    for (const [key, val] of Object.entries(extra)) {
      if (val === undefined) continue;
      idx++;
      const alias = `v${idx}`;
      if (reserved.has(key)) {
        const nameAlias = `#n${idx}`;
        names[nameAlias] = key;
        updateParts.push(`${nameAlias} = :${alias}`);
      } else {
        updateParts.push(`${key} = :${alias}`);
      }
      values[`:${alias}`] = val;
    }

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { repoFullName, prNumberCommitSha },
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async queryByPR(repoFullName: string, prPrefix: string, limit = 5): Promise<ReviewItem[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'repoFullName = :repo AND begins_with(prNumberCommitSha, :pr)',
        ExpressionAttributeValues: {
          ':repo': repoFullName,
          ':pr': prPrefix,
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );

    return (result.Items ?? []) as ReviewItem[];
  }
}
