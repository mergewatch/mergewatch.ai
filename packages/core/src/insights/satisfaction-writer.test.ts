import { describe, it, expect, vi } from 'vitest';
import { recordSummaryHelpfulVotes, summaryReactionsToVotes } from './satisfaction-writer.js';
import type { ISatisfactionStore } from '../storage/types.js';

const NOW = '2026-05-20T00:00:00.000Z';

/** A satisfaction store mock that records the helpful-vote calls. */
function mockStore() {
  return {
    recordHelpfulVotes: vi.fn().mockResolvedValue(undefined),
    listHelpfulVotes: vi.fn(),
    getNpsResponse: vi.fn(),
    recordNpsResponse: vi.fn(),
    listNpsResponses: vi.fn(),
  } as unknown as ISatisfactionStore & { recordHelpfulVotes: ReturnType<typeof vi.fn> };
}

describe('summaryReactionsToVotes', () => {
  it('maps 👍/❤️/🚀 to up and 👎/🤔 to down', () => {
    expect(summaryReactionsToVotes({ '+1': 2, heart: 1, rocket: 1, '-1': 3, confused: 1, eyes: 9 }))
      .toEqual({ up: 4, down: 4 });
  });

  it('returns zeros for undefined / empty counts', () => {
    expect(summaryReactionsToVotes(undefined)).toEqual({ up: 0, down: 0 });
    expect(summaryReactionsToVotes({})).toEqual({ up: 0, down: 0 });
  });
});

describe('recordSummaryHelpfulVotes', () => {
  it('records only the positive delta vs the prior snapshot', async () => {
    const store = mockStore();
    const snap = await recordSummaryHelpfulVotes(
      store, '42', 'org/repo', 7,
      { '+1': 3, '-1': 1 },          // current
      { '+1': 1 },                   // prior snapshot (1 👍 already counted)
      NOW,
    );
    expect(store.recordHelpfulVotes).toHaveBeenCalledTimes(1);
    expect(store.recordHelpfulVotes).toHaveBeenCalledWith('42', 'org/repo', 7, { up: 2, down: 1 }, NOW);
    // New snapshot is the tracked subset of the current counts.
    expect(snap).toEqual({ '+1': 3, '-1': 1 });
  });

  it('does not write when there is no new reaction (monotonic, no decrement)', async () => {
    const store = mockStore();
    const snap = await recordSummaryHelpfulVotes(
      store, '42', 'org/repo', 7,
      { '+1': 1 },                   // a 👍 was removed since last poll
      { '+1': 2, '-1': 1 },
      NOW,
    );
    expect(store.recordHelpfulVotes).not.toHaveBeenCalled();
    // Snapshot still reflects the current observed counts.
    expect(snap).toEqual({ '+1': 1 });
  });

  it('records the full count on first sight (no prior snapshot)', async () => {
    const store = mockStore();
    await recordSummaryHelpfulVotes(store, '42', 'org/repo', 7, { '+1': 2, heart: 1 }, undefined, NOW);
    expect(store.recordHelpfulVotes).toHaveBeenCalledWith('42', 'org/repo', 7, { up: 3, down: 0 }, NOW);
  });

  it('is a no-op (returns the snapshot) when no store is wired', async () => {
    const snap = await recordSummaryHelpfulVotes(undefined, '42', 'org/repo', 7, { '+1': 5 }, undefined, NOW);
    expect(snap).toEqual({ '+1': 5 });
  });

  it('swallows store errors and still returns the new snapshot', async () => {
    const store = mockStore();
    (store.recordHelpfulVotes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const snap = await recordSummaryHelpfulVotes(store, '42', 'org/repo', 7, { '+1': 1 }, undefined, NOW);
    expect(snap).toEqual({ '+1': 1 });
  });
});
