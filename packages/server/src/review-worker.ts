/**
 * #355 — self-hosted review worker: drains the Postgres review-job queue
 * with a bounded concurrency, which is the admission control the direct
 * fire-and-forget dispatch never had (a 57-PR burst used to become 57
 * concurrent pipelines against one provider rate limit).
 *
 * Same lightweight `setInterval` shape as insights-cron.ts — one in-process
 * loop, no extra dependency. Multiple server replicas are safe: claims go
 * through `SELECT … FOR UPDATE SKIP LOCKED`.
 *
 * Outcome handling:
 *   - success            → complete (job done)
 *   - throttle (429)     → retry with exponential backoff, up to MAX_ATTEMPTS,
 *                          then dead (DLQ analogue — visible via the table,
 *                          the check run stays in_progress as "stuck", never
 *                          a silent loss)
 *   - any other error    → complete: the processor already recorded the
 *                          terminal outcome (status=failed + failure check);
 *                          the queue's delivery job is done.
 */

import { isThrottleError } from '@mergewatch/core';
import type { IReviewJobQueue, ClaimedReviewJob, ReviewJobPayload } from '@mergewatch/core';

export interface ReviewWorkerOptions {
  /** Max reviews processed concurrently. Env: REVIEW_CONCURRENCY (default 3). */
  concurrency?: number;
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Lock horizon per claim in seconds — must exceed the slowest review (default 900). */
  lockSeconds?: number;
  /** Throttle redeliveries before a job is declared dead (default 5). */
  maxAttempts?: number;
  /** Base backoff in seconds; attempt N waits base × 2^(N-1) (default 60). */
  backoffBaseSeconds?: number;
}

export interface ReviewWorkerHandle {
  stop(): void;
  /** Test seam — run one poll cycle immediately. */
  tick(): Promise<void>;
}

export function startReviewWorker(
  queue: IReviewJobQueue,
  processJob: (payload: ReviewJobPayload) => Promise<void>,
  options: ReviewWorkerOptions = {},
): ReviewWorkerHandle {
  const concurrency = options.concurrency
    ?? (Number(process.env.REVIEW_CONCURRENCY) > 0 ? Number(process.env.REVIEW_CONCURRENCY) : 3);
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const lockSeconds = options.lockSeconds ?? 900;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffBaseSeconds = options.backoffBaseSeconds ?? 60;

  let active = 0;
  let stopped = false;

  async function handle(job: ClaimedReviewJob): Promise<void> {
    active++;
    try {
      await processJob(job.payload);
      await queue.complete(job.id);
    } catch (err) {
      if (isThrottleError(err)) {
        if (job.attempts >= maxAttempts) {
          console.error(
            '[review-worker] job %s dead after %d throttled attempts — inspect review_jobs (status=dead)',
            job.id, job.attempts,
          );
          await queue.kill(job.id).catch((qErr) => {
            console.error('[review-worker] queue.kill failed for job %s — row stays processing until lock expiry:', job.id, qErr);
          });
        } else {
          const delay = backoffBaseSeconds * 2 ** (job.attempts - 1);
          console.warn('[review-worker] job %s throttled (attempt %d) — retrying in %ds', job.id, job.attempts, delay);
          await queue.retry(job.id, delay).catch((qErr) => {
            console.error('[review-worker] queue.retry failed for job %s — row stays processing until lock expiry:', job.id, qErr);
          });
        }
      } else {
        // The processor already recorded the terminal failure (status +
        // failure check run) — delivery is complete from the queue's view.
        await queue.complete(job.id).catch((qErr) => {
          console.error('[review-worker] queue.complete failed for job %s — expect a duplicate delivery at lock expiry:', job.id, qErr);
        });
      }
    } finally {
      active--;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const slots = concurrency - active;
    if (slots <= 0) return;
    let jobs: ClaimedReviewJob[];
    try {
      jobs = await queue.claim(slots, lockSeconds);
    } catch (err) {
      console.warn('[review-worker] claim failed:', err);
      return;
    }
    // Fire handlers without awaiting completion — the active counter is the
    // concurrency gate; the next tick only claims what fits.
    for (const job of jobs) void handle(job);
  }

  const interval = setInterval(() => void tick(), pollIntervalMs);
  interval.unref?.();
  console.log(
    '[review-worker] started — concurrency %d, poll %dms, lock %ds, maxAttempts %d',
    concurrency, pollIntervalMs, lockSeconds, maxAttempts,
  );

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
    tick,
  };
}
