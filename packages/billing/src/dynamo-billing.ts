/**
 * Low-level DynamoDB operations for billing fields on the #SETTINGS sentinel row
 * in the mergewatch-installations table.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { BillingFields } from '@mergewatch/core';

const SETTINGS_SK = '#SETTINGS';

/** Read billing fields from the #SETTINGS sentinel row. */
export async function getBillingFields(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
): Promise<BillingFields> {
  const result = await client.send(new GetCommand({
    TableName: table,
    Key: { installationId, repoFullName: SETTINGS_SK },
    ProjectionExpression:
      'freeReviewsUsed, stripeCustomerId, balanceCents, billingPeriod, '
      + 'prCount, prTimestamps, totalBilledCents, autoReloadEnabled, '
      + 'autoReloadThresholdCents, autoReloadAmountCents, autoReloadInFlight, '
      + 'blockedAt, blockIssueNumber, blockIssueRepo, '
      // OSS Program (#261, org scope #409). Omitting a field here reads it back
      // as undefined with no error, which would silently disable sponsorship —
      // keep this list in sync with BillingFields. `ossGrantScope` in
      // particular: absent reads as 'repos', so leaving it out of the
      // projection would make every org-scoped grant behave as a grant naming
      // no repos at all.
      + 'ossGrantScope, ossGrantAccount, '
      + 'ossGrantRepos, ossGrantExpiresAt, ossGrantedAt, ossGrantNote, '
      + 'ossMonthlyCapCents, ossPeriod, ossSponsoredCentsThisPeriod, '
      + 'ossSponsoredCentsLifetime',
  }));

  return (result.Item as BillingFields) ?? {};
}

/**
 * Atomically increment freeReviewsUsed.
 * Fails with ConditionalCheckFailedException if already >= limit.
 */
export async function incrementFreeReviewsUsed(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  limit: number,
): Promise<void> {
  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId, repoFullName: SETTINGS_SK },
    UpdateExpression: 'ADD freeReviewsUsed :one',
    ConditionExpression: '(attribute_not_exists(freeReviewsUsed) OR freeReviewsUsed < :limit)',
    ExpressionAttributeValues: {
      ':one': 1,
      ':limit': limit,
    },
  }));
}

/**
 * Atomically deduct from balanceCents.
 * Fails with ConditionalCheckFailedException if insufficient balance.
 */
export async function deductBalance(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  amountCents: number,
): Promise<void> {
  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId, repoFullName: SETTINGS_SK },
    UpdateExpression: 'SET balanceCents = balanceCents - :amount',
    ConditionExpression: 'attribute_exists(balanceCents) AND balanceCents >= :amount',
    ExpressionAttributeValues: {
      ':amount': amountCents,
    },
  }));
}

/**
 * Atomically deduct balance AND record usage stats in a single DynamoDB call.
 * Fails with ConditionalCheckFailedException if insufficient balance.
 */
export async function deductBalanceAndRecordUsage(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  params: {
    amountCents: number;
    totalBilledCents: number;
    prCount: number;
    billingPeriod: string;
    prTimestamps: string[];
  },
): Promise<void> {
  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId, repoFullName: SETTINGS_SK },
    UpdateExpression:
      'SET balanceCents = balanceCents - :amount, '
      + 'totalBilledCents = :totalBilled, '
      + 'prCount = :prCount, '
      + 'billingPeriod = :period, '
      + 'prTimestamps = :timestamps',
    ConditionExpression: 'attribute_exists(balanceCents) AND balanceCents >= :amount',
    ExpressionAttributeValues: {
      ':amount': params.amountCents,
      ':totalBilled': params.totalBilledCents,
      ':prCount': params.prCount,
      ':period': params.billingPeriod,
      ':timestamps': params.prTimestamps,
    },
  }));
}

/**
 * #261 — Atomically accrue a sponsored review's cost against the OSS grant.
 *
 * Two paths, because DynamoDB can't branch between ADD and SET in one
 * expression:
 *   1. Same period → `ADD` both counters. Atomic, so concurrent reviews across
 *      repos in the same installation can't lose an increment.
 *   2. Period rolled over (or first ever accrual) → `SET` the period counter to
 *      this review's cost while still `ADD`-ing lifetime.
 *
 * Two reviews racing across a month boundary can both take path 2, and one
 * overwrites the other's period counter. That undercounts a fair-use figure by
 * one review at the rollover instant and is not worth a transaction; the
 * lifetime counter stays exact because it is always an ADD.
 */
export async function accrueOssSponsoredCost(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  amountCents: number,
  period: string,
): Promise<void> {
  const key = { installationId, repoFullName: SETTINGS_SK };

  try {
    await client.send(new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression:
        'ADD ossSponsoredCentsThisPeriod :amount, ossSponsoredCentsLifetime :amount',
      ConditionExpression: 'ossPeriod = :period',
      ExpressionAttributeValues: { ':amount': amountCents, ':period': period },
    }));
    return;
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }

  await client.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression:
      'SET ossPeriod = :period, ossSponsoredCentsThisPeriod = :amount '
      + 'ADD ossSponsoredCentsLifetime :amount',
    ExpressionAttributeValues: { ':amount': amountCents, ':period': period },
  }));
}

/** Generic update of billing fields on the #SETTINGS row.
 *  Fields set to `undefined` are REMOVED from DynamoDB (not silently dropped). */
export async function updateBillingFields(
  client: DynamoDBDocumentClient,
  table: string,
  installationId: string,
  fields: Partial<BillingFields>,
): Promise<void> {
  const setEntries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const removeKeys = Object.entries(fields).filter(([, v]) => v === undefined).map(([k]) => k);

  if (setEntries.length === 0 && removeKeys.length === 0) return;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts: string[] = [];

  if (setEntries.length > 0) {
    const setExprs: string[] = [];
    for (const [key, value] of setEntries) {
      const nameToken = `#${key}`;
      const valToken = `:${key}`;
      names[nameToken] = key;
      values[valToken] = value;
      setExprs.push(`${nameToken} = ${valToken}`);
    }
    parts.push(`SET ${setExprs.join(', ')}`);
  }

  if (removeKeys.length > 0) {
    const removeExprs: string[] = [];
    for (const key of removeKeys) {
      const nameToken = `#${key}`;
      names[nameToken] = key;
      removeExprs.push(nameToken);
    }
    parts.push(`REMOVE ${removeExprs.join(', ')}`);
  }

  await client.send(new UpdateCommand({
    TableName: table,
    Key: { installationId, repoFullName: SETTINGS_SK },
    UpdateExpression: parts.join(' '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  }));
}
