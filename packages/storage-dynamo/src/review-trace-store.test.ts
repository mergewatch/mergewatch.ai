import { describe, it, expect, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ReviewTraceItem } from '@mergewatch/core';
import {
  DynamoReviewTraceStore,
  DEFAULT_REVIEW_TRACES_TABLE,
} from './review-trace-store.js';
import { DynamoReviewStore } from './review-store.js';

function makeClient(item?: unknown) {
  const sent: any[] = [];
  const client = {
    send: vi.fn(async (cmd: any) => {
      sent.push(cmd);
      return item !== undefined ? { Item: item } : { Items: [] };
    }),
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const TRACE: ReviewTraceItem = {
  repoFullName: 'o/r',
  prNumberCommitSha: '42#abc123',
  outcomes: [],
  createdAt: '2026-08-25T12:00:00.000Z',
  ttl: 1_800_000_000,
};

describe('DynamoReviewTraceStore', () => {
  it('writes to its own table, never the reviews table', () => {
    // The whole point of the separate table: queryByPR matches
    // begins_with(prNumberCommitSha, "42#"), so a trace sharing that key space
    // would be returned as a review — and with limit 5, could evict a real one
    // from the previous-review lookup feeding previousFindings, delta and FP-B.
    expect(DEFAULT_REVIEW_TRACES_TABLE).not.toBe('mergewatch-reviews');
  });

  it('puts the trace under the review key, unsuffixed', async () => {
    const { client, sent } = makeClient();
    await new DynamoReviewTraceStore(client, 'traces').put(TRACE);
    expect(sent[0].input.TableName).toBe('traces');
    expect(sent[0].input.Item.prNumberCommitSha).toBe('42#abc123');
    // A suffix here is exactly what would collide on the reviews table.
    expect(sent[0].input.Item.prNumberCommitSha).not.toMatch(/#TRACE$/);
  });

  it('round-trips a stored trace', async () => {
    const { client } = makeClient(TRACE);
    const got = await new DynamoReviewTraceStore(client, 'traces').get('o/r', '42#abc123');
    expect(got).toEqual(TRACE);
  });

  it('returns null for a missing trace', async () => {
    const client = { send: vi.fn(async () => ({})) } as unknown as DynamoDBDocumentClient;
    const got = await new DynamoReviewTraceStore(client, 'traces').get('o/r', 'nope');
    expect(got).toBeNull();
  });

  it('carries the TTL attribute so the table self-prunes', async () => {
    const { client, sent } = makeClient();
    await new DynamoReviewTraceStore(client, 'traces').put(TRACE);
    expect(sent[0].input.Item.ttl).toBe(1_800_000_000);
  });
});

describe('queryByPR isolation (#471 regression)', () => {
  it('queries only the reviews table, so a trace can never appear in its results', async () => {
    const { client, sent } = makeClient();
    await new DynamoReviewStore(client, 'mergewatch-reviews-test').queryByPR('o/r', '42#');
    expect(sent).toHaveLength(1);
    expect(sent[0].input.TableName).toBe('mergewatch-reviews-test');
    // Traces live in a different table entirely, so the prefix match cannot
    // reach them regardless of how their sort key is shaped.
    expect(sent[0].input.TableName).not.toBe(DEFAULT_REVIEW_TRACES_TABLE);
    expect(sent[0].input.KeyConditionExpression).toContain('begins_with(prNumberCommitSha');
  });
});

describe('malformed stored data (#480 review)', () => {
  it('treats an item with non-array outcomes as absent', async () => {
    // Consumers (#472, #295) iterate `outcomes`; handing them an object would
    // crash there instead of failing at the storage boundary.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient({ ...TRACE, outcomes: { not: 'an array' } });
    const got = await new DynamoReviewTraceStore(client, 'traces').get('o/r', '42#abc123');
    expect(got).toBeNull();
  });

  it('treats an item missing outcomes entirely as absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient({ repoFullName: 'o/r', prNumberCommitSha: '42#abc123' });
    const got = await new DynamoReviewTraceStore(client, 'traces').get('o/r', '42#abc123');
    expect(got).toBeNull();
  });
});
