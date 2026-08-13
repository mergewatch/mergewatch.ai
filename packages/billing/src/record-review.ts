import type Stripe from 'stripe';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FREE_REVIEW_LIMIT } from './constants';
import { calculateReviewCost } from './cost';
import {
  getBillingFields,
  incrementFreeReviewsUsed,
  deductBalanceAndRecordUsage,
  accrueOssSponsoredCost,
} from './dynamo-billing';
import { maybeAutoReload } from './auto-reload';
// Aliased: the paid branch below already has a local `currentPeriod`.
import { currentPeriod as ossAccrualPeriod, evaluateOssGrant } from './oss-grant';
import type { RepoContext } from './oss-grant';

/**
 * Record a completed review against billing.
 *
 * - OSS Program: accrue the cost against the grant; no charge, no free-tier
 *   consumption, no Stripe call (#261)
 * - Free tier: atomically increment freeReviewsUsed
 * - Paid tier: atomically deduct totalCents from DynamoDB balanceCents,
 *   then debit the Stripe Customer Balance to keep them in sync.
 *
 * @param reviewKey — unique key for this review (e.g. prNumberCommitSha),
 *   used as idempotency guard to prevent double-billing on Lambda retries
 * @param stripe — optional Stripe client; when provided, Stripe balance is also debited
 * @param repo — optional repo context; omit to skip OSS evaluation entirely.
 *   Pass the same value given to `billingCheck` so the gate and the recording
 *   path agree on whether the review was sponsored.
 */
export async function recordReview(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  estimatedCostUsd: number,
  reviewKey: string,
  stripe?: Stripe,
  repo?: RepoContext,
): Promise<void> {
  const fields = await getBillingFields(client, table, installationId);

  // OSS Program — sponsored. Track what the review would have cost so program
  // spend is a reportable number rather than an invisible subsidy, but never
  // touch balance, freeReviewsUsed, or Stripe.
  //
  // Re-derived from the stored fields rather than passed in from the gate: a
  // sponsored review that wrongly consumed the free tier would turn a lapsed
  // grant into an instantly-blocked account, with a "credits required" issue
  // filed on the maintainer's public repo.
  if (evaluateOssGrant(fields, repo).eligible) {
    const cost = calculateReviewCost(estimatedCostUsd);
    await accrueOssSponsoredCost(
      client,
      table,
      installationId,
      cost.totalCents,
      ossAccrualPeriod(),
    );
    return;
  }

  if ((fields.freeReviewsUsed ?? 0) < FREE_REVIEW_LIMIT) {
    // Free tier — just bump the counter
    await incrementFreeReviewsUsed(client, table, installationId, FREE_REVIEW_LIMIT);
    return;
  }

  // Paid tier — deduct from DynamoDB balance + update usage in a single call
  const cost = calculateReviewCost(estimatedCostUsd);
  const now = new Date().toISOString();
  const currentPeriod = now.slice(0, 7); // YYYY-MM
  const prTimestamps = [...(fields.prTimestamps ?? []), now].slice(-100); // keep last 100

  await deductBalanceAndRecordUsage(client, table, installationId, {
    amountCents: cost.totalCents,
    totalBilledCents: (fields.totalBilledCents ?? 0) + cost.totalCents,
    prCount: (fields.prCount ?? 0) + 1,
    billingPeriod: currentPeriod,
    prTimestamps,
  });

  // Debit Stripe Customer Balance (positive amount = debit from customer)
  // Uses reviewKey as idempotency key to prevent double-charges on retry
  if (stripe && fields.stripeCustomerId) {
    try {
      await stripe.customers.createBalanceTransaction(
        fields.stripeCustomerId,
        {
          amount: cost.totalCents,
          currency: 'usd',
          description: `MergeWatch review ($${cost.total.toFixed(4)})`,
          metadata: {
            mergewatchInstallationId: installationId,
            reviewKey,
            llmCost: String(cost.llmCost),
            platformFee: String(cost.platformFee),
          },
        },
        { idempotencyKey: `review-billing-${installationId}-${reviewKey}` },
      );
    } catch (err) {
      // Non-critical: DynamoDB is the source of truth, Stripe is secondary
      console.warn('Failed to debit Stripe customer balance:', err);
    }

    // Check if auto-reload should fire
    try {
      await maybeAutoReload(client, table, stripe, installationId);
    } catch (err) {
      console.warn('Auto-reload check failed:', err);
    }
  }
}
