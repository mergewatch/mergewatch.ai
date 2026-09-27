import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @mergewatch/core so we don't pull the full review pipeline. The mock
// returns a hard-coded ReviewPipelineResult and captures the options passed in.
const runReviewPipeline = vi.fn();
const fetchRepoConfig = vi.fn();
const fetchConventions = vi.fn();

vi.mock('@mergewatch/core', async () => {
  const actual = await vi.importActual<typeof import('@mergewatch/core')>('@mergewatch/core');
  return {
    ...actual,
    runReviewPipeline: (...args: unknown[]) => runReviewPipeline(...args),
    fetchRepoConfig: (...args: unknown[]) => fetchRepoConfig(...args),
    fetchConventions: (...args: unknown[]) => fetchConventions(...args),
  };
});

import {
  buildOutput,
  handleReviewDiff,
  splitOwnerRepo,
  validateInput,
} from './review-diff.js';
import type { ReviewPipelineResult } from '@mergewatch/core';
import type { McpServerDeps } from '../server-deps.js';
import type { AuthResolution } from '../middleware/auth.js';

function makeDeps(over: Partial<McpServerDeps> = {}): McpServerDeps {
  return {
    llm: { invoke: vi.fn() } as any,
    authProvider: {
      getInstallationOctokit: vi.fn().mockResolvedValue({} as any),
    },
    installationStore: {} as any,
    reviewStore: {} as any,
    apiKeyStore: {} as any,
    sessionStore: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    billing: {
      check: vi.fn().mockResolvedValue({ status: 'allow', firstBlock: false }),
      record: vi.fn().mockResolvedValue(undefined),
    },
    ddbClient: { send: vi.fn() } as any,
    installationsTable: 'installations-test',
    ...over,
  };
}

function makeAuth(over: Partial<AuthResolution> = {}): AuthResolution {
  return {
    installationId: '42',
    scope: 'all',
    keyHash: 'h',
    ...over,
  };
}

function mockPipelineResult() {
  return {
    summary: 'ok',
    findings: [
      { file: 'a.ts', line: 1, severity: 'warning', category: 'bug', title: 't', description: 'd', suggestion: 's' },
      { file: 'a.ts', line: 2, severity: 'info', category: 'style', title: 't2', description: 'd2', suggestion: 's2' },
      { file: 'b.ts', line: 5, severity: 'critical', category: 'security', title: 't3', description: 'd3', suggestion: 's3' },
    ],
    changedLines: new Map([
      ['a.ts', new Set([1, 2, 3])],
      ['b.ts', new Set([5])],
    ]),
    // #662 — the one critical is a built-in, untagged: it blocks.
    gate: {
      fails: true, blockingCriticalCount: 1, advisoryCriticalCount: 0, unverifiedCriticalCount: 0,
      orgBlockedBy: [], refutedOrgBlockingCount: 0, authorWaivedBlocking: [],
    },
    diagram: '',
    diagramCaption: '',
    mergeScore: 3,
    mergeScoreReason: 'meh',
    suppressedCount: 4,
    filterOutcomes: [],
    parseFailureCount: 0,
    degenerateResponseCount: 0,
    enabledAgentCount: 6,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.12,
    conventionsUsed: false,
    deltaCaption: null,
  } satisfies ReviewPipelineResult;
}

describe('splitOwnerRepo', () => {
  it('parses owner/repo', () => {
    expect(splitOwnerRepo('acme/web')).toEqual({ owner: 'acme', repo: 'web' });
  });

  it('returns null for malformed inputs', () => {
    expect(splitOwnerRepo(undefined)).toBeNull();
    expect(splitOwnerRepo('')).toBeNull();
    expect(splitOwnerRepo('no-slash')).toBeNull();
    expect(splitOwnerRepo('/starts-with-slash')).toBeNull();
    expect(splitOwnerRepo('ends-with-slash/')).toBeNull();
  });
});

describe('validateInput', () => {
  it('accepts a non-empty diff', () => {
    expect(() => validateInput({ diff: 'diff --git' })).not.toThrow();
  });

  it('rejects missing diff', () => {
    expect(() => validateInput({} as any)).toThrow();
  });

  it('rejects empty diff', () => {
    expect(() => validateInput({ diff: '   ' })).toThrow();
  });
});

describe('buildOutput', () => {
  it('shapes stats from the pipeline result', () => {
    const out = buildOutput('sess-1', 2, mockPipelineResult(), 1234);
    expect(out.sessionId).toBe('sess-1');
    expect(out.iteration).toBe(2);
    expect(out.mergeScore).toBe(3);
    expect(out.stats).toEqual({
      filesAnalyzed: 2,
      linesChanged: 4,
      findingsBySeverity: { critical: 1, warning: 1, info: 1 },
      enabledAgentCount: 6,
      suppressedCount: 4,
      durationMs: 1234,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.12,
    });
  });
});

describe('handleReviewDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runReviewPipeline.mockResolvedValue(mockPipelineResult());
    fetchRepoConfig.mockResolvedValue(null);
    fetchConventions.mockResolvedValue(null);
  });

  it('blocks when billing.check returns block', async () => {
    const deps = makeDeps({
      billing: {
        check: vi.fn().mockResolvedValue({ status: 'block', firstBlock: true }),
        record: vi.fn(),
      },
    });
    await expect(
      handleReviewDiff({ diff: 'd' }, deps, makeAuth()),
    ).rejects.toMatchObject({ name: 'BillingBlockedError' });
    expect(runReviewPipeline).not.toHaveBeenCalled();
  });

  it('runs the pipeline with agentAuthored=true', async () => {
    const deps = makeDeps();
    await handleReviewDiff({ diff: 'diff content' }, deps, makeAuth());
    expect(runReviewPipeline).toHaveBeenCalledOnce();
    const [pipelineOpts, pipelineDeps] = runReviewPipeline.mock.calls[0] as any[];
    expect(pipelineOpts.agentAuthored).toBe(true);
    expect(pipelineOpts.diff).toBe('diff content');
    expect(pipelineOpts.context.prNumber).toBe(0);
    expect(pipelineDeps.llm).toBe(deps.llm);
  });

  it('skips repo context load when no repo provided', async () => {
    const deps = makeDeps();
    await handleReviewDiff({ diff: 'd' }, deps, makeAuth());
    expect(fetchRepoConfig).not.toHaveBeenCalled();
    expect(fetchConventions).not.toHaveBeenCalled();
    expect(deps.authProvider.getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('loads repo config + conventions when repo is provided', async () => {
    fetchConventions.mockResolvedValueOnce({ content: 'conv', sourcePath: 'AGENTS.md', truncated: false });
    const deps = makeDeps();
    await handleReviewDiff({ diff: 'd', repo: 'acme/web' }, deps, makeAuth());
    expect(deps.authProvider.getInstallationOctokit).toHaveBeenCalledWith(42);
    expect(fetchRepoConfig).toHaveBeenCalled();
    expect(fetchConventions).toHaveBeenCalled();
    const pipelineOpts = runReviewPipeline.mock.calls[0][0];
    expect(pipelineOpts.conventions).toBe('conv');
    expect(pipelineOpts.context.owner).toBe('acme');
    expect(pipelineOpts.context.repo).toBe('web');
  });

  it('rejects repo out of scope', async () => {
    const deps = makeDeps();
    await expect(
      handleReviewDiff(
        { diff: 'd', repo: 'other/repo' },
        deps,
        makeAuth({ scope: ['acme/web'] }),
      ),
    ).rejects.toThrow(/scope/);
  });

  it('records billing with session-scoped idempotency key', async () => {
    const deps = makeDeps();
    const out = await handleReviewDiff({ diff: 'd', sessionId: 'sess-provided' }, deps, makeAuth());
    // first call → iteration 1, key = mcp-<sessionId>-1
    expect(deps.billing.record).toHaveBeenCalledOnce();
    const callArgs = (deps.billing.record as any).mock.calls[0];
    expect(callArgs[2]).toBe('42'); // installationId
    expect(callArgs[3]).toBe(0.12); // costCents 12 → billed fully on new session
    expect(callArgs[4]).toBe('mcp-sess-provided-1');
    expect(out.iteration).toBe(1);
    expect(out.sessionId).toBe('sess-provided');
  });

  it('bills delta on a continuation within TTL', async () => {
    const now = Date.now();
    const priorCostCents = 10;
    const deps = makeDeps({
      sessionStore: {
        get: vi.fn().mockResolvedValue({
          sessionId: 'sess-1',
          installationId: '42',
          firstBilledAt: new Date(now - 60_000).toISOString(),
          maxBilledCents: priorCostCents,
          iteration: 1,
          ttl: Math.floor(now / 1000) + 60,
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    });
    await handleReviewDiff({ diff: 'd', sessionId: 'sess-1' }, deps, makeAuth());
    const callArgs = (deps.billing.record as any).mock.calls[0];
    // new cost = 12 cents, prior max = 10 → billed delta 0.02 USD
    expect(callArgs[3]).toBeCloseTo(0.02, 5);
    expect(callArgs[4]).toBe('mcp-sess-1-2');
  });

  it('persists the session row via sessionStore.upsert', async () => {
    const deps = makeDeps();
    await handleReviewDiff({ diff: 'd' }, deps, makeAuth());
    expect(deps.sessionStore.upsert).toHaveBeenCalledOnce();
    const rec = (deps.sessionStore.upsert as any).mock.calls[0][0];
    expect(rec.installationId).toBe('42');
    expect(rec.iteration).toBe(1);
    expect(rec.maxBilledCents).toBe(12);
    expect(rec.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('still runs pipeline with defaults when repo context load fails', async () => {
    fetchRepoConfig.mockRejectedValueOnce(new Error('404'));
    const deps = makeDeps({
      authProvider: { getInstallationOctokit: vi.fn().mockRejectedValue(new Error('no octokit')) },
    });
    await handleReviewDiff({ diff: 'd', repo: 'acme/web' }, deps, makeAuth());
    expect(runReviewPipeline).toHaveBeenCalled();
  });
});
