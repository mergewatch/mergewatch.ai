import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the handler so the module sees
// mocked versions of @mergewatch/core, the AWS SDKs, and the SSM auth provider.
// ---------------------------------------------------------------------------

const mockEnqueue = vi.fn().mockResolvedValue({});
const mockFindExistingBotComment = vi.fn().mockResolvedValue(null);
const mockFetchRepoConfig = vi.fn();
const mockClassifyPrSource = vi.fn();
const mockGetInstallationOctokit = vi.fn();

vi.mock('@mergewatch/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergewatch/core')>();
  return {
    ...actual,
    findExistingBotComment: (...args: unknown[]) => mockFindExistingBotComment(...args),
    fetchRepoConfig: (...args: unknown[]) => mockFetchRepoConfig(...args),
    classifyPrSource: (...args: unknown[]) => mockClassifyPrSource(...args),
  };
});

const mockSqsSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send(cmd: unknown) { return mockSqsSend(cmd); }
  },
  SendMessageCommand: class {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  },
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send(cmd: unknown) { return mockEnqueue(cmd); }
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  },
  InvocationType: { Event: 'Event' },
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { send() { return Promise.resolve({}); } },
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: () => Promise.resolve({}) }),
  },
  PutCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
}));

vi.mock('../github-auth-ssm.js', () => ({
  SSMGitHubAuthProvider: class {
    getInstallationOctokit(id: number) { return mockGetInstallationOctokit(id); }
  },
  getWebhookSecret: () => Promise.resolve('test-secret'),
}));

import { verifySignature, parseReviewMode, shouldHandleReviewCommentEvent, isMergeWatchCheckRun, handler } from './webhook.js';
import { REVIEW_TRIGGERING_ACTIONS, COMMENT_LOOKUP_ACTIONS, MERGEWATCH_CHECK_RUN_NAME } from '@mergewatch/core';
import type { PullRequestReviewCommentEvent, PullRequestEvent, CheckRunEvent } from '@mergewatch/core';

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
    expect(verifySignature(secret, body, sign(body))).toBe(true);
  });

  it('returns false when signature header is undefined', () => {
    expect(verifySignature(secret, '{}', undefined)).toBe(false);
  });

  it('returns false when signature header is empty string', () => {
    expect(verifySignature(secret, '{}', '')).toBe(false);
  });

  it('returns false for a wrong signature', () => {
    expect(verifySignature(secret, '{}', 'sha256=deadbeef')).toBe(false);
  });

  it('returns false when body has been tampered with', () => {
    const original = '{"action":"opened"}';
    const tampered = '{"action":"closed"}';
    expect(verifySignature(secret, tampered, sign(original))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseReviewMode
// ---------------------------------------------------------------------------

describe('parseReviewMode', () => {
  it('returns "review" for "@mergewatch review"', () => {
    expect(parseReviewMode('@mergewatch review')).toBe('review');
  });

  it('returns "summary" for "@mergewatch summary"', () => {
    expect(parseReviewMode('@mergewatch summary')).toBe('summary');
  });

  it('returns "review" for bare "@mergewatch" at end of string', () => {
    expect(parseReviewMode('@mergewatch')).toBe('review');
  });

  it('returns "respond" for "@mergewatch" followed by arbitrary text', () => {
    expect(parseReviewMode('Hey @mergewatch can you explain this?')).toBe('respond');
  });

  it('returns null when @mergewatch is not mentioned', () => {
    expect(parseReviewMode('This is a regular comment')).toBeNull();
  });

  it('is case-insensitive for @MergeWatch', () => {
    expect(parseReviewMode('@MergeWatch review')).toBe('review');
  });

  it('is case-insensitive for @MERGEWATCH', () => {
    expect(parseReviewMode('@MERGEWATCH summary')).toBe('summary');
  });

  it('returns "review" for "@mergewatch" on its own line in a multi-line comment', () => {
    expect(parseReviewMode('Please review this\n@mergewatch\nThanks')).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// REVIEW_TRIGGERING_ACTIONS & COMMENT_LOOKUP_ACTIONS
// ---------------------------------------------------------------------------

describe('REVIEW_TRIGGERING_ACTIONS', () => {
  it('includes opened, synchronize, ready_for_review, and reopened', () => {
    expect(REVIEW_TRIGGERING_ACTIONS).toContain('opened');
    expect(REVIEW_TRIGGERING_ACTIONS).toContain('synchronize');
    expect(REVIEW_TRIGGERING_ACTIONS).toContain('ready_for_review');
    expect(REVIEW_TRIGGERING_ACTIONS).toContain('reopened');
  });

  it('does not include non-review actions', () => {
    expect(REVIEW_TRIGGERING_ACTIONS).not.toContain('closed');
    expect(REVIEW_TRIGGERING_ACTIONS).not.toContain('edited');
    expect(REVIEW_TRIGGERING_ACTIONS).not.toContain('converted_to_draft');
  });
});

describe('COMMENT_LOOKUP_ACTIONS', () => {
  it('includes actions where existing comments should be looked up', () => {
    expect(COMMENT_LOOKUP_ACTIONS).toContain('synchronize');
    expect(COMMENT_LOOKUP_ACTIONS).toContain('ready_for_review');
    expect(COMMENT_LOOKUP_ACTIONS).toContain('reopened');
  });

  it('does not include opened (first review creates a new comment)', () => {
    expect(COMMENT_LOOKUP_ACTIONS).not.toContain('opened');
  });
});

// ---------------------------------------------------------------------------
// shouldHandleReviewCommentEvent
// ---------------------------------------------------------------------------

describe('shouldHandleReviewCommentEvent', () => {
  function makeEvent(overrides: Partial<PullRequestReviewCommentEvent> = {}): PullRequestReviewCommentEvent {
    return {
      action: 'created',
      sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
      installation: { id: 123 },
      comment: {
        id: 1001,
        body: 'reply body',
        pull_request_review_id: null,
        in_reply_to_id: 1000,
        node_id: 'node-id',
        user: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
        path: 'src/foo.ts',
        commit_id: 'abc',
      },
      pull_request: { number: 5 } as any,
      repository: { name: 'r', owner: { login: 'o' } } as any,
      ...overrides,
    };
  }

  it('returns true for a valid human reply with installation id', () => {
    expect(shouldHandleReviewCommentEvent(makeEvent())).toBe(true);
  });

  it('returns false for non-created actions', () => {
    expect(shouldHandleReviewCommentEvent(makeEvent({ action: 'edited' }))).toBe(false);
    expect(shouldHandleReviewCommentEvent(makeEvent({ action: 'deleted' }))).toBe(false);
  });

  it('returns false for bot senders (loop guard)', () => {
    expect(shouldHandleReviewCommentEvent(makeEvent({
      sender: { login: 'mergewatch[bot]', id: 2, avatar_url: '', type: 'Bot' },
    }))).toBe(false);
  });

  it('returns false when sender login ends with [bot] even with type=User', () => {
    expect(shouldHandleReviewCommentEvent(makeEvent({
      sender: { login: 'copilot-pull-request-reviewer[bot]', id: 2, avatar_url: '', type: 'User' },
    }))).toBe(false);
  });

  it('returns false when comment author is a bot but sender is human', () => {
    const evt = makeEvent({ sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' } });
    evt.comment.user = { login: 'dependabot[bot]', id: 9, avatar_url: '', type: 'Bot' };
    expect(shouldHandleReviewCommentEvent(evt)).toBe(false);
  });

  it('returns false when comment author login carries [bot] suffix', () => {
    const evt = makeEvent({ sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' } });
    evt.comment.user = { login: 'CopilotAI[bot]', id: 9, avatar_url: '', type: 'User' };
    expect(shouldHandleReviewCommentEvent(evt)).toBe(false);
  });

  it('returns false when the comment is not a reply (no in_reply_to_id)', () => {
    const evt = makeEvent();
    delete (evt.comment as any).in_reply_to_id;
    expect(shouldHandleReviewCommentEvent(evt)).toBe(false);
  });

  it('returns false when installation metadata is missing', () => {
    const evt = makeEvent();
    evt.installation = undefined;
    expect(shouldHandleReviewCommentEvent(evt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handler — agent-source classification on pull_request events
// ---------------------------------------------------------------------------

function signBody(body: string, secret = 'test-secret'): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

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

function makeApiGatewayEvent(body: string): any {
  return {
    body,
    headers: {
      'x-hub-signature-256': signBody(body),
      'x-github-event': 'pull_request',
    },
  };
}

describe('handler — agent-source classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue({});
    mockFetchRepoConfig.mockResolvedValue(null);
  });

  it('propagates source=agent and agentKind into the enqueued payload', async () => {
    mockFetchRepoConfig.mockResolvedValue({
      agentReview: { enabled: true, detection: { branchPrefixes: ['claude/'] } },
    });
    mockClassifyPrSource.mockResolvedValue({
      source: 'agent',
      agentKind: 'claude',
      matchedRule: 'branch',
    });

    const body = JSON.stringify(makePullRequestEvent());
    const res = await handler(makeApiGatewayEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockClassifyPrSource).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const invokeInput = (mockEnqueue.mock.calls[0][0] as { input: { Payload: Buffer } }).input;
    const payload = JSON.parse(invokeInput.Payload.toString());
    expect(payload.source).toBe('agent');
    expect(payload.agentKind).toBe('claude');
  });

  it('passes undefined agentReview config when repo YAML has no agentReview block', async () => {
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });

    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    expect(mockClassifyPrSource).toHaveBeenCalledTimes(1);
    // Third argument to classifyPrSource is the agentReview config.
    const callArgs = mockClassifyPrSource.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });

  it('populates agentReview config when repo YAML opts in', async () => {
    mockFetchRepoConfig.mockResolvedValue({
      agentReview: { enabled: true },
    });
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });

    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    const callArgs = mockClassifyPrSource.mock.calls[0];
    expect(callArgs[2]).toBeDefined();
    expect(callArgs[2].enabled).toBe(true);
    // mergeConfig fills the detection block with defaults.
    expect(callArgs[2].detection).toBeDefined();
  });

  it('propagates source=human when classifier returns human', async () => {
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });

    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    const invokeInput = (mockEnqueue.mock.calls[0][0] as { input: { Payload: Buffer } }).input;
    const payload = JSON.parse(invokeInput.Payload.toString());
    expect(payload.source).toBe('human');
    expect(payload.agentKind).toBeUndefined();
  });

  it('runs classification on synchronize events (not only opened)', async () => {
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
    mockFindExistingBotComment.mockResolvedValue(123);

    const body = JSON.stringify(makePullRequestEvent({ action: 'synchronize' }));
    await handler(makeApiGatewayEvent(body));

    expect(mockClassifyPrSource).toHaveBeenCalledTimes(1);
    const invokeInput = (mockEnqueue.mock.calls[0][0] as { input: { Payload: Buffer } }).input;
    const payload = JSON.parse(invokeInput.Payload.toString());
    expect(payload.source).toBe('human');
    expect(payload.existingCommentId).toBe(123);
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
  return {
    action: overrides.action ?? 'rerequested',
    check_run: {
      id: 9001,
      name: overrides.name ?? MERGEWATCH_CHECK_RUN_NAME,
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      app: { id: 42, slug: 'mergewatch-ai', name: 'MergeWatch' },
      pull_requests: overrides.pullRequests ?? [
        {
          number: 42,
          head: {
            label: 'user:feat',
            ref: 'feat',
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
        },
      ],
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

function makeCheckRunApiEvent(body: string) {
  return {
    body,
    headers: {
      'x-hub-signature-256': signBody(body),
      'x-github-event': 'check_run',
    },
  } as any;
}

describe('isMergeWatchCheckRun', () => {
  it('returns true when check_run.name is MergeWatch Review', () => {
    expect(isMergeWatchCheckRun(makeCheckRunEvent())).toBe(true);
  });

  it('returns false for unrelated check runs (e.g., CodeQL)', () => {
    expect(isMergeWatchCheckRun(makeCheckRunEvent({ name: 'CodeQL' }))).toBe(false);
  });

  it('returns false when name is missing', () => {
    const event = makeCheckRunEvent();
    (event.check_run as unknown as { name: undefined }).name = undefined;
    expect(isMergeWatchCheckRun(event)).toBe(false);
  });
});

describe('handler — check_run.rerequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            draft: false,
            labels: [{ name: 'needs-review' }],
            changed_files: 3,
          },
        }),
      },
    });
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
  });

  it('enqueues a review job with existingCommentId', async () => {
    mockFindExistingBotComment.mockResolvedValue(555);
    const body = JSON.stringify(makeCheckRunEvent());
    const res = await handler(makeCheckRunApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const invokeInput = (mockEnqueue.mock.calls[0][0] as { input: { Payload: Buffer } }).input;
    const payload = JSON.parse(invokeInput.Payload.toString());
    expect(payload.prNumber).toBe(42);
    expect(payload.mode).toBe('review');
    expect(payload.existingCommentId).toBe(555);
    expect(payload.prLabels).toEqual(['needs-review']);
    expect(payload.changedFileCount).toBe(3);
  });

  it('ignores check_run actions other than rerequested', async () => {
    const body = JSON.stringify(makeCheckRunEvent({ action: 'created' }));
    const res = await handler(makeCheckRunApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('ignores check runs from other apps (name mismatch)', async () => {
    const body = JSON.stringify(makeCheckRunEvent({ name: 'CodeQL' }));
    const res = await handler(makeCheckRunApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does nothing when installation id is missing', async () => {
    const body = JSON.stringify(makeCheckRunEvent({ installation: undefined }));
    const res = await handler(makeCheckRunApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does nothing when the check is not attached to any PR', async () => {
    const body = JSON.stringify(makeCheckRunEvent({ pullRequests: [] }));
    const res = await handler(makeCheckRunApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// OSS Program repo identity (#261)
// ---------------------------------------------------------------------------

describe('handler — OSS repo identity on the job payload (#261)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue({});
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
  });

  function enqueuedPayload() {
    const invokeInput = (mockEnqueue.mock.calls[0][0] as { input: { Payload: Buffer } }).input;
    return JSON.parse(invokeInput.Payload.toString());
  }

  it('forwards repoId and isPublic for a public repo', async () => {
    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    const payload = enqueuedPayload();
    expect(payload.repoId).toBe(1);
    expect(payload.isPublic).toBe(true);
  });

  it('reports isPublic=false for a private repo', async () => {
    // The gate re-checks visibility on every review precisely so a repo
    // flipped private stops being sponsored — this is the signal it reads.
    const event = makePullRequestEvent();
    event.repository.private = true;
    const body = JSON.stringify(event);
    await handler(makeApiGatewayEvent(body));

    expect(enqueuedPayload().isPublic).toBe(false);
  });

  it('carries the numeric repo id, not the name', async () => {
    // Grants match on the immutable id so a rename or transfer can't lapse them.
    const event = makePullRequestEvent();
    event.repository.id = 987654;
    const body = JSON.stringify(event);
    await handler(makeApiGatewayEvent(body));

    expect(enqueuedPayload().repoId).toBe(987654);
  });
});

// ---------------------------------------------------------------------------
// #355 — review jobs go through SQS when the queue is configured
// ---------------------------------------------------------------------------

describe('enqueueReviewJob transport (#355)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue({});
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
    delete process.env.REVIEW_QUEUE_URL;
  });

  it('sends the job to SQS when REVIEW_QUEUE_URL is set — never a direct invoke', async () => {
    process.env.REVIEW_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/1/mergewatch-review-queue-test';
    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const input = (mockSqsSend.mock.calls[0][0] as { input: { QueueUrl: string; MessageBody: string } }).input;
    expect(input.QueueUrl).toContain('mergewatch-review-queue-test');
    const payload = JSON.parse(input.MessageBody);
    expect(payload.mode).toBe('review');
    expect(payload.prNumber).toBeDefined();
  });

  it('falls back to direct async invoke when the queue URL is unset (deploy-order safety)', async () => {
    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config must be read at the PR head ref (#399 / #400)
//
// Both bugs were the same mistake: `.mergewatch.yml` fetched without a ref
// resolves against the DEFAULT BRANCH, so config that lives on the PR branch
// is invisible. That made agentReview detection fall through to 'human' and
// made the whole config block inert on mention-triggered reviews.
// ---------------------------------------------------------------------------

function makeIssueCommentEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    issue: {
      number: 7,
      pull_request: { url: 'https://api.github.com/repos/octo/repo/pulls/7' },
    },
    comment: {
      body: '@mergewatch review',
      user: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
    },
    sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'octo/repo',
      owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' },
      private: false,
      html_url: '',
      default_branch: 'main',
      visibility: 'public',
    },
    installation: { id: 99 },
    ...overrides,
  };
}

function makeIssueCommentApiEvent(body: string) {
  return {
    body,
    headers: {
      'x-hub-signature-256': signBody(body),
      'x-github-event': 'issue_comment',
    },
  } as any;
}

describe('handler — repo config is read at the PR head ref (#399/#400)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoConfig.mockResolvedValue(null);
    mockClassifyPrSource.mockResolvedValue({ source: 'human' });
    mockFindExistingBotComment.mockResolvedValue(null);
  });

  function enqueuedPayload() {
    const invokeInput = (mockEnqueue.mock.calls[0][0] as { input: { Payload: Buffer } }).input;
    return JSON.parse(invokeInput.Payload.toString());
  }

  it('fetches .mergewatch.yml at the head SHA when classifying a pull_request (#399)', async () => {
    mockGetInstallationOctokit.mockResolvedValue({});

    const body = JSON.stringify(makePullRequestEvent());
    await handler(makeApiGatewayEvent(body));

    expect(mockFetchRepoConfig).toHaveBeenCalled();
    // (octokit, owner, repo, ref) — the 4th arg is what makes an agentReview
    // block that only exists on the PR branch visible to the classifier.
    expect(mockFetchRepoConfig.mock.calls[0][3]).toBe('abc123');
  });

  it('puts the head SHA on a mention-triggered job so config does not fall back to base (#400)', async () => {
    const mockPullsGet = vi.fn().mockResolvedValue({ data: { head: { sha: 'head-sha-999' } } });
    mockGetInstallationOctokit.mockResolvedValue({ pulls: { get: mockPullsGet } });

    const body = JSON.stringify(makeIssueCommentEvent());
    const res = await handler(makeIssueCommentApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockPullsGet).toHaveBeenCalledWith({ owner: 'octo', repo: 'repo', pull_number: 7 });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const payload = enqueuedPayload();
    expect(payload.mentionTriggered).toBe(true);
    expect(payload.headSha).toBe('head-sha-999');
  });

  it('still enqueues the mention-triggered review when the head-SHA lookup fails', async () => {
    const mockPullsGet = vi.fn().mockRejectedValue(new Error('boom'));
    mockGetInstallationOctokit.mockResolvedValue({ pulls: { get: mockPullsGet } });

    const body = JSON.stringify(makeIssueCommentEvent());
    const res = await handler(makeIssueCommentApiEvent(body));

    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const payload = enqueuedPayload();
    expect(payload.mentionTriggered).toBe(true);
    expect(payload.headSha).toBeUndefined();
  });
});
