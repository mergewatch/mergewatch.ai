import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresSatisfactionStore } from './satisfaction-store';
import { helpfulVotes, npsResponses } from './schema';

/**
 * Drizzle chain mock (mirrors api-key-store.test). Terminal calls resolve to
 * the configured result; .onConflictDoUpdate() resolves like .values().
 */
function chain(result: any) {
  const p: any = {
    select: vi.fn(() => p),
    from: vi.fn(() => p),
    where: vi.fn(() => p),
    limit: vi.fn(() => Promise.resolve(result)),
    insert: vi.fn(() => p),
    values: vi.fn(() => p),
    onConflictDoUpdate: vi.fn(() => Promise.resolve(result)),
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return p;
}

describe('PostgresSatisfactionStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recordHelpfulVotes upserts with an atomic increment on conflict', async () => {
    const db: any = chain(undefined);
    const store = new PostgresSatisfactionStore(db);
    await store.recordHelpfulVotes('42', 'octo/repo', 7, { up: 2, down: 1 }, 'iso');
    expect(db.insert).toHaveBeenCalledWith(helpfulVotes);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, up: 2, down: 1, lastVoteAt: 'iso' }),
    );
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('recordHelpfulVotes is a no-op when both deltas are zero', async () => {
    const db: any = chain(undefined);
    const store = new PostgresSatisfactionStore(db);
    await store.recordHelpfulVotes('42', 'octo/repo', 7, { up: 0, down: 0 }, 'iso');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('getNpsResponse returns null when no row', async () => {
    const db: any = chain([]);
    const store = new PostgresSatisfactionStore(db);
    expect(await store.getNpsResponse('42', 'u1')).toBeNull();
  });

  it('getNpsResponse hydrates the row when present', async () => {
    const db: any = chain([{ installationId: '42', githubUserId: 'u1', score: 9, respondedAt: 'iso' }]);
    const store = new PostgresSatisfactionStore(db);
    expect(await store.getNpsResponse('42', 'u1')).toEqual({ installationId: '42', githubUserId: 'u1', score: 9, respondedAt: 'iso' });
  });

  it('recordNpsResponse upserts latest-wins', async () => {
    const db: any = chain(undefined);
    const store = new PostgresSatisfactionStore(db);
    await store.recordNpsResponse({ installationId: '42', githubUserId: 'u1', score: 8, respondedAt: 'iso' });
    expect(db.insert).toHaveBeenCalledWith(npsResponses);
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('listHelpfulVotes / listNpsResponses hydrate rows', async () => {
    const hvDb: any = chain([{ installationId: '42', repoFullName: 'octo/repo', prNumber: 7, up: 3, down: 1, lastVoteAt: 'iso' }]);
    expect((await new PostgresSatisfactionStore(hvDb).listHelpfulVotes('42')).items).toEqual([
      { installationId: '42', repoFullName: 'octo/repo', prNumber: 7, up: 3, down: 1, lastVoteAt: 'iso' },
    ]);
    const npsDb: any = chain([{ installationId: '42', githubUserId: 'u1', score: 10, respondedAt: 'iso' }]);
    expect((await new PostgresSatisfactionStore(npsDb).listNpsResponses('42')).items).toEqual([
      { installationId: '42', githubUserId: 'u1', score: 10, respondedAt: 'iso' },
    ]);
  });
});
