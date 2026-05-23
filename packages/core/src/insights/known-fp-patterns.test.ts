import { describe, it, expect, vi } from 'vitest';
import { loadKnownFPPatterns } from './known-fp-patterns.js';
import type { IFPInsightStore } from '../storage/types.js';
import type { InstallationFPInsight } from '../types/db.js';

function makeInsight(over: Partial<InstallationFPInsight> = {}): InstallationFPInsight {
  return {
    installationId: '42',
    window: '90d',
    windowStart: '2026-02-22T00:00:00.000Z',
    windowEnd: '2026-05-22T00:00:00.000Z',
    generatedAt: '2026-05-22T00:00:00.000Z',
    totalFindingsSurfaced: 100,
    totalDisputes: 30,
    disputeRate: 0.30,
    totalSilentDrops: 5,
    totalAgreements: 12,
    perCategory: {},
    perRepo: {},
    topClusters: [],
    ...over,
  };
}

function makeStore(insight: InstallationFPInsight | null): IFPInsightStore {
  return {
    upsert: vi.fn(),
    get: vi.fn(async () => insight),
    listByInstallation: vi.fn(async () => insight ? [insight] : []),
  };
}

describe('loadKnownFPPatterns (FB-L)', () => {
  it('returns [] when feedback.learnFromDisputes is false (default)', async () => {
    const insight = makeInsight({
      topClusters: [{ sigTokens: ['x'], representativeTitle: 'X', surfaceCount: 100, disputeCount: 100, rate: 1.0 }],
    });
    const store = makeStore(insight);
    const result = await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: false } });
    expect(result).toEqual([]);
    expect(store.get).not.toHaveBeenCalled(); // doesn't even read the store
  });

  it('returns [] when feedback is undefined entirely', async () => {
    const store = makeStore(makeInsight({ topClusters: [{ sigTokens: ['x'], representativeTitle: 'X', surfaceCount: 10, disputeCount: 10, rate: 1.0 }] }));
    const result = await loadKnownFPPatterns(store, '42');
    expect(result).toEqual([]);
  });

  it('returns [] when store is undefined (older deployments)', async () => {
    const result = await loadKnownFPPatterns(undefined, '42', { feedback: { learnFromDisputes: true } });
    expect(result).toEqual([]);
  });

  it('returns [] when installationId is missing', async () => {
    const store = makeStore(makeInsight());
    const result = await loadKnownFPPatterns(store, undefined, { feedback: { learnFromDisputes: true } });
    expect(result).toEqual([]);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('returns [] when no rollup exists yet for the installation', async () => {
    const store = makeStore(null);
    const result = await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: true } });
    expect(result).toEqual([]);
  });

  it('reads from the 90d window specifically (widest signal)', async () => {
    const store = makeStore(makeInsight());
    await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: true } });
    expect(store.get).toHaveBeenCalledWith('42', '90d');
  });

  it('filters clusters below the surfaceCount threshold (default ≥ 5)', async () => {
    const store = makeStore(makeInsight({
      topClusters: [
        { sigTokens: ['a'], representativeTitle: 'Below threshold', surfaceCount: 3, disputeCount: 3, rate: 1.0 }, // surface < 5 → excluded
        { sigTokens: ['b'], representativeTitle: 'At threshold',    surfaceCount: 5, disputeCount: 5, rate: 1.0 }, // surface = 5 → included
      ],
    }));
    const result = await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: true } });
    expect(result).toHaveLength(1);
    expect(result[0].representativeTitle).toBe('At threshold');
  });

  it('filters clusters below the disputeRate threshold (default ≥ 0.75)', async () => {
    const store = makeStore(makeInsight({
      topClusters: [
        { sigTokens: ['a'], representativeTitle: 'Low rate',  surfaceCount: 10, disputeCount: 7, rate: 0.70 }, // 0.70 < 0.75 → excluded
        { sigTokens: ['b'], representativeTitle: 'High rate', surfaceCount: 10, disputeCount: 8, rate: 0.80 }, // 0.80 ≥ 0.75 → included
      ],
    }));
    const result = await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: true } });
    expect(result).toHaveLength(1);
    expect(result[0].representativeTitle).toBe('High rate');
  });

  it('respects custom threshold knobs', async () => {
    const store = makeStore(makeInsight({
      topClusters: [
        { sigTokens: ['a'], representativeTitle: 'A', surfaceCount: 6, disputeCount: 3, rate: 0.50 },
      ],
    }));
    const result = await loadKnownFPPatterns(store, '42', {
      feedback: {
        learnFromDisputes: true,
        knownFPPatternsMinSurfaceCount: 5,
        knownFPPatternsMinDisputeRate: 0.5, // lower threshold than default
      },
    });
    expect(result).toHaveLength(1);
  });

  it('caps at topK (default 5)', async () => {
    const clusters = Array.from({ length: 10 }, (_, i) => ({
      sigTokens: [`token${i}`],
      representativeTitle: `Cluster ${i}`,
      surfaceCount: 10,
      disputeCount: 10,
      rate: 1.0,
    }));
    const store = makeStore(makeInsight({ topClusters: clusters }));
    const result = await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: true } });
    expect(result).toHaveLength(5);
  });

  it('honours a custom topK', async () => {
    const clusters = Array.from({ length: 10 }, (_, i) => ({
      sigTokens: [`token${i}`],
      representativeTitle: `Cluster ${i}`,
      surfaceCount: 10,
      disputeCount: 10,
      rate: 1.0,
    }));
    const store = makeStore(makeInsight({ topClusters: clusters }));
    const result = await loadKnownFPPatterns(store, '42', {
      feedback: { learnFromDisputes: true, knownFPPatternsTopK: 2 },
    });
    expect(result).toHaveLength(2);
  });

  it('sorts by leverage (rate × surfaceCount) desc for stable selection', async () => {
    const store = makeStore(makeInsight({
      topClusters: [
        { sigTokens: ['low'],  representativeTitle: 'Low leverage',  surfaceCount: 6,   disputeCount: 6,   rate: 1.0 }, // 6
        { sigTokens: ['high'], representativeTitle: 'High leverage', surfaceCount: 100, disputeCount: 100, rate: 1.0 }, // 100
        { sigTokens: ['mid'],  representativeTitle: 'Mid leverage',  surfaceCount: 20,  disputeCount: 18,  rate: 0.90 }, // 18
      ],
    }));
    const result = await loadKnownFPPatterns(store, '42', {
      feedback: { learnFromDisputes: true, knownFPPatternsTopK: 3 },
    });
    expect(result.map((p) => p.representativeTitle)).toEqual([
      'High leverage', 'Mid leverage', 'Low leverage',
    ]);
  });

  it('returns [] on store error (best-effort fail-safe)', async () => {
    const store: IFPInsightStore = {
      upsert: vi.fn(),
      get: vi.fn(async () => { throw new Error('DynamoDB throttled'); }),
      listByInstallation: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadKnownFPPatterns(store, '42', { feedback: { learnFromDisputes: true } });
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
