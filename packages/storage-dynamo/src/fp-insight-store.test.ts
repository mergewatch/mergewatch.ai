import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoFPInsightStore } from './fp-insight-store.js';
import type { InstallationFPInsight } from '@mergewatch/core';

const TABLE = 'test-fp-insights';

function makeClient(response: unknown = {}) {
  return { send: vi.fn().mockResolvedValue(response) } as any;
}

const baseInsight: InstallationFPInsight = {
  installationId: '42',
  window: '7d',
  windowStart: '2026-05-15T00:00:00.000Z',
  windowEnd: '2026-05-22T00:00:00.000Z',
  generatedAt: '2026-05-22T00:00:00.000Z',
  totalFindingsSurfaced: 0,
  totalDisputes: 0,
  disputeRate: 0,
  totalSilentDrops: 0,
  totalAgreements: 0,
  perCategory: {},
  perRepo: {},
  topClusters: [],
};

const cycleTime: NonNullable<InstallationFPInsight['cycleTime']> = {
  mergedCount: 2,
  reviewedMergedCount: 1,
  unreviewedMergedCount: 1,
  closedUnmergedCount: 0,
  openCount: 3,
  timeToMergeHours: { p50: 24, p75: 36, p90: 48 },
  timeToMergeHoursReviewed: { p50: 12, p75: 12, p90: 12 },
  timeToMergeHoursUnreviewed: { p50: 48, p75: 48, p90: 48 },
  timeToMergeFromFirstReviewHours: { p50: 6, p75: 6, p90: 6 },
  roundTripsBeforeMerge: { p50: 2, p75: 2, p90: 2 },
};

describe('DynamoFPInsightStore — cycleTime (TTM #194)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the cycleTime block when present', async () => {
    const client = makeClient();
    const store = new DynamoFPInsightStore(client, TABLE);
    await store.upsert({ ...baseInsight, cycleTime });
    const cmd = client.send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.Item.cycleTime).toEqual(cycleTime);
  });

  it('writes null (not undefined) when cycleTime is absent', async () => {
    const client = makeClient();
    const store = new DynamoFPInsightStore(client, TABLE);
    await store.upsert(baseInsight);
    const cmd = client.send.mock.calls[0][0];
    expect(cmd.input.Item.cycleTime).toBeNull();
  });

  it('round-trips cycleTime back on read', async () => {
    const client = makeClient({ Item: { ...baseInsight, disputeRate: '0', cycleTime } });
    const store = new DynamoFPInsightStore(client, TABLE);
    const got = await store.get('42', '7d');
    expect(got?.cycleTime).toEqual(cycleTime);
  });

  it('leaves cycleTime undefined for pre-Stage-2 rows (null/absent)', async () => {
    const client = makeClient({ Item: { ...baseInsight, disputeRate: '0', cycleTime: null } });
    const store = new DynamoFPInsightStore(client, TABLE);
    const got = await store.get('42', '7d');
    expect(got?.cycleTime).toBeUndefined();
  });
});
