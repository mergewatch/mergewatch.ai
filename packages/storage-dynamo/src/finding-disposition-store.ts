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
} from '@mergewatch/core';

export const DEFAULT_FINDING_DISPOSITIONS_TABLE = 'mergewatch-finding-dispositions';

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
      // Counter defaults so subsequent increment* calls don't have to
      // bootstrap. DynamoDB rejects ADD on a non-existent attribute when
      // the target type is unset; pre-seeding to 0 sidesteps that.
      'disputeCount = if_not_exists(disputeCount, :zero)',
      'verifiedCount = if_not_exists(verifiedCount, :zero)',
      'unverifiedCount = if_not_exists(unverifiedCount, :zero)',
      'silentDropCount = if_not_exists(silentDropCount, :zero)',
      'agreementCount = if_not_exists(agreementCount, :zero)',
    ];
    const exprValues: Record<string, unknown> = {
      ':now': nowIso,
      ':zero': 0,
      ':one': 1,
    };
    if (attribution?.category !== undefined) {
      setExprs.push('category = :category');
      exprValues[':category'] = attribution.category;
    }
    if (attribution?.topAgent !== undefined) {
      setExprs.push('topAgent = :topAgent');
      exprValues[':topAgent'] = attribution.topAgent;
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
    attrName: 'disputeCount' | 'verifiedCount' | 'unverifiedCount' | 'silentDropCount' | 'agreementCount',
  ): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(installationId, repoFullName), sk: findingMatchKey },
        UpdateExpression: `SET #c = if_not_exists(#c, :zero) + :one`,
        ExpressionAttributeNames: { '#c': attrName },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      }));
    } catch (err) {
      console.warn('[fb-a] %s increment failed (%s/%s/%s):', attrName, installationId, repoFullName, findingMatchKey, err);
    }
  }

  incrementDispute(i: string, r: string, k: string)     { return this.incrementCounter(i, r, k, 'disputeCount'); }
  incrementVerified(i: string, r: string, k: string)    { return this.incrementCounter(i, r, k, 'verifiedCount'); }
  incrementUnverified(i: string, r: string, k: string)  { return this.incrementCounter(i, r, k, 'unverifiedCount'); }
  incrementSilentDrop(i: string, r: string, k: string)  { return this.incrementCounter(i, r, k, 'silentDropCount'); }
  incrementAgreement(i: string, r: string, k: string)   { return this.incrementCounter(i, r, k, 'agreementCount'); }

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
  };
  if (it.category) r.category = it.category as FindingDispositionRecord['category'];
  if (it.topAgent) r.topAgent = String(it.topAgent);
  if (Array.isArray(it.sigTokens)) r.sigTokens = it.sigTokens as string[];
  if (Array.isArray(it.rejectReasons)) r.rejectReasons = it.rejectReasons as FindingDispositionRecord['rejectReasons'];
  return r;
}
