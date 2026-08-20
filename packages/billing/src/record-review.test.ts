import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordReview } from './record-review';
import { FREE_REVIEW_LIMIT } from './constants';

// Mock the DynamoDB layer
vi.mock('./dynamo-billing', () => ({
  getBillingFields: vi.fn(),
  incrementFreeReviewsUsed: vi.fn(),
  deductBalanceAndRecordUsage: vi.fn(),
  accrueOssSponsoredCost: vi.fn(),
}));

import {
  getBillingFields,
  incrementFreeReviewsUsed,
  deductBalanceAndRecordUsage,
  accrueOssSponsoredCost,
} from './dynamo-billing';
const mockGetFields = vi.mocked(getBillingFields);
const mockIncrement = vi.mocked(incrementFreeReviewsUsed);
const mockDeductAndRecord = vi.mocked(deductBalanceAndRecordUsage);
const mockAccrueOss = vi.mocked(accrueOssSponsoredCost);

const client = {} as any;
const table = 'test-table';
const installationId = 'inst-123';
const reviewKey = '42#abc1234';

describe('recordReview', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('increments free counter when on free tier', async () => {
    mockGetFields.mockResolvedValue({ freeReviewsUsed: 2 });

    await recordReview(client, table, installationId, 0.02, reviewKey);

    expect(mockIncrement).toHaveBeenCalledWith(client, table, installationId, FREE_REVIEW_LIMIT);
    expect(mockDeductAndRecord).not.toHaveBeenCalled();
  });

  it('increments free counter when freeReviewsUsed is undefined (first review)', async () => {
    mockGetFields.mockResolvedValue({});

    await recordReview(client, table, installationId, 0.01, reviewKey);

    expect(mockIncrement).toHaveBeenCalled();
    expect(mockDeductAndRecord).not.toHaveBeenCalled();
  });

  it('deducts balance and records usage when free reviews exhausted', async () => {
    mockGetFields.mockResolvedValue({ freeReviewsUsed: FREE_REVIEW_LIMIT, balanceCents: 1000 });

    await recordReview(client, table, installationId, 0.02, reviewKey);

    expect(mockIncrement).not.toHaveBeenCalled();
    expect(mockDeductAndRecord).toHaveBeenCalledWith(
      client, table, installationId,
      expect.objectContaining({
        amountCents: 4, // 0.02 + 0.005 + 0.008 = 0.033 → ceil = 4
        prCount: 1,
      }),
    );
  });

  it('deducts correct amount for larger LLM cost', async () => {
    mockGetFields.mockResolvedValue({ freeReviewsUsed: FREE_REVIEW_LIMIT, balanceCents: 5000 });

    await recordReview(client, table, installationId, 0.50, reviewKey);

    // 0.50 + 0.005 + 0.20 = 0.705 → 71 cents
    expect(mockDeductAndRecord).toHaveBeenCalledWith(
      client, table, installationId,
      expect.objectContaining({ amountCents: 71 }),
    );
  });

  it('does not deduct for free tier even with high LLM cost', async () => {
    mockGetFields.mockResolvedValue({ freeReviewsUsed: FREE_REVIEW_LIMIT - 1 });

    await recordReview(client, table, installationId, 1.00, reviewKey);

    expect(mockIncrement).toHaveBeenCalled();
    expect(mockDeductAndRecord).not.toHaveBeenCalled();
  });

  it('debits Stripe balance when stripe client and customer ID are present', async () => {
    const mockStripe = {
      customers: {
        createBalanceTransaction: vi.fn().mockResolvedValue({}),
      },
    } as any;
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 1000,
      stripeCustomerId: 'cus_123',
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, mockStripe);

    expect(mockStripe.customers.createBalanceTransaction).toHaveBeenCalledWith(
      'cus_123',
      expect.objectContaining({ amount: 4, currency: 'usd' }),
      expect.objectContaining({ idempotencyKey: `review-billing-${installationId}-${reviewKey}` }),
    );
  });

  it('does not call Stripe when no stripe client provided', async () => {
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 1000,
      stripeCustomerId: 'cus_123',
    });

    // No stripe param
    await recordReview(client, table, installationId, 0.02, reviewKey);

    // No error thrown, Stripe not called
    expect(mockDeductAndRecord).toHaveBeenCalled();
  });

  it('does not call Stripe when no customer ID exists', async () => {
    const mockStripe = {
      customers: {
        createBalanceTransaction: vi.fn(),
      },
    } as any;
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 1000,
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, mockStripe);

    expect(mockStripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it('logs warning but does not throw when Stripe debit fails', async () => {
    const mockStripe = {
      customers: {
        createBalanceTransaction: vi.fn().mockRejectedValue(new Error('Stripe error')),
      },
    } as any;
    mockGetFields.mockResolvedValue({
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 1000,
      stripeCustomerId: 'cus_123',
    });

    // Should not throw
    await recordReview(client, table, installationId, 0.02, reviewKey, mockStripe);

    // DynamoDB deduction still happened
    expect(mockDeductAndRecord).toHaveBeenCalled();
  });
});

describe('recordReview — OSS Program (#261)', () => {
  const REPO_ID = 4242;
  const grantedRepo = { repoId: REPO_ID, repoFullName: 'octocat/hello-world', isPublic: true };
  const activeGrant = {
    ossGrantRepos: [{ id: REPO_ID, fullName: 'octocat/hello-world' }],
    ossGrantExpiresAt: '2099-01-01T00:00:00.000Z',
    ossMonthlyCapCents: 2000,
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accrues sponsored cost instead of charging', async () => {
    mockGetFields.mockResolvedValue({ ...activeGrant, freeReviewsUsed: FREE_REVIEW_LIMIT });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, grantedRepo);

    // Same formula the paid path charges: $0.02 LLM + $0.005 infra + 40%
    // margin = $0.033, rounded up by calculateReviewCost to 4 cents.
    expect(mockAccrueOss).toHaveBeenCalledWith(
      client,
      table,
      installationId,
      4,
      new Date().toISOString().slice(0, 7),
    );
    expect(mockDeductAndRecord).not.toHaveBeenCalled();
  });

  it('does NOT consume the free tier on a sponsored review', async () => {
    // Burning freeReviewsUsed here would turn a lapsed grant into an instantly
    // blocked account with an issue filed on the maintainer's public repo.
    mockGetFields.mockResolvedValue({ ...activeGrant, freeReviewsUsed: 0 });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, grantedRepo);

    expect(mockIncrement).not.toHaveBeenCalled();
    expect(mockAccrueOss).toHaveBeenCalled();
  });

  it('never touches Stripe on a sponsored review', async () => {
    const mockStripe = {
      customers: { createBalanceTransaction: vi.fn() },
    } as any;
    mockGetFields.mockResolvedValue({
      ...activeGrant,
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
      stripeCustomerId: 'cus_123',
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, mockStripe, grantedRepo);

    expect(mockStripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
    expect(mockAccrueOss).toHaveBeenCalled();
  });

  it('charges normally for an unnamed repo in a granted installation', async () => {
    mockGetFields.mockResolvedValue({
      ...activeGrant,
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
    });
    const other = { repoId: 9999, repoFullName: 'octocat/commercial', isPublic: true };

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, other);

    expect(mockAccrueOss).not.toHaveBeenCalled();
    expect(mockDeductAndRecord).toHaveBeenCalled();
  });

  it('charges normally once the grant has expired', async () => {
    mockGetFields.mockResolvedValue({
      ...activeGrant,
      ossGrantExpiresAt: '2020-01-01T00:00:00.000Z',
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, grantedRepo);

    expect(mockAccrueOss).not.toHaveBeenCalled();
    expect(mockDeductAndRecord).toHaveBeenCalled();
  });

  it('is unchanged from pre-#261 when repo context is omitted', async () => {
    mockGetFields.mockResolvedValue({ ...activeGrant, freeReviewsUsed: 2 });

    await recordReview(client, table, installationId, 0.02, reviewKey);

    expect(mockAccrueOss).not.toHaveBeenCalled();
    expect(mockIncrement).toHaveBeenCalled();
  });
});

describe('recordReview — OSS Program org scope (#409)', () => {
  const orgGrant = {
    ossGrantScope: 'org' as const,
    ossGrantAccount: { id: 9931, login: 'acme-corp' },
    ossGrantExpiresAt: '2099-01-01T00:00:00.000Z',
    ossMonthlyCapCents: 2000,
  };
  /** A repo no grant has ever named — covered only because the scope is org. */
  const unnamedPublicRepo = {
    repoId: 777001,
    repoFullName: 'acme-corp/brand-new-service',
    isPublic: true,
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accrues sponsored cost for a repo the grant never named', async () => {
    mockGetFields.mockResolvedValue({ ...orgGrant, freeReviewsUsed: FREE_REVIEW_LIMIT });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, unnamedPublicRepo);

    expect(mockAccrueOss).toHaveBeenCalledWith(
      client,
      table,
      installationId,
      4,
      new Date().toISOString().slice(0, 7),
    );
    expect(mockDeductAndRecord).not.toHaveBeenCalled();
  });

  it('does NOT consume the free tier under org scope', async () => {
    mockGetFields.mockResolvedValue({ ...orgGrant, freeReviewsUsed: 0 });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, unnamedPublicRepo);

    expect(mockIncrement).not.toHaveBeenCalled();
    expect(mockAccrueOss).toHaveBeenCalled();
  });

  it('never touches Stripe under org scope', async () => {
    const mockStripe = { customers: { createBalanceTransaction: vi.fn() } } as any;
    mockGetFields.mockResolvedValue({
      ...orgGrant,
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
      stripeCustomerId: 'cus_123',
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, mockStripe, unnamedPublicRepo);

    expect(mockStripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
    expect(mockAccrueOss).toHaveBeenCalled();
  });

  it('charges normally for a private repo under an org grant', async () => {
    // The gate and the accrual path must agree that private is never sponsored,
    // or a private repo would be reviewed free and billed to nobody.
    mockGetFields.mockResolvedValue({
      ...orgGrant,
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, {
      ...unnamedPublicRepo,
      isPublic: false,
    });

    expect(mockAccrueOss).not.toHaveBeenCalled();
    expect(mockDeductAndRecord).toHaveBeenCalled();
  });

  it('charges normally once an org grant has expired', async () => {
    mockGetFields.mockResolvedValue({
      ...orgGrant,
      ossGrantExpiresAt: '2020-01-01T00:00:00.000Z',
      freeReviewsUsed: FREE_REVIEW_LIMIT,
      balanceCents: 10_000,
    });

    await recordReview(client, table, installationId, 0.02, reviewKey, undefined, unnamedPublicRepo);

    expect(mockAccrueOss).not.toHaveBeenCalled();
    expect(mockDeductAndRecord).toHaveBeenCalled();
  });
});
