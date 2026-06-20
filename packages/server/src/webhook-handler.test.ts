import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// Mock the review-processor BEFORE importing the webhook handler so we can
// capture the ReviewJobPayload it's handed without actually running a review.
const mockProcessReviewJob = vi.fn().mockResolvedValue(undefined);
vi.mock('./review-processor.js', () => ({
  processReviewJob: (...args: unknown[]) => mockProcessReviewJob(...args),
}));

const mockFindExistingBotComment = vi.fn().mockResolvedValue(null);
const mockFetchRepoConfig = vi.fn().mockResolvedValue(null);
const mockClassifyPrSource = vi.fn().mockResolvedValue({ source: 'human' });

vi.mock('@mergewatch/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergewatch/core')>();
  return {
    ...actual,
    findExistingBotComment: (...args: unknown[]) => mockFindExistingBotComment(...args),
    fetchRepoConfig: (...args: unknown[]) => mockFetchRepoConfig(...args),
    classifyPrSource: (...args: unknown[]) => mockClassifyPrSource(...args),
  };
});

import { verifySignature, parseReviewMode, isMergeWatchCheckRun, createWebhookHandler } from './webhook-handler.js';
import type { WebhookDeps } from './webhook-handler.js';
import { MERGEWATCH_CHECK_RUN_NAME } from '@mergewatch/core';
import type { IInstallationStore, IReviewStore, IGitHubAuthProvider, ILLMProvider, IPRLifecycleStore, PullRequestEvent, CheckRunEvent, IssueCommentEvent, PullRequestReviewCommentEvent } from '@mergewatch/core';

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  const secret = 'test-webhook-secret';

  function sign(body: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  }

  it('returns true for a valid HMAC-SHA256 signature', () => {
    const body = '{"action":"opened"}';
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    expect(verifySignature('{}', 'sha256=deadbeef', secret)).toBe(false);
  });

  it('returns false when signature length mismatches', () => {
    expect(verifySignature('{}', 'sha256=abc', secret)).toBe(false);
  });

  it('returns false when body has been tampered with', () => {
    const original = '{"action":"opened"}';
    const tampered = '{"action":"closed"}';
    expect(verifySignature(tampered, sign(original), secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseReviewMode
// ---------------------------------------------------------------------------

describe('parseReviewMode', () => {
  it('returns mode "review" for "@mergewatch review"', () => {
    expect(parseReviewMode('@mergewatch review')).toEqual({ mode: 'review' });
  });

  it('returns mode "summary" for "@mergewatch summary"', () => {
    expect(parseReviewMode('@mergewatch summary')).toEqual({ mode: 'summary' });
  });

  it('returns mode "respond" with userComment for bare "@mergewatch" mention', () => {
    const body = 'Hey @mergewatch can you explain this?';
    expect(parseReviewMode(body)).toEqual({ mode: 'respond', userComment: body });
  });

  it('returns null when no @mergewatch is mentioned', () => {
    expect(parseReviewMode('This is a regular comment')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseReviewMode('@MERGEWATCH review')).toEqual({ mode: 'review' });
  });

  it('returns mode "respond" for @mergewatch with unknown subcommand', () => {
    const body = '@mergewatch explain the security implications';
    expect(parseReviewMode(body)).toEqual({ mode: 'respond', userComment: body });
  });

  it('handles @mergewatch alone (defaults to respond since includes check)', () => {
    // "@mergewatch" alone lowercase includes "@mergewatch" so it hits respond
    const body = '@mergewatch';
    expect(parseReviewMode(body)).toEqual({ mode: 'respond', userComment: body });
  });

  it('trims whitespace before checking', () => {
    expect(parseReviewMode('  @mergewatch summary  ')).toEqual({ mode: 'summary' });
  });
});

// ---------------------------------------------------------------------------
// createWebhookHandler — agent-source classification on pull_request events
// ---------------------------------------------------------------------------

function makePullRequestEvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    action: 'opened',
    number: 7,
    pull_request: {
      number: 7,
      title: 'Automated change',
      body: null,
      state: 'open',
      html_url: 'https://github.com/octo/repo/pull/7',
      head: {
        label: 'octo:claude/fix-bug',
        ref: 'claude/fix-bug',
        sha: 'abc123',
        repo: {
          id: 1,
          name: 'repo',
          full_name: 'octo/repo',
          owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
          private: false,
          html_url: '',
          default_branch: 'main',
        },
      },
      base: {
        label: 'octo:main',
        ref: 'main',
        sha: 'def456',
        repo: {
          id: 1,
          name: 'repo',
          full_name: 'octo/repo',
          owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
          private: false,
          html_url: '',
          default_branch: 'main',
        },
      },
      user: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
      draft: false,
      labels: [],
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    },
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'octo/repo',
      owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
      private: false,
      html_url: '',
      default_branch: 'main',
    },
    installation: { id: 999 },
    sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
    ...overrides,
  };
}

function makeDeps(): WebhookDeps {
  return {
    webhookSecret: 'test-secret',
    installationStore: {
      get: vi.fn(),
      getSettings: vi.fn(),
      upsert: vi.fn(),
    } as unknown as IInstallationStore,
    reviewStore: {
      claimReview: vi.fn(),
      updateStatus: vi.fn(),
      queryByPR: vi.fn(),
      upsert: vi.fn(),
    } as unknown as IReviewStore,
    authProvider: {
      getInstallationOctokit: vi.fn().mockResolvedValue({}),
    } as unknown as IGitHubAuthProvider,
    llm: { invoke: vi.fn() } as unknown as ILLMProvider,
    dashboardBaseUrl: 'https://mergewatch.ai',
  };
}

function signBody(body: string, secret = 'test-secret'): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeReqRes(rawBody: string, event = 'pull_request') {
  const req = {
    headers: {
      'x-hub-signature-256': signBody(rawBody),
      'x-github-event': event,
    },
    body: JSON.parse(rawBody),
    rawBody,
  } as any;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as any;
  return { req, res };
}

describe('createWebhookHandler — pull_request classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
    mockFindExistingBotComment.mockResolvedValue(null);
  });

  it('propagates source=agent and agentKind into the review job', async () => {
    mockFetchRepoConfig.mockResolvedValue({
      agentReview: { enabled: true, detection: { branchPrefixes: ['claude/'] } },
    });
    mockClassifyPrSource.mockResolvedValue({
      source: 'agent',
      agentKind: 'claude',
      matchedRule: 'branch',
    });

    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makePullRequestEvent());
    const { req, res } = makeReqRes(body);

    await handler(req, res);
    // processReviewJob is called fire-and-forget; await a microtask so the
    // awaited classification chain completes before we assert.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockClassifyPrSource).toHaveBeenCalledTimes(1);
    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
    const job = mockProcessReviewJob.mock.calls[0][0];
    expect(job.source).toBe('agent');
    expect(job.agentKind).toBe('claude');
  });

  it('passes source=human when classifier returns human', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makePullRequestEvent());
    const { req, res } = makeReqRes(body);

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    const job = mockProcessReviewJob.mock.calls[0][0];
    expect(job.source).toBe('human');
    expect(job.agentKind).toBeUndefined();
  });

  it('passes undefined agentReview config when YAML lacks agentReview', async () => {
    mockFetchRepoConfig.mockResolvedValue(null);
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makePullRequestEvent());
    const { req, res } = makeReqRes(body);

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    const callArgs = mockClassifyPrSource.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });

  it('populates agentReview config when YAML opts in', async () => {
    mockFetchRepoConfig.mockResolvedValue({ agentReview: { enabled: true } });
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makePullRequestEvent());
    const { req, res } = makeReqRes(body);

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    const callArgs = mockClassifyPrSource.mock.calls[0];
    expect(callArgs[2]).toBeDefined();
    expect(callArgs[2].enabled).toBe(true);
    expect(callArgs[2].detection).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TTM (#194) — PR-lifecycle recording on pull_request events
// ---------------------------------------------------------------------------

function makeLifecycleStore(): IPRLifecycleStore {
  return {
    upsertOpened: vi.fn().mockResolvedValue(undefined),
    recordPush: vi.fn().mockResolvedValue(undefined),
    markReviewed: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    markMerged: vi.fn().mockResolvedValue(undefined),
    markClosedUnmerged: vi.fn().mockResolvedValue(undefined),
    listByInstallation: vi.fn().mockResolvedValue({ items: [] }),
  };
}

describe('createWebhookHandler — PR lifecycle recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
    mockFindExistingBotComment.mockResolvedValue(null);
  });

  async function run(event: PullRequestEvent) {
    const prLifecycleStore = makeLifecycleStore();
    const deps = { ...makeDeps(), prLifecycleStore };
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(event);
    const { req, res } = makeReqRes(body);
    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));
    return prLifecycleStore;
  }

  it('records upsertOpened on `opened` and still enqueues the review', async () => {
    const store = await run(makePullRequestEvent({ action: 'opened' }));
    expect(store.upsertOpened).toHaveBeenCalledTimes(1);
    expect(store.upsertOpened).toHaveBeenCalledWith({
      installationId: '999',
      repoFullName: 'octo/repo',
      prNumber: 7,
      prCreatedAt: '2026-04-01T00:00:00Z',
    });
    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
  });

  it('records recordPush on `synchronize`', async () => {
    const store = await run(makePullRequestEvent({ action: 'synchronize' }));
    expect(store.recordPush).toHaveBeenCalledWith('999', 'octo/repo', 7);
    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
  });

  it('records markMerged on `closed` with merged=true and does NOT enqueue a review', async () => {
    const base = makePullRequestEvent({ action: 'closed' });
    const event: PullRequestEvent = {
      ...base,
      pull_request: {
        ...base.pull_request,
        state: 'closed',
        merged: true,
        merged_at: '2026-04-03T12:00:00Z',
        closed_at: '2026-04-03T12:00:00Z',
      },
    };
    const store = await run(event);
    expect(store.markMerged).toHaveBeenCalledWith({
      installationId: '999',
      repoFullName: 'octo/repo',
      prNumber: 7,
      prCreatedAt: '2026-04-01T00:00:00Z',
      at: '2026-04-03T12:00:00Z',
    });
    expect(store.markClosedUnmerged).not.toHaveBeenCalled();
    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('records markClosedUnmerged on `closed` with merged=false and does NOT enqueue a review', async () => {
    const base = makePullRequestEvent({ action: 'closed' });
    const event: PullRequestEvent = {
      ...base,
      pull_request: {
        ...base.pull_request,
        state: 'closed',
        merged: false,
        closed_at: '2026-04-03T12:00:00Z',
      },
    };
    const store = await run(event);
    expect(store.markClosedUnmerged).toHaveBeenCalledWith({
      installationId: '999',
      repoFullName: 'octo/repo',
      prNumber: 7,
      prCreatedAt: '2026-04-01T00:00:00Z',
      at: '2026-04-03T12:00:00Z',
    });
    expect(store.markMerged).not.toHaveBeenCalled();
    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('does not throw when no prLifecycleStore is wired (best-effort no-op)', async () => {
    const deps = makeDeps(); // no prLifecycleStore
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makePullRequestEvent({ action: 'opened' }));
    const { req, res } = makeReqRes(body);
    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// check_run.rerequested dispatch
// ---------------------------------------------------------------------------

function makeCheckRunEvent(overrides: {
  action?: CheckRunEvent['action'];
  name?: string;
  pullRequests?: CheckRunEvent['check_run']['pull_requests'];
  installation?: CheckRunEvent['installation'];
} = {}): CheckRunEvent {
  const prRef = {
    number: 42,
    head: {
      label: 'octo:feat',
      ref: 'feat',
      sha: 'abc123',
      repo: {
        id: 1,
        name: 'repo',
        full_name: 'octo/repo',
        owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' as const },
        private: false,
        html_url: '',
        default_branch: 'main',
      },
    },
    base: {
      label: 'octo:main',
      ref: 'main',
      sha: 'def456',
      repo: {
        id: 1,
        name: 'repo',
        full_name: 'octo/repo',
        owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' as const },
        private: false,
        html_url: '',
        default_branch: 'main',
      },
    },
  };
  return {
    action: overrides.action ?? 'rerequested',
    check_run: {
      id: 9001,
      name: overrides.name ?? MERGEWATCH_CHECK_RUN_NAME,
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      app: { id: 42, slug: 'mergewatch-ai', name: 'MergeWatch' },
      pull_requests: overrides.pullRequests ?? [prRef],
    },
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'octo/repo',
      owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
      private: false,
      html_url: '',
      default_branch: 'main',
    },
    installation: 'installation' in overrides ? overrides.installation : { id: 999 },
    sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
  };
}

describe('isMergeWatchCheckRun', () => {
  it('returns true when check_run.name is MergeWatch Review', () => {
    expect(isMergeWatchCheckRun(makeCheckRunEvent())).toBe(true);
  });

  it('returns false for a check run from another tool', () => {
    expect(isMergeWatchCheckRun(makeCheckRunEvent({ name: 'CodeQL' }))).toBe(false);
  });
});

describe('createWebhookHandler — check_run.rerequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
    mockFindExistingBotComment.mockResolvedValue(null);
  });

  function makeDepsWithPR() {
    const deps = makeDeps();
    (deps.authProvider.getInstallationOctokit as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: { draft: false, labels: [{ name: 'needs-review' }], changed_files: 3 },
          }),
        },
      });
    return deps;
  }

  it('enqueues a review job on rerequested for a MergeWatch check', async () => {
    const deps = makeDepsWithPR();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makeCheckRunEvent());
    const { req, res } = makeReqRes(body, 'check_run');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
    const job = mockProcessReviewJob.mock.calls[0][0];
    expect(job.prNumber).toBe(42);
    expect(job.mode).toBe('review');
    expect(job.changedFileCount).toBe(3);
    expect(job.prLabels).toEqual(['needs-review']);
  });

  it('ignores non-rerequested check_run actions', async () => {
    const deps = makeDepsWithPR();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makeCheckRunEvent({ action: 'created' }));
    const { req, res } = makeReqRes(body, 'check_run');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('ignores check runs from other tools', async () => {
    const deps = makeDepsWithPR();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makeCheckRunEvent({ name: 'CodeQL' }));
    const { req, res } = makeReqRes(body, 'check_run');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('skips when no PR is attached to the check', async () => {
    const deps = makeDepsWithPR();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makeCheckRunEvent({ pullRequests: [] }));
    const { req, res } = makeReqRes(body, 'check_run');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bot-comment filtering (issue_comment + pull_request_review_comment)
// ---------------------------------------------------------------------------

function makeIssueCommentEvent(overrides: {
  senderType?: 'User' | 'Bot';
  senderLogin?: string;
  commentUserType?: 'User' | 'Bot';
  commentUserLogin?: string;
  body?: string;
} = {}): IssueCommentEvent {
  const senderLogin = overrides.senderLogin ?? 'alice';
  const senderType = overrides.senderType ?? 'User';
  return {
    action: 'created',
    comment: {
      id: 555,
      body: overrides.body ?? '@mergewatch review',
      user: {
        login: overrides.commentUserLogin ?? senderLogin,
        id: 2,
        avatar_url: '',
        type: overrides.commentUserType ?? senderType,
      },
      html_url: '',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    },
    issue: {
      number: 42,
      title: 'test',
      body: null,
      state: 'open',
      pull_request: { url: '', html_url: '' },
      user: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
    },
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'octo/repo',
      owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
      private: false,
      html_url: '',
      default_branch: 'main',
    },
    installation: { id: 999 },
    sender: { login: senderLogin, id: 1, avatar_url: '', type: senderType },
  };
}

describe('createWebhookHandler — issue_comment bot filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
  });

  it('skips comments where sender.type=Bot', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makeIssueCommentEvent({ senderType: 'Bot', senderLogin: 'copilot[bot]' }));
    const { req, res } = makeReqRes(body, 'issue_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('skips comments whose author login ends with [bot] even if sender.type=User', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(
      makeIssueCommentEvent({
        senderType: 'User',
        senderLogin: 'copilot-pull-request-reviewer[bot]',
        commentUserLogin: 'copilot-pull-request-reviewer[bot]',
      }),
    );
    const { req, res } = makeReqRes(body, 'issue_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('skips when comment author is a bot but sender is a human', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(
      makeIssueCommentEvent({
        senderType: 'User',
        senderLogin: 'alice',
        commentUserType: 'Bot',
        commentUserLogin: 'dependabot[bot]',
      }),
    );
    const { req, res } = makeReqRes(body, 'issue_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('still processes legitimate human @mergewatch mentions', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(
      makeIssueCommentEvent({ senderType: 'User', senderLogin: 'alice', body: '@mergewatch review' }),
    );
    const { req, res } = makeReqRes(body, 'issue_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
  });
});

function makeReviewCommentEvent(overrides: {
  senderType?: 'User' | 'Bot';
  senderLogin?: string;
  commentUserType?: 'User' | 'Bot';
  commentUserLogin?: string;
  inReplyToId?: number | undefined;
} = {}): PullRequestReviewCommentEvent {
  const senderLogin = overrides.senderLogin ?? 'alice';
  const senderType = overrides.senderType ?? 'User';
  return {
    action: 'created',
    comment: {
      id: 1001,
      body: 'thanks for the review',
      pull_request_review_id: null,
      in_reply_to_id: 'inReplyToId' in overrides ? overrides.inReplyToId! : 1000,
      node_id: 'node-id',
      user: {
        login: overrides.commentUserLogin ?? senderLogin,
        id: 2,
        avatar_url: '',
        type: overrides.commentUserType ?? senderType,
      },
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
      path: 'src/foo.ts',
      commit_id: 'abc',
    },
    pull_request: { number: 5 } as never,
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'octo/repo',
      owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
      private: false,
      html_url: '',
      default_branch: 'main',
    },
    installation: { id: 999 },
    sender: { login: senderLogin, id: 1, avatar_url: '', type: senderType },
  };
}

describe('createWebhookHandler — pull_request_review_comment bot filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips replies where sender.type=Bot', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(makeReviewCommentEvent({ senderType: 'Bot', senderLogin: 'mergewatch[bot]' }));
    const { req, res } = makeReqRes(body, 'pull_request_review_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('skips replies whose author login ends with [bot] (App via OAuth user)', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(
      makeReviewCommentEvent({
        senderType: 'User',
        senderLogin: 'copilot-pull-request-reviewer[bot]',
        commentUserLogin: 'copilot-pull-request-reviewer[bot]',
      }),
    );
    const { req, res } = makeReqRes(body, 'pull_request_review_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('skips replies whose comment author is a bot even when sender is human', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(
      makeReviewCommentEvent({
        senderType: 'User',
        senderLogin: 'alice',
        commentUserType: 'Bot',
        commentUserLogin: 'codeql[bot]',
      }),
    );
    const { req, res } = makeReqRes(body, 'pull_request_review_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).not.toHaveBeenCalled();
  });

  it('still processes a human reply in a bot-rooted thread', async () => {
    const deps = makeDeps();
    const handler = createWebhookHandler(deps);
    const body = JSON.stringify(
      makeReviewCommentEvent({ senderType: 'User', senderLogin: 'alice' }),
    );
    const { req, res } = makeReqRes(body, 'pull_request_review_comment');

    await handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessReviewJob).toHaveBeenCalledTimes(1);
    expect(mockProcessReviewJob.mock.calls[0][0].mode).toBe('inline_reply');
  });
});
