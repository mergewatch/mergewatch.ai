/**
 * Notifications posted when an installation is blocked due to insufficient credits.
 *
 * - Check Run with conclusion: action_required
 * - GitHub Issue filed once (atomic via conditional write on blockIssueNumber)
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createCheckRun } from '@mergewatch/core';
import { updateBillingFields } from './dynamo-billing';

const SETTINGS_SK = '#SETTINGS';

type Octokit = Parameters<typeof createCheckRun>[0];

/**
 * Copy variant for the block notifications.
 *
 * `oss` is used when the installation had an OSS Program grant that lapsed or
 * hit its fair-use ceiling (#261). Telling an open-source maintainer we
 * invited into a free program to "add a credit card" is the wrong message —
 * the public page promises heavy usage moves to bring-your-own-key or
 * sponsorship, so the copy points there instead.
 */
export type BlockVariant = 'credits' | 'oss';

const OSS_PROGRAM_URL = 'https://mergewatch.ai/open-source';
const BILLING_URL = 'https://mergewatch.ai/dashboard/billing';

/** Post a Check Run indicating the review was blocked by billing. */
export async function postBlockedCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  variant: BlockVariant = 'credits',
): Promise<void> {
  const oss = variant === 'oss';
  await createCheckRun(octokit, owner, repo, sha, {
    status: 'completed',
    conclusion: 'action_required',
    title: oss
      ? 'Review paused — open-source grant needs renewing'
      : 'Review blocked — credits required',
    summary: oss
      ? 'This PR was not reviewed because this project\'s MergeWatch open-source '
        + 'grant has expired or reached its fair-use limit for this month. '
        + `Get in touch via ${OSS_PROGRAM_URL} to renew it, or switch to `
        + 'bring-your-own-key or self-hosting — both are free and unlimited.'
      : 'This PR was not reviewed because this installation has no remaining credits. '
        + `Please add credits at ${BILLING_URL} to resume reviews.`,
  });
}

/**
 * Create a GitHub Issue notifying the installation owner that reviews are blocked.
 * Uses a DynamoDB conditional write to ensure only one issue is created.
 */
export async function ensureBillingIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  installationId: string,
  client: DynamoDBDocumentClient,
  table: string,
  variant: BlockVariant = 'credits',
): Promise<void> {
  // Atomically claim the right to create the issue
  try {
    await client.send(new UpdateCommand({
      TableName: table,
      Key: { installationId, repoFullName: SETTINGS_SK },
      UpdateExpression: 'SET blockedAt = :now, blockIssueRepo = :repo',
      ConditionExpression: 'attribute_not_exists(blockIssueNumber)',
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':repo': `${owner}/${repo}`,
      },
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log(`[billing] Billing issue already claimed by another process for install=${installationId}`);
      return;
    }
    throw err;
  }

  // Create the GitHub Issue
  let issueNumber: number;
  try {
    const issue = await octokit.issues.create({
      owner,
      repo,
      title: variant === 'oss'
        ? 'MergeWatch: reviews paused — open-source grant needs renewing'
        : 'MergeWatch: reviews paused — credits required',
      body: variant === 'oss'
        ? 'MergeWatch has paused PR reviews for this repository because its '
          + 'open-source grant has expired or reached its fair-use limit for '
          + 'this month.\n\n'
          + `Reply here or get in touch via [mergewatch.ai/open-source](${OSS_PROGRAM_URL}) `
          + 'and we will renew it — there is no charge.\n\n'
          + 'If this project has outgrown the program, bring-your-own-key and '
          + 'self-hosting are both free and unlimited.\n\n'
          + 'This issue will be closed automatically once reviews resume.'
        : 'MergeWatch has paused PR reviews for this repository because the installation '
          + 'has used all free reviews and has no remaining credits.\n\n'
          + 'To resume reviews, please add credits at '
          + `[mergewatch.ai/dashboard/billing](${BILLING_URL}).\n\n`
          + 'This issue will be closed automatically once credits are added.',
      labels: ['mergewatch'],
    });
    issueNumber = issue.data.number;
  } catch (err) {
    // Non-fatal: the review is already blocked (402 returned regardless).
    // Since blockIssueNumber is never stored on failure, the next blocked
    // review will see firstBlock=true again and retry issue creation — self-healing.
    console.error(`[billing] NOTIFY_FAILED: could not create billing issue for ${owner}/${repo} install=${installationId}:`, err);
    return;
  }

  // Store the issue number so we can close it later
  await updateBillingFields(client, table, installationId, {
    blockIssueNumber: issueNumber,
    blockIssueRepo: `${owner}/${repo}`,
  });
}

/** Close a previously opened billing issue and clear the tracking fields. */
export async function closeBillingIssue(
  octokit: Octokit,
  installationId: string,
  client: DynamoDBDocumentClient,
  table: string,
  issueNumber: number,
  issueRepo: string,
): Promise<void> {
  const [owner, repo] = issueRepo.split('/');

  try {
    await octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: 'closed',
      state_reason: 'completed',
    });

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: 'Credits have been added. MergeWatch reviews are now active again.',
    });
  } catch (err) {
    console.warn('Failed to close billing issue:', err);
  }

  // Clear billing block fields
  await updateBillingFields(client, table, installationId, {
    blockedAt: undefined,
    blockIssueNumber: undefined,
    blockIssueRepo: undefined,
  });
}
