import { describe, it, expect, vi } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoReviewStore } from './review-store.js';

const TABLE = 'test-reviews';

const review = {
  repoFullName: 'octo/repo',
  prNumberCommitSha: '7#abc1234',
  status: 'pending' as const,
  createdAt: '2026-08-16T00:00:00.000Z',
};

describe('DynamoReviewStore.claimReview (#355)', () => {
  it("treats 'pending' as claimable so a throttled-and-parked review can be re-claimed", async () => {
    const client = { send: vi.fn().mockResolvedValue({}) } as any;
    const store = new DynamoReviewStore(client, TABLE);

    expect(await store.claimReview(review as any)).toBe(true);
    const cmd = client.send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.ConditionExpression).toBe(
      'attribute_not_exists(repoFullName) OR #s IN (:failed, :skipped, :complete, :pending)',
    );
    expect(cmd.input.ExpressionAttributeValues[':pending']).toBe('pending');
    // The claim itself writes in_progress — that state stays unclaimable (dedup).
    expect(cmd.input.Item.status).toBe('in_progress');
  });

  it('returns false (not throw) when the row is already in_progress', async () => {
    const client = {
      send: vi.fn().mockRejectedValue({ name: 'ConditionalCheckFailedException' }),
    } as any;
    const store = new DynamoReviewStore(client, TABLE);
    expect(await store.claimReview(review as any)).toBe(false);
  });

  it('rethrows non-conditional errors', async () => {
    const client = {
      send: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'InternalServerError' })),
    } as any;
    const store = new DynamoReviewStore(client, TABLE);
    await expect(store.claimReview(review as any)).rejects.toThrow('boom');
  });
});

describe('DynamoReviewStore — safety score and band (#713)', () => {
  it("the 'complete' write sets both attributes", async () => {
    const send = vi.fn().mockResolvedValue({});
    await new DynamoReviewStore({ send } as any, 'reviews').updateStatus('octo/repo', '7#abc', 'complete', { safetyScore: 33, safetyBand: 'risky' });
    const { UpdateExpression: expr, ExpressionAttributeValues: vals } = send.mock.calls[0][0].input;
    const valueFor = (attr: string) => vals[expr.match(new RegExp(`${attr} = (:v\\d+)`))![1]];
    expect(valueFor('safetyScore')).toBe(33);
    expect(valueFor('safetyBand')).toBe('risky');
  });
});

describe('DynamoReviewStore — safety feedback (#716)', () => {
  it('appends with list_append(if_not_exists(...)) and a one-element list', async () => {
    const send = vi.fn().mockResolvedValue({});
    const entry = { band: 'risky' as const, user: 'alice', at: 't' };
    await new DynamoReviewStore({ send } as any, 'reviews').appendSafetyFeedback('octo/repo', '7#abc', entry);
    const input = send.mock.calls[0][0].input;
    expect(input.Key).toEqual({ repoFullName: 'octo/repo', prNumberCommitSha: '7#abc' });
    expect(input.UpdateExpression).toContain('list_append(if_not_exists(safetyFeedback, :empty), :entry)');
    expect(input.ExpressionAttributeValues[':entry']).toEqual([entry]);
    expect(input.ExpressionAttributeValues[':empty']).toEqual([]);
  });
});
