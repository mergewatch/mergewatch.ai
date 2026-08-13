import { describe, it, expect, vi } from 'vitest';
import { billingCheck, isLapsedOssGrant } from './billing-check';
import { FREE_REVIEW_LIMIT, MIN_BALANCE_CENTS } from './constants';

// Mock the DynamoDB layer — we test billing logic, not DynamoDB calls
vi.mock('./dynamo-billing', () => ({
  getBillingFields: vi.fn(),
}));

import { getBillingFields } from './dynamo-billing';
const mockGetFields = vi.mocked(getBillingFields);

const client = {} as any;
const table = 'test-table';
const installationId = 'inst-123';

describe('billingCheck', () => {
  it('allows when freeReviewsUsed is 0 (fresh install)', async () => {
    mockGetFields.mockResolvedValue({});
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('allow');
    expect(result.firstBlock).toBe(false);
  });

  it('allows when freeReviewsUsed < FREE_REVIEW_LIMIT', async () => {
    mockGetFields.mockResolvedValue({ freeReviewsUsed: FREE_REVIEW_LIMIT - 1 });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('allow');
  });

  it('allows when free reviews exhausted but balance is sufficient', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: MIN_BALANCE_CENTS,
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('allow');
  });

  it('allows with large balance', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT + 100,
      balanceCents: 10000,
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('allow');
  });

  it('blocks when free reviews exhausted and balance is 0', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 0,
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('block');
  });

  it('blocks when balance is below minimum', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: MIN_BALANCE_CENTS - 1,
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('block');
  });

  it('sets firstBlock=true when no prior blockedAt', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 0,
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.firstBlock).toBe(true);
  });

  it('sets firstBlock=false when blockedAt already exists', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 0,
      blockedAt: '2026-01-01T00:00:00Z',
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.firstBlock).toBe(false);
  });

  it('blocks when balanceCents is undefined (never topped up)', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
    });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('block');
  });

  it('throws when getBillingFields fails (DynamoDB error)', async () => {
    mockGetFields.mockRejectedValue(new Error('DynamoDB timeout'));
    await expect(billingCheck(client, table, installationId)).rejects.toThrow('DynamoDB timeout');
  });
});

describe('billingCheck — OSS Program (#261)', () => {
  const REPO_ID = 4242;
  const grantedRepo = { repoId: REPO_ID, repoFullName: 'octocat/hello-world', isPublic: true };

  /** Exhausted free tier + zero balance: without a grant this install is blocked. */
  const exhausted = {
    freeReviewsUsed: FREE_REVIEW_LIMIT,
    balanceCents: 0,
  };

  const activeGrant = {
    ossGrantRepos: [{ id: REPO_ID, fullName: 'octocat/hello-world' }],
    ossGrantExpiresAt: '2099-01-01T00:00:00.000Z',
    ossMonthlyCapCents: 2000,
  };

  it('allows with reason=oss for a named public repo, even with no free tier and no balance', async () => {
    mockGetFields.mockResolvedValue({ ...exhausted, ...activeGrant });
    const result = await billingCheck(client, table, installationId, grantedRepo);
    expect(result).toEqual({ status: 'allow', firstBlock: false, reason: 'oss' });
  });

  it('blocks an unnamed public repo in the same installation', async () => {
    mockGetFields.mockResolvedValue({ ...exhausted, ...activeGrant });
    const other = { repoId: 9999, repoFullName: 'octocat/commercial', isPublic: true };
    const result = await billingCheck(client, table, installationId, other);
    expect(result.status).toBe('block');
  });

  it('blocks a named repo that has been flipped private', async () => {
    mockGetFields.mockResolvedValue({ ...exhausted, ...activeGrant });
    const result = await billingCheck(client, table, installationId, {
      ...grantedRepo,
      isPublic: false,
    });
    expect(result.status).toBe('block');
  });

  it('falls back to the free tier — not a block — when the grant has expired', async () => {
    // A lapsed grant must land softly on the 5 free reviews every install gets,
    // never straight to a "credits required" issue on a public OSS repo.
    mockGetFields.mockResolvedValue({
      ...activeGrant,
      ossGrantExpiresAt: '2020-01-01T00:00:00.000Z',
      freeReviewsUsed: 0,
    });
    const result = await billingCheck(client, table, installationId, grantedRepo);
    expect(result).toEqual({
      status: 'allow', firstBlock: false, reason: 'free_tier', ossReason: 'grant_expired',
    });
  });

  it('falls through to the standard gate when over the fair-use cap', async () => {
    mockGetFields.mockResolvedValue({
      ...activeGrant,
      ossPeriod: new Date().toISOString().slice(0, 7),
      ossSponsoredCentsThisPeriod: 2000,
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
    });
    const result = await billingCheck(client, table, installationId, grantedRepo);
    expect(result).toEqual({
      status: 'allow', firstBlock: false, reason: 'paid', ossReason: 'cap_exceeded',
    });
  });

  it('is byte-for-byte pre-#261 when repo context is omitted', async () => {
    // The MCP path calls this with three arguments and must be unaffected.
    mockGetFields.mockResolvedValue({ ...exhausted, ...activeGrant });
    const result = await billingCheck(client, table, installationId);
    expect(result.status).toBe('block');
    // Self-describing rather than undefined; isLapsedOssGrant treats it as false,
    // so the block copy stays the standard credits wording.
    expect(result.ossReason).toBe('no_repo_context');
  });
});

describe('isLapsedOssGrant', () => {
  it('is true only for a grant relationship that lapsed or hit its ceiling', () => {
    expect(isLapsedOssGrant('grant_expired')).toBe(true);
    expect(isLapsedOssGrant('cap_exceeded')).toBe(true);
  });

  it('is false when the repo was simply never sponsored', () => {
    // These get standard billing copy — there is no grant to renew.
    expect(isLapsedOssGrant('no_grant')).toBe(false);
    expect(isLapsedOssGrant('repo_not_granted')).toBe(false);
    expect(isLapsedOssGrant('repo_not_public')).toBe(false);
    expect(isLapsedOssGrant('no_repo_context')).toBe(false);
    expect(isLapsedOssGrant(undefined)).toBe(false);
  });
});
