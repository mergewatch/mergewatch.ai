import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ILLMProvider } from '../llm/types.js';
import {
  handleInlineReply,
  detectResolveIntent,
  parseRejectIntent,
  enrichResolvedFindingKeys,
  persistInlineResolveMemory,
  MAX_INLINE_RESOLVED_KEYS,
  REJECT_CATEGORIES,
  MAX_BOT_REPLIES,
} from './inline-reply.js';
import { buildInlineComments } from '../github/client.js';
import { findingMatchKeys } from '../review-delta.js';
import type { IReviewStore } from '../storage/types.js';
import type { ReviewItem } from '../types/db.js';

// ─── detectResolveIntent ────────────────────────────────────────────────────

describe('detectResolveIntent', () => {
  it('matches the standalone /resolve command', () => {
    expect(detectResolveIntent('/resolve')).toBe(true);
    expect(detectResolveIntent('  /resolve  ')).toBe(true);
    expect(detectResolveIntent('Thanks! /resolve')).toBe(true);
  });

  it('matches a bare "resolve" reply', () => {
    expect(detectResolveIntent('resolve')).toBe(true);
    expect(detectResolveIntent('Resolve')).toBe(true);
    expect(detectResolveIntent('resolve.')).toBe(true);
  });

  it('matches common affirmative phrasings', () => {
    expect(detectResolveIntent('resolved')).toBe(true);
    expect(detectResolveIntent('Please resolve')).toBe(true);
    expect(detectResolveIntent('Mergewatch resolve')).toBe(true);
    expect(detectResolveIntent('yes, resolve')).toBe(true);
  });

  it("does NOT match prose that happens to contain the word resolve", () => {
    expect(detectResolveIntent("Here's how I'd resolve this differently.")).toBe(false);
    expect(detectResolveIntent('This will not resolve the underlying issue.')).toBe(false);
    expect(detectResolveIntent('I want to resolve it in a follow-up PR.')).toBe(false);
  });

  it('does not match on empty input', () => {
    expect(detectResolveIntent('')).toBe(false);
    expect(detectResolveIntent('   ')).toBe(false);
  });

  it('matches case-insensitively and with punctuation variations', () => {
    expect(detectResolveIntent('RESOLVE')).toBe(true);
    expect(detectResolveIntent('Resolve!')).toBe(true);
    expect(detectResolveIntent('resolve.')).toBe(true);
    expect(detectResolveIntent(' resolve ')).toBe(true);
  });

  it('does not match ambiguous phrases', () => {
    expect(detectResolveIntent('resolves the issue in the next PR')).toBe(false);
    expect(detectResolveIntent('I cannot resolve this right now')).toBe(false);
    expect(detectResolveIntent('the bug will resolve itself')).toBe(false);
  });
});

// ─── enrichResolvedFindingKeys (FP-F regression #182) ─────────────────────

describe('enrichResolvedFindingKeys', () => {
  it('adds the fingerprint key for any prior finding whose title key matches a resolved key', () => {
    // Title-only persistence is brittle when the next review's LLM
    // rewords the title; adding the fingerprint key from the prior
    // round's findings makes suppression survive the rewording.
    const resolved = ['src/admin.ts::T::Unauthenticated admin endpoint'];
    const prev = [
      { file: 'src/admin.ts', line: 8, title: 'Unauthenticated admin endpoint', fingerprint: 'abc123' },
    ];
    const enriched = enrichResolvedFindingKeys(resolved, prev);
    expect(enriched).toContain('src/admin.ts::T::Unauthenticated admin endpoint');
    expect(enriched).toContain('src/admin.ts::F::abc123');
    expect(enriched).toHaveLength(2);
  });

  it('returns the seed unchanged when the prior finding has no fingerprint', () => {
    const resolved = ['src/admin.ts::T::Title'];
    const prev = [{ file: 'src/admin.ts', line: 8, title: 'Title' }];
    const enriched = enrichResolvedFindingKeys(resolved, prev);
    expect(enriched).toEqual(['src/admin.ts::T::Title']);
  });

  it('passes through resolved keys when previousFindings is empty / undefined / null', () => {
    const resolved = ['src/admin.ts::T::Title'];
    expect(enrichResolvedFindingKeys(resolved, undefined)).toEqual(resolved);
    expect(enrichResolvedFindingKeys(resolved, null)).toEqual(resolved);
    expect(enrichResolvedFindingKeys(resolved, [])).toEqual(resolved);
  });

  it('ignores prior findings that do not intersect the seed', () => {
    // The join is "any of finding's keys is in the seed". If neither
    // title nor fingerprint key matches a resolved key, do not enrich.
    const resolved = ['src/a.ts::T::Resolved'];
    const prev = [
      { file: 'src/b.ts', line: 1, title: 'Unrelated', fingerprint: 'xyz' },
      { file: 'src/a.ts', line: 1, title: 'Different title same file', fingerprint: 'qqq' },
    ];
    const enriched = enrichResolvedFindingKeys(resolved, prev);
    expect(enriched).toEqual(['src/a.ts::T::Resolved']);
  });

  it('matches via fingerprint key when the seed already carries one', () => {
    // Defensive: a future caller that hands enrich a fingerprint key
    // should still pick up the title key from the matching prior finding.
    const resolved = ['src/a.ts::F::fp1'];
    const prev = [{ file: 'src/a.ts', line: 1, title: 'T', fingerprint: 'fp1' }];
    const enriched = enrichResolvedFindingKeys(resolved, prev);
    expect(new Set(enriched)).toEqual(new Set(['src/a.ts::F::fp1', 'src/a.ts::T::T']));
  });

  it('handles multiple resolved findings independently', () => {
    const resolved = [
      'src/a.ts::T::Alpha',
      'src/b.ts::T::Beta',
    ];
    const prev = [
      { file: 'src/a.ts', line: 1, title: 'Alpha', fingerprint: 'aaa' },
      { file: 'src/b.ts', line: 1, title: 'Beta', fingerprint: 'bbb' },
      { file: 'src/c.ts', line: 1, title: 'Gamma', fingerprint: 'ccc' },
    ];
    const enriched = new Set(enrichResolvedFindingKeys(resolved, prev));
    expect(enriched).toEqual(new Set([
      'src/a.ts::T::Alpha',
      'src/a.ts::F::aaa',
      'src/b.ts::T::Beta',
      'src/b.ts::F::bbb',
    ]));
  });

  it('deduplicates when seed and prior finding produce the same key', () => {
    const resolved = ['src/a.ts::T::T', 'src/a.ts::F::fp'];
    const prev = [{ file: 'src/a.ts', line: 1, title: 'T', fingerprint: 'fp' }];
    const enriched = enrichResolvedFindingKeys(resolved, prev);
    expect(enriched).toHaveLength(2);
    expect(new Set(enriched)).toEqual(new Set(['src/a.ts::T::T', 'src/a.ts::F::fp']));
  });
});

// ─── persistInlineResolveMemory (FP-F regression #182 + review feedback) ───

describe('persistInlineResolveMemory', () => {
  type UpdateStatusArgs = Parameters<IReviewStore['updateStatus']>;
  type UpdateStatusFn = (...args: UpdateStatusArgs) => Promise<void>;
  interface MockReviewStore extends IReviewStore {
    updateStatusCalls: UpdateStatusArgs[];
    updateStatusImpl: UpdateStatusFn;
  }

  function makeReviewStore(): MockReviewStore {
    const updateStatusCalls: UpdateStatusArgs[] = [];
    let updateStatusImpl: UpdateStatusFn = async () => {};
    const store: MockReviewStore = {
      updateStatusCalls,
      get updateStatusImpl() { return updateStatusImpl; },
      set updateStatusImpl(v: UpdateStatusFn) { updateStatusImpl = v; },
      async upsert() {},
      async claimReview() { return true; },
      async updateStatus(repoFullName, key, status, extra) {
        const args: UpdateStatusArgs = [repoFullName, key, status, extra];
        updateStatusCalls.push(args);
        return updateStatusImpl(...args);
      },
      async queryByPR() { return []; },
    };
    return store;
  }

  function makeLatestReview(over: Partial<ReviewItem> = {}): ReviewItem {
    return {
      repoFullName: 'o/r',
      prNumberCommitSha: '42#abc',
      status: 'complete',
      createdAt: '2026-05-01T00:00:00Z',
      ...over,
    } as ReviewItem;
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('no-ops + logs the no-prior-review diagnostic when latestReview is undefined', async () => {
    const store = makeReviewStore();
    const r = await persistInlineResolveMemory({
      reviewStore: store,
      latestReview: undefined,
      resolvedFindingKeys: ['a::T::x'],
      repoFullName: 'o/r',
      prNumber: 42,
    });
    expect(r).toEqual({ persisted: false, enrichedCount: 0 });
    expect(store.updateStatusCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no prior complete review found/),
      'o/r', 42,
    );
  });

  it('no-ops + logs the no-keys diagnostic when resolvedFindingKeys is empty', async () => {
    const store = makeReviewStore();
    const r = await persistInlineResolveMemory({
      reviewStore: store,
      latestReview: makeLatestReview(),
      resolvedFindingKeys: [],
      repoFullName: 'o/r',
      prNumber: 42,
    });
    expect(r).toEqual({ persisted: false, enrichedCount: 0 });
    expect(store.updateStatusCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no resolved keys derived/),
      'o/r', 42,
    );
  });

  it('persists + logs success on the happy path, enriching with fingerprints from the prior findings', async () => {
    const store = makeReviewStore();
    const latestReview = makeLatestReview({
      findings: [
        { file: 'src/a.ts', line: 1, severity: 'critical', title: 'T', description: '', suggestion: '', fingerprint: 'fp1' } as ReviewItem['findings'] extends (infer X)[] | undefined ? X : never,
      ],
    });
    const r = await persistInlineResolveMemory({
      reviewStore: store,
      latestReview,
      resolvedFindingKeys: ['src/a.ts::T::T'],
      repoFullName: 'o/r',
      prNumber: 42,
    });
    expect(r.persisted).toBe(true);
    expect(r.enrichedCount).toBe(2);
    expect(store.updateStatusCalls).toHaveLength(1);
    const [repo, key, status, extra] = store.updateStatusCalls[0];
    expect(repo).toBe('o/r');
    expect(key).toBe('42#abc');
    expect(status).toBe('complete');
    expect(new Set((extra as { inlineResolvedKeys: string[] }).inlineResolvedKeys)).toEqual(
      new Set(['src/a.ts::T::T', 'src/a.ts::F::fp1']),
    );
    expect(logSpy).toHaveBeenCalled();
  });

  it('unions enriched keys with the existing inlineResolvedKeys on the review (preserves prior memory)', async () => {
    const store = makeReviewStore();
    const latestReview = makeLatestReview({
      inlineResolvedKeys: ['old/key::T::Foo'],
      findings: [],
    });
    await persistInlineResolveMemory({
      reviewStore: store,
      latestReview,
      resolvedFindingKeys: ['new/key::T::Bar'],
      repoFullName: 'o/r',
      prNumber: 42,
    });
    const merged = (store.updateStatusCalls[0][3] as { inlineResolvedKeys: string[] }).inlineResolvedKeys;
    expect(new Set(merged)).toEqual(new Set(['old/key::T::Foo', 'new/key::T::Bar']));
  });

  it('caps the merged set at MAX_INLINE_RESOLVED_KEYS (defensive row-size guard)', async () => {
    const store = makeReviewStore();
    const existing = Array.from({ length: MAX_INLINE_RESOLVED_KEYS + 50 }, (_, i) => `e::T::${i}`);
    await persistInlineResolveMemory({
      reviewStore: store,
      latestReview: makeLatestReview({ inlineResolvedKeys: existing, findings: [] }),
      resolvedFindingKeys: ['new::T::X'],
      repoFullName: 'o/r',
      prNumber: 42,
    });
    const merged = (store.updateStatusCalls[0][3] as { inlineResolvedKeys: string[] }).inlineResolvedKeys;
    expect(merged).toHaveLength(MAX_INLINE_RESOLVED_KEYS);
  });

  it('reports persisted=false + warn-logs (does NOT log success) when updateStatus throws — fixes the misleading-log bug from the PR #185 review', async () => {
    // The pre-fix bug: success log fired regardless of `.catch`. The new
    // contract: log success ONLY on actual await completion, log failure
    // on throw, never both. This guards against the regression.
    const store = makeReviewStore();
    store.updateStatusImpl = async () => { throw new Error('dynamo blew up'); };
    const r = await persistInlineResolveMemory({
      reviewStore: store,
      latestReview: makeLatestReview({ findings: [] }),
      resolvedFindingKeys: ['a::T::x'],
      repoFullName: 'o/r',
      prNumber: 42,
    });
    expect(r.persisted).toBe(false);
    expect(r.enrichedCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/failed to persist inline-resolve keys/),
      'o/r', 42,
      expect.any(Error),
    );
    // Success log MUST NOT fire.
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ─── parseRejectIntent (FB-D) ──────────────────────────────────────────────

describe('parseRejectIntent (FB-D)', () => {
  it('parses a known category with no free-text reason', () => {
    expect(parseRejectIntent('/mergewatch reject already-handled')).toEqual({
      category: 'already-handled',
      text: undefined,
      coerced: false,
    });
  });

  it('parses a known category with a free-text reason', () => {
    expect(parseRejectIntent('/mergewatch reject out-of-scope This is integration-only')).toEqual({
      category: 'out-of-scope',
      text: 'This is integration-only',
      coerced: false,
    });
  });

  it('recognises every locked category', () => {
    for (const cat of REJECT_CATEGORIES) {
      const r = parseRejectIntent(`/mergewatch reject ${cat}`);
      expect(r?.category).toBe(cat);
      expect(r?.coerced).toBe(false);
    }
  });

  it('is case-insensitive on the `/mergewatch reject` prefix AND the category', () => {
    expect(parseRejectIntent('/Mergewatch Reject ALREADY-HANDLED')).toMatchObject({
      category: 'already-handled',
      coerced: false,
    });
  });

  it('silently coerces an unrecognised category to `other`, preserving the typo in the text', () => {
    // Locked design: don't ask the user to re-type — preserve the signal.
    expect(parseRejectIntent('/mergewatch reject typo-cat foo bar')).toEqual({
      category: 'other',
      text: 'typo-cat foo bar',
      coerced: true,
    });
  });

  it('coerces bare `/mergewatch reject` (no category at all) to `other` with no text', () => {
    expect(parseRejectIntent('/mergewatch reject')).toEqual({
      category: 'other',
      text: undefined,
      coerced: true,
    });
  });

  it('returns null when the line shape does not match (no slash command)', () => {
    expect(parseRejectIntent("here's how I'd reject this differently")).toBeNull();
    expect(parseRejectIntent('this finding should be rejected')).toBeNull();
    expect(parseRejectIntent('')).toBeNull();
  });

  it('matches when the command appears after other lines in a multi-line reply', () => {
    const body = 'Thanks for the review.\n/mergewatch reject style-disagreement we use snake_case in python';
    expect(parseRejectIntent(body)).toMatchObject({
      category: 'style-disagreement',
      text: 'we use snake_case in python',
      coerced: false,
    });
  });

  it('does not bleed into a following line (single-line scope)', () => {
    const body = '/mergewatch reject already-handled\nbut on the next line, free text';
    expect(parseRejectIntent(body)).toEqual({
      category: 'already-handled',
      text: undefined,
      coerced: false,
    });
  });
});

// ─── handleInlineReply ──────────────────────────────────────────────────────

interface MockOctokitCalls {
  listReviewComments: ReturnType<typeof vi.fn>;
  createReplyForReviewComment: ReturnType<typeof vi.fn>;
  updateReviewComment: ReturnType<typeof vi.fn>;
  createForPullRequestReviewComment: ReturnType<typeof vi.fn>;
  deleteForPullRequestComment: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
}

function makeOctokitMock(comments: Array<{
  id: number;
  body: string;
  user: { login: string; type: 'User' | 'Bot' };
  in_reply_to_id?: number;
  created_at?: string;
  /** FP-F: optional file path the inline review comment is anchored to. */
  path?: string;
}>): { octokit: Octokit; calls: MockOctokitCalls } {
  const calls: MockOctokitCalls = {
    listReviewComments: vi.fn(async () => ({ data: comments })),
    createReplyForReviewComment: vi.fn(async () => ({ data: { id: 99999 } })),
    updateReviewComment: vi.fn(async () => ({ data: {} })),
    createForPullRequestReviewComment: vi.fn(async () => ({ data: { id: 777 } })),
    deleteForPullRequestComment: vi.fn(async () => ({})),
    graphql: vi.fn(async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: 'THREAD_NODE_ID', comments: { nodes: comments.map((c) => ({ databaseId: c.id })) } }],
          },
        },
      },
    })),
  };
  const octokit = {
    pulls: {
      listReviewComments: calls.listReviewComments,
      createReplyForReviewComment: calls.createReplyForReviewComment,
      updateReviewComment: calls.updateReviewComment,
    },
    reactions: {
      createForPullRequestReviewComment: calls.createForPullRequestReviewComment,
      deleteForPullRequestComment: calls.deleteForPullRequestComment,
    },
    graphql: calls.graphql,
  } as unknown as Octokit;
  return { octokit, calls };
}

function makeLLM(response: string): ILLMProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async invoke(_modelId: string, prompt: string) {
      calls.push(prompt);
      return { text: response };
    },
  };
}

const baseComments = [
  { id: 100, body: '<!-- mergewatch-inline -->\nMissing try/catch around this call.', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, created_at: '2026-04-01T00:00:00Z' },
  { id: 101, body: 'We handle errors with middleware — see packages/server/middleware/error.ts.', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
];

describe('handleInlineReply', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips when the thread root is not bot-authored', async () => {
    const { octokit } = makeOctokitMock([
      { id: 100, body: 'human top comment', user: { login: 'alice', type: 'User' } },
      { id: 101, body: 'reply', user: { login: 'bob', type: 'User' }, in_reply_to_id: 100 },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('skipped');
    expect(llm.calls).toHaveLength(0);
  });

  it('skips when the thread root is a third-party bot (CopilotAI, dependabot, etc.)', async () => {
    // Root is bot-authored but lacks the MergeWatch inline marker — exactly
    // the CopilotAI-thread scenario we want to ignore so MergeWatch doesn't
    // barge into conversations it didn't start.
    const { octokit } = makeOctokitMock([
      { id: 100, body: '**🔴 Possible null deref**\n\nDescription from another reviewer.', user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' as const } },
      { id: 101, body: 'thanks!', user: { login: 'alice', type: 'User' as const }, in_reply_to_id: 100 },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('skipped');
    expect(llm.calls).toHaveLength(0);
  });

  it('skips when the reply is not at the tip of the thread', async () => {
    // replyCommentId points to the root, not the latest comment
    const { octokit } = makeOctokitMock(baseComments);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 100 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('skipped');
  });

  it('resolves the thread on explicit resolve intent without calling the LLM', async () => {
    const { octokit, calls } = makeOctokitMock([
      ...baseComments,
      { id: 102, body: '/resolve', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 101, created_at: '2026-04-01T02:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 102 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('resolved');
    expect(llm.calls).toHaveLength(0);
    expect(calls.graphql).toHaveBeenCalled();
    // Eyes reaction added + removed
    expect(calls.createForPullRequestReviewComment).toHaveBeenCalled();
    expect(calls.deleteForPullRequestComment).toHaveBeenCalled();
  });

  it('FP-F (#182) — resolve recovers the embedded fingerprint key directly, surviving title rewording', async () => {
    // Build a real inline comment from a critical finding (with a W9
    // fingerprint), exactly as the review pipeline does — the round-trip
    // through buildInlineComments → extractInlineCommentFingerprint is the
    // crux of #182.
    const finding = {
      file: 'src/admin.ts',
      line: 8,
      severity: 'critical' as const,
      title: 'Unauthenticated admin endpoint exposes sensitive data',
      description: 'Anyone can call this.',
      suggestion: '',
      // Code text with chars that would break a raw HTML comment (`--`, `>`).
      fingerprint: "app.get('/admin', (req, res) => res.json(getAllUsers()))",
    };
    const [inline] = buildInlineComments([finding], ['src/admin.ts'], new Map([['src/admin.ts', new Set([8])]]));
    const root = {
      id: 100,
      body: inline.body,
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'src/admin.ts',
    };
    const { octokit } = makeOctokitMock([
      root,
      { id: 101, body: 'resolved', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('resolved');
    // Both the title key AND the stable fingerprint key are derived directly
    // from the comment — no dependency on the prior-review findings lookup.
    expect(result.resolvedFindingKeys).toContain('src/admin.ts::T::Unauthenticated admin endpoint exposes sensitive data');
    expect(result.resolvedFindingKeys).toContain(`src/admin.ts::F::${finding.fingerprint}`);
    // #182: next round, the LLM rewords the title but the code is unchanged
    // (same fingerprint) — the finding still matches the resolved set via the
    // fingerprint key, so it is suppressed rather than re-emitted.
    const rewordedNextRound = {
      file: 'src/admin.ts',
      line: 8,
      title: 'Unauthenticated admin endpoint exposes sensitive USER data',
      fingerprint: finding.fingerprint,
    };
    const stillSuppressed = findingMatchKeys(rewordedNextRound).some((k) => result.resolvedFindingKeys!.includes(k));
    expect(stillSuppressed).toBe(true);
  });

  it('calls the LLM and posts a threaded reply on normal replies', async () => {
    const { octokit, calls } = makeOctokitMock(baseComments);
    const agentResponse = JSON.stringify({
      reply: 'Got it — middleware makes sense here. Reply `resolve` to close this thread.',
      recommendation: 'resolve',
      reasoning: 'valid convention-based dismissal',
    });
    const llm = makeLLM(agentResponse);
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('replied');
    expect(result.recommendation).toBe('resolve');
    expect(result.botCommentId).toBe(99999);
    expect(calls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 100, body: expect.stringContaining('middleware') }),
    );
    // Eyes reaction was added then removed
    expect(calls.createForPullRequestReviewComment).toHaveBeenCalled();
    expect(calls.deleteForPullRequestComment).toHaveBeenCalled();
  });

  it('#233 — prices the reply via customPricing keyed to the light model', async () => {
    const agentResponse = JSON.stringify({
      reply: 'Thanks — that makes sense.',
      recommendation: 'keep',
      reasoning: 'x',
    });
    const ARN = 'arn:aws:bedrock:us-west-2:0:application-inference-profile/abc';
    const llmWithUsage: ILLMProvider = {
      invoke: async () => ({
        text: agentResponse,
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    };

    // Unpriced: the ARN light model isn't in the default table → cost is null.
    {
      const { octokit } = makeOctokitMock(baseComments);
      const result = await handleInlineReply(
        { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
        { octokit, llm: llmWithUsage, lightModelId: ARN },
      );
      expect(result.action).toBe('replied');
      expect(result.estimatedCostUsd).toBeNull();
    }

    // Priced via customPricing keyed to the same ARN → real spend.
    {
      const { octokit } = makeOctokitMock(baseComments);
      const result = await handleInlineReply(
        { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
        {
          octokit,
          llm: llmWithUsage,
          lightModelId: ARN,
          customPricing: { [ARN]: { inputPer1M: 5, outputPer1M: 25 } },
        },
      );
      expect(result.action).toBe('replied');
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
    }
  });

  it('stops engaging once the thread already has MAX_BOT_REPLIES bot replies', async () => {
    const thread = [
      { id: 100, body: 'finding', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, created_at: '2026-04-01T00:00:00Z' },
      { id: 101, body: 'disagree', user: { login: 'alice', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
      { id: 102, body: 'reply 1', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, in_reply_to_id: 100, created_at: '2026-04-01T02:00:00Z' },
      { id: 103, body: 'nope', user: { login: 'alice', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T03:00:00Z' },
      { id: 104, body: 'reply 2', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, in_reply_to_id: 100, created_at: '2026-04-01T04:00:00Z' },
      { id: 105, body: 'still nope', user: { login: 'alice', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T05:00:00Z' },
      { id: 106, body: 'reply 3', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, in_reply_to_id: 100, created_at: '2026-04-01T06:00:00Z' },
      { id: 107, body: 'one more', user: { login: 'alice', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T07:00:00Z' },
    ];
    expect(thread.filter((c) => c.user.type === 'Bot').length).toBe(MAX_BOT_REPLIES + 1);
    const { octokit, calls } = makeOctokitMock(thread);
    const llm = makeLLM('should not be called');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 107 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('skipped');
    expect(llm.calls).toHaveLength(0);
    expect(calls.createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('falls back to a safe reply when the LLM returns invalid JSON', async () => {
    const { octokit, calls } = makeOctokitMock(baseComments);
    const llm = makeLLM('not valid json at all');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('replied');
    expect(result.recommendation).toBe('needs_info');
    expect(calls.createReplyForReviewComment).toHaveBeenCalled();
  });

  it('injects repo conventions into the prompt when provided', async () => {
    const { octokit } = makeOctokitMock(baseComments);
    const llm = makeLLM(JSON.stringify({ reply: 'ok', recommendation: 'keep' }));
    await handleInlineReply(
      {
        owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101,
        conventions: '# We handle errors via middleware',
      },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(llm.calls[0]).toContain('handle errors via middleware');
    expect(llm.calls[0]).not.toContain('{{CONVENTIONS}}');
  });

  it('skips resolve when the GraphQL thread lookup returns null', async () => {
    const { octokit, calls } = makeOctokitMock([
      ...baseComments,
      { id: 102, body: '/resolve', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 101, created_at: '2026-04-01T02:00:00Z' },
    ]);
    // Override the graphql mock to return no matching thread
    (calls.graphql as any).mockImplementation(async () => ({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    }));
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 102 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('skipped');
    expect(result.reason).toMatch(/thread id/);
  });

  it('removes the eyes reaction even when the LLM throws', async () => {
    const { octokit, calls } = makeOctokitMock(baseComments);
    const llm: ILLMProvider = {
      invoke: vi.fn(async () => { throw new Error('boom'); }),
    };
    await expect(handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    )).rejects.toThrow('boom');
    expect(calls.deleteForPullRequestComment).toHaveBeenCalled();
  });

  // ─── FP-F — surface stable identity keys for the resolved finding ─────────

  it('FP-F — returns resolvedFindingKeys when the root inline comment has a path + title', async () => {
    // Root body uses the canonical inline-finding shape (`<!-- mergewatch-inline -->`
    // + `**🔴 <title>**`) so extractInlineCommentTitle can recover the title.
    const inlineRoot = {
      id: 100,
      body: '<!-- mergewatch-inline -->\n**🔴 Missing try/catch around this call**\n\nWrap fetch() so a network error doesn\'t crash the worker.',
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'packages/server/src/worker.ts',
    };
    const { octokit } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: 'looks fine to me', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
      { id: 102, body: '/resolve', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 101, created_at: '2026-04-01T02:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 102 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('resolved');
    expect(result.resolvedFindingKeys).toEqual([
      'packages/server/src/worker.ts::T::Missing try/catch around this call',
    ]);
  });

  it('FP-F — leaves resolvedFindingKeys undefined when the root has no path (older inline comments)', async () => {
    // No `path` on the root → can't derive the file portion of the match key.
    // Resolution itself still succeeds; just no key memory is surfaced.
    const { octokit } = makeOctokitMock([
      { id: 100, body: '<!-- mergewatch-inline -->\n**🔴 Title here**\n\nDesc.', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, created_at: '2026-04-01T00:00:00Z' },
      { id: 101, body: '/resolve', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('resolved');
    expect(result.resolvedFindingKeys).toBeUndefined();
  });

  it('FP-F — leaves resolvedFindingKeys undefined when the body has no `**🔴 …**` title', async () => {
    // Body has the marker but pre-W6 / non-finding shape → no recoverable title.
    const { octokit } = makeOctokitMock([
      { id: 100, body: '<!-- mergewatch-inline -->\nFreeform note without the bold-red-emoji title.', user: { login: 'mergewatch[bot]', type: 'Bot' as const }, path: 'a.ts', created_at: '2026-04-01T00:00:00Z' },
      { id: 101, body: '/resolve', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('resolved');
    expect(result.resolvedFindingKeys).toBeUndefined();
  });

  it('FP-F — keys are NOT emitted on non-resolve replies (only on the explicit-resolve fast path)', async () => {
    const inlineRoot = {
      id: 100,
      body: '<!-- mergewatch-inline -->\n**🔴 Some title**\n\nDesc.',
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'src/a.ts',
    };
    const { octokit } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: 'not a resolve reply — just a discussion', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM(JSON.stringify({ reply: 'ack', recommendation: 'keep' }));
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('replied');
    expect(result.resolvedFindingKeys).toBeUndefined();
  });

  // ─── FB-D — /mergewatch reject ───────────────────────────────────────────

  it('FB-D — `/mergewatch reject <category>` returns action=rejected with category + match keys', async () => {
    const inlineRoot = {
      id: 100,
      body: '<!-- mergewatch-inline -->\n**🔴 Missing try/catch around this call**\n\nWrap fetch().',
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'packages/server/src/worker.ts',
    };
    const { octokit, calls } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: '/mergewatch reject already-handled We use a middleware', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('rejected');
    expect(result.rejectCategory).toBe('already-handled');
    expect(result.rejectText).toBe('We use a middleware');
    expect(result.rejectedFindingKeys).toEqual([
      'packages/server/src/worker.ts::T::Missing try/catch around this call',
    ]);
    // Zero LLM cost on the fast path.
    expect(llm.calls).toHaveLength(0);
    // Bot confirms by EDITING the finding comment (append a footer), NOT a
    // thread reply — a reply is auto-wrapped into a spurious COMMENTED Review
    // (#190). The original body is preserved and the category + sentinel added.
    expect(calls.createReplyForReviewComment).not.toHaveBeenCalled();
    expect(calls.updateReviewComment).toHaveBeenCalledTimes(1);
    const editArg = (calls.updateReviewComment as any).mock.calls[0][0];
    expect(editArg.comment_id).toBe(100);
    expect(editArg.body).toContain(inlineRoot.body);
    expect(editArg.body).toContain('already-handled');
    expect(editArg.body).toContain('Marked **rejected**');
    expect(editArg.body).toContain('<!-- mergewatch-rejected -->');
    expect(result.botCommentId).toBe(100);
    // Does NOT auto-resolve the thread (orthogonal verbs).
    expect(calls.graphql).not.toHaveBeenCalled();
  });

  it('FB-D — bot reply explains the silent-other coercion when the user mistypes', async () => {
    const inlineRoot = {
      id: 100,
      body: '<!-- mergewatch-inline -->\n**🔴 Some title**\n\nDesc.',
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'src/a.ts',
    };
    const { octokit, calls } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: '/mergewatch reject typo-cat foo', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('rejected');
    expect(result.rejectCategory).toBe('other');
    expect(result.rejectText).toBe('typo-cat foo');
    expect(calls.createReplyForReviewComment).not.toHaveBeenCalled();
    const editArg = (calls.updateReviewComment as any).mock.calls[0][0];
    expect(editArg.body).toContain('other');
    expect(editArg.body).toMatch(/known reject category/i);
  });

  it('FB-D — re-delivery on an already-rejected finding is an idempotent no-op', async () => {
    const inlineRoot = {
      id: 100,
      body: "<!-- mergewatch-inline -->\n**🔴 Some title**\n\nDesc.\n\n<!-- mergewatch-rejected -->\n---\n> ✅ Marked **rejected** (`style-disagreement`) — won't re-raise.",
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'src/a.ts',
    };
    const { octokit, calls } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: '/mergewatch reject style-disagreement', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    // Sentinel already present → skip without re-editing or re-recording.
    expect(result.action).toBe('skipped');
    expect(result.reason).toMatch(/already marked rejected/i);
    expect(calls.updateReviewComment).not.toHaveBeenCalled();
    expect(calls.createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('FB-D — resolve takes precedence when both `/resolve` and `/mergewatch reject` appear in the same reply', async () => {
    // Document the locked precedence: explicit `/resolve` wins (the
    // handler checks resolve intent BEFORE reject intent in the
    // fast-path chain). Users wanting BOTH should reject first, then
    // resolve separately.
    const inlineRoot = {
      id: 100,
      body: '<!-- mergewatch-inline -->\n**🔴 Some title**\n\nDesc.',
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
      path: 'src/a.ts',
    };
    const { octokit } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: '/resolve\n/mergewatch reject already-handled', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('resolved');
    expect(result.rejectCategory).toBeUndefined();
  });

  it('FB-D — `/mergewatch reject` without a recoverable finding still posts a confirmation and returns the category (no keys)', async () => {
    // Root has no `path` → keys can't be derived. The category + text
    // still surface so the bot's confirmation reply is correct; the
    // dispute-write path in the handler will be a no-op when keys is
    // empty (recordDisputes guards on empty array).
    const inlineRoot = {
      id: 100,
      body: '<!-- mergewatch-inline -->\n**🔴 Title**\n\nDesc.',
      user: { login: 'mergewatch[bot]', type: 'Bot' as const },
      created_at: '2026-04-01T00:00:00Z',
    };
    const { octokit } = makeOctokitMock([
      inlineRoot,
      { id: 101, body: '/mergewatch reject other', user: { login: 'santthosh', type: 'User' as const }, in_reply_to_id: 100, created_at: '2026-04-01T01:00:00Z' },
    ]);
    const llm = makeLLM('unused');
    const result = await handleInlineReply(
      { owner: 'o', repo: 'r', prNumber: 1, replyCommentId: 101 },
      { octokit, llm, lightModelId: 'light' },
    );
    expect(result.action).toBe('rejected');
    expect(result.rejectCategory).toBe('other');
    expect(result.rejectedFindingKeys).toBeUndefined();
  });
});
