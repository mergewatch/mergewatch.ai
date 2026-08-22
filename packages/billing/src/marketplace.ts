/**
 * #421 — GitHub Marketplace purchase records.
 *
 * The Marketplace listing carries a **free plan only**: discovery and install
 * happen through Marketplace, but money never does. Paid conversion stays on
 * MergeWatch's own SaaS billing (Stripe prepaid credits, the free tier, OSS
 * grants). So nothing here grants entitlement and nothing here revokes it —
 * these records exist for **attribution**: which installations arrived via
 * Marketplace, on what plan, and when.
 *
 * It lives in `@mergewatch/billing` because that package already owns the
 * SaaS-only installation-table helpers and `isSaas()`, not because Marketplace
 * bills anything. If paid Marketplace plans are ever added, this is where the
 * entitlement mapping would go and the naming stops being a compromise.
 *
 * ## Why the record is keyed by account, not installation
 *
 * A Marketplace event carries an **account** (login + numeric id), never an
 * installation. The installations table is partitioned by `installationId`, so
 * a login cannot be resolved to an installation without scanning.
 *
 * Rather than scan, the account-keyed row IS the durable record, under a
 * `#MARKETPLACE` sentinel partition — the same idiom as `#SETTINGS`, `#AGENTS`,
 * and `#PENDING-OSS`. `installation.created` then attaches it to the
 * installation. A purchase is therefore never lost regardless of ordering, and
 * for a free plan GitHub processes the purchase *before* redirecting to
 * install, so purchase-then-install is the normal path.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MarketplacePurchaseEvent } from '@mergewatch/core';

/** Partition key every Marketplace record shares. */
export const MARKETPLACE_PK = '#MARKETPLACE';

const SETTINGS_SK = '#SETTINGS';

/**
 * One account's Marketplace state.
 *
 * The sort key is the table's `repoFullName` attribute — an artifact of reusing
 * the installations table, not a repository. It holds the **lowercased** account
 * login; `accountLogin` keeps GitHub's original casing for display.
 */
export interface MarketplaceRecord {
  /** Always `MARKETPLACE_PK`. */
  installationId: string;
  /** Sort key: lowercased account login. Not a repository. */
  repoFullName: string;
  /** The login as GitHub sent it. Display only. */
  accountLogin: string;
  /** GitHub's immutable numeric account id. */
  accountId: number;
  accountType?: string;
  planName?: string;
  planId?: number;
  /** The most recent action seen for this account. */
  lastAction: MarketplacePurchaseEvent['action'];
  /** First time we saw a `purchased` for this account. Never overwritten. */
  purchasedAt?: string;
  /** Set on `cancelled`. Recorded only — nothing is revoked. */
  cancelledAt?: string;
  /** Last time any Marketplace event touched this record. */
  updatedAt: string;
  /** Set once `installation.created` attached this record to an installation. */
  attachedInstallationId?: string;
  attachedAt?: string;
}

/**
 * GitHub logins are case-insensitive, and the login is the only join key we
 * have between a purchase and an installation.
 */
export function normalizeAccount(login: string): string {
  return login.trim().toLowerCase();
}

/** Read one account's Marketplace record, or null. */
export async function getMarketplaceRecord(
  client: DynamoDBDocumentClient,
  table: string,
  login: string,
): Promise<MarketplaceRecord | null> {
  const res = await client.send(new GetCommand({
    TableName: table,
    Key: { installationId: MARKETPLACE_PK, repoFullName: normalizeAccount(login) },
  }));
  return (res.Item as MarketplaceRecord | undefined) ?? null;
}

/** Every Marketplace record. Operational visibility — who came from the listing. */
export async function listMarketplaceRecords(
  client: DynamoDBDocumentClient,
  table: string,
): Promise<MarketplaceRecord[]> {
  const out: MarketplaceRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await client.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'installationId = :pk',
      ExpressionAttributeValues: { ':pk': MARKETPLACE_PK },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as MarketplaceRecord[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

/**
 * Record a Marketplace event against its account.
 *
 * Idempotent by construction: the row is keyed by account, so a redelivered
 * `purchased` rewrites the same row rather than adding a second one.
 * `purchasedAt` and the attachment fields are preserved across rewrites —
 * a redelivery must not reset when we first saw the account, and must not
 * detach an installation we already attached.
 *
 * **`cancelled` revokes nothing.** With a free plan and Stripe-side paid
 * billing, a Marketplace cancellation says nothing about whether the customer
 * still has the App installed or credits on file. Recording it and changing
 * nothing else is the correct behavior, not an omission.
 */
export async function recordMarketplaceEvent(
  client: DynamoDBDocumentClient,
  table: string,
  event: MarketplacePurchaseEvent,
  now: Date = new Date(),
): Promise<MarketplaceRecord> {
  const purchase = event.marketplace_purchase;
  const account = purchase.account;
  const sk = normalizeAccount(account.login);
  const ts = now.toISOString();

  const existing = await getMarketplaceRecord(client, table, account.login);

  const record: MarketplaceRecord = {
    installationId: MARKETPLACE_PK,
    repoFullName: sk,
    accountLogin: account.login,
    accountId: account.id,
    ...(account.type ? { accountType: account.type } : {}),
    ...(purchase.plan?.name ? { planName: purchase.plan.name } : {}),
    ...(purchase.plan?.id != null ? { planId: purchase.plan.id } : {}),
    lastAction: event.action,
    // First sighting wins — a redelivery must not move it.
    ...(existing?.purchasedAt
      ? { purchasedAt: existing.purchasedAt }
      : event.action === 'purchased'
        ? { purchasedAt: ts }
        : {}),
    ...(event.action === 'cancelled'
      ? { cancelledAt: ts }
      : existing?.cancelledAt
        ? { cancelledAt: existing.cancelledAt }
        : {}),
    updatedAt: ts,
    // Never drop an attachment we already made.
    ...(existing?.attachedInstallationId
      ? { attachedInstallationId: existing.attachedInstallationId, attachedAt: existing.attachedAt }
      : {}),
  };

  await client.send(new PutCommand({ TableName: table, Item: record }));
  return record;
}

export type AttachResult =
  | { attached: true; record: MarketplaceRecord }
  | { attached: false; reason: 'no_record' | 'already_attached' };

/**
 * Attach an account's Marketplace record to the installation it belongs to,
 * called from `installation.created`.
 *
 * Writes attribution onto the installation's `#SETTINGS` row so the review path
 * and dashboard can see it without a second lookup, and stamps the Marketplace
 * record with the installation it landed on.
 *
 * Re-attaching is a no-op: `installation.created` is redeliverable, and an
 * account that uninstalls and reinstalls gets a new installation id — keeping
 * the first attachment means the record reflects where the purchase originally
 * landed rather than flapping on reinstall.
 */
export async function attachMarketplaceToInstallation(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  accountLogin: string,
  now: Date = new Date(),
): Promise<AttachResult> {
  const record = await getMarketplaceRecord(client, table, accountLogin);
  if (!record) return { attached: false, reason: 'no_record' };
  if (record.attachedInstallationId) return { attached: false, reason: 'already_attached' };

  const ts = now.toISOString();

  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId, repoFullName: SETTINGS_SK },
    UpdateExpression:
      'SET marketplaceAccountLogin = :login, marketplaceAccountId = :id, '
      + 'marketplacePlanName = :plan, marketplaceAttachedAt = :at',
    ExpressionAttributeValues: {
      ':login': record.accountLogin,
      ':id': record.accountId,
      ':plan': record.planName ?? 'unknown',
      ':at': ts,
    },
  }));

  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId: MARKETPLACE_PK, repoFullName: normalizeAccount(accountLogin) },
    UpdateExpression: 'SET attachedInstallationId = :inst, attachedAt = :at',
    ExpressionAttributeValues: { ':inst': installationId, ':at': ts },
  }));

  return { attached: true, record: { ...record, attachedInstallationId: installationId, attachedAt: ts } };
}
