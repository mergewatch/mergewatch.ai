import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresFindingDispositionStore } from './finding-disposition-store';
import { findingDispositions } from './schema';

/** Drizzle chain mock (mirrors review-cost-store.test). */
function chain(result: any) {
  const p: any = {
    select: vi.fn(() => p),
    from: vi.fn(() => p),
    where: vi.fn(() => p),
    limit: vi.fn(() => Promise.resolve(result)),
    insert: vi.fn(() => p),
    values: vi.fn(() => p),
    onConflictDoUpdate: vi.fn(() => Promise.resolve(result)),
    update: vi.fn(() => p),
    set: vi.fn(() => p),
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return p;
}

describe('PostgresFindingDispositionStore #334 period buckets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upsertSurface seeds periodCounts with today\'s surface bucket on insert', async () => {
    const db: any = chain(undefined);
    const store = new PostgresFindingDispositionStore(db);
    await store.upsertSurface('42', 'octo/repo', 'k', '2026-08-16T14:30:00Z');
    expect(db.insert).toHaveBeenCalledWith(findingDispositions);
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({
      periodCounts: { '2026-08-16': { surface: 1 } },
    }));
    // Conflict path bumps the bucket too (SQL expression — assert presence).
    const conflictSet = db.onConflictDoUpdate.mock.calls[0][0].set;
    expect(conflictSet.periodCounts).toBeDefined();
  });

  it('increment* writes the lifetime column and the periodCounts bucket in one UPDATE', async () => {
    const db: any = chain(undefined);
    const store = new PostgresFindingDispositionStore(db);
    await store.incrementDispute('42', 'octo/repo', 'k', '2026-08-15T23:59:59Z');
    expect(db.update).toHaveBeenCalledWith(findingDispositions);
    const setArg = db.set.mock.calls[0][0];
    expect(setArg.disputeCount).toBeDefined();
    expect(setArg.periodCounts).toBeDefined();
    // The bucket-bump SQL targets the UTC day of nowIso and the short
    // counter key. Drizzle SQL params carry the bound values.
    const params = collectSqlParams(setArg.periodCounts);
    expect(params).toContain('2026-08-15');
    expect(params).toContain('dispute');
  });

  it('increment* defaults the bucket day to today when nowIso is omitted', async () => {
    const db: any = chain(undefined);
    const store = new PostgresFindingDispositionStore(db);
    await store.incrementResolve('42', 'octo/repo', 'k');
    const params = collectSqlParams(db.set.mock.calls[0][0].periodCounts);
    const today = new Date().toISOString().slice(0, 10);
    expect(params).toContain(today);
    expect(params).toContain('resolve');
  });

  it('hydrates periodCounts from period_counts and leaves it absent on legacy rows', async () => {
    const db: any = chain([
      row({ periodCounts: { '2026-08-16': { surface: 2, dispute: 1 } } }),
      row({ periodCounts: null }),
    ]);
    const store = new PostgresFindingDispositionStore(db);
    const { items } = await store.listByInstallation('42');
    expect(items[0].periodCounts).toEqual({ '2026-08-16': { surface: 2, dispute: 1 } });
    expect(items[1].periodCounts).toBeUndefined();
  });
});

/** Minimal DB row shape for hydration tests. */
function row(over: Record<string, unknown> = {}) {
  return {
    installationId: '42',
    repoFullName: 'octo/repo',
    findingMatchKey: 'k',
    firstSeen: '2026-08-01T00:00:00Z',
    lastSeen: '2026-08-16T00:00:00Z',
    surfaceCount: 1,
    disputeCount: 0,
    verifiedCount: 0,
    unverifiedCount: 0,
    silentDropCount: 0,
    agreementCount: 0,
    resolveCount: 0,
    category: null,
    topAgent: null,
    severity: null,
    sigTokens: null,
    rejectReasons: null,
    periodCounts: null,
    ...over,
  };
}

/** Walk a drizzle SQL template and collect its bound string params. */
function collectSqlParams(sqlObj: any): string[] {
  const out: string[] = [];
  const visit = (node: any) => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === 'object') {
      if ('value' in node) visit(node.value);
      if ('queryChunks' in node) visit(node.queryChunks);
    }
  };
  visit(sqlObj);
  return out;
}
