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
