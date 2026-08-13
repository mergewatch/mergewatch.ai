/**
 * #261 — OSS Program grant evaluation.
 *
 * The predicate both the gate and the accrual path depend on, so the negative
 * cases matter as much as the positive one: a false positive sponsors work we
 * didn't approve, and a false negative silently bills a maintainer we promised
 * free review.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateOssGrant,
  currentPeriod,
  sponsoredCentsThisPeriod,
} from './oss-grant';
import type { RepoContext } from './oss-grant';
import type { BillingFields } from '@mergewatch/core';

const NOW = new Date('2026-08-12T00:00:00.000Z');
const PERIOD = '2026-08';

const GRANTED_REPO_ID = 4242;

const grantedRepo: RepoContext = {
  repoId: GRANTED_REPO_ID,
  repoFullName: 'octocat/hello-world',
  isPublic: true,
};

/** An active grant covering exactly `GRANTED_REPO_ID`, expiring in ~4 months. */
function activeGrant(overrides: Partial<BillingFields> = {}): BillingFields {
  return {
    ossGrantRepos: [{ id: GRANTED_REPO_ID, fullName: 'octocat/hello-world' }],
    ossGrantExpiresAt: '2026-12-01T00:00:00.000Z',
    ossMonthlyCapCents: 2000,
    ...overrides,
  };
}

describe('evaluateOssGrant', () => {
  it('sponsors a named public repo under an active grant', () => {
    expect(evaluateOssGrant(activeGrant(), grantedRepo, NOW)).toEqual({ eligible: true });
  });

  it('skips evaluation entirely when no repo context is supplied', () => {
    // The MCP path calls billingCheck with three args; that must stay pre-#261.
    expect(evaluateOssGrant(activeGrant(), undefined, NOW)).toEqual({
      eligible: false,
      reason: 'no_repo_context',
    });
  });

  it('does not sponsor an installation with no grant at all', () => {
    expect(evaluateOssGrant({}, grantedRepo, NOW)).toEqual({
      eligible: false,
      reason: 'no_grant',
    });
  });

  it('does not sponsor when the grant names no repos', () => {
    // An empty list is not "all repos" — there is no installation-wide mode.
    const fields = activeGrant({ ossGrantRepos: [] });
    expect(evaluateOssGrant(fields, grantedRepo, NOW)).toEqual({
      eligible: false,
      reason: 'no_grant',
    });
  });

  it('does not sponsor an UNNAMED public repo in the same installation', () => {
    // The open-core case: a genuinely-OSS repo alongside public-but-commercial
    // ones. Only the named repo is sponsored.
    const otherRepo: RepoContext = {
      repoId: 9999,
      repoFullName: 'octocat/commercial-product',
      isPublic: true,
    };
    expect(evaluateOssGrant(activeGrant(), otherRepo, NOW)).toEqual({
      eligible: false,
      reason: 'repo_not_granted',
    });
  });

  it('does not sponsor a named repo that is private', () => {
    // Being named is necessary but not sufficient.
    const privateRepo: RepoContext = { ...grantedRepo, isPublic: false };
    expect(evaluateOssGrant(activeGrant(), privateRepo, NOW)).toEqual({
      eligible: false,
      reason: 'repo_not_public',
    });
  });

  it('stops sponsoring a named repo the moment it is flipped private', () => {
    // The actual cost leak an approval-time snapshot cannot catch.
    const fields = activeGrant();
    expect(evaluateOssGrant(fields, grantedRepo, NOW).eligible).toBe(true);
    expect(evaluateOssGrant(fields, { ...grantedRepo, isPublic: false }, NOW)).toEqual({
      eligible: false,
      reason: 'repo_not_public',
    });
  });

  it('keeps sponsoring a repo that was renamed or transferred', () => {
    // full_name changed, numeric id did not. Matching on the name here would
    // lapse the grant and file a "credits required" issue on a public OSS repo.
    const renamed: RepoContext = {
      repoId: GRANTED_REPO_ID,
      repoFullName: 'new-org/renamed-project',
      isPublic: true,
    };
    expect(evaluateOssGrant(activeGrant(), renamed, NOW)).toEqual({ eligible: true });
  });

  it('does not sponsor once the grant has expired', () => {
    const fields = activeGrant({ ossGrantExpiresAt: '2026-08-01T00:00:00.000Z' });
    expect(evaluateOssGrant(fields, grantedRepo, NOW)).toEqual({
      eligible: false,
      reason: 'grant_expired',
    });
  });

  it('treats a revoked grant (expiry set to the past) as expired', () => {
    const fields = activeGrant({ ossGrantExpiresAt: '2020-01-01T00:00:00.000Z' });
    expect(evaluateOssGrant(fields, grantedRepo, NOW).eligible).toBe(false);
  });

  it('fails closed on an unparseable expiry rather than sponsoring forever', () => {
    const fields = activeGrant({ ossGrantExpiresAt: 'not-a-date' });
    expect(evaluateOssGrant(fields, grantedRepo, NOW)).toEqual({
      eligible: false,
      reason: 'grant_expired',
    });
  });

  it('does not sponsor once the month is at the fair-use cap', () => {
    const fields = activeGrant({
      ossMonthlyCapCents: 2000,
      ossPeriod: PERIOD,
      ossSponsoredCentsThisPeriod: 2000,
    });
    expect(evaluateOssGrant(fields, grantedRepo, NOW)).toEqual({
      eligible: false,
      reason: 'cap_exceeded',
    });
  });

  it('still sponsors while under the cap', () => {
    const fields = activeGrant({
      ossMonthlyCapCents: 2000,
      ossPeriod: PERIOD,
      ossSponsoredCentsThisPeriod: 1999,
    });
    expect(evaluateOssGrant(fields, grantedRepo, NOW).eligible).toBe(true);
  });

  it('ignores accrual from a previous period when applying the cap', () => {
    // Last month's spend must not carry over and starve this month.
    const fields = activeGrant({
      ossMonthlyCapCents: 2000,
      ossPeriod: '2026-07',
      ossSponsoredCentsThisPeriod: 999_999,
    });
    expect(evaluateOssGrant(fields, grantedRepo, NOW).eligible).toBe(true);
  });

  it('sponsors without limit when no cap is configured', () => {
    const fields = activeGrant({
      ossMonthlyCapCents: undefined,
      ossPeriod: PERIOD,
      ossSponsoredCentsThisPeriod: 999_999,
    });
    expect(evaluateOssGrant(fields, grantedRepo, NOW).eligible).toBe(true);
  });
});

describe('currentPeriod', () => {
  it('formats the accrual period as YYYY-MM', () => {
    expect(currentPeriod(NOW)).toBe(PERIOD);
  });
});

describe('sponsoredCentsThisPeriod', () => {
  it('returns the accrued amount when the period matches', () => {
    const fields: BillingFields = { ossPeriod: PERIOD, ossSponsoredCentsThisPeriod: 750 };
    expect(sponsoredCentsThisPeriod(fields, PERIOD)).toBe(750);
  });

  it('returns 0 when the stored period is stale', () => {
    const fields: BillingFields = { ossPeriod: '2026-07', ossSponsoredCentsThisPeriod: 750 };
    expect(sponsoredCentsThisPeriod(fields, PERIOD)).toBe(0);
  });

  it('returns 0 when nothing has accrued yet', () => {
    expect(sponsoredCentsThisPeriod({}, PERIOD)).toBe(0);
  });
});
