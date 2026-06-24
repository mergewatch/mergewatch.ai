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
    resolveCount: 0,
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

// ─── TTM (#194) — cycle-time wiring ────────────────────────────────────────

import type { PRLifecycleRecord } from '../types/db.js';

function prRecord(over: Partial<PRLifecycleRecord> = {}): PRLifecycleRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    prNumber: 1,
    prCreatedAt: '2026-05-20T00:00:00.000Z',
    mergedAt: '2026-05-21T00:00:00.000Z',
    state: 'merged',
    reviewed: true,
    skipped: false,
    totalPushes: 2,
    pushesAfterFirstReview: 1,
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...over,
  };
}

describe('runInsightRollup — cycle-time block', () => {
  it('attaches a cycleTime block to every window when prLifecycleStore is wired', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    const prCalls: Array<{ id: string; cursor?: string }> = [];
    const withPr: RollupStores & { upserts: InstallationFPInsight[] } = {
      ...stores,
      prLifecycleStore: {
        listByInstallation: vi.fn(async (id: string, opts?: { cursor?: string }) => {
          prCalls.push({ id, cursor: opts?.cursor });
          return { items: [prRecord()] };
        }),
      },
    };
    await runInsightRollup(withPr, WINDOW_END);
    expect(prCalls).toEqual([{ id: '42', cursor: undefined }]);
    expect(stores.upserts).toHaveLength(3);
    for (const u of stores.upserts) {
      expect(u.cycleTime).toBeDefined();
      expect(u.cycleTime?.mergedCount).toBe(1);
      expect(u.cycleTime?.reviewedMergedCount).toBe(1);
      expect(u.cycleTime?.timeToMergeHours).toEqual({ p50: 24, p75: 24, p90: 24 });
      expect(u.cycleTime?.roundTripsBeforeMerge).toEqual({ p50: 1, p75: 1, p90: 1 });
    }
  });

  it('omits cycleTime entirely when no prLifecycleStore is wired (back-compat)', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    await runInsightRollup(stores, WINDOW_END);
    for (const u of stores.upserts) {
      expect(u.cycleTime).toBeUndefined();
    }
  });

  it('follows cursor pagination across multiple pages of PR-lifecycle records', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    const withPr: RollupStores & { upserts: InstallationFPInsight[] } = {
      ...stores,
      prLifecycleStore: {
        listByInstallation: async (_id: string, opts?: { cursor?: string }) => {
          if (!opts?.cursor) return { items: [prRecord({ prNumber: 1 })], nextCursor: 'p2' };
          return { items: [prRecord({ prNumber: 2 })] };
        },
      },
    };
    await runInsightRollup(withPr, WINDOW_END);
    // Both pages' merged PRs counted into each window.
    expect(stores.upserts[0].cycleTime?.mergedCount).toBe(2);
  });

  // ── #193 — cost block wiring ──────────────────────────────────────────────

  it('attaches a cost block when the costStore is wired', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    const withCost: RollupStores & { upserts: InstallationFPInsight[] } = {
      ...stores,
      costStore: {
        listByInstallation: async (_id: string, opts?: { cursor?: string }) => {
          if (!opts?.cursor) return { items: [
            { installationId: '42', repoFullName: 'org/repo', prNumber: 1, commitSha: 'a', completedAt: '2026-05-21T00:00:00.000Z', inputTokens: 100, outputTokens: 20, costUsd: 2, findingCount: 4 },
          ], nextCursor: 'p2' };
          return { items: [
            { installationId: '42', repoFullName: 'org/repo', prNumber: 2, commitSha: 'b', completedAt: '2026-05-21T00:00:00.000Z', inputTokens: 50, outputTokens: 10, costUsd: null, findingCount: 1 },
          ] };
        },
      },
    };
    await runInsightRollup(withCost, WINDOW_END);
    for (const u of stores.upserts) {
      expect(u.cost).toBeDefined();
    }
    // Both pages aggregated; the null-cost review is counted but unpriced.
    const c7 = stores.upserts.find((u) => u.window === '7d')!.cost!;
    expect(c7.reviewCount).toBe(2);
    expect(c7.pricedReviewCount).toBe(1);
    expect(c7.unpricedReviewCount).toBe(1);
    expect(c7.totalCostUsd).toBe(2);
    expect(c7.avgCostPerFinding).toBe(0.5); // 2 / 4
  });

  it('omits the cost block when no costStore is wired (back-compat)', async () => {
    const stores = makeStores({ installationIds: ['42'], recordsByInstallation: { '42': [] } });
    await runInsightRollup(stores, WINDOW_END);
    for (const u of stores.upserts) {
      expect(u.cost).toBeUndefined();
    }
  });
});
