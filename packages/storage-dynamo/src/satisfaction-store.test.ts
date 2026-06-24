import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateCommand, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoSatisfactionStore } from './satisfaction-store.js';

const TABLE = 'test-satisfaction';

function makeClient(response: unknown = {}) {
  return { send: vi.fn().mockResolvedValue(response) } as any;
}

function lastCmd(client: any) {
  const calls = client.send.mock.calls;
  return calls[calls.length - 1][0];
}

describe('DynamoSatisfactionStore', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('helpful votes', () => {
    it('keys the row by installation / HV#repo#pr and increments up+down', async () => {
      const client = makeClient();
      const store = new DynamoSatisfactionStore(client, TABLE);
      await store.recordHelpfulVotes('42', 'octo/repo', 7, { up: 2, down: 1 }, '2026-05-20T00:00:00Z');
      const cmd = lastCmd(client);
      expect(cmd).toBeInstanceOf(UpdateCommand);
      expect(cmd.input.Key).toEqual({ pk: '42', sk: 'HV#octo/repo#7' });
      expect(cmd.input.UpdateExpression).toContain('up = if_not_exists(up, :zero) + :u');
      expect(cmd.input.UpdateExpression).toContain('down = if_not_exists(down, :zero) + :d');
      expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ':u': 2, ':d': 1, ':at': '2026-05-20T00:00:00Z' });
    });

    it('is a no-op when both deltas are zero', async () => {
      const client = makeClient();
      const store = new DynamoSatisfactionStore(client, TABLE);
      await store.recordHelpfulVotes('42', 'octo/repo', 7, { up: 0, down: 0 }, '2026-05-20T00:00:00Z');
      expect(client.send).not.toHaveBeenCalled();
    });

    it('swallows write failures (best-effort)', async () => {
      const client = { send: vi.fn().mockRejectedValue(new Error('throttled')) } as any;
      const store = new DynamoSatisfactionStore(client, TABLE);
      await expect(store.recordHelpfulVotes('42', 'octo/repo', 7, { up: 1 }, 'now')).resolves.toBeUndefined();
    });

    it('lists helpful votes via Query with the HV# prefix', async () => {
      const client = makeClient({
        Items: [{ pk: '42', repoFullName: 'octo/repo', prNumber: 7, up: 3, down: 1, lastVoteAt: 'iso' }],
      });
      const store = new DynamoSatisfactionStore(client, TABLE);
      const { items } = await store.listHelpfulVotes('42');
      const cmd = lastCmd(client);
      expect(cmd).toBeInstanceOf(QueryCommand);
      expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ':pk': '42', ':prefix': 'HV#' });
      expect(items).toEqual([{ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, up: 3, down: 1, lastVoteAt: 'iso' }]);
    });
  });

  describe('NPS', () => {
    it('reads a response via Get keyed by NPS#userId', async () => {
      const client = makeClient({ Item: { installationId: '42', githubUserId: 'u1', score: 9, respondedAt: 'iso' } });
      const store = new DynamoSatisfactionStore(client, TABLE);
      const r = await store.getNpsResponse('42', 'u1');
      const cmd = lastCmd(client);
      expect(cmd).toBeInstanceOf(GetCommand);
      expect(cmd.input.Key).toEqual({ pk: '42', sk: 'NPS#u1' });
      expect(r).toEqual({ installationId: '42', githubUserId: 'u1', score: 9, respondedAt: 'iso' });
    });

    it('returns null when no response exists', async () => {
      const client = makeClient({});
      const store = new DynamoSatisfactionStore(client, TABLE);
      expect(await store.getNpsResponse('42', 'u1')).toBeNull();
    });

    it('records a response via Put (latest-wins)', async () => {
      const client = makeClient();
      const store = new DynamoSatisfactionStore(client, TABLE);
      await store.recordNpsResponse({ installationId: '42', githubUserId: 'u1', score: 8, respondedAt: 'iso' });
      const cmd = lastCmd(client);
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input.Item).toMatchObject({ pk: '42', sk: 'NPS#u1', score: 8, respondedAt: 'iso' });
    });

    it('lists NPS responses via Query with the NPS# prefix', async () => {
      const client = makeClient({ Items: [{ installationId: '42', githubUserId: 'u1', score: 10, respondedAt: 'iso' }] });
      const store = new DynamoSatisfactionStore(client, TABLE);
      const { items } = await store.listNpsResponses('42');
      const cmd = lastCmd(client);
      expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ':pk': '42', ':prefix': 'NPS#' });
      expect(items).toEqual([{ installationId: '42', githubUserId: 'u1', score: 10, respondedAt: 'iso' }]);
    });
  });
});
