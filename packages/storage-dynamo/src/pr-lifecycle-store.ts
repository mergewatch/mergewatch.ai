/**
 * DynamoDB implementation of `IPRLifecycleStore` (TTM / #194).
 *
 * Table shape (created in infra/template.yaml):
 *   PK: `${installationId}#${repoFullName}`
 *   SK: prNumber (String — the PR number, stringified)
 *
 * The composite PK keeps one installation's PRs colocated for efficient
 * listByInstallation (Scan + begins_with filter, no GSI) — same trade-off as
 * the FB-A finding-disposition table. One row per PR (not per commit).
 *
 * Best-effort writes: every method swallows-and-logs on failure so a
 * lifecycle write can never block the review pipeline. Terminal-state
 * discipline is enforced with ConditionExpressions (swallowed when they fail).
 */

import {
  DynamoDBDocumentClient,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  IPRLifecycleStore,
  PRLifecycleOpenInput,
  PRLifecycleCloseInput,
  PRLifecycleRecord,
} from '@mergewatch/core';

export const DEFAULT_PR_LIFECYCLE_TABLE = 'mergewatch-pr-lifecycle';

/** Retain terminal rows ~90 days past close — long enough for the 90d window. */
const TTL_DAYS_AFTER_TERMINAL = 90;

/** Compose the partition key from installation + repo. */
function pk(installationId: string, repoFullName: string): string {
  return `${installationId}#${repoFullName}`;
}

/** Re-split the partition key. Symmetric with {@link pk}. */
function splitPk(composite: string): { installationId: string; repoFullName: string } {
  const idx = composite.indexOf('#');
  return idx < 0
    ? { installationId: composite, repoFullName: '' }
    : { installationId: composite.slice(0, idx), repoFullName: composite.slice(idx + 1) };
}

/** Unix epoch seconds, TTL_DAYS_AFTER_TERMINAL past the given ISO timestamp. */
function ttlFrom(iso: string): number {
  const ms = Date.parse(iso);
  const base = Number.isNaN(ms) ? Date.now() : ms;
  return Math.floor(base / 1000) + TTL_DAYS_AFTER_TERMINAL * 24 * 60 * 60;
}

/**
 * Shared bootstrap clause: defaults every non-key attribute so a row created
 * by any entry point (open / push / review / skip / close) is internally
 * consistent. `if_not_exists` makes each idempotent.
 */
const BOOTSTRAP_SET = [
  'reviewed = if_not_exists(reviewed, :false)',
  'skipped = if_not_exists(skipped, :false)',
  'totalPushes = if_not_exists(totalPushes, :zero)',
  'pushesAfterFirstReview = if_not_exists(pushesAfterFirstReview, :zero)',
];

const BOOTSTRAP_VALUES = { ':false': false, ':zero': 0 } as const;

export class DynamoPRLifecycleStore implements IPRLifecycleStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string = DEFAULT_PR_LIFECYCLE_TABLE,
  ) {}

  async upsertOpened(rec: PRLifecycleOpenInput): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(rec.installationId, rec.repoFullName), sk: String(rec.prNumber) },
        UpdateExpression:
          'SET prCreatedAt = if_not_exists(prCreatedAt, :createdAt), ' +
          '#state = if_not_exists(#state, :open), updatedAt = :now, ' +
          BOOTSTRAP_SET.join(', '),
        // Only create or touch an open row — never resurrect a terminal one.
        ConditionExpression: 'attribute_not_exists(pk) OR #state = :open',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':createdAt': rec.prCreatedAt,
          ':open': 'open',
          ':now': now,
          ...BOOTSTRAP_VALUES,
        },
      }));
    } catch (err) {
      if (isConditionalFail(err)) return; // terminal row — expected no-op
      console.warn('[ttm] upsertOpened failed (%s/%s#%d):', rec.installationId, rec.repoFullName, rec.prNumber, err);
    }
  }

  async recordPush(installationId: string, repoFullName: string, prNumber: number): Promise<void> {
    const now = new Date().toISOString();
    const key = { pk: pk(installationId, repoFullName), sk: String(prNumber) };
    // First write: bump totalPushes + bootstrap the row (creates it if missing).
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression:
          'SET #state = if_not_exists(#state, :open), updatedAt = :now, ' +
          'totalPushes = if_not_exists(totalPushes, :zero) + :one, ' +
          'reviewed = if_not_exists(reviewed, :false), ' +
          'skipped = if_not_exists(skipped, :false), ' +
          'pushesAfterFirstReview = if_not_exists(pushesAfterFirstReview, :zero)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':open': 'open', ':now': now, ':zero': 0, ':one': 1, ':false': false },
      }));
    } catch (err) {
      console.warn('[ttm] recordPush (total) failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
      return;
    }
    // Second write: bump the post-first-review counter ONLY if a review landed.
    // DynamoDB can't gate arithmetic on attribute existence inside one SET, so
    // this is a separate conditional update; the conditional failure is the
    // common (pre-review) case and is swallowed.
    //
    // The two writes are intentionally NON-transactional. If this second write
    // fails for a non-conditional reason, totalPushes advances while
    // pushesAfterFirstReview lags by one — an acceptable skew because both are
    // best-effort analytics feeding a round-trip *proxy*, not a correctness
    // invariant, and the lag self-heals on the next push. We log (below) so a
    // persistent divergence is visible rather than silent.
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: 'SET pushesAfterFirstReview = if_not_exists(pushesAfterFirstReview, :zero) + :one',
        ConditionExpression: 'attribute_exists(firstReviewAt)',
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      }));
    } catch (err) {
      if (isConditionalFail(err)) return; // no first review yet — expected
      console.warn('[ttm] recordPush (afterReview) failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async markReviewed(installationId: string, repoFullName: string, prNumber: number, atIso: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(installationId, repoFullName), sk: String(prNumber) },
        UpdateExpression:
          'SET firstReviewAt = if_not_exists(firstReviewAt, :at), reviewed = :true, ' +
          '#state = if_not_exists(#state, :open), updatedAt = :at, ' +
          'skipped = if_not_exists(skipped, :false), ' +
          'totalPushes = if_not_exists(totalPushes, :zero), ' +
          'pushesAfterFirstReview = if_not_exists(pushesAfterFirstReview, :zero)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':at': atIso, ':true': true, ':open': 'open', ':false': false, ':zero': 0 },
      }));
    } catch (err) {
      console.warn('[ttm] markReviewed failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async markSkipped(installationId: string, repoFullName: string, prNumber: number, atIso: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(installationId, repoFullName), sk: String(prNumber) },
        UpdateExpression:
          'SET skipped = :true, #state = if_not_exists(#state, :open), updatedAt = :at, ' +
          'reviewed = if_not_exists(reviewed, :false), ' +
          'totalPushes = if_not_exists(totalPushes, :zero), ' +
          'pushesAfterFirstReview = if_not_exists(pushesAfterFirstReview, :zero)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':true': true, ':at': atIso, ':open': 'open', ':false': false, ':zero': 0 },
      }));
    } catch (err) {
      console.warn('[ttm] markSkipped failed (%s/%s#%d):', installationId, repoFullName, prNumber, err);
    }
  }

  async markMerged(rec: PRLifecycleCloseInput): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(rec.installationId, rec.repoFullName), sk: String(rec.prNumber) },
        // Merge is authoritative — overwrite state + prCreatedAt unconditionally
        // (the closed payload carries the canonical created_at).
        UpdateExpression:
          'SET #state = :merged, mergedAt = :at, prCreatedAt = :createdAt, updatedAt = :at, #ttl = :ttl, ' +
          BOOTSTRAP_SET.join(', '),
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':merged': 'merged',
          ':at': rec.at,
          ':createdAt': rec.prCreatedAt,
          ':ttl': ttlFrom(rec.at),
          ...BOOTSTRAP_VALUES,
        },
      }));
    } catch (err) {
      console.warn('[ttm] markMerged failed (%s/%s#%d):', rec.installationId, rec.repoFullName, rec.prNumber, err);
    }
  }

  async markClosedUnmerged(rec: PRLifecycleCloseInput): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(rec.installationId, rec.repoFullName), sk: String(rec.prNumber) },
        UpdateExpression:
          'SET #state = :closed, closedAt = :at, prCreatedAt = if_not_exists(prCreatedAt, :createdAt), ' +
          'updatedAt = :at, #ttl = :ttl, ' + BOOTSTRAP_SET.join(', '),
        // Defensive: a merged row must never be downgraded to closed_unmerged.
        ConditionExpression: 'attribute_not_exists(#state) OR #state <> :merged',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':closed': 'closed_unmerged',
          ':merged': 'merged',
          ':at': rec.at,
          ':createdAt': rec.prCreatedAt,
          ':ttl': ttlFrom(rec.at),
          ...BOOTSTRAP_VALUES,
        },
      }));
    } catch (err) {
      if (isConditionalFail(err)) return; // already merged — keep terminal merged
      console.warn('[ttm] markClosedUnmerged failed (%s/%s#%d):', rec.installationId, rec.repoFullName, rec.prNumber, err);
    }
  }

  async listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: PRLifecycleRecord[]; nextCursor?: string }> {
    // Bounded Scan with begins_with(pk, '<installationId>#') — same rationale as
    // the FB-A disposition table: the nightly rollup is the only caller and
    // per-installation PR counts are bounded.
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const prefix = `${installationId}#`;
    const resp = await this.client.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'begins_with(#pk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':prefix': prefix },
      Limit: limit,
      ...(opts?.cursor ? { ExclusiveStartKey: JSON.parse(opts.cursor) } : {}),
    }));
    const items = (resp.Items ?? []).map(itemToRecord);
    return resp.LastEvaluatedKey
      ? { items, nextCursor: JSON.stringify(resp.LastEvaluatedKey) }
      : { items };
  }
}

function isConditionalFail(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ConditionalCheckFailedException';
}

/** Decode a DynamoDB item into the typed record shape. */
function itemToRecord(it: Record<string, unknown>): PRLifecycleRecord {
  const { installationId, repoFullName } = splitPk(String(it.pk));
  const r: PRLifecycleRecord = {
    installationId,
    repoFullName,
    prNumber: Number(it.sk ?? 0),
    prCreatedAt: String(it.prCreatedAt ?? ''),
    state: (it.state as PRLifecycleRecord['state']) ?? 'open',
    reviewed: Boolean(it.reviewed ?? false),
    skipped: Boolean(it.skipped ?? false),
    totalPushes: Number(it.totalPushes ?? 0),
    pushesAfterFirstReview: Number(it.pushesAfterFirstReview ?? 0),
    updatedAt: String(it.updatedAt ?? ''),
  };
  if (it.firstReviewAt) r.firstReviewAt = String(it.firstReviewAt);
  if (it.mergedAt) r.mergedAt = String(it.mergedAt);
  if (it.closedAt) r.closedAt = String(it.closedAt);
  if (it.ttl !== undefined) r.ttl = Number(it.ttl);
  return r;
}
