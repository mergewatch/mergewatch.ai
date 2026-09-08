import { describe, it, expect } from 'vitest';
import { renderCostPayload, parseCostPayload, COST_PAYLOAD_MARKER } from './comment-formatter.js';

/**
 * #561 — the E2E grader parses cost out of the review comment's PROSE table
 * with a regex, across a repo boundary. A formatter change stops it matching
 * and the suite total silently collapses to $0.00 — which reads as good news,
 * in the direction that makes the cost work look finished.
 *
 * Nothing pins the two ends together, and nothing can: the parser lives in
 * another repo, so a test here would have to COPY the regexes and could drift
 * exactly the same way. A machine-readable payload removes the coupling rather
 * than testing it.
 */
describe('renderCostPayload', () => {
  it('round-trips through parse', () => {
    const p = { inputTokens: 115256, outputTokens: 2551, estimatedCostUsd: 0.2424 };
    expect(parseCostPayload(renderCostPayload(p))).toEqual(p);
  });

  it('is an HTML comment — invisible when rendered', () => {
    const s = renderCostPayload({ estimatedCostUsd: 1 });
    expect(s.startsWith('<!--')).toBe(true);
    expect(s.endsWith('-->')).toBe(true);
  });

  it('omits absent fields rather than writing null', () => {
    // A null would be indistinguishable from a real zero once parsed.
    expect(renderCostPayload({ estimatedCostUsd: 0.5 })).toBe(
      `<!-- ${COST_PAYLOAD_MARKER}:{"estimatedCostUsd":0.5} -->`,
    );
  });

  it('emits an empty payload rather than nothing when no numbers exist', () => {
    // `{}` says "this deployment emits payloads and this review had no cost".
    // No payload at all says "I could not tell" — a different thing, and the
    // exact ambiguity #561 is about.
    expect(renderCostPayload({})).toBe(`<!-- ${COST_PAYLOAD_MARKER}:{} -->`);
    expect(parseCostPayload(renderCostPayload({}))).toEqual({});
  });

  it('carries the cumulative figure on a re-review', () => {
    // The prose table switches format once a PR is reviewed twice; the payload
    // keeps both numbers as separate fields, so a consumer never has to know
    // which sentence form it is looking at.
    const p = { estimatedCostUsd: 0.1, cumulativeCostUsd: 0.75 };
    expect(parseCostPayload(renderCostPayload(p))).toEqual(p);
  });
});

describe('parseCostPayload', () => {
  it('returns null when absent, so a caller can fall back to the prose', () => {
    // This is what keeps a review from an OLDER deployment readable while the
    // payload rolls out across stages.
    expect(parseCostPayload('a comment with no payload')).toBeNull();
    expect(parseCostPayload('')).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', () => {
    // Throwing here would take down the whole grading step, not just the note.
    expect(parseCostPayload(`<!-- ${COST_PAYLOAD_MARKER}:{not json} -->`)).toBeNull();
  });

  it('finds the payload among surrounding comment text', () => {
    const body = `## Review\n\nsome prose\n\n${renderCostPayload({ estimatedCostUsd: 2 })}\n\nmore prose`;
    expect(parseCostPayload(body)).toEqual({ estimatedCostUsd: 2 });
  });
});
