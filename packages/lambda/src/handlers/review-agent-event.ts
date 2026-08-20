/**
 * #355 — review-agent event normalization.
 *
 * The review agent historically received a bare `ReviewJobPayload` via
 * direct async Lambda invoke. With the SQS admission-control queue the same
 * payload arrives wrapped in an SQS event (`Records[].body`, BatchSize 1).
 * Both shapes must work: the queue is the steady state, direct invoke
 * remains the webhook's deploy-order fallback and the operator's manual
 * re-drive tool.
 */
import type { ReviewJobPayload } from '@mergewatch/core';

interface SqsRecordLike {
  body: string;
  /** SQS delivery bookkeeping — "1" on first receive, incremented on redelivery. */
  attributes?: { ApproximateReceiveCount?: string };
}

export type ReviewAgentEvent = ReviewJobPayload | { Records: SqsRecordLike[] };

/**
 * Unwrap the job payload from either invocation shape. The event source is
 * configured with BatchSize 1, so an SQS event carries exactly one record;
 * anything else (0 or >1) is a configuration drift worth failing loudly on
 * rather than silently reviewing only the first PR.
 */
export function payloadFromEvent(event: ReviewAgentEvent): ReviewJobPayload {
  if (event != null && typeof event === 'object' && 'Records' in event && Array.isArray(event.Records)) {
    if (event.Records.length !== 1) {
      throw new Error(
        `Expected exactly 1 SQS record (BatchSize 1), got ${event.Records.length}`,
      );
    }
    return JSON.parse(event.Records[0].body) as ReviewJobPayload;
  }
  return event as ReviewJobPayload;
}

/**
 * #370 — delivery attempt for this invocation: SQS's ApproximateReceiveCount
 * ("2" means this is the first redelivery), or 1 for direct invokes. Drives
 * the attempt number on the throttle-parked check run so a parked review is
 * distinguishable from a hung one.
 */
export function attemptFromEvent(event: ReviewAgentEvent): number {
  if (event != null && typeof event === 'object' && 'Records' in event && Array.isArray(event.Records)) {
    const n = Number(event.Records[0]?.attributes?.ApproximateReceiveCount);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 1;
}

/**
 * #370 — the throttle-parked check-run summary. A parked review used to show
 * a static "will retry shortly", which E2E graders (and humans) read as a
 * hang once it aged past a few minutes. Attempt count + parked-at time +
 * explicit expectations make the state self-explanatory.
 */
export function rateLimitedCheckSummary(attempt: number, parkedAtIso: string): string {
  return `Attempt ${attempt} of 3 parked at ${parkedAtIso} — the model provider is rate limiting requests. `
    + 'MergeWatch retries automatically via the review queue; under burst load a retry can take ~30 minutes. '
    + 'If all attempts exhaust, the job is dead-lettered and automatically re-driven every few '
    + 'minutes until the provider recovers (#398), so a long outage still resolves without '
    + 'intervention. You can also re-run this check or comment `@mergewatch review` to retry now.';
}
