import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoPRLifecycleStore } from './pr-lifecycle-store.js';

const TABLE = 'test-pr-lifecycle';

function makeClient(response: unknown = {}) {
  return { send: vi.fn().mockResolvedValue(response) } as any;
}

/** Pull every UpdateCommand the store issued. */
function updates(client: any): UpdateCommand[] {
  return client.send.mock.calls
    .map((c: any[]) => c[0])
    .filter((cmd: any) => cmd instanceof UpdateCommand);
}

describe('DynamoPRLifecycleStore key + command construction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys rows by `${installationId}#${repoFullName}` / prNumber', async () => {
    const client = makeClient();
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await store.upsertOpened({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, prCreatedAt: '2026-04-01T00:00:00Z' });
    const cmd = updates(client)[0];
    expect(cmd.input.Key).toEqual({ pk: '42#octo/repo', sk: '7' });
    expect(cmd.input.TableName).toBe(TABLE);
  });

  it('upsertOpened guards against resurrecting a terminal row', async () => {
    const client = makeClient();
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await store.upsertOpened({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, prCreatedAt: '2026-04-01T00:00:00Z' });
    const cmd = updates(client)[0];
    // Only create or touch an open row.
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(pk) OR #state = :open');
    expect(cmd.input.ExpressionAttributeValues?.[':open']).toBe('open');
  });

  it('upsertOpened swallows the ConditionalCheckFailedException (terminal row no-op)', async () => {
    const client = { send: vi.fn().mockRejectedValue({ name: 'ConditionalCheckFailedException' }) } as any;
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await expect(
      store.upsertOpened({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, prCreatedAt: '2026-04-01T00:00:00Z' }),
    ).resolves.toBeUndefined();
  });

  it('recordPush issues two updates: total always, post-review guarded on firstReviewAt', async () => {
    const client = makeClient();
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await store.recordPush('42', 'octo/repo', 7);
    const cmds = updates(client);
    expect(cmds).toHaveLength(2);
    // 1st: unconditional total_pushes bump.
    expect(cmds[0].input.ConditionExpression).toBeUndefined();
    expect(cmds[0].input.UpdateExpression).toContain('totalPushes = if_not_exists(totalPushes, :zero) + :one');
    // 2nd: post-first-review counter only when a review has landed.
    expect(cmds[1].input.ConditionExpression).toBe('attribute_exists(firstReviewAt)');
    expect(cmds[1].input.UpdateExpression).toContain('pushesAfterFirstReview');
  });

  it('recordPush swallows the guarded conditional failure (no review yet)', async () => {
    // First send (total bump) succeeds; second (guarded) fails the condition.
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' });
    const store = new DynamoPRLifecycleStore({ send } as any, TABLE);
    await expect(store.recordPush('42', 'octo/repo', 7)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('markReviewed sets firstReviewAt set-once and reviewed=true', async () => {
    const client = makeClient();
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await store.markReviewed('42', 'octo/repo', 7, '2026-04-02T09:00:00Z');
    const cmd = updates(client)[0];
    expect(cmd.input.UpdateExpression).toContain('firstReviewAt = if_not_exists(firstReviewAt, :at)');
    expect(cmd.input.UpdateExpression).toContain('reviewed = :true');
    expect(cmd.input.ExpressionAttributeValues?.[':at']).toBe('2026-04-02T09:00:00Z');
  });

  it('markMerged overwrites state + prCreatedAt unconditionally and sets a ttl', async () => {
    const client = makeClient();
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await store.markMerged({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, prCreatedAt: '2026-04-01T00:00:00Z', at: '2026-04-03T12:00:00Z' });
    const cmd = updates(client)[0];
    expect(cmd.input.ConditionExpression).toBeUndefined(); // merge is authoritative
    expect(cmd.input.ExpressionAttributeValues?.[':merged']).toBe('merged');
    const ttl = cmd.input.ExpressionAttributeValues?.[':ttl'];
    const expected = Math.floor(Date.parse('2026-04-03T12:00:00Z') / 1000) + 90 * 24 * 60 * 60;
    expect(ttl).toBe(expected);
  });

  it('markClosedUnmerged guards against downgrading a merged row', async () => {
    const client = makeClient();
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await store.markClosedUnmerged({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, prCreatedAt: '2026-04-01T00:00:00Z', at: '2026-04-03T12:00:00Z' });
    const cmd = updates(client)[0];
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(#state) OR #state <> :merged');
    expect(cmd.input.ExpressionAttributeValues?.[':closed']).toBe('closed_unmerged');
  });

  it('markClosedUnmerged swallows the conditional failure when already merged', async () => {
    const client = { send: vi.fn().mockRejectedValue({ name: 'ConditionalCheckFailedException' }) } as any;
    const store = new DynamoPRLifecycleStore(client, TABLE);
    await expect(
      store.markClosedUnmerged({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, prCreatedAt: '2026-04-01T00:00:00Z', at: '2026-04-03T12:00:00Z' }),
    ).resolves.toBeUndefined();
  });

  it('listByInstallation Scans with a begins_with prefix and decodes rows', async () => {
    const client = makeClient({
      Items: [{
        pk: '42#octo/repo', sk: '7',
        prCreatedAt: '2026-04-01T00:00:00Z', state: 'merged',
        reviewed: true, skipped: false, totalPushes: 3, pushesAfterFirstReview: 1,
        firstReviewAt: '2026-04-02T09:00:00Z', mergedAt: '2026-04-03T12:00:00Z',
        updatedAt: '2026-04-03T12:00:00Z', ttl: 1_900_000_000,
      }],
    });
    const store = new DynamoPRLifecycleStore(client, TABLE);
    const { items } = await store.listByInstallation('42');
    const cmd = client.send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(ScanCommand);
    expect(cmd.input.ExpressionAttributeValues?.[':prefix']).toBe('42#');
    expect(items).toEqual([{
      installationId: '42', repoFullName: 'octo/repo', prNumber: 7,
      prCreatedAt: '2026-04-01T00:00:00Z', state: 'merged',
      reviewed: true, skipped: false, totalPushes: 3, pushesAfterFirstReview: 1,
      updatedAt: '2026-04-03T12:00:00Z',
      firstReviewAt: '2026-04-02T09:00:00Z', mergedAt: '2026-04-03T12:00:00Z',
      ttl: 1_900_000_000,
    }]);
  });
});
