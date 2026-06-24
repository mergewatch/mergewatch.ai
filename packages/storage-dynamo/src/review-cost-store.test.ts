import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoReviewCostStore } from './review-cost-store.js';
import type { ReviewCostRecord } from '@mergewatch/core';

const TABLE = 'test-review-costs';

function makeClient(response: unknown = {}) {
  return { send: vi.fn().mockResolvedValue(response) } as any;
}

function lastCmd(client: any) {
  const calls = client.send.mock.calls;
  return calls[calls.length - 1][0];
}

function rec(over: Partial<ReviewCostRecord> = {}): ReviewCostRecord {
  return {
    installationId: '42',
    repoFullName: 'octo/repo',
    prNumber: 7,
    commitSha: 'abc1234',
    completedAt: '2026-05-20T00:00:00.000Z',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 1.5,
    findingCount: 3,
    model: 'claude-sonnet-4',
    ...over,
  };
}

describe('DynamoReviewCostStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes one row per (repo, pr, commit) under the installation partition', async () => {
    const client = makeClient();
    const store = new DynamoReviewCostStore(client, TABLE);
    await store.recordCost(rec());
    const cmd = lastCmd(client);
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.Item).toMatchObject({
      pk: '42',
      sk: 'octo/repo#7#abc1234',
      costUsd: 1.5,
      findingCount: 3,
      model: 'claude-sonnet-4',
    });
    // TTL is set for self-pruning.
    expect(typeof cmd.input.Item.ttl).toBe('number');
  });

  it('persists null cost (unpriced) rather than dropping the attribute', async () => {
    const client = makeClient();
    const store = new DynamoReviewCostStore(client, TABLE);
    await store.recordCost(rec({ costUsd: null }));
    expect(lastCmd(client).input.Item.costUsd).toBeNull();
  });

  it('swallows write failures (best-effort)', async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error('throttled')) } as any;
    const store = new DynamoReviewCostStore(client, TABLE);
    await expect(store.recordCost(rec())).resolves.toBeUndefined();
  });

  it('lists rows for an installation and round-trips null cost', async () => {
    const client = makeClient({
      Items: [
        { pk: '42', installationId: '42', repoFullName: 'octo/repo', prNumber: 7, commitSha: 'abc', completedAt: 'iso', inputTokens: 100, outputTokens: 20, costUsd: 1.5, findingCount: 3, model: 'm' },
        { pk: '42', installationId: '42', repoFullName: 'octo/repo', prNumber: 8, commitSha: 'def', completedAt: 'iso', inputTokens: 50, outputTokens: 5, costUsd: null, findingCount: 0 },
      ],
    });
    const store = new DynamoReviewCostStore(client, TABLE);
    const { items } = await store.listByInstallation('42');
    expect(lastCmd(client)).toBeInstanceOf(QueryCommand);
    expect(lastCmd(client).input.ExpressionAttributeValues).toMatchObject({ ':pk': '42' });
    expect(items[0].costUsd).toBe(1.5);
    expect(items[1].costUsd).toBeNull(); // unpriced survives the round trip
    expect(items[0].model).toBe('m');
  });

  it('threads the pagination cursor', async () => {
    const client = makeClient({ Items: [], LastEvaluatedKey: { pk: '42', sk: 'x' } });
    const store = new DynamoReviewCostStore(client, TABLE);
    const { nextCursor } = await store.listByInstallation('42');
    expect(nextCursor).toBe(JSON.stringify({ pk: '42', sk: 'x' }));
  });
});
