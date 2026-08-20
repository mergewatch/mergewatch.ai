/**
 * #409 — OSS Program pre-approval.
 *
 * The claim runs unattended on a webhook, so the failure modes that matter are
 * the ones nobody would notice: a redelivery resetting a grant an operator had
 * since amended, a spent approval silently re-firing on reinstall, or a stale
 * approval sponsoring an org that installed two years after the decision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PREAPPROVAL_PK,
  normalizeLogin,
  putPreapproval,
  getPreapproval,
  listPreapprovals,
  claimOssPreapproval,
} from './oss-preapproval';
import type { OssPreapproval } from './oss-preapproval';
import { OSS_DEFAULT_MONTHLY_CAP_CENTS, OSS_DEFAULT_TERM_MONTHS, OSS_PREAPPROVAL_TTL_DAYS } from './constants';

const table = 'test-installations';
const NOW = new Date('2026-08-20T12:00:00.000Z');
const account = { id: 9931, login: 'Acme-Corp' };
const INSTALL_ID = '48210231';

/** A live pre-approval for `acme-corp`, written 10 days ago. */
function pendingRow(overrides: Partial<OssPreapproval> = {}): OssPreapproval {
  return {
    installationId: PREAPPROVAL_PK,
    repoFullName: 'acme-corp',
    orgLogin: 'Acme-Corp',
    capCents: 2000,
    months: 12,
    note: 'form response #42',
    preapprovedAt: '2026-08-10T12:00:00.000Z',
    preapprovalExpiresAt: '2026-11-08T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Minimal DynamoDBDocumentClient double. Commands are identified by their
 * constructor name so the assertions read like the calls they check.
 */
function makeClient(getItem: OssPreapproval | null) {
  const sent: { type: string; input: any }[] = [];
  const conditionFailures = new Set<string>();

  const client = {
    send: vi.fn(async (cmd: any) => {
      const type = cmd.constructor.name;
      sent.push({ type, input: cmd.input });

      if (type === 'GetCommand') return { Item: getItem ?? undefined };
      if (type === 'QueryCommand') return { Items: getItem ? [getItem] : [] };
      if (type === 'UpdateCommand' && conditionFailures.has(cmd.input.Key.repoFullName)) {
        const err = new Error('The conditional request failed');
        (err as any).name = 'ConditionalCheckFailedException';
        throw err;
      }
      return {};
    }),
  } as any;

  return {
    client,
    sent,
    /** Make the next UpdateCommand on this sort key fail its condition. */
    failConditionOn: (sk: string) => conditionFailures.add(sk),
    of: (type: string) => sent.filter((s) => s.type === type),
  };
}

describe('normalizeLogin', () => {
  it('lowercases and trims, so operator casing never breaks a claim', () => {
    // GitHub logins are case-insensitive; the operator types whatever the
    // application form had.
    expect(normalizeLogin('Acme-Corp')).toBe('acme-corp');
    expect(normalizeLogin('  ACME-CORP  ')).toBe('acme-corp');
    expect(normalizeLogin('acme-corp')).toBe('acme-corp');
  });
});

describe('putPreapproval', () => {
  beforeEach(() => vi.resetAllMocks());

  it('writes under the sentinel PK with a normalized sort key', async () => {
    const h = makeClient(null);
    const row = await putPreapproval(h.client, table, { orgLogin: 'Acme-Corp' }, NOW);

    expect(row.installationId).toBe(PREAPPROVAL_PK);
    expect(row.repoFullName).toBe('acme-corp');
    // Original casing is kept for display only.
    expect(row.orgLogin).toBe('Acme-Corp');
  });

  it('defaults cap and term to the program defaults', async () => {
    const h = makeClient(null);
    const row = await putPreapproval(h.client, table, { orgLogin: 'acme-corp' }, NOW);

    expect(row.capCents).toBe(OSS_DEFAULT_MONTHLY_CAP_CENTS);
    expect(row.months).toBe(OSS_DEFAULT_TERM_MONTHS);
  });

  it('expires the pre-approval OSS_PREAPPROVAL_TTL_DAYS out', async () => {
    const h = makeClient(null);
    const row = await putPreapproval(h.client, table, { orgLogin: 'acme-corp' }, NOW);

    const days = (Date.parse(row.preapprovalExpiresAt) - NOW.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(OSS_PREAPPROVAL_TTL_DAYS, 5);
  });

  it('honours explicit cap, term, and ttl overrides', async () => {
    const h = makeClient(null);
    const row = await putPreapproval(
      h.client,
      table,
      { orgLogin: 'acme-corp', capCents: 5000, months: 6, ttlDays: 30, note: 'ref #7' },
      NOW,
    );

    expect(row.capCents).toBe(5000);
    expect(row.months).toBe(6);
    expect(row.note).toBe('ref #7');
    const days = (Date.parse(row.preapprovalExpiresAt) - NOW.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 5);
  });

  it('omits note entirely rather than storing undefined', async () => {
    const h = makeClient(null);
    const row = await putPreapproval(h.client, table, { orgLogin: 'acme-corp' }, NOW);
    expect('note' in row).toBe(false);
  });
});

describe('getPreapproval / listPreapprovals', () => {
  beforeEach(() => vi.resetAllMocks());

  it('looks up by normalized login regardless of casing', async () => {
    const h = makeClient(pendingRow());
    await getPreapproval(h.client, table, 'ACME-CORP');

    expect(h.of('GetCommand')[0].input.Key).toEqual({
      installationId: PREAPPROVAL_PK,
      repoFullName: 'acme-corp',
    });
  });

  it('returns null when nothing is pending', async () => {
    const h = makeClient(null);
    expect(await getPreapproval(h.client, table, 'nobody')).toBeNull();
  });

  it('queries the sentinel partition', async () => {
    const h = makeClient(pendingRow());
    const rows = await listPreapprovals(h.client, table);

    expect(h.of('QueryCommand')[0].input.ExpressionAttributeValues).toEqual({
      ':pk': PREAPPROVAL_PK,
    });
    expect(rows).toHaveLength(1);
  });
});

describe('claimOssPreapproval', () => {
  beforeEach(() => vi.resetAllMocks());

  it('writes an org-scoped grant onto the installation #SETTINGS row', async () => {
    const h = makeClient(pendingRow());
    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result).toMatchObject({ claimed: true, capCents: 2000 });

    const settingsWrite = h.of('UpdateCommand')
      .find((c) => c.input.Key.repoFullName === '#SETTINGS')!;
    expect(settingsWrite.input.Key.installationId).toBe(INSTALL_ID);
    expect(settingsWrite.input.ExpressionAttributeValues[':scope']).toBe('org');
    expect(settingsWrite.input.ExpressionAttributeValues[':account']).toEqual({
      id: 9931,
      login: 'Acme-Corp',
    });
    expect(settingsWrite.input.ExpressionAttributeValues[':cap']).toBe(2000);
  });

  it('guards the grant write so a redelivery cannot reset it', async () => {
    const h = makeClient(pendingRow());
    await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    const settingsWrite = h.of('UpdateCommand')
      .find((c) => c.input.Key.repoFullName === '#SETTINGS')!;
    expect(settingsWrite.input.ConditionExpression).toBe(
      'attribute_not_exists(ossGrantExpiresAt)',
    );
  });

  it('runs the grant term from the claim, not from the approval', async () => {
    // An org that took six weeks to install still gets its full 12 months.
    const h = makeClient(pendingRow({ months: 12 }));
    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result.claimed).toBe(true);
    expect((result as any).expiresAt).toBe('2027-08-20T12:00:00.000Z');
  });

  it('marks the pending row claimed AFTER the grant lands', async () => {
    const h = makeClient(pendingRow());
    await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    const updates = h.of('UpdateCommand');
    const settingsIdx = updates.findIndex((c) => c.input.Key.repoFullName === '#SETTINGS');
    const claimIdx = updates.findIndex((c) => c.input.Key.installationId === PREAPPROVAL_PK);

    // Order matters: if the mark fails, a redelivery retries and stops at
    // grant_exists. Marking first would risk losing the grant entirely.
    expect(settingsIdx).toBeLessThan(claimIdx);
    expect(updates[claimIdx].input.ExpressionAttributeValues[':inst']).toBe(INSTALL_ID);
  });

  it('is a no-op when no pre-approval exists', async () => {
    const h = makeClient(null);
    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result).toEqual({ claimed: false, reason: 'no_preapproval' });
    expect(h.of('UpdateCommand')).toHaveLength(0);
  });

  it('never re-fires a claimed pre-approval on reinstall', async () => {
    // Uninstall/reinstall must not silently re-grant — a spent approval goes
    // back through an operator.
    const h = makeClient(pendingRow({ claimedAt: '2026-08-15T00:00:00.000Z' }));
    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result).toEqual({ claimed: false, reason: 'already_claimed' });
    expect(h.of('UpdateCommand')).toHaveLength(0);
  });

  it('refuses an expired pre-approval and stamps it', async () => {
    const h = makeClient(pendingRow({ preapprovalExpiresAt: '2026-08-01T00:00:00.000Z' }));
    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result).toEqual({ claimed: false, reason: 'expired' });

    const updates = h.of('UpdateCommand');
    // Only the expiry stamp — nothing was written to #SETTINGS.
    expect(updates).toHaveLength(1);
    expect(updates[0].input.Key.installationId).toBe(PREAPPROVAL_PK);
    expect(updates[0].input.UpdateExpression).toBe('SET expiredAt = :at');
  });

  it('fails closed on an unparseable expiry', async () => {
    const h = makeClient(pendingRow({ preapprovalExpiresAt: 'not-a-date' }));
    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result).toEqual({ claimed: false, reason: 'expired' });
  });

  it('treats an existing grant as a successful no-op, not an error', async () => {
    // The redelivery case: an operator amended or revoked the grant in between.
    const h = makeClient(pendingRow());
    h.failConditionOn('#SETTINGS');

    const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    expect(result).toEqual({ claimed: false, reason: 'grant_exists' });
    // The pending row must NOT be marked claimed — the grant it describes was
    // never the one that landed.
    expect(h.of('UpdateCommand').some((c) => c.input.Key.installationId === PREAPPROVAL_PK))
      .toBe(false);
  });

  it('rethrows a non-condition DynamoDB failure', async () => {
    const h = makeClient(pendingRow());
    h.client.send = vi.fn(async (cmd: any) => {
      if (cmd.constructor.name === 'GetCommand') return { Item: pendingRow() };
      throw Object.assign(new Error('ProvisionedThroughputExceeded'), {
        name: 'ProvisionedThroughputExceededException',
      });
    });

    await expect(
      claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });

  it('matches a pre-approval written with different casing', async () => {
    const h = makeClient(pendingRow());
    await claimOssPreapproval(h.client, table, INSTALL_ID, { id: 1, login: 'ACME-CORP' }, NOW);

    expect(h.of('GetCommand')[0].input.Key.repoFullName).toBe('acme-corp');
  });

  it('carries the operator note into the grant for provenance', async () => {
    const h = makeClient(pendingRow({ note: 'form response #42' }));
    await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    const settingsWrite = h.of('UpdateCommand')
      .find((c) => c.input.Key.repoFullName === '#SETTINGS')!;
    expect(settingsWrite.input.ExpressionAttributeValues[':note'])
      .toContain('form response #42');
    expect(settingsWrite.input.ExpressionAttributeValues[':note'])
      .toContain('claimed from pre-approval');
  });

  it('still records provenance when the operator left no note', async () => {
    const h = makeClient(pendingRow({ note: undefined }));
    await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    const settingsWrite = h.of('UpdateCommand')
      .find((c) => c.input.Key.repoFullName === '#SETTINGS')!;
    expect(settingsWrite.input.ExpressionAttributeValues[':note'])
      .toBe('Claimed from pre-approval 2026-08-10T12:00:00.000Z');
  });

  it('does not touch balance, free tier, or any non-OSS billing field', async () => {
    // The claim writes an entitlement, not money.
    const h = makeClient(pendingRow());
    await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);

    const settingsWrite = h.of('UpdateCommand')
      .find((c) => c.input.Key.repoFullName === '#SETTINGS')!;
    const expr = settingsWrite.input.UpdateExpression as string;
    expect(expr).not.toMatch(/balanceCents|freeReviewsUsed|stripeCustomerId/);
  });
});

describe('date arithmetic is timezone-independent', () => {
  // Local-time setDate/setMonth shift by an extra hour across a DST boundary,
  // which would make a grant's expiry depend on whose laptop ran the script.
  const TZ_CASES = ['UTC', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata'];

  it('produces the same TTL in every timezone', async () => {
    const results = new Set<string>();
    for (const tz of TZ_CASES) {
      const original = process.env.TZ;
      process.env.TZ = tz;
      const h = makeClient(null);
      const row = await putPreapproval(h.client, table, { orgLogin: 'acme-corp' }, NOW);
      results.add(row.preapprovalExpiresAt);
      process.env.TZ = original;
    }
    expect(results.size).toBe(1);
  });

  it('lands the TTL exactly 90 × 24h out, DST boundary or not', async () => {
    // Aug 20 -> Nov 18 crosses the US DST change on Nov 1.
    const h = makeClient(null);
    const row = await putPreapproval(h.client, table, { orgLogin: 'acme-corp' }, NOW);

    expect(Date.parse(row.preapprovalExpiresAt) - NOW.getTime())
      .toBe(OSS_PREAPPROVAL_TTL_DAYS * 86_400_000);
  });

  it('produces the same grant expiry in every timezone', async () => {
    const results = new Set<string>();
    for (const tz of TZ_CASES) {
      const original = process.env.TZ;
      process.env.TZ = tz;
      const h = makeClient(pendingRow({ months: 12 }));
      const result = await claimOssPreapproval(h.client, table, INSTALL_ID, account, NOW);
      results.add((result as any).expiresAt);
      process.env.TZ = original;
    }
    expect(results.size).toBe(1);
    expect([...results][0]).toBe('2027-08-20T12:00:00.000Z');
  });
});
