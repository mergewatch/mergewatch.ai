/**
 * #398 — dead-letter auto-redrive.
 *
 * The review queue gives a throttled job 3 delivery attempts ~6 minutes apart
 * (VisibilityTimeout), so the retry envelope covers roughly 18 minutes. That
 * is sized for burst contention. It is not sized for a provider quota window:
 * on 2026-08-19 Bedrock rejected essentially every request for ~2.75 hours,
 * 28 of 57 reviews blew through all three attempts inside the first minute of
 * the outage, and every one landed in the DLQ where nothing re-drove it. The
 * PRs were left with a check run stuck `in_progress` forever — and because
 * GitHub's re-run button 404s on an in-progress check, users had no
 * self-service recovery either.
 *
 * This sweeper closes that hole: on a schedule it moves DLQ messages back
 * onto the review queue, so an outage of any length self-heals once the
 * provider recovers. Each redrive is delayed (growing with the generation
 * count) so a long outage costs a slow trickle of cheap throttle rejections
 * rather than a hot spin, and generations are capped so a genuinely poisoned
 * message cannot cycle forever — when the cap is hit the check run is
 * completed honestly instead of being abandoned mid-flight.
 */
import {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { createCheckRun } from '@mergewatch/core';
import type { ReviewJobPayload } from '@mergewatch/core';
import { SSMGitHubAuthProvider } from '../github-auth-ssm.js';

const sqs = new SQSClient({});
const authProvider = new SSMGitHubAuthProvider();

const REVIEW_QUEUE_URL = process.env.REVIEW_QUEUE_URL ?? '';
const REVIEW_DLQ_URL = process.env.REVIEW_DLQ_URL ?? '';

/** Message attribute tracking how many times this job has been re-driven. */
const GENERATION_ATTR = 'MergeWatchRedriveGeneration';

/**
 * Give up after this many redrive generations. Each generation is up to 3
 * delivery attempts plus its redrive delay, so 8 generations spans several
 * hours of outage — long enough for any realistic quota window, short enough
 * that a poisoned payload stops cycling the same day.
 */
const MAX_GENERATIONS = Number(process.env.DLQ_MAX_GENERATIONS ?? 8);

/** Cap the work per invocation so one sweep can't run past the Lambda timeout. */
const MAX_MESSAGES_PER_RUN = Number(process.env.DLQ_MAX_MESSAGES_PER_RUN ?? 50);

/**
 * Back off between generations: SQS caps DelaySeconds at 900 (15 min). A
 * first redrive goes back promptly (the outage may already be over); later
 * generations wait longer so a multi-hour outage is not hammered.
 */
export function redriveDelaySeconds(generation: number): number {
  return Math.min(900, generation * 120);
}

/**
 * A job whose retries are exhausted should not be left with an `in_progress`
 * check run — that reads as a hang and blocks GitHub's re-run affordance.
 * Best-effort: a failure here must not stop the sweep.
 */
async function completeAbandonedCheck(payload: ReviewJobPayload): Promise<void> {
  const { installationId, owner, repo, headSha, prNumber } = payload;
  if (!installationId || !owner || !repo || !headSha) return;

  try {
    const octokit = await authProvider.getInstallationOctokit(installationId);
    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'failure',
      title: 'Review abandoned — provider unavailable',
      summary:
        'MergeWatch retried this review across several queue generations and the model provider '
        + 'was still rate limiting. The job has been dropped so it does not cycle indefinitely. '
        + 'Re-run this check or comment `@mergewatch review` to try again.',
    });
    console.log(`Completed abandoned check run for ${owner}/${repo}#${prNumber}`);
  } catch (err) {
    console.error(`Failed to complete abandoned check run for ${owner}/${repo}#${prNumber}:`, err);
  }
}

/**
 * Is this job still worth re-driving? A dead-lettered review outlives the PR
 * that asked for it: the first production sweep re-drove jobs for
 * mergewatch/fixtures#635-643, all closed ~15 minutes earlier, and the review
 * agent dutifully started reviewing them — spending model calls on PRs nobody
 * would ever read, and (worse, during an outage) competing for the very quota
 * the live reviews were starved of.
 *
 * `null` means "couldn't tell" — treated as alive, because dropping a real
 * review on a transient API blip is the worse error.
 */
async function isPrStillOpen(payload: ReviewJobPayload): Promise<boolean | null> {
  const { installationId, owner, repo, prNumber } = payload;
  if (!installationId || !owner || !repo || !prNumber) return null;

  try {
    const octokit = await authProvider.getInstallationOctokit(installationId);
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    return data.state === 'open';
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    // A deleted PR is definitively not worth reviewing; anything else is
    // indeterminate.
    if (status === 404) return false;
    console.warn(`Could not determine PR state for ${owner}/${repo}#${prNumber}:`, err);
    return null;
  }
}

export async function handler(): Promise<{ redriven: number; abandoned: number; stale: number }> {
  if (!REVIEW_QUEUE_URL || !REVIEW_DLQ_URL) {
    console.warn('REVIEW_QUEUE_URL / REVIEW_DLQ_URL unset — dlq-redrive is a no-op');
    return { redriven: 0, abandoned: 0, stale: 0 };
  }

  let redriven = 0;
  let abandoned = 0;
  let stale = 0;
  let processed = 0;

  while (processed < MAX_MESSAGES_PER_RUN) {
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: REVIEW_DLQ_URL,
        MaxNumberOfMessages: 10,
        // Long-poll briefly so a sparse DLQ doesn't need many round trips,
        // while keeping the whole sweep well inside the Lambda timeout.
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
        // Hide re-driven messages from a concurrent sweep long enough to
        // finish sending + deleting them.
        VisibilityTimeout: 60,
      }),
    );

    const messages = received.Messages ?? [];
    if (messages.length === 0) break;

    for (const message of messages) {
      processed += 1;
      if (!message.Body || !message.ReceiptHandle) continue;

      const generation =
        Number(message.MessageAttributes?.[GENERATION_ATTR]?.StringValue ?? '0') || 0;

      let payload: ReviewJobPayload | null = null;
      try {
        payload = JSON.parse(message.Body) as ReviewJobPayload;
      } catch (err) {
        // Unparseable payloads can never succeed — drop rather than cycle.
        console.error('Dropping unparseable DLQ message:', err);
        await sqs
          .send(new DeleteMessageCommand({ QueueUrl: REVIEW_DLQ_URL, ReceiptHandle: message.ReceiptHandle }))
          .catch((delErr) => console.error('Failed to delete unparseable DLQ message:', delErr));
        continue;
      }

      const label = `${payload.owner}/${payload.repo}#${payload.prNumber}`;

      // Drop jobs whose PR has closed or merged while the job sat in the DLQ.
      // No check run to complete — the PR is gone; reviving it would only
      // burn model quota the live reviews need.
      if ((await isPrStillOpen(payload)) === false) {
        console.log(`Dropping dead-lettered review for ${label} — PR is no longer open`);
        await sqs
          .send(new DeleteMessageCommand({ QueueUrl: REVIEW_DLQ_URL, ReceiptHandle: message.ReceiptHandle }))
          .catch((err) => console.error(`Failed to delete stale DLQ message for ${label}:`, err));
        stale += 1;
        continue;
      }

      if (generation >= MAX_GENERATIONS) {
        console.warn(`Abandoning review after ${generation} redrive generations: ${label}`);
        await completeAbandonedCheck(payload);
        await sqs
          .send(new DeleteMessageCommand({ QueueUrl: REVIEW_DLQ_URL, ReceiptHandle: message.ReceiptHandle }))
          .catch((err) => console.error(`Failed to delete abandoned DLQ message for ${label}:`, err));
        abandoned += 1;
        continue;
      }

      const nextGeneration = generation + 1;
      const delay = redriveDelaySeconds(nextGeneration);

      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: REVIEW_QUEUE_URL,
            MessageBody: message.Body,
            DelaySeconds: delay,
            MessageAttributes: {
              [GENERATION_ATTR]: { DataType: 'Number', StringValue: String(nextGeneration) },
            },
          }),
        );
      } catch (err) {
        // Leave the message in the DLQ; its visibility timeout expires and the
        // next sweep retries it. Never delete a message we failed to re-send.
        console.error(`Failed to redrive ${label} — leaving it in the DLQ:`, err);
        continue;
      }

      await sqs
        .send(new DeleteMessageCommand({ QueueUrl: REVIEW_DLQ_URL, ReceiptHandle: message.ReceiptHandle }))
        .catch((err) =>
          // The job is already back on the queue; a failed delete means it may
          // be re-driven twice. claimReview on the review path makes that a
          // no-op, so log and move on rather than failing the sweep.
          console.error(`Redrove ${label} but failed to delete it from the DLQ:`, err),
        );

      redriven += 1;
      console.log(`Redrove ${label} (generation ${nextGeneration}, delay ${delay}s)`);
    }
  }

  if (redriven > 0 || abandoned > 0 || stale > 0) {
    console.log(
      `DLQ sweep complete: ${redriven} redriven, ${abandoned} abandoned, ${stale} dropped (PR closed)`,
    );
  }
  return { redriven, abandoned, stale };
}
