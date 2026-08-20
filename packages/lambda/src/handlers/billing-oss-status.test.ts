/**
 * #409 — `ossStatus` must report org-scoped grants.
 *
 * Before this, the helper bailed to `null` whenever the repo list was empty,
 * which is the normal state of an org-scoped grant — so the dashboard would
 * have told a sponsored org it had no grant at all.
 */
import { describe, it, expect, vi } from 'vitest';

// billing.ts constructs SSM/Dynamo clients and pulls in Stripe at module load.
// None of that is exercised here — ossStatus is a pure function over fields.
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { send() { return Promise.resolve({}); } },
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: () => Promise.resolve({}) }) },
}));
vi.mock('@mergewatch/billing', () => ({
  getStripe: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  createSetupSession: vi.fn(),
  createTopUp: vi.fn(),
  getBillingFields: vi.fn(),
  updateBillingFields: vi.fn(),
  closeBillingIssue: vi.fn(),
  FREE_REVIEW_LIMIT: 5,
  MIN_BALANCE_CENTS: 5,
  getStripeWebhookSecret: vi.fn(),
  getBillingApiSecret: vi.fn(),
}));
vi.mock('../github-auth-ssm.js', () => ({
  SSMGitHubAuthProvider: class { getInstallationOctokit() { return Promise.resolve({}); } },
}));

import { ossStatus } from './billing.js';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PERIOD = new Date().toISOString().slice(0, 7);

describe('ossStatus — org scope (#409)', () => {
  it('reports an org-scoped grant that has no repo list', () => {
    const status = ossStatus({
      ossGrantScope: 'org',
      ossGrantAccount: { id: 9931, login: 'acme-corp' },
      ossGrantExpiresAt: FUTURE,
      ossMonthlyCapCents: 2000,
    } as any);

    expect(status).not.toBeNull();
    expect(status!.active).toBe(true);
    expect(status!.scope).toBe('org');
    expect(status!.account).toEqual({ id: 9931, login: 'acme-corp' });
  });

  it('reports repos as null under org scope rather than a stale list', () => {
    // The gate ignores a leftover list from an earlier repos-scoped grant;
    // rendering it would understate coverage to the maintainer.
    const status = ossStatus({
      ossGrantScope: 'org',
      ossGrantRepos: [{ id: 1, fullName: 'acme-corp/old-only-this' }],
      ossGrantExpiresAt: FUTURE,
    } as any);

    expect(status!.repos).toBeNull();
  });

  it('marks an expired org grant inactive rather than hiding it', () => {
    const status = ossStatus({
      ossGrantScope: 'org',
      ossGrantExpiresAt: '2020-01-01T00:00:00.000Z',
    } as any);

    expect(status).not.toBeNull();
    expect(status!.active).toBe(false);
  });

  it('still surfaces period and lifetime accrual under org scope', () => {
    const status = ossStatus({
      ossGrantScope: 'org',
      ossGrantExpiresAt: FUTURE,
      ossPeriod: PERIOD,
      ossSponsoredCentsThisPeriod: 412,
      ossSponsoredCentsLifetime: 9001,
    } as any);

    expect(status!.sponsoredThisPeriodCents).toBe(412);
    expect(status!.sponsoredLifetimeCents).toBe(9001);
  });
});

describe('ossStatus — repos scope stays as it was (#261)', () => {
  it('reports a named-repo grant', () => {
    const status = ossStatus({
      ossGrantRepos: [{ id: 1, fullName: 'octocat/hello-world' }],
      ossGrantExpiresAt: FUTURE,
      ossMonthlyCapCents: 2000,
    } as any);

    expect(status!.scope).toBe('repos');
    expect(status!.repos).toEqual(['octocat/hello-world']);
  });

  it('returns null for a repos-scoped grant naming nothing', () => {
    expect(ossStatus({ ossGrantExpiresAt: FUTURE } as any)).toBeNull();
  });

  it('returns null for an installation with no grant at all', () => {
    expect(ossStatus({} as any)).toBeNull();
  });

  it('returns null when a repo list exists but no expiry does', () => {
    expect(ossStatus({ ossGrantRepos: [{ id: 1, fullName: 'a/b' }] } as any)).toBeNull();
  });
});
