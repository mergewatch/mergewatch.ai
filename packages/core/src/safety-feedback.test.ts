import { describe, it, expect, vi } from 'vitest';
import { parseSafetyFeedback, latestScoredReview, recordSafetyFeedback } from './safety-feedback.js';
import type { ReviewItem } from './types/db.js';

describe('parseSafetyFeedback (#716)', () => {
  it.each([
    ['@mergewatch safety safe', { band: 'safe' }],
    ['@mergewatch safety Caution', { band: 'caution' }],
    ['@MergeWatch Safety RISKY', { band: 'risky' }],
    ['Looks fine to me.\n@mergewatch safety caution', { band: 'caution' }],
    ['  @mergewatch safety risky because x', { band: 'risky', reason: 'because x' }],
  ])('%j → %j', (body, expected) => {
    expect(parseSafetyFeedback(body)).toEqual(expected);
  });

  it('truncates a reason to 500 characters', () => {
    expect(parseSafetyFeedback(`@mergewatch safety risky ${'x'.repeat(600)}`)!.reason).toHaveLength(500);
  });

  it.each([
    '@mergewatch safety',
    '@mergewatch safety maybe',
    '@mergewatch safetyrisky',
    '@mergewatch safety risky-ish',
    '@mergewatch safety safe?',
    '@mergewatch\nsafety risky',
    '> @mergewatch safety risky',
    '@mergewatch review',
    '@mergewatch safety why so risky?',
  ])('%j → null', (body) => {
    expect(parseSafetyFeedback(body)).toBeNull();
  });
});

const row = (sha: string, createdAt: string, safetyBand?: ReviewItem['safetyBand']): ReviewItem =>
  ({ repoFullName: 'o/r', prNumberCommitSha: `42#${sha}`, status: 'complete', createdAt, ...(safetyBand ? { safetyBand } : {}) }) as ReviewItem;

describe('latestScoredReview (#716)', () => {
  it('picks the newest scored row by createdAt, not by position', () => {
    // DynamoDB order: descending SHA, so the newest row is not first.
    const rows = [row('f00', '2026-01-01T00:00:00Z', 'safe'), row('000', '2026-01-02T00:00:00Z', 'risky'), row('aaa', '2026-01-03T00:00:00Z')];
    expect(latestScoredReview(rows)?.prNumberCommitSha).toBe('42#000');
  });
  it('is undefined when no row has a band', () => {
    expect(latestScoredReview([row('a', 't')])).toBeUndefined();
  });
});

describe('recordSafetyFeedback (#716)', () => {
  const octokit = () => ({ reactions: { createForIssueComment: vi.fn().mockResolvedValue({ data: { id: 1 } }) } }) as any;
  const store = (rows: ReviewItem[]) => ({ queryByPR: vi.fn().mockResolvedValue(rows), appendSafetyFeedback: vi.fn() }) as any;
  const base = { command: { band: 'risky' as const, reason: 'x' }, user: 'alice', repoFullName: 'o/r', owner: 'o', repo: 'r', prNumber: 42, commentId: 9, now: () => 'T' };

  it('appends to the latest scored row and reacts +1', async () => {
    const o = octokit(); const s = store([row('f', '1', 'safe'), row('0', '2', 'risky')]);
    expect(await recordSafetyFeedback({ ...base, octokit: o, reviewStore: s })).toBe('recorded');
    expect(s.queryByPR).toHaveBeenCalledWith('o/r', '42#', 50);
    expect(s.appendSafetyFeedback).toHaveBeenCalledWith('o/r', '42#0', { band: 'risky', user: 'alice', at: 'T', reason: 'x' });
    expect(o.reactions.createForIssueComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 9, content: '+1' });
  });

  it('with no scored row: writes nothing and reacts confused', async () => {
    const o = octokit(); const s = store([row('a', '1')]);
    expect(await recordSafetyFeedback({ ...base, octokit: o, reviewStore: s })).toBe('no-scored-review');
    expect(s.appendSafetyFeedback).not.toHaveBeenCalled();
    expect(o.reactions.createForIssueComment.mock.calls[0][0].content).toBe('confused');
  });

  it('a failed reaction does not fail the vote', async () => {
    const o = { reactions: { createForIssueComment: vi.fn().mockRejectedValue(new Error('403')) } } as any;
    const s = store([row('0', '2', 'risky')]);
    await expect(recordSafetyFeedback({ ...base, octokit: o, reviewStore: s })).resolves.toBe('recorded');
    expect(s.appendSafetyFeedback).toHaveBeenCalledTimes(1);
  });
});
