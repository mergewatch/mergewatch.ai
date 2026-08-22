/**
 * #421 — GitHub Marketplace purchase records.
 *
 * The listing carries a free plan only, so the failure modes worth pinning are
 * about *not* doing things: never revoking on cancel, never double-recording a
 * redelivery, never resetting first-seen or detaching on a rewrite.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MARKETPLACE_PK,
  normalizeAccount,
  getMarketplaceRecord,
  recordMarketplaceEvent,
  attachMarketplaceToInstallation,
} from './marketplace';
import type { MarketplaceRecord } from './marketplace';

const table = 'installations';
const NOW = new Date('2026-08-22T12:00:00.000Z');
const LATER = new Date('2026-09-01T12:00:00.000Z');

function event(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    effective_date: '2026-08-22T12:00:00Z',
    sender: { login: 'someone', id: 1, type: 'User' },
    marketplace_purchase: {
      account: { type: 'Organization', id: 9931, login: 'Acme-Corp' },
      billing_cycle: 'monthly',
      plan: { id: 77, name: 'Free', monthly_price_in_cents: 0 },
      ...overrides,
    },
  } as any;
}

/** Minimal doc-client double that remembers what was written. */
function makeClient(seed: MarketplaceRecord | null = null) {
  const store = new Map<string, any>();
  if (seed) store.set(`${seed.installationId}|${seed.repoFullName}`, seed);
  const sent: { type: string; input: any }[] = [];

  const client = {
    send: vi.fn(async (cmd: any) => {
      const type = cmd.constructor.name;
      sent.push({ type, input: cmd.input });
      const key = (k: any) => `${k.installationId}|${k.repoFullName}`;
      if (type === 'GetCommand') return { Item: store.get(key(cmd.input.Key)) };
      if (type === 'PutCommand') { store.set(key(cmd.input.Item), cmd.input.Item); return {}; }
      if (type === 'UpdateCommand') {
        const k = key(cmd.input.Key);
        store.set(k, { ...(store.get(k) ?? cmd.input.Key), ...cmd.input.ExpressionAttributeValues });
        return {};
      }
      if (type === 'QueryCommand') return { Items: [...store.values()] };
      return {};
    }),
  } as any;

  return { client, store, sent, of: (t: string) => sent.filter((s) => s.type === t) };
}

describe('normalizeAccount', () => {
  it('lowercases and trims so login casing never splits a record', () => {
    expect(normalizeAccount('Acme-Corp')).toBe('acme-corp');
    expect(normalizeAccount('  ACME-CORP ')).toBe('acme-corp');
  });
});

describe('recordMarketplaceEvent', () => {
  it('records a purchase under the sentinel partition, keyed by lowercased login', async () => {
    const h = makeClient();
    const r = await recordMarketplaceEvent(h.client, table, event('purchased'), NOW);

    expect(r.installationId).toBe(MARKETPLACE_PK);
    expect(r.repoFullName).toBe('acme-corp');
    expect(r.accountLogin).toBe('Acme-Corp');   // original casing kept for display
    expect(r.accountId).toBe(9931);
    expect(r.planName).toBe('Free');
    expect(r.lastAction).toBe('purchased');
    expect(r.purchasedAt).toBe(NOW.toISOString());
  });

  it('is idempotent — a redelivered purchase rewrites one row, not two', async () => {
    const h = makeClient();
    await recordMarketplaceEvent(h.client, table, event('purchased'), NOW);
    await recordMarketplaceEvent(h.client, table, event('purchased'), LATER);

    expect(h.store.size).toBe(1);
  });

  it('never moves purchasedAt on redelivery', async () => {
    // First sighting is the attribution timestamp; a redelivery must not
    // rewrite when the account arrived.
    const h = makeClient();
    await recordMarketplaceEvent(h.client, table, event('purchased'), NOW);
    const again = await recordMarketplaceEvent(h.client, table, event('purchased'), LATER);

    expect(again.purchasedAt).toBe(NOW.toISOString());
    expect(again.updatedAt).toBe(LATER.toISOString());
  });

  it('records a cancellation WITHOUT revoking anything', async () => {
    // With a free plan and Stripe-side paid billing, a Marketplace cancel says
    // nothing about installs or credits. Recording it and changing nothing
    // else is correct, not an omission.
    const h = makeClient();
    await recordMarketplaceEvent(h.client, table, event('purchased'), NOW);
    const cancelled = await recordMarketplaceEvent(h.client, table, event('cancelled'), LATER);

    expect(cancelled.cancelledAt).toBe(LATER.toISOString());
    expect(cancelled.lastAction).toBe('cancelled');
    // Attribution survives the cancellation.
    expect(cancelled.purchasedAt).toBe(NOW.toISOString());
    // Nothing was written to any installation's #SETTINGS row.
    expect(h.of('UpdateCommand')).toHaveLength(0);
  });

  it('keeps an existing attachment when a later event rewrites the row', async () => {
    const h = makeClient({
      installationId: MARKETPLACE_PK, repoFullName: 'acme-corp',
      accountLogin: 'Acme-Corp', accountId: 9931, lastAction: 'purchased',
      purchasedAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      attachedInstallationId: '4242', attachedAt: NOW.toISOString(),
    });
    const r = await recordMarketplaceEvent(h.client, table, event('cancelled'), LATER);
    expect(r.attachedInstallationId).toBe('4242');
  });

  it('records an unexpected action rather than dropping it', async () => {
    // A free-only listing should not produce these; if one arrives it must be
    // visible in the data, not silently discarded.
    const h = makeClient();
    const r = await recordMarketplaceEvent(h.client, table, event('changed'), NOW);
    expect(r.lastAction).toBe('changed');
    // Not a purchase, so no purchase timestamp is invented.
    expect(r.purchasedAt).toBeUndefined();
  });

  it('matches a record written under different login casing', async () => {
    const h = makeClient();
    await recordMarketplaceEvent(h.client, table, event('purchased'), NOW);
    const found = await getMarketplaceRecord(h.client, table, 'ACME-CORP');
    expect(found?.accountId).toBe(9931);
  });
});

describe('attachMarketplaceToInstallation', () => {
  const seeded = (): MarketplaceRecord => ({
    installationId: MARKETPLACE_PK, repoFullName: 'acme-corp',
    accountLogin: 'Acme-Corp', accountId: 9931, planName: 'Free',
    lastAction: 'purchased', purchasedAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });

  it('writes attribution onto the installation #SETTINGS row', async () => {
    const h = makeClient(seeded());
    const res = await attachMarketplaceToInstallation(h.client, table, '4242', 'Acme-Corp', LATER);

    expect(res.attached).toBe(true);
    const settings = h.of('UpdateCommand').find((c) => c.input.Key.repoFullName === '#SETTINGS')!;
    expect(settings.input.Key.installationId).toBe('4242');
    expect(settings.input.ExpressionAttributeValues[':login']).toBe('Acme-Corp');
    expect(settings.input.ExpressionAttributeValues[':plan']).toBe('Free');
  });

  it('stamps the marketplace record with the installation it landed on', async () => {
    const h = makeClient(seeded());
    await attachMarketplaceToInstallation(h.client, table, '4242', 'Acme-Corp', LATER);

    const stamp = h.of('UpdateCommand').find((c) => c.input.Key.installationId === MARKETPLACE_PK)!;
    expect(stamp.input.ExpressionAttributeValues[':inst']).toBe('4242');
  });

  it('is a no-op with no marketplace record — the common case', async () => {
    // Most installs do not come from Marketplace.
    const h = makeClient();
    const res = await attachMarketplaceToInstallation(h.client, table, '4242', 'nobody', LATER);

    expect(res).toEqual({ attached: false, reason: 'no_record' });
    expect(h.of('UpdateCommand')).toHaveLength(0);
  });

  it('does not re-attach, so a reinstall never flaps the attribution', async () => {
    const h = makeClient({ ...seeded(), attachedInstallationId: '1111', attachedAt: NOW.toISOString() });
    const res = await attachMarketplaceToInstallation(h.client, table, '9999', 'Acme-Corp', LATER);

    expect(res).toEqual({ attached: false, reason: 'already_attached' });
    expect(h.of('UpdateCommand')).toHaveLength(0);
  });

  it('KNOWN LIMITATION: install-then-purchase leaves the record unattached', async () => {
    // Attach only runs on installation.created. If an already-installed account
    // later buys the free plan from the listing, the record is written but
    // never denormalized onto #SETTINGS, because a Marketplace event carries an
    // account and resolving it to an installation would need a table scan or an
    // App JWT — neither is cheap, and neither is in scope for attribution.
    //
    // Attribution is NOT lost: the #MARKETPLACE row exists and is queryable by
    // account. Only the #SETTINGS convenience copy is missing. Pinned here so
    // the behavior is a known tradeoff rather than an accident.
    const h = makeClient();
    await recordMarketplaceEvent(h.client, table, event('purchased'), NOW);

    const record = await getMarketplaceRecord(h.client, table, 'Acme-Corp');
    expect(record).not.toBeNull();
    expect(record!.attachedInstallationId).toBeUndefined();
    // Nothing was written to any installation row.
    expect(h.of('UpdateCommand')).toHaveLength(0);
  });

  it('resolves the record regardless of login casing', async () => {
    const h = makeClient(seeded());
    const res = await attachMarketplaceToInstallation(h.client, table, '4242', 'acme-corp', LATER);
    expect(res.attached).toBe(true);
  });
});
