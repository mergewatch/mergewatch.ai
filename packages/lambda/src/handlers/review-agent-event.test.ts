import { describe, it, expect } from 'vitest';
import { payloadFromEvent, attemptFromEvent, rateLimitedCheckSummary } from './review-agent-event.js';

const job = { installationId: 1, owner: 'octo', repo: 'repo', prNumber: 7, mode: 'review' as const };

describe('payloadFromEvent (#355)', () => {
  it('passes a direct-invoke payload through untouched', () => {
    expect(payloadFromEvent(job as any)).toEqual(job);
  });

  it('unwraps a single SQS record body', () => {
    expect(payloadFromEvent({ Records: [{ body: JSON.stringify(job) }] })).toEqual(job);
  });

  it('fails loudly on batch-size drift instead of silently dropping PRs', () => {
    expect(() => payloadFromEvent({ Records: [] })).toThrow('Expected exactly 1 SQS record');
    expect(() => payloadFromEvent({
      Records: [{ body: JSON.stringify(job) }, { body: JSON.stringify(job) }],
    })).toThrow('got 2');
  });

  it('throws on an unparseable record body (goes to redrive, then DLQ)', () => {
    expect(() => payloadFromEvent({ Records: [{ body: 'not-json' }] })).toThrow();
  });
});

describe('attemptFromEvent (#370)', () => {
  it('reads the SQS ApproximateReceiveCount', () => {
    expect(attemptFromEvent({
      Records: [{ body: JSON.stringify(job), attributes: { ApproximateReceiveCount: '2' } }],
    })).toBe(2);
  });

  it('defaults to 1 for direct invokes and missing/garbage attributes', () => {
    expect(attemptFromEvent(job as any)).toBe(1);
    expect(attemptFromEvent({ Records: [{ body: '{}' }] })).toBe(1);
    expect(attemptFromEvent({
      Records: [{ body: '{}', attributes: { ApproximateReceiveCount: 'NaN' } }],
    })).toBe(1);
  });
});

describe('rateLimitedCheckSummary (#370)', () => {
  it('carries attempt, parked-at time, retry expectations, and the DLQ end-state', () => {
    const s = rateLimitedCheckSummary(2, '2026-08-18T01:35:13.000Z');
    expect(s).toContain('Attempt 2 of 3');
    expect(s).toContain('parked at 2026-08-18T01:35:13.000Z');
    expect(s).toContain('retries automatically');
    expect(s).toContain('dead-letter queue');
  });
});
