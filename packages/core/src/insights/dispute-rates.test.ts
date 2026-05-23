import { describe, it, expect } from 'vitest';
import { loadCategoryDisputeRates } from './dispute-rates.js';
import type { IFPInsightStore, InstallationFPInsight } from '../index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeStore(insight: InstallationFPInsight | null | Error): IFPInsightStore {
  return {
    async get(_id, _window) {
      if (insight instanceof Error) throw insight;
      return insight;
    },
    async upsert() { /* unused */ },
    async listByInstallation() { return []; },
  };
}

function makeInsight(perCategory: Record<string, { surfaced: number; disputed: number; rate: number }>): InstallationFPInsight {
  return {
    installationId: '42',
    window: '30d',
    windowStart: '2026-04-22T00:00:00Z',
    windowEnd: '2026-05-22T00:00:00Z',
    generatedAt: '2026-05-22T00:00:00Z',
    totalFindingsSurfaced: 0,
    totalDisputes: 0,
    disputeRate: 0,
    totalSilentDrops: 0,
    totalAgreements: 0,
    perCategory,
    perRepo: {},
    topClusters: [],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadCategoryDisputeRates (FP-J L1)', () => {
  it('returns {} when no store is provided (back-compat)', async () => {
    const rates = await loadCategoryDisputeRates(undefined, 42);
    expect(rates).toEqual({});
  });

  it('returns {} when installationId is null/undefined', async () => {
    const store = makeStore(makeInsight({ style: { surfaced: 10, disputed: 8, rate: 0.8 } }));
    expect(await loadCategoryDisputeRates(store, undefined)).toEqual({});
    expect(await loadCategoryDisputeRates(store, null as unknown as number)).toEqual({});
  });

  it('returns {} when the store has no insight for this installation (fresh install)', async () => {
    const rates = await loadCategoryDisputeRates(makeStore(null), 42);
    expect(rates).toEqual({});
  });

  it('returns {} on store read failure (logged, swallowed; pipeline must not block)', async () => {
    const rates = await loadCategoryDisputeRates(makeStore(new Error('upstream-degraded')), 42);
    expect(rates).toEqual({});
  });

  it('projects perCategory.rate into the simple {category: rate} map', async () => {
    const insight = makeInsight({
      style:    { surfaced: 20, disputed: 16, rate: 0.8  },
      security: { surfaced: 10, disputed: 1,  rate: 0.1  },
    });
    const rates = await loadCategoryDisputeRates(makeStore(insight), 42);
    expect(rates).toEqual({ style: 0.8, security: 0.1 });
  });

  it('filters out categories below the MIN_SURFACED floor (small-N noise guard)', async () => {
    const insight = makeInsight({
      style:    { surfaced: 20, disputed: 16, rate: 0.8  }, // kept
      flaky:    { surfaced: 1,  disputed: 1,  rate: 1.0  }, // dropped — only 1 surfacing
      borderline: { surfaced: 4, disputed: 3, rate: 0.75 }, // dropped — below 5
    });
    const rates = await loadCategoryDisputeRates(makeStore(insight), 42);
    expect(rates).toEqual({ style: 0.8 });
  });

  it('handles installationId as a number (handler passes it through unstringified)', async () => {
    const insight = makeInsight({ style: { surfaced: 10, disputed: 8, rate: 0.8 } });
    const rates = await loadCategoryDisputeRates(makeStore(insight), 42);
    expect(rates).toEqual({ style: 0.8 });
  });

  it('handles an empty perCategory bucket on an otherwise valid insight', async () => {
    const insight = makeInsight({});
    const rates = await loadCategoryDisputeRates(makeStore(insight), 42);
    expect(rates).toEqual({});
  });
});
