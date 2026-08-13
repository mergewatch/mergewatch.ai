import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureBillingIssue, closeBillingIssue, postBlockedCheckRun } from './block-notify';

// Mock DynamoDB layer
vi.mock('./dynamo-billing', () => ({
  updateBillingFields: vi.fn(),
}));

import { updateBillingFields } from './dynamo-billing';
const mockUpdateFields = vi.mocked(updateBillingFields);

// Helper: create a mock DynamoDB client
function createMockDynamo(sendBehavior?: (cmd: any) => any) {
  return {
    send: vi.fn(sendBehavior ?? (() => Promise.resolve({}))),
  } as any;
}

// Helper: create a mock Octokit
function createMockOctokit(overrides: Record<string, any> = {}) {
  return {
    issues: {
      create: vi.fn().mockResolvedValue({ data: { number: 42 } }),
      update: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    },
    checks: {
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as any;
}

const table = 'test-table';
const installationId = 'inst-123';
const owner = 'acme';
const repo = 'webapp';

describe('ensureBillingIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a GitHub issue and stores issue number on success', async () => {
    const client = createMockDynamo();
    const octokit = createMockOctokit();

    await ensureBillingIssue(octokit, owner, repo, installationId, client, table);

    // DynamoDB conditional write was sent
    expect(client.send).toHaveBeenCalledTimes(1);

    // GitHub issue was created
    expect(octokit.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        repo,
        title: expect.stringContaining('credits required'),
        labels: ['mergewatch'],
      }),
    );

    // Issue number stored in DynamoDB
    expect(mockUpdateFields).toHaveBeenCalledWith(client, table, installationId, {
      blockIssueNumber: 42,
      blockIssueRepo: 'acme/webapp',
    });
  });

  it('returns early when conditional check fails (issue already claimed)', async () => {
    const condErr = new Error('Conditional check failed');
    (condErr as any).name = 'ConditionalCheckFailedException';
    const client = createMockDynamo(() => Promise.reject(condErr));
    const octokit = createMockOctokit();

    await ensureBillingIssue(octokit, owner, repo, installationId, client, table);

    // Should NOT create GitHub issue
    expect(octokit.issues.create).not.toHaveBeenCalled();
    expect(mockUpdateFields).not.toHaveBeenCalled();
  });

  it('throws on non-ConditionalCheckFailed DynamoDB errors', async () => {
    const client = createMockDynamo(() => Promise.reject(new Error('Access denied')));
    const octokit = createMockOctokit();

    await expect(
      ensureBillingIssue(octokit, owner, repo, installationId, client, table),
    ).rejects.toThrow('Access denied');
  });

  it('returns early without storing issue number when GitHub API fails', async () => {
    const client = createMockDynamo();
    const octokit = createMockOctokit({
      issues: {
        create: vi.fn().mockRejectedValue(new Error('GitHub API error')),
      },
    });

    // Should not throw
    await ensureBillingIssue(octokit, owner, repo, installationId, client, table);

    // Should NOT store issue number
    expect(mockUpdateFields).not.toHaveBeenCalled();
  });
});

describe('closeBillingIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the issue, adds comment, and clears billing fields', async () => {
    const client = {} as any;
    const octokit = createMockOctokit();

    await closeBillingIssue(octokit, installationId, client, table, 42, 'acme/webapp');

    expect(octokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'webapp',
        issue_number: 42,
        state: 'closed',
      }),
    );

    expect(octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining('Credits have been added'),
      }),
    );

    // Billing fields cleared
    expect(mockUpdateFields).toHaveBeenCalledWith(client, table, installationId, {
      blockedAt: undefined,
      blockIssueNumber: undefined,
      blockIssueRepo: undefined,
    });
  });

  it('still clears billing fields when GitHub API fails', async () => {
    const client = {} as any;
    const octokit = createMockOctokit({
      issues: {
        update: vi.fn().mockRejectedValue(new Error('Not found')),
        createComment: vi.fn(),
      },
    });

    await closeBillingIssue(octokit, installationId, client, table, 42, 'acme/webapp');

    // Billing fields should still be cleared even if GitHub fails
    expect(mockUpdateFields).toHaveBeenCalled();
  });
});

describe('postBlockedCheckRun', () => {
  it('creates a check run with action_required conclusion', async () => {
    const octokit = createMockOctokit();

    await postBlockedCheckRun(octokit, owner, repo, 'abc1234');

    expect(octokit.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        repo,
        head_sha: 'abc1234',
        conclusion: 'action_required',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// OSS Program block copy (#261)
// ---------------------------------------------------------------------------

describe('block notifications — OSS variant (#261)', () => {
  it('defaults to credits copy, unchanged from pre-#261', async () => {
    const octokit = createMockOctokit();
    await postBlockedCheckRun(octokit, owner, repo, 'sha123');

    const { output } = octokit.checks.create.mock.calls[0][0];
    expect(output.title).toContain('credits required');
    expect(output.summary).toContain('dashboard/billing');
  });

  it('points a lapsed OSS grant at renewal and BYOK, never at a credit card', async () => {
    const octokit = createMockOctokit();
    await postBlockedCheckRun(octokit, owner, repo, 'sha123', 'oss');

    const { output } = octokit.checks.create.mock.calls[0][0];
    expect(output.title).toContain('open-source grant');
    expect(output.summary).toContain('mergewatch.ai/open-source');
    expect(output.summary).not.toContain('dashboard/billing');
    expect(output.summary).not.toContain('add credits');
  });

  it('files an OSS-worded issue rather than a credits one', async () => {
    const octokit = createMockOctokit();
    const client = createMockDynamo();

    await ensureBillingIssue(octokit, owner, repo, 'inst-1', client, 'tbl', 'oss');

    const issue = octokit.issues.create.mock.calls[0][0];
    expect(issue.title).toContain('open-source grant');
    expect(issue.body).toContain('there is no charge');
    expect(issue.body).not.toContain('dashboard/billing');
  });
});
