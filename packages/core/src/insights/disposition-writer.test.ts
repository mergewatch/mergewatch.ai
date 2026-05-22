import { describe, it, expect, vi } from 'vitest';
import {
  recordFindingSurfacings,
  recordDisputes,
  detectQuietDrops,
  recordQuietDrops,
} from './disposition-writer.js';
import type { IFindingDispositionStore } from '../storage/types.js';
import type { OrchestratedFinding, PreviousFinding } from '../agents/reviewer.js';

// ─── Mock store ─────────────────────────────────────────────────────────────

function makeMockStore(): IFindingDispositionStore & {
  calls: {
    upsertSurface: Array<[string, string, string, string, unknown]>;
    incrementDispute: string[][];
    incrementVerified: string[][];
    incrementUnverified: string[][];
    incrementSilentDrop: string[][];
    incrementAgreement: string[][];
    appendRejectReason: Array<[string, string, string, unknown]>;
  };
} {
  const calls = {
    upsertSurface: [] as Array<[string, string, string, string, unknown]>,
    incrementDispute: [] as string[][],
    incrementVerified: [] as string[][],
    incrementUnverified: [] as string[][],
    incrementSilentDrop: [] as string[][],
    incrementAgreement: [] as string[][],
    appendRejectReason: [] as Array<[string, string, string, unknown]>,
  };
  return {
    calls,
    async upsertSurface(installationId, repoFullName, k, nowIso, attribution) {
      calls.upsertSurface.push([installationId, repoFullName, k, nowIso, attribution]);
    },
    async incrementDispute(i, r, k)     { calls.incrementDispute.push([i, r, k]); },
    async incrementVerified(i, r, k)    { calls.incrementVerified.push([i, r, k]); },
    async incrementUnverified(i, r, k)  { calls.incrementUnverified.push([i, r, k]); },
    async incrementSilentDrop(i, r, k)  { calls.incrementSilentDrop.push([i, r, k]); },
    async incrementAgreement(i, r, k)   { calls.incrementAgreement.push([i, r, k]); },
    async appendRejectReason(i, r, k, reason) {
      calls.appendRejectReason.push([i, r, k, reason]);
    },
    async listByInstallation() {
      return { items: [] };
    },
  };
}

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeFinding(over: Partial<OrchestratedFinding> = {}): OrchestratedFinding {
  return {
    file: 'src/a.ts',
    line: 10,
    severity: 'warning',
    category: 'bug',
    title: 'Missing await on async fetch',
    description: 'fetch() returns a promise that is not awaited',
    suggestion: 'await fetch()',
    ...over,
  } as OrchestratedFinding;
}

// ─── recordFindingSurfacings ────────────────────────────────────────────────

describe('recordFindingSurfacings (FB-A)', () => {
  it('writes one upsertSurface per match key per finding', async () => {
    const store = makeMockStore();
    const findings = [makeFinding()];
    await recordFindingSurfacings(store, 42, 'org/repo', findings, '2026-05-22T00:00:00Z');
    // No fingerprint → just the title key
    expect(store.calls.upsertSurface).toHaveLength(1);
    expect(store.calls.upsertSurface[0][0]).toBe('42');
    expect(store.calls.upsertSurface[0][1]).toBe('org/repo');
    expect(store.calls.upsertSurface[0][2]).toBe('src/a.ts::T::Missing await on async fetch');
    expect(store.calls.upsertSurface[0][3]).toBe('2026-05-22T00:00:00Z');
  });

  it('writes BOTH title and fingerprint keys when the finding has a fingerprint', async () => {
    const store = makeMockStore();
    const f = makeFinding({ fingerprint: 'fetch(url, opts);' });
    await recordFindingSurfacings(store, 42, 'org/repo', [f], '2026-05-22T00:00:00Z');
    const keys = store.calls.upsertSurface.map((c) => c[2]);
    expect(keys).toEqual([
      'src/a.ts::T::Missing await on async fetch',
      'src/a.ts::F::fetch(url, opts);',
    ]);
  });

  it('attaches sigTokens (W10 token bag) so FB-E clustering can merge sibling rows', async () => {
    const store = makeMockStore();
    await recordFindingSurfacings(store, 42, 'org/repo', [makeFinding()], '2026-05-22T00:00:00Z');
    const attribution = store.calls.upsertSurface[0][4] as { sigTokens?: string[] };
    expect(Array.isArray(attribution.sigTokens)).toBe(true);
    expect(attribution.sigTokens!.length).toBeGreaterThan(0);
    // significant tokens (≥5 chars, stop-words removed) — we should see
    // "missing" / "async" / "await" / "fetch" (at least most of these).
    const tokens = (attribution.sigTokens ?? []).join(' ');
    expect(tokens).toMatch(/missing|async|await|fetch/);
  });

  it('forwards verified verification verdict to incrementVerified', async () => {
    const store = makeMockStore();
    await recordFindingSurfacings(store, 42, 'org/repo', [
      makeFinding({ verification: 'verified' }),
    ], '2026-05-22T00:00:00Z');
    expect(store.calls.incrementVerified).toHaveLength(1);
    expect(store.calls.incrementUnverified).toHaveLength(0);
  });

  it('forwards unverified verification verdict to incrementUnverified', async () => {
    const store = makeMockStore();
    await recordFindingSurfacings(store, 42, 'org/repo', [
      makeFinding({ verification: 'unverified' }),
    ], '2026-05-22T00:00:00Z');
    expect(store.calls.incrementVerified).toHaveLength(0);
    expect(store.calls.incrementUnverified).toHaveLength(1);
  });

  it('writes nothing when no store is provided (back-compat)', async () => {
    // Smoke test: undefined store must not throw — analytics is optional.
    await expect(
      recordFindingSurfacings(undefined, 42, 'org/repo', [makeFinding()], '2026-05-22T00:00:00Z'),
    ).resolves.toBeUndefined();
  });

  it('writes nothing when installationId is missing (typed but optional)', async () => {
    const store = makeMockStore();
    await recordFindingSurfacings(store, undefined, 'org/repo', [makeFinding()], '2026-05-22T00:00:00Z');
    expect(store.calls.upsertSurface).toHaveLength(0);
  });

  it('logs but does not throw when the store rejects', async () => {
    const store = makeMockStore();
    store.upsertSurface = vi.fn(async () => { throw new Error('disk full'); }) as never;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordFindingSurfacings(store, 42, 'org/repo', [makeFinding()], '2026-05-22T00:00:00Z'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── recordDisputes ─────────────────────────────────────────────────────────

describe('recordDisputes (FB-A)', () => {
  it('calls incrementDispute once per key', async () => {
    const store = makeMockStore();
    await recordDisputes(store, 42, 'org/repo', [
      'src/a.ts::T::Foo',
      'src/a.ts::F::abc123',
    ]);
    expect(store.calls.incrementDispute).toEqual([
      ['42', 'org/repo', 'src/a.ts::T::Foo'],
      ['42', 'org/repo', 'src/a.ts::F::abc123'],
    ]);
  });

  it('is a no-op when the key list is empty', async () => {
    const store = makeMockStore();
    await recordDisputes(store, 42, 'org/repo', []);
    expect(store.calls.incrementDispute).toHaveLength(0);
  });
});

// ─── detectQuietDrops (FB-B) ────────────────────────────────────────────────

function priorFinding(over: Partial<PreviousFinding> = {}): PreviousFinding {
  return {
    file: 'src/a.ts',
    line: 10,
    severity: 'warning',
    title: 'Was here last time',
    description: '',
    suggestion: '',
    ...over,
  } as PreviousFinding;
}

describe('detectQuietDrops (FB-B)', () => {
  it('returns a prior finding that is absent from current AND cited line was not changed', async () => {
    const current = [makeFinding({ title: 'Different finding' })];
    const prior = [priorFinding()];
    const changedLines = new Map<string, Set<number>>();
    // No changes touched src/a.ts:10
    const drops = detectQuietDrops(current, prior, changedLines);
    expect(drops).toHaveLength(1);
    expect(drops[0].title).toBe('Was here last time');
  });

  it('does NOT count a prior finding whose cited line WAS changed as a quiet drop', async () => {
    const current = [makeFinding({ title: 'Different finding' })];
    const prior = [priorFinding({ file: 'src/a.ts', line: 10 })];
    const changedLines = new Map([['src/a.ts', new Set([9, 10, 11])]]);
    const drops = detectQuietDrops(current, prior, changedLines);
    expect(drops).toHaveLength(0);
  });

  it('does NOT count a prior finding that is STILL in current (matched by title key)', async () => {
    const current = [makeFinding({ title: 'Was here last time' })];
    const prior = [priorFinding()];
    const changedLines = new Map<string, Set<number>>();
    const drops = detectQuietDrops(current, prior, changedLines);
    expect(drops).toHaveLength(0);
  });

  it('uses W9 fingerprint key for matching too — a reworded title with same fingerprint is NOT a quiet drop', async () => {
    const current = [makeFinding({ title: 'New wording', fingerprint: 'fetch(url);' })];
    const prior = [priorFinding({ title: 'Old wording', fingerprint: 'fetch(url);' })];
    const changedLines = new Map<string, Set<number>>();
    const drops = detectQuietDrops(current, prior, changedLines);
    // The fingerprint key on both sides matches → it's still "present", not dropped.
    expect(drops).toHaveLength(0);
  });

  it('returns empty when there are no prior findings', async () => {
    const drops = detectQuietDrops([], [], new Map());
    expect(drops).toHaveLength(0);
  });

  it('returns empty (conservative) when changedLines is undefined — no false-positive silentDrops', async () => {
    // Older callers / mocks may not pass changedLines. We must not invent a
    // "quiet drop" signal when we don't have proof the cited code was
    // untouched — that would over-attribute disputes.
    const drops = detectQuietDrops(
      [],
      [priorFinding()],
      undefined as unknown as Map<string, Set<number>>,
    );
    expect(drops).toHaveLength(0);
  });
});

// ─── recordQuietDrops ───────────────────────────────────────────────────────

describe('recordQuietDrops (FB-B)', () => {
  it('writes one incrementSilentDrop per match key per quiet-dropped finding', async () => {
    const store = makeMockStore();
    await recordQuietDrops(store, 42, 'org/repo', [priorFinding()]);
    expect(store.calls.incrementSilentDrop).toHaveLength(1);
    expect(store.calls.incrementSilentDrop[0]).toEqual(['42', 'org/repo', 'src/a.ts::T::Was here last time']);
  });

  it('is a no-op on empty input', async () => {
    const store = makeMockStore();
    await recordQuietDrops(store, 42, 'org/repo', []);
    expect(store.calls.incrementSilentDrop).toHaveLength(0);
  });
});
