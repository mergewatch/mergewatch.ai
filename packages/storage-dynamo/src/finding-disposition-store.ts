/**
 * DynamoDB implementation of `IFindingDispositionStore` (FB-A).
 *
 * Table shape (created in infra/template.yaml):
 *   PK: `${installationId}#${repoFullName}`
 *   SK: `findingMatchKey`
 *
 * The composite PK keeps a single installation's records colocated for
 * efficient listByInstallation queries (no cross-partition scan, no GSI
 * required). DynamoDB UpdateExpressions handle the atomic counter
 * increments + jsonb-array-style append; no read-modify-write loops.
 *
 * Best-effort writes: every method swallows-and-logs on failure so a
 * disposition write can never block the review pipeline.
 */

import {
  DynamoDBDocumentClient,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  IFindingDispositionStore,
  FindingDispositionAttribution,
  FindingDispositionRecord,
  PeriodCounterBucket,
} from '@mergewatch/core';
import { periodDayKey } from '@mergewatch/core';

export const DEFAULT_FINDING_DISPOSITIONS_TABLE = 'mergewatch-finding-dispositions';

/**
 * #334 — per-day counter buckets are stored FLATTENED as top-level numeric
 * attributes named `pc#<YYYY-MM-DD>#<counter>` (e.g. `pc#2026-08-16#dispute`)
 * rather than a nested `periodCounts` map. Rationale: DynamoDB cannot
 * atomically create-and-increment a two-level nested map path in one
 * UpdateExpression (intermediate path segments must already exist), which
 * would force a read-or-retry dance on the review hot path. A flat attribute
 * keeps every bucket bump the same single-call
 * `if_not_exists(#a, :zero) + :one` idiom the lifetime counters use.
 * `itemToRecord` folds them back into the typed `periodCounts` map on read.
 */
const PERIOD_ATTR_PREFIX = 'pc#';

function periodAttr(day: string, counter: keyof PeriodCounterBucket): string {
  return `${PERIOD_ATTR_PREFIX}${day}#${counter}`;
}

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

export class DynamoFindingDispositionStore implements IFindingDispositionStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string = DEFAULT_FINDING_DISPOSITIONS_TABLE,
  ) {}

  async upsertSurface(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    nowIso: string,
    attribution?: FindingDispositionAttribution,
  ): Promise<void> {
    // UpdateExpression strategy:
    //   • firstSeen — set ONLY if attribute_not_exists (preserves the original
    //     creation timestamp once the row exists).
    //   • lastSeen — overwrite on every call.
    //   • surfaceCount — `if_not_exists(surfaceCount, :zero) + :one`. The
    //     attribute_not_exists vs SET semantics around counters in DynamoDB
    //     require this pattern.
    //   • category / topAgent / sigTokens — only set when this caller passed
    //     them (avoids clearing prior attribution on minimal upserts).
    const setExprs: string[] = [
      'firstSeen = if_not_exists(firstSeen, :now)',
      'lastSeen = :now',
      'surfaceCount = if_not_exists(surfaceCount, :zero) + :one',
      // #334 — bump today's flattened surface bucket in the same call.
      '#pcSurface = if_not_exists(#pcSurface, :zero) + :one',
      // Counter defaults so subsequent increment* calls don't have to
      // bootstrap. DynamoDB rejects ADD on a non-existent attribute when
      // the target type is unset; pre-seeding to 0 sidesteps that.
      'disputeCount = if_not_exists(disputeCount, :zero)',
      'verifiedCount = if_not_exists(verifiedCount, :zero)',
      'unverifiedCount = if_not_exists(unverifiedCount, :zero)',
      'silentDropCount = if_not_exists(silentDropCount, :zero)',
      'agreementCount = if_not_exists(agreementCount, :zero)',
      'resolveCount = if_not_exists(resolveCount, :zero)',
    ];
    const exprValues: Record<string, unknown> = {
      ':now': nowIso,
      ':zero': 0,
      ':one': 1,
    };
    const exprNames: Record<string, string> = {
      '#pcSurface': periodAttr(periodDayKey(nowIso), 'surface'),
    };
    if (attribution?.category !== undefined) {
      setExprs.push('category = :category');
      exprValues[':category'] = attribution.category;
    }
    if (attribution?.topAgent !== undefined) {
      setExprs.push('topAgent = :topAgent');
      exprValues[':topAgent'] = attribution.topAgent;
    }
    if (attribution?.severity !== undefined) {
      // FB-I — severity drives the severity-shopping detector rollup.
      setExprs.push('severity = :severity');
      exprValues[':severity'] = attribution.severity;
    }
    if (attribution?.sigTokens !== undefined) {
      setExprs.push('sigTokens = :sigTokens');
      exprValues[':sigTokens'] = attribution.sigTokens;
    }

    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(installationId, repoFullName), sk: findingMatchKey },
        UpdateExpression: 'SET ' + setExprs.join(', '),
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
      }));
    } catch (err) {
      console.warn('[fb-a] upsertSurface failed (%s/%s/%s):', installationId, repoFullName, findingMatchKey, err);
    }
  }

  private async incrementCounter(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    attrName: 'disputeCount' | 'verifiedCount' | 'unverifiedCount' | 'silentDropCount' | 'agreementCount' | 'resolveCount',
    periodKey: keyof PeriodCounterBucket,
    nowIso?: string,
  ): Promise<void> {
    try {
      const day = periodDayKey(nowIso ?? new Date().toISOString());
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        // #334 — the lifetime counter and its per-day bucket bump in ONE
        // expression so they can never drift apart.
        UpdateExpression: `SET #c = if_not_exists(#c, :zero) + :one, #p = if_not_exists(#p, :zero) + :one`,
        Key: { pk: pk(installationId, repoFullName), sk: findingMatchKey },
        ExpressionAttributeNames: { '#c': attrName, '#p': periodAttr(day, periodKey) },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      }));
    } catch (err) {
      console.warn('[fb-a] %s increment failed (%s/%s/%s):', attrName, installationId, repoFullName, findingMatchKey, err);
    }
  }

  incrementDispute(i: string, r: string, k: string, nowIso?: string)     { return this.incrementCounter(i, r, k, 'disputeCount', 'dispute', nowIso); }
  incrementVerified(i: string, r: string, k: string, nowIso?: string)    { return this.incrementCounter(i, r, k, 'verifiedCount', 'verified', nowIso); }
  incrementUnverified(i: string, r: string, k: string, nowIso?: string)  { return this.incrementCounter(i, r, k, 'unverifiedCount', 'unverified', nowIso); }
  incrementSilentDrop(i: string, r: string, k: string, nowIso?: string)  { return this.incrementCounter(i, r, k, 'silentDropCount', 'silentDrop', nowIso); }
  incrementAgreement(i: string, r: string, k: string, nowIso?: string)   { return this.incrementCounter(i, r, k, 'agreementCount', 'agreement', nowIso); }
  incrementResolve(i: string, r: string, k: string, nowIso?: string)     { return this.incrementCounter(i, r, k, 'resolveCount', 'resolve', nowIso); }

  async appendRejectReason(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    reason: NonNullable<FindingDispositionRecord['rejectReasons']>[number],
  ): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(installationId, repoFullName), sk: findingMatchKey },
        // list_append + if_not_exists(rejectReasons, :empty) — the if_not_exists
        // bootstraps an empty list so the first append doesn't fail on an
        // unset attribute.
        UpdateExpression: 'SET rejectReasons = list_append(if_not_exists(rejectReasons, :empty), :reason)',
        ExpressionAttributeValues: { ':empty': [], ':reason': [reason] },
      }));
    } catch (err) {
      console.warn('[fb-a] appendRejectReason failed (%s/%s/%s):', installationId, repoFullName, findingMatchKey, err);
    }
  }

  async listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: FindingDispositionRecord[]; nextCursor?: string }> {
    // Bounded Scan with `begins_with(pk, '<installationId>#')`. We deliberately
    // accept Scan cost over a GSI here because:
    //   (a) FB-E's nightly rollup is the only caller — once a day per install.
    //   (b) Per-installation record counts are bounded (~thousands).
    //   (c) Avoiding a GSI keeps the hot-path write cost (every surfacing,
    //       dispute, verification…) cheap — a GSI would double per-item write
    //       cost.
    // Revisit if any installation grows past ~10k records: at that point a
    // sparse GSI on installationId becomes the right move.
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

/** Decode a DynamoDB item into the typed record shape. */
function itemToRecord(it: Record<string, unknown>): FindingDispositionRecord {
  const { installationId, repoFullName } = splitPk(String(it.pk));
  const r: FindingDispositionRecord = {
    installationId,
    repoFullName,
    findingMatchKey: String(it.sk ?? ''),
    firstSeen: String(it.firstSeen ?? ''),
    lastSeen: String(it.lastSeen ?? ''),
    surfaceCount: Number(it.surfaceCount ?? 0),
    disputeCount: Number(it.disputeCount ?? 0),
    verifiedCount: Number(it.verifiedCount ?? 0),
    unverifiedCount: Number(it.unverifiedCount ?? 0),
    silentDropCount: Number(it.silentDropCount ?? 0),
    agreementCount: Number(it.agreementCount ?? 0),
    resolveCount: Number(it.resolveCount ?? 0),
  };
  if (it.category) r.category = it.category as FindingDispositionRecord['category'];
  if (it.topAgent) r.topAgent = String(it.topAgent);
  if (it.severity) r.severity = it.severity as FindingDispositionRecord['severity'];
  if (Array.isArray(it.sigTokens)) r.sigTokens = it.sigTokens as string[];
  if (Array.isArray(it.rejectReasons)) r.rejectReasons = it.rejectReasons as FindingDispositionRecord['rejectReasons'];

  // #334 — fold the flattened `pc#<day>#<counter>` attributes back into the
  // typed periodCounts map. Attributes that don't parse cleanly are skipped
  // (defensive: a malformed name should not poison the whole record).
  let periodCounts: FindingDispositionRecord['periodCounts'];
  for (const [attr, value] of Object.entries(it)) {
    if (!attr.startsWith(PERIOD_ATTR_PREFIX)) continue;
    const [day, counter] = attr.slice(PERIOD_ATTR_PREFIX.length).split('#');
    if (!day || !counter) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    periodCounts ??= {};
    (periodCounts[day] ??= {})[counter as keyof PeriodCounterBucket] = n;
  }
  if (periodCounts) r.periodCounts = periodCounts;
  return r;
}
