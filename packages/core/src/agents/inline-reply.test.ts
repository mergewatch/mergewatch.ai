import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ILLMProvider } from '../llm/types.js';
import { handleInlineReply, detectResolveIntent, MAX_BOT_REPLIES } from './inline-reply.js';

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

// ─── handleInlineReply ──────────────────────────────────────────────────────

interface MockOctokitCalls {
  listReviewComments: ReturnType<typeof vi.fn>;
  createReplyForReviewComment: ReturnType<typeof vi.fn>;
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
});
