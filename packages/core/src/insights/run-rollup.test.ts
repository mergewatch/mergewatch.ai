import { describe, it, expect, vi } from 'vitest';
import { runInsightRollup, type RollupStores } from './run-rollup.js';
import type { FindingDispositionRecord, InstallationFPInsight } from '../types/db.js';

const WINDOW_END = '2026-05-22T00:00:00.000Z';

function record(over: Partial<FindingDispositionRecord> = {}): FindingDispositionRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    findingMatchKey: 'src/a.ts::T::X',
    firstSeen: '2026-05-21T00:00:00.000Z',
    lastSeen: '2026-05-21T00:00:00.000Z', // 1 day before window end → in 7d
    surfaceCount: 1,
    disputeCount: 0,
    verifiedCount: 0,
    unverifiedCount: 0,
    silentDropCount: 0,
    agreementCount: 0,
    ...over,
  };
}

function makeStores(opts: {
  installationIds?: string[];
  recordsByInstallation?: Record<string, FindingDispositionRecord[]>;
  installationsThrow?: boolean;
  dispositionThrowsFor?: string;
  upsertThrowsFor?: string;
}): RollupStores & { upserts: InstallationFPInsight[] } {
  const upserts: InstallationFPInsight[] = [];
  return {
    upserts,
    installationStore: {
      listInstallationIds: vi.fn(async () => {
        if (opts.installationsThrow) throw new Error('list fail');
        return opts.installationIds ?? [];
      }),
    },
    dispositionStore: {
      listByInstallation: vi.fn(async (id: string) => {
        if (opts.dispositionThrowsFor === id) throw new Error('disp fail');
        return { items: opts.recordsByInstallation?.[id] ?? [] };
      }),
    },
    fpInsightStore: {
      upsert: vi.fn(async (insight: InstallationFPInsight) => {
        if (opts.upsertThrowsFor === insight.installationId) throw new Error('upsert fail');
        upserts.push(insight);
      }),
    },
  };
}

describe('runInsightRollup (FB-E orchestrator)', () => {
  it('writes 3 rows (7d / 30d / 90d) per installation', async () => {
    const stores = makeStores({
      installationIds: ['42', '99'],
      recordsByInstallation: {
        '42': [record({ installationId: '42', surfaceCount: 5 })],
        '99': [record({ installationId: '99', surfaceCount: 3 })],
      },
    });
    const result = await runInsightRollup(stores, WINDOW_END);
    expect(result.installationsProcessed).toBe(2);
    expect(result.rowsWritten).toBe(6); // 2 installations × 3 windows
    expect(result.installationsFailed).toEqual([]);
    expect(stores.upserts.map((u) => u.window).sort()).toEqual(['30d', '30d', '7d', '7d', '90d', '90d']);
  });

  it('uses the provided windowEndIso as the anchor for all windows', async () => {
    const stores = makeStores({
      installationIds: ['42'],
      recordsByInstallation: { '42': [] },
    });
    await runInsightRollup(stores, WINDOW_END);
    for (const upsert of stores.upserts) {
      expect(upsert.windowEnd).toBe(WINDOW_END);
      expect(upsert.generatedAt).toBe(WINDOW_END);
    }
  });

  it('defaults windowEnd to now when not provided', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    const before = Date.now();
    await runInsightRollup(stores);
    const after = Date.now();
    const insightTs = new Date(stores.upserts[0].windowEnd).getTime();
    expect(insightTs).toBeGreaterThanOrEqual(before);
    expect(insightTs).toBeLessThanOrEqual(after);
  });

  it('isolates per-installation failure — one broken install doesn\'t halt the rest', async () => {
    const stores = makeStores({
      installationIds: ['ok-1', 'broken', 'ok-2'],
      recordsByInstallation: {
        'ok-1': [record({ installationId: 'ok-1' })],
        'ok-2': [record({ installationId: 'ok-2' })],
      },
      dispositionThrowsFor: 'broken',
    });
    const result = await runInsightRollup(stores, WINDOW_END);
    expect(result.installationsProcessed).toBe(2);
    expect(result.installationsFailed).toEqual(['broken']);
    expect(result.rowsWritten).toBe(6); // 2 OK × 3 windows
  });

  it('re-throws when listInstallationIds fails so callers see operator-visible failure', async () => {
    // Earlier behaviour returned an empty result, which made a catastrophic
    // enumeration failure look identical to "no installations to process".
    // Now we re-throw so the Lambda invocation fails (→ CloudWatch alarm)
    // and the self-hosted cron's outer try/catch logs + skips the cycle.
    const stores = makeStores({ installationsThrow: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runInsightRollup(stores, WINDOW_END)).rejects.toThrow('list fail');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('follows cursor pagination across multiple pages of disposition records', async () => {
    // FB-E previously stopped after the first 1000-row page — a silent
    // truncation hazard for installations with high finding volume. Now
    // we loop until nextCursor is unset.
    const calls: Array<{ id: string; cursor?: string }> = [];
    const stores: RollupStores & { upserts: InstallationFPInsight[] } = {
      upserts: [],
      installationStore: { listInstallationIds: async () => ['42'] },
      dispositionStore: {
        listByInstallation: async (id, opts) => {
          calls.push({ id, cursor: opts?.cursor });
          if (!opts?.cursor) {
            return { items: [record({ surfaceCount: 1 })], nextCursor: 'page-2' };
          }
          if (opts.cursor === 'page-2') {
            return { items: [record({ surfaceCount: 2 })], nextCursor: 'page-3' };
          }
          // Final page: no nextCursor.
          return { items: [record({ surfaceCount: 4 })] };
        },
      },
      fpInsightStore: {
        upsert: async (i) => { (stores.upserts as InstallationFPInsight[]).push(i); },
      },
    };
    const result = await runInsightRollup(stores, WINDOW_END);
    expect(calls).toEqual([
      { id: '42', cursor: undefined },
      { id: '42', cursor: 'page-2' },
      { id: '42', cursor: 'page-3' },
    ]);
    // All three records (1+2+4=7) summed into each window's surface count.
    expect(stores.upserts[0].totalFindingsSurfaced).toBe(7);
    expect(result.installationsProcessed).toBe(1);
  });

  it('counts installations as failed when ANY of the three window upserts fails', async () => {
    // Tighter contract: if any upsert in the per-install loop throws,
    // the whole install is marked failed (not "2/3 windows succeeded").
    const stores = makeStores({
      installationIds: ['42'],
      recordsByInstallation: { '42': [record({ installationId: '42' })] },
      upsertThrowsFor: '42',
    });
    const result = await runInsightRollup(stores, WINDOW_END);
    expect(result.installationsProcessed).toBe(0);
    expect(result.installationsFailed).toEqual(['42']);
  });

  it('writes 3 zero rows for an installation with no records (still has an insight to read)', async () => {
    const stores = makeStores({
      installationIds: ['fresh-install'],
      recordsByInstallation: { 'fresh-install': [] },
    });
    await runInsightRollup(stores, WINDOW_END);
    expect(stores.upserts).toHaveLength(3);
    for (const upsert of stores.upserts) {
      expect(upsert.totalFindingsSurfaced).toBe(0);
      expect(upsert.disputeRate).toBe(0);
    }
  });

  it('reports elapsedMs', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    const result = await runInsightRollup(stores, WINDOW_END);
    expect(typeof result.elapsedMs).toBe('number');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
