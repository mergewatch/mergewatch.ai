import { describe, it, expect } from 'vitest';
import { payloadFromEvent } from './review-agent-event.js';

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
