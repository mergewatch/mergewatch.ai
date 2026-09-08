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
  /**
   * #563 — identity of the billable unit of work, when the runtime can supply
   * one. `reviewKey` is `prNumber#sha`, which cannot distinguish a redelivered
   * webhook (must not double-charge) from a genuine second review of the same
   * commit (must charge). Stripe rejected the second call because the key had
   * already been used with a different amount, so the re-review was delivered
   * and never billed — while DynamoDB still recorded the usage, leaving the
   * two ledgers silently disagreeing.
   *
   * Absent means keep the old per-commit key: that is correct for a runtime
   * with no stable per-attempt identity, and inventing one there could
   * double-charge a redelivery.
   */
  billingAttemptId?: string,
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
        {
          idempotencyKey: billingAttemptId
            ? `review-billing-${installationId}-${reviewKey}-${billingAttemptId}`
            : `review-billing-${installationId}-${reviewKey}`,
        },
      );
    } catch (err) {
      // #563 — the ledgers can now disagree only on a real Stripe failure, not
      // on a re-review. Logged at ERROR because a failed debit means usage was
      // recorded and money was not taken: the divergence accumulates silently
      // and nothing else watches for it.
      console.error(
        '[billing] Stripe debit FAILED — usage recorded but not charged for %s:',
        reviewKey, err,
      );
    }

    // Check if auto-reload should fire
    try {
      await maybeAutoReload(client, table, stripe, installationId);
    } catch (err) {
      console.warn('Auto-reload check failed:', err);
    }
  }
}
