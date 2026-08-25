/**
 * DynamoDB implementation of `IReviewTraceStore` (#471).
 *
 * Table shape (created in infra/template.yaml):
 *   PK: repoFullName
 *   SK: prNumberCommitSha   — the SAME key as the review it describes
 *
 * A separate table, not a suffixed sort key on the reviews table. `queryByPR`
 * matches `begins_with(prNumberCommitSha, "42#")`, so a row keyed
 * `42#abc123#TRACE` comes back as if it were a review — and every call site
 * passes a small `limit`, so trace rows could evict real reviews from the
 * previous-review lookup feeding `previousFindings`, the delta and FP-B.
 * Sharing the key space is a correctness bug, not a style choice. The separate
 * table also sidesteps Dynamo's 400KB item cap.
 *
 * Rows carry a 30-day TTL (set by buildReviewTrace) — shorter than a review,
 * because this is a debugging and trust artifact rather than a system of
 * record.
 */

import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IReviewTraceStore, ReviewTraceItem } from '@mergewatch/core';

export const DEFAULT_REVIEW_TRACES_TABLE = 'mergewatch-review-traces';

export class DynamoReviewTraceStore implements IReviewTraceStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string = DEFAULT_REVIEW_TRACES_TABLE,
  ) {}

  async put(trace: ReviewTraceItem): Promise<void> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: trace }),
    );
  }

  async get(
    repoFullName: string,
    prNumberCommitSha: string,
  ): Promise<ReviewTraceItem | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { repoFullName, prNumberCommitSha },
      }),
    );
    return (result.Item as ReviewTraceItem | undefined) ?? null;
  }
}
