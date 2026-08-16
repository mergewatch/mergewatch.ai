import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoFindingDispositionStore } from './finding-disposition-store.js';

const TABLE = 'test-finding-dispositions';

function makeClient(response: unknown = {}) {
  return { send: vi.fn().mockResolvedValue(response) } as any;
}

/** Pull every UpdateCommand the store issued. */
function updates(client: any): UpdateCommand[] {
  return client.send.mock.calls
    .map((c: any[]) => c[0])
    .filter((cmd: any) => cmd instanceof UpdateCommand);
}

describe('DynamoFindingDispositionStore #334 period buckets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upsertSurface bumps the flattened per-day surface bucket in the same call', async () => {
    const client = makeClient();
    const store = new DynamoFindingDispositionStore(client, TABLE);
    await store.upsertSurface('42', 'octo/repo', 'src/a.ts::T::title', '2026-08-16T14:30:00Z');
    const cmd = updates(client)[0];
    expect(cmd.input.Key).toEqual({ pk: '42#octo/repo', sk: 'src/a.ts::T::title' });
    // Lifetime counter and bucket bump live in ONE expression.
    expect(cmd.input.UpdateExpression).toContain('surfaceCount = if_not_exists(surfaceCount, :zero) + :one');
    expect(cmd.input.UpdateExpression).toContain('#pcSurface = if_not_exists(#pcSurface, :zero) + :one');
    // Day key is the UTC calendar date of nowIso.
    expect(cmd.input.ExpressionAttributeNames?.['#pcSurface']).toBe('pc#2026-08-16#surface');
  });

  it('increment* bumps the lifetime counter and its day bucket atomically', async () => {
    const client = makeClient();
    const store = new DynamoFindingDispositionStore(client, TABLE);
    await store.incrementDispute('42', 'octo/repo', 'k', '2026-08-15T23:59:59Z');
    const cmd = updates(client)[0];
    expect(cmd.input.UpdateExpression).toBe(
      'SET #c = if_not_exists(#c, :zero) + :one, #p = if_not_exists(#p, :zero) + :one',
    );
    expect(cmd.input.ExpressionAttributeNames).toEqual({
      '#c': 'disputeCount',
      '#p': 'pc#2026-08-15#dispute',
    });
  });

  it('increment* defaults the bucket day to today when nowIso is omitted (back-compat callers)', async () => {
    const client = makeClient();
    const store = new DynamoFindingDispositionStore(client, TABLE);
    await store.incrementResolve('42', 'octo/repo', 'k');
    const cmd = updates(client)[0];
    const attr = cmd.input.ExpressionAttributeNames?.['#p'] as string;
    expect(attr).toMatch(/^pc#\d{4}-\d{2}-\d{2}#resolve$/);
  });

  it('every counter maps to its matching bucket key', async () => {
    const client = makeClient();
    const store = new DynamoFindingDispositionStore(client, TABLE);
    const now = '2026-08-16T00:00:00Z';
    await store.incrementVerified('1', 'o/r', 'k', now);
    await store.incrementUnverified('1', 'o/r', 'k', now);
    await store.incrementSilentDrop('1', 'o/r', 'k', now);
    await store.incrementAgreement('1', 'o/r', 'k', now);
    const names = updates(client).map((c) => c.input.ExpressionAttributeNames?.['#p']);
    expect(names).toEqual([
      'pc#2026-08-16#verified',
      'pc#2026-08-16#unverified',
      'pc#2026-08-16#silentDrop',
      'pc#2026-08-16#agreement',
    ]);
  });

  it('listByInstallation folds pc# attributes back into the typed periodCounts map', async () => {
    const client = makeClient({
      Items: [{
        pk: '42#octo/repo',
        sk: 'k1',
        firstSeen: '2026-08-01T00:00:00Z',
        lastSeen: '2026-08-16T00:00:00Z',
        surfaceCount: 3,
        'pc#2026-08-01#surface': 1,
        'pc#2026-08-16#surface': 2,
        'pc#2026-08-16#dispute': 1,
      }],
    });
    const store = new DynamoFindingDispositionStore(client, TABLE);
    const { items } = await store.listByInstallation('42');
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(ScanCommand);
    expect(items[0].periodCounts).toEqual({
      '2026-08-01': { surface: 1 },
      '2026-08-16': { surface: 2, dispute: 1 },
    });
  });

  it('leaves periodCounts absent on legacy items and skips malformed pc# attributes', async () => {
    const client = makeClient({
      Items: [
        { pk: '42#octo/repo', sk: 'legacy', firstSeen: 'a', lastSeen: 'b', surfaceCount: 5 },
        { pk: '42#octo/repo', sk: 'weird', firstSeen: 'a', lastSeen: 'b', surfaceCount: 1, 'pc#nonsense': 'NaN-ish', 'pc#2026-08-16#surface': 1 },
      ],
    });
    const store = new DynamoFindingDispositionStore(client, TABLE);
    const { items } = await store.listByInstallation('42');
    expect(items[0].periodCounts).toBeUndefined();
    expect(items[1].periodCounts).toEqual({ '2026-08-16': { surface: 1 } });
  });
});
