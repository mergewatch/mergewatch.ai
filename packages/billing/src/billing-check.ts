import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getBillingFields } from './dynamo-billing';
import { FREE_REVIEW_LIMIT, MIN_BALANCE_CENTS } from './constants';
import { evaluateOssGrant } from './oss-grant';
import type { RepoContext, OssIneligibleReason } from './oss-grant';

export interface BillingCheckResult {
  /** Whether the review is allowed. */
  status: 'allow' | 'block';
  /**
   * True when this is the first time the installation is being blocked
   * (no prior blockedAt timestamp). Used to decide whether to file a GitHub Issue.
   */
  firstBlock: boolean;
  /**
   * Why the review was allowed. `oss` means the cost is sponsored under the
   * OSS Program and must not be charged or counted against the free tier —
   * `recordReview` re-derives this rather than trusting it, but callers use it
   * for logging and for the dashboard's billing state.
   */
  reason?: 'oss' | 'free_tier' | 'paid';
  /**
   * Why the OSS grant did not apply, when repo context was supplied and the
   * review wasn't sponsored. Lets the block path tell a lapsed or over-cap
   * maintainer something useful ("your grant expired") instead of the generic
   * "add a credit card", which is the wrong thing to say to someone we invited
   * into a free program.
   */
  ossReason?: OssIneligibleReason;
}

/**
 * Reasons that warrant OSS-specific block copy: the installation has a real
 * grant relationship that lapsed or hit its ceiling. The others
 * (`no_grant`, `repo_not_granted`, `repo_not_public`) mean this repo was never
 * sponsored, so standard billing copy is correct.
 */
export function isLapsedOssGrant(reason: OssIneligibleReason | undefined): boolean {
  return reason === 'grant_expired' || reason === 'cap_exceeded';
}

/**
 * Determine whether an installation is allowed to run a review.
 *
 * Decision tree:
 *   1. Covered by an active OSS grant → allow (sponsored, #261)
 *   2. freeReviewsUsed < FREE_REVIEW_LIMIT → allow (free tier)
 *   3. balanceCents >= MIN_BALANCE_CENTS → allow (paid)
 *   4. Otherwise → block
 *
 * `repo` is optional. Omit it and the OSS branch is skipped entirely, leaving
 * behavior byte-for-byte identical to pre-#261 — that's what lets the MCP path
 * keep calling this with three arguments.
 */
export async function billingCheck(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  repo?: RepoContext,
): Promise<BillingCheckResult> {
  const fields = await getBillingFields(client, table, installationId);

  const freeUsed = fields.freeReviewsUsed ?? 0;
  const balanceCents = fields.balanceCents ?? 0;

  // OSS Program path — sponsored, so it never touches the free tier or balance.
  // Falling through on an ineligible result is deliberate: an expired grant or
  // a month over its fair-use cap degrades to normal billing instead of
  // blocking a maintainer outright.
  const oss = evaluateOssGrant(fields, repo);
  if (oss.eligible) {
    console.log(`[billing] allow install=${installationId} reason=oss repo=${repo?.repoFullName}`);
    return { status: 'allow', firstBlock: false, reason: 'oss' };
  }
  // Always the concrete reason — `no_repo_context` when OSS wasn't evaluated at
  // all. Self-describing beats an undefined a reader has to reason about.
  const ossReason = oss.reason;
  if (repo && oss.reason !== 'no_grant') {
    console.log(
      `[billing] oss not applied install=${installationId} repo=${repo.repoFullName} reason=${oss.reason}`,
    );
  }

  // Free tier path
  if (freeUsed < FREE_REVIEW_LIMIT) {
    console.log(`[billing] allow install=${installationId} reason=free_tier used=${freeUsed}/${FREE_REVIEW_LIMIT}`);
    return { status: 'allow', firstBlock: false, reason: 'free_tier', ossReason };
  }

  // Paid path
  if (balanceCents >= MIN_BALANCE_CENTS) {
    console.log(`[billing] allow install=${installationId} reason=paid balance=${balanceCents}c`);
    return { status: 'allow', firstBlock: false, reason: 'paid', ossReason };
  }

  // Blocked
  const firstBlock = !fields.blockedAt;
  console.log(`[billing] block install=${installationId} balance=${balanceCents}c firstBlock=${firstBlock}`);
  return { status: 'block', firstBlock, ossReason };
}
