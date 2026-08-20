/**
 * #409 — OSS Program pre-approval.
 *
 * Approving a project used to require the maintainer to install the App first:
 * `scripts/grant-oss.ts` resolves a repo to its installation, and without an
 * installation there is no `#SETTINGS` row to write a grant onto. A pre-approval
 * parks the decision in a pending row keyed by org login; the webhook claims it
 * on `installation.created` and the org's very first PR is already sponsored.
 *
 * The pending row lives in the installations table under a sentinel partition
 * key, alongside the existing `#SETTINGS` / `#AGENTS` sentinel idiom. That costs
 * no new infrastructure: the webhook Lambda already writes this table.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { OssGrantAccount } from '@mergewatch/core';
import {
  OSS_DEFAULT_MONTHLY_CAP_CENTS,
  OSS_DEFAULT_TERM_MONTHS,
  OSS_PREAPPROVAL_TTL_DAYS,
} from './constants';

/** Partition key every pending pre-approval row shares. */
export const PREAPPROVAL_PK = '#PENDING-OSS';

const SETTINGS_SK = '#SETTINGS';

/**
 * A parked approval, waiting for the org to install the App.
 *
 * The sort key is the table's `repoFullName` attribute — an artifact of reusing
 * the installations table, not a repository name. It holds the **lowercased**
 * org login; `orgLogin` keeps the operator's original casing for display.
 */
export interface OssPreapproval {
  /** Always `PREAPPROVAL_PK`. */
  installationId: string;
  /** Sort key: lowercased org login. Not a repository. */
  repoFullName: string;
  /** The login as the operator typed it. Display only — never matched on. */
  orgLogin: string;
  /** Monthly fair-use ceiling the claimed grant will carry. */
  capCents: number;
  /** Grant term in months, applied from the moment of the claim, not of approval. */
  months: number;
  /** Provenance: application reference, project name, approver. */
  note?: string;
  preapprovedAt: string;
  /** After this instant the pre-approval is dead and will not be claimed. */
  preapprovalExpiresAt: string;
  /** Set once the org installed and the grant was written. A claimed row is inert. */
  claimedAt?: string;
  claimedInstallationId?: string;
  /** Set when a claim attempt found the row already past `preapprovalExpiresAt`. */
  expiredAt?: string;
}

export type ClaimSkipReason =
  | 'no_preapproval'
  | 'already_claimed'
  | 'expired'
  | 'grant_exists';

export type ClaimResult =
  | { claimed: true; expiresAt: string; capCents: number }
  | { claimed: false; reason: ClaimSkipReason };

/**
 * GitHub logins are case-insensitive, and an operator types whatever casing the
 * application form had. Normalizing on both write and read is what makes
 * `--preapprove Acme-Corp` match an install by `acme-corp`.
 */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * `from` shifted by whole calendar months, in UTC.
 *
 * `setUTCMonth`, not `setMonth`: the local-time variants shift by an extra hour
 * across a DST boundary, which would make a grant's expiry depend on the
 * timezone of whoever ran the script. Lambda runs in UTC; an operator's laptop
 * does not.
 *
 * Calendar months, so Jan 31 + 1 month lands in early March rather than Feb 31.
 * At the 6–12 month terms this is used for, that edge is not worth special-casing.
 */
function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * `from` shifted by whole days.
 *
 * A TTL is a duration, not a calendar concept, so this is plain millisecond
 * arithmetic — exactly `days × 24h` regardless of DST or timezone.
 */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export interface PreapprovalInput {
  orgLogin: string;
  capCents?: number;
  months?: number;
  note?: string;
  /** Days before an unclaimed pre-approval goes stale. */
  ttlDays?: number;
}

/**
 * Write (or overwrite) a pending pre-approval.
 *
 * Deliberately an unconditional `Put`: re-running `--preapprove` for an org is
 * how an operator renews or corrects one, and refusing would just push them to
 * delete-then-write. Overwriting a **claimed** row would silently un-claim it,
 * so the operator script is responsible for showing existing state and
 * confirming before calling this — the same posture `grant-oss.ts` already
 * takes with its blast-radius print.
 */
export async function putPreapproval(
  client: DynamoDBDocumentClient,
  table: string,
  input: PreapprovalInput,
  now: Date = new Date(),
): Promise<OssPreapproval> {
  const item: OssPreapproval = {
    installationId: PREAPPROVAL_PK,
    repoFullName: normalizeLogin(input.orgLogin),
    orgLogin: input.orgLogin.trim(),
    capCents: input.capCents ?? OSS_DEFAULT_MONTHLY_CAP_CENTS,
    months: input.months ?? OSS_DEFAULT_TERM_MONTHS,
    ...(input.note ? { note: input.note } : {}),
    preapprovedAt: now.toISOString(),
    preapprovalExpiresAt: addDays(now, input.ttlDays ?? OSS_PREAPPROVAL_TTL_DAYS).toISOString(),
  };

  await client.send(new PutCommand({ TableName: table, Item: item }));
  return item;
}

/** Read one pending pre-approval by org login, or null. */
export async function getPreapproval(
  client: DynamoDBDocumentClient,
  table: string,
  orgLogin: string,
): Promise<OssPreapproval | null> {
  const res = await client.send(new GetCommand({
    TableName: table,
    Key: { installationId: PREAPPROVAL_PK, repoFullName: normalizeLogin(orgLogin) },
  }));
  return (res.Item as OssPreapproval | undefined) ?? null;
}

/**
 * Every pre-approval ever written, claimed and unclaimed alike. Claimed rows are
 * kept rather than deleted so this stays an honest record of who was approved
 * and what became of it — the same reason #261 keeps `ossGrantedAt` and
 * `ossGrantNote` on the grant itself.
 */
export async function listPreapprovals(
  client: DynamoDBDocumentClient,
  table: string,
): Promise<OssPreapproval[]> {
  const out: OssPreapproval[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await client.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'installationId = :pk',
      ExpressionAttributeValues: { ':pk': PREAPPROVAL_PK },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as OssPreapproval[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

/** Mark a row so a later `--list-preapprovals` shows why it never fired. */
async function stampExpired(
  client: DynamoDBDocumentClient,
  table: string,
  sk: string,
  now: Date,
): Promise<void> {
  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId: PREAPPROVAL_PK, repoFullName: sk },
    UpdateExpression: 'SET expiredAt = :at',
    ExpressionAttributeValues: { ':at': now.toISOString() },
  }));
}

/**
 * Apply a pending pre-approval to a freshly-created installation.
 *
 * Called from the `installation.created` webhook. Three properties matter more
 * than the happy path:
 *
 * **Idempotent.** `installation.created` is redeliverable, and an operator may
 * amend or revoke the grant afterwards. The `#SETTINGS` write is conditional on
 * `attribute_not_exists(ossGrantExpiresAt)`, so a redelivery can never reset a
 * grant that has since been changed. A failed condition is a successful no-op,
 * not an error.
 *
 * **Ordered.** The pending row is marked claimed only *after* the grant lands.
 * If the mark fails, a redelivery retries and stops at `grant_exists` — the
 * grant is never written twice, and never lost because a bookkeeping write
 * failed.
 *
 * **Never re-fires.** A row carrying `claimedAt` is inert, so uninstalling and
 * reinstalling does not silently re-grant. A spent approval goes back through an
 * operator.
 *
 * The grant term runs from the claim, not from the approval: an org that takes
 * six weeks to install still gets its full 12 months.
 */
export async function claimOssPreapproval(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  account: OssGrantAccount,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const sk = normalizeLogin(account.login);

  const pending = await getPreapproval(client, table, account.login);
  if (!pending) return { claimed: false, reason: 'no_preapproval' };
  if (pending.claimedAt) return { claimed: false, reason: 'already_claimed' };

  const expiresAt = Date.parse(pending.preapprovalExpiresAt);
  // An unparseable date fails closed, same as the grant-expiry check.
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    await stampExpired(client, table, sk, now);
    return { claimed: false, reason: 'expired' };
  }

  const grantExpiresAt = addMonths(now, pending.months).toISOString();
  const account_: OssGrantAccount = { id: account.id, login: account.login };

  try {
    await client.send(new UpdateCommand({
      TableName: table,
      Key: { installationId, repoFullName: SETTINGS_SK },
      UpdateExpression:
        'SET ossGrantScope = :scope, ossGrantAccount = :account, '
        + 'ossGrantExpiresAt = :expires, ossMonthlyCapCents = :cap, '
        + 'ossGrantedAt = :granted, ossGrantNote = :note',
      // Never overwrite a grant that already exists — this is what makes a
      // webhook redelivery, or an operator who granted manually in the meantime,
      // harmless.
      ConditionExpression: 'attribute_not_exists(ossGrantExpiresAt)',
      ExpressionAttributeValues: {
        ':scope': 'org',
        ':account': account_,
        ':expires': grantExpiresAt,
        ':cap': pending.capCents,
        ':granted': now.toISOString(),
        ':note': pending.note
          ? `${pending.note} (claimed from pre-approval ${pending.preapprovedAt})`
          : `Claimed from pre-approval ${pending.preapprovedAt}`,
      },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { claimed: false, reason: 'grant_exists' };
    }
    throw err;
  }

  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId: PREAPPROVAL_PK, repoFullName: sk },
    UpdateExpression: 'SET claimedAt = :at, claimedInstallationId = :inst',
    ExpressionAttributeValues: { ':at': now.toISOString(), ':inst': installationId },
  }));

  return { claimed: true, expiresAt: grantExpiresAt, capCents: pending.capCents };
}
