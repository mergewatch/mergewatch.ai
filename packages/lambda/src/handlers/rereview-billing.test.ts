import { describe, it, expect } from 'vitest';
import { billingAttemptIdFromEvent } from './review-agent-event.js';

/**
 * #563 — a re-review of an unchanged commit is BILLABLE (product decision,
 * 2026-09-08).
 *
 * The idempotency key was `review-billing-{installation}-{pr}#{sha}`, which
 * cannot distinguish:
 *   - a redelivered webhook for the SAME review  → must NOT double-charge
 *   - a genuine second review of the same commit → MUST charge
 *
 * Stripe rejected the second call ("Keys for idempotent requests can only be
 * used with the same parameters"), so the re-review was delivered and never
 * billed — while DynamoDB still recorded the usage. The two ledgers diverged
 * silently, and the divergence accumulates.
 */
const sqs = (messageId?: string) => ({
  Records: [{ body: '{}', ...(messageId ? { messageId } : {}) }],
}) as never;

describe('billingAttemptIdFromEvent', () => {
  it('returns the SQS message id — distinct per enqueue', () => {
    // A Re-run click or `@mergewatch review` is a NEW enqueue with a new id,
    // so the key differs and Stripe charges.
    expect(billingAttemptIdFromEvent(sqs('msg-abc'))).toBe('msg-abc');
    expect(billingAttemptIdFromEvent(sqs('msg-def'))).toBe('msg-def');
  });

  it('is STABLE across a redelivery of the same message', () => {
    // SQS reuses the message id when redelivering, so the original
    // double-charge protection is preserved exactly.
    const first = billingAttemptIdFromEvent(sqs('msg-same'));
    const redelivery = billingAttemptIdFromEvent(sqs('msg-same'));
    expect(redelivery).toBe(first);
  });

  it('returns null on the direct-invoke fallback, keeping the old key', () => {
    // A stack deployed without the queue has no stable per-attempt identity.
    // Inventing one there could double-charge a redelivery, so the per-commit
    // key stays — today's behaviour, unchanged.
    expect(billingAttemptIdFromEvent({ owner: 'o', repo: 'r' } as never)).toBeNull();
  });

  it('returns null rather than an empty string when the id is missing', () => {
    // An empty suffix would build `...-{sha}-`, a THIRD distinct key shape —
    // neither the old one nor a real attempt id.
    expect(billingAttemptIdFromEvent(sqs())).toBeNull();
    expect(billingAttemptIdFromEvent(sqs(''))).toBeNull();
  });
});

describe('the resulting idempotency key', () => {
  const key = (inst: string, reviewKey: string, attemptId?: string) =>
    attemptId
      ? `review-billing-${inst}-${reviewKey}-${attemptId}`
      : `review-billing-${inst}-${reviewKey}`;

  it('differs between two reviews of the SAME commit', () => {
    expect(key('1', '42#abc', 'msg-1')).not.toBe(key('1', '42#abc', 'msg-2'));
  });

  it('is identical for a redelivery of the same review', () => {
    expect(key('1', '42#abc', 'msg-1')).toBe(key('1', '42#abc', 'msg-1'));
  });

  it('is unchanged from before when no attempt id is available', () => {
    // Back-compat: the direct-invoke path keys exactly as it did.
    expect(key('1', '42#abc')).toBe('review-billing-1-42#abc');
  });
});
