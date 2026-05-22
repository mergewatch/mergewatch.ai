import { describe, it, expect } from 'vitest';
import { buildInsightFromDispositions, WINDOW_LENGTH_MS } from './rollup.js';
import type { FindingDispositionRecord } from '../types/db.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const WINDOW_END = '2026-05-22T00:00:00.000Z';
const WINDOW_END_MS = new Date(WINDOW_END).getTime();

function isoOffset(daysBack: number): string {
  return new Date(WINDOW_END_MS - daysBack * 24 * 60 * 60 * 1000).toISOString();
}

function record(over: Partial<FindingDispositionRecord> = {}): FindingDispositionRecord {
  return {
    installationId: '42',
    repoFullName: 'org/repo',
    findingMatchKey: 'src/a.ts::T::Missing await on fetch',
    firstSeen: isoOffset(5),
    lastSeen: isoOffset(1),
    surfaceCount: 1,
    disputeCount: 0,
    verifiedCount: 0,
    unverifiedCount: 0,
    silentDropCount: 0,
    agreementCount: 0,
    category: 'bug',
    topAgent: 'bug',
    sigTokens: ['missing', 'await', 'fetch'],
    ...over,
  };
}

// ─── Window filtering ───────────────────────────────────────────────────────

describe('buildInsightFromDispositions — window filtering', () => {
  it('includes only records whose lastSeen falls inside the window', () => {
    const records = [
      record({ lastSeen: isoOffset(1), surfaceCount: 5 }),
      record({ lastSeen: isoOffset(10), surfaceCount: 3 }),
      record({ lastSeen: isoOffset(45), surfaceCount: 7 }),
    ];
    const r7  = buildInsightFromDispositions('42', '7d',  WINDOW_END, records);
    const r30 = buildInsightFromDispositions('42', '30d', WINDOW_END, records);
    const r90 = buildInsightFromDispositions('42', '90d', WINDOW_END, records);
    expect(r7.totalFindingsSurfaced).toBe(5);          // only the 1-day-old
    expect(r30.totalFindingsSurfaced).toBe(5 + 3);     // 1d + 10d
    expect(r90.totalFindingsSurfaced).toBe(5 + 3 + 7); // all three
  });

  it('sets windowStart correctly relative to windowEnd for each window', () => {
    const r7 = buildInsightFromDispositions('42', '7d', WINDOW_END, []);
    expect(new Date(r7.windowEnd).getTime() - new Date(r7.windowStart).getTime()).toBe(WINDOW_LENGTH_MS['7d']);
  });

  it('returns zero counters with no records', () => {
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, []);
    expect(r.totalFindingsSurfaced).toBe(0);
    expect(r.totalDisputes).toBe(0);
    expect(r.disputeRate).toBe(0);
    expect(r.topClusters).toEqual([]);
    expect(r.perCategory).toEqual({});
    expect(r.perRepo).toEqual({});
  });
});

// ─── Global counters ───────────────────────────────────────────────────────

describe('buildInsightFromDispositions — global counters', () => {
  it('sums every counter across in-window records', () => {
    const records = [
      record({ surfaceCount: 10, disputeCount: 3, silentDropCount: 1, agreementCount: 2 }),
      record({ surfaceCount: 4,  disputeCount: 1, silentDropCount: 2, agreementCount: 1 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.totalFindingsSurfaced).toBe(14);
    expect(r.totalDisputes).toBe(4);
    expect(r.totalSilentDrops).toBe(3);
    expect(r.totalAgreements).toBe(3);
    expect(r.disputeRate).toBeCloseTo(4 / 14);
  });

  it('disputeRate is 0 when no surfacings (avoids divide-by-zero)', () => {
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, []);
    expect(r.disputeRate).toBe(0);
  });
});

// ─── Per-category / per-repo buckets ───────────────────────────────────────

describe('buildInsightFromDispositions — buckets', () => {
  it('buckets by category and computes per-category rate', () => {
    const records = [
      record({ category: 'security', surfaceCount: 10, disputeCount: 1 }),
      record({ category: 'style',    surfaceCount: 20, disputeCount: 16 }),
      record({ category: 'security', surfaceCount: 5,  disputeCount: 0  }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.perCategory).toEqual({
      security: { surfaced: 15, disputed: 1,  rate: 1  / 15 },
      style:    { surfaced: 20, disputed: 16, rate: 16 / 20 },
    });
  });

  it('lumps records without a category under "uncategorized"', () => {
    const records = [
      record({ category: undefined, surfaceCount: 4, disputeCount: 2 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.perCategory).toEqual({
      uncategorized: { surfaced: 4, disputed: 2, rate: 0.5 },
    });
  });

  it('buckets by repoFullName independently of category', () => {
    const records = [
      record({ repoFullName: 'org/api', surfaceCount: 6, disputeCount: 3 }),
      record({ repoFullName: 'org/web', surfaceCount: 4, disputeCount: 0 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.perRepo['org/api'].rate).toBeCloseTo(0.5);
    expect(r.perRepo['org/web'].rate).toBe(0);
  });
});

// ─── Clusters ───────────────────────────────────────────────────────────────

describe('buildInsightFromDispositions — clusters', () => {
  it('clusters records that share at least one sigToken', () => {
    const records = [
      record({ findingMatchKey: 'src/a.ts::T::Missing await on fetch',  sigTokens: ['missing', 'await', 'fetch'],   surfaceCount: 5, disputeCount: 4 }),
      record({ findingMatchKey: 'src/b.ts::T::Async fetch not awaited', sigTokens: ['async',   'fetch', 'awaited'], surfaceCount: 3, disputeCount: 2 }),
      // Different cluster — no shared tokens with the above.
      record({ findingMatchKey: 'src/c.ts::T::Magic number 42',        sigTokens: ['magic',  'number'],            surfaceCount: 2, disputeCount: 0 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    // Two distinct clusters.
    expect(r.topClusters).toHaveLength(2);
    // The fetch cluster sums both members.
    const fetchCluster = r.topClusters.find((c) => c.sigTokens.includes('fetch'))!;
    expect(fetchCluster.surfaceCount).toBe(8);
    expect(fetchCluster.disputeCount).toBe(6);
    expect(fetchCluster.rate).toBeCloseTo(6 / 8);
  });

  it('picks the highest-surfacing member\'s title as the cluster representative', () => {
    const records = [
      record({ findingMatchKey: 'src/a.ts::T::Tiny issue',   sigTokens: ['shared'], surfaceCount: 1 }),
      record({ findingMatchKey: 'src/b.ts::T::Main concern', sigTokens: ['shared'], surfaceCount: 20 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.topClusters[0].representativeTitle).toBe('Main concern');
  });

  it('falls back to the file path when the match key is fingerprint-form (no title)', () => {
    const records = [
      record({ findingMatchKey: 'src/a.ts::F::const x = await fn();', sigTokens: ['some', 'token'], surfaceCount: 5 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.topClusters[0].representativeTitle).toBe('src/a.ts');
  });

  it('skips records with no sigTokens — they don\'t cluster but still count in totals', () => {
    const records = [
      record({ sigTokens: undefined, surfaceCount: 7, disputeCount: 2 }),
      record({ sigTokens: ['shared'], surfaceCount: 3, disputeCount: 1 }),
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.totalFindingsSurfaced).toBe(10);    // both contribute to totals
    expect(r.topClusters).toHaveLength(1);       // only the one with sigTokens clusters
    expect(r.topClusters[0].surfaceCount).toBe(3);
  });

  it('sorts top clusters by disputeRate × surfaceCount desc (leverage)', () => {
    // High rate but low volume vs lower rate but higher volume.
    const records = [
      record({ findingMatchKey: 'a::T::Rare gem',       sigTokens: ['rare'],   surfaceCount: 2,  disputeCount: 2  }), // rate=1.0  leverage=2
      record({ findingMatchKey: 'b::T::Bigger problem', sigTokens: ['common'], surfaceCount: 30, disputeCount: 12 }), // rate=0.4  leverage=12
    ];
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.topClusters[0].representativeTitle).toBe('Bigger problem');
  });

  it('caps topClusters at the configured limit (default 10)', () => {
    // Build 15 distinct clusters by giving each a unique sigToken.
    const records = Array.from({ length: 15 }, (_, i) => record({
      findingMatchKey: `src/${i}.ts::T::Cluster ${i}`,
      sigTokens: [`uniqueToken${i}`],
      surfaceCount: 1,
      disputeCount: 1,
    }));
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, records);
    expect(r.topClusters).toHaveLength(10);
  });
});

// ─── Window metadata ────────────────────────────────────────────────────────

describe('buildInsightFromDispositions — metadata', () => {
  it('echoes installationId and window verbatim', () => {
    const r = buildInsightFromDispositions('inst-42', '30d', WINDOW_END, []);
    expect(r.installationId).toBe('inst-42');
    expect(r.window).toBe('30d');
  });

  it('sets generatedAt = windowEnd (the rollup is anchored to the window upper bound)', () => {
    const r = buildInsightFromDispositions('42', '7d', WINDOW_END, []);
    expect(r.generatedAt).toBe(r.windowEnd);
    expect(r.windowEnd).toBe(WINDOW_END);
  });
});
