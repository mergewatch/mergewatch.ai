/**
 * #261 — OSS Program grant evaluation.
 *
 * Pure predicate over the OSS fields on the `#SETTINGS` row, shared by the
 * billing gate (`billingCheck`) and the accrual path (`recordReview`) so the
 * two can never disagree about whether a review is sponsored.
 */

import type { BillingFields } from '@mergewatch/core';

/**
 * Repo context the OSS gate needs. Optional at every call site: when it's
 * absent the OSS branch is skipped entirely and behavior is identical to
 * pre-#261. That's what keeps the MCP path (`packages/mcp/src/middleware/
 * billing.ts`, whose `repo` input is optional and often literally 'unknown')
 * compiling and behaving unchanged.
 */
export interface RepoContext {
  /** GitHub's immutable numeric repository ID. The only field matched on. */
  repoId: number;
  /** owner/repo. Logging and diagnostics only — never matched on. */
  repoFullName: string;
  /**
   * Whether the repo is public **right now**, read from the current webhook
   * payload rather than a snapshot taken at approval time. A repo approved as
   * public can be flipped private afterward; that's the actual cost leak, and
   * only a live check catches it.
   */
  isPublic: boolean;
}

/** Current accrual period key (YYYY-MM) for a given instant. */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Sponsored cost already accrued in the current period. Accrual from an
 * earlier period doesn't count against this month's cap, so a stale
 * `ossPeriod` reads as zero rather than carrying over.
 */
export function sponsoredCentsThisPeriod(fields: BillingFields, period: string): number {
  if (fields.ossPeriod !== period) return 0;
  return fields.ossSponsoredCentsThisPeriod ?? 0;
}

export type OssIneligibleReason =
  | 'no_repo_context'
  | 'no_grant'
  | 'grant_expired'
  | 'repo_not_granted'
  | 'repo_not_public'
  | 'cap_exceeded';

export type OssEligibility =
  | { eligible: true }
  | { eligible: false; reason: OssIneligibleReason };

/**
 * Decide whether this review is covered by an active OSS grant.
 *
 * Being named in the grant is necessary but **not sufficient** — the repo must
 * also be public at this moment, the grant must not have expired, and the
 * month's sponsored spend must be under the fair-use cap.
 *
 * Over the cap is deliberately not a hard stop: the caller falls through to
 * the normal free-tier/balance gate, so a busy month degrades to standard
 * billing rather than blocking a maintainer outright.
 */
export function evaluateOssGrant(
  fields: BillingFields,
  repo: RepoContext | undefined,
  now: Date = new Date(),
): OssEligibility {
  if (!repo) return { eligible: false, reason: 'no_repo_context' };

  const repos = fields.ossGrantRepos;
  if (!fields.ossGrantExpiresAt || !repos || repos.length === 0) {
    return { eligible: false, reason: 'no_grant' };
  }

  // Revoking a grant is setting the expiry to the past, so this covers both
  // lapsed and revoked. An unparseable date fails closed.
  const expiresAt = Date.parse(fields.ossGrantExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { eligible: false, reason: 'grant_expired' };
  }

  if (!repos.some((r) => r.id === repo.repoId)) {
    return { eligible: false, reason: 'repo_not_granted' };
  }

  if (!repo.isPublic) return { eligible: false, reason: 'repo_not_public' };

  const cap = fields.ossMonthlyCapCents;
  if (cap != null && sponsoredCentsThisPeriod(fields, currentPeriod(now)) >= cap) {
    return { eligible: false, reason: 'cap_exceeded' };
  }

  return { eligible: true };
}
