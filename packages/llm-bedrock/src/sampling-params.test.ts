/**
 * #262 — which models accept sampling parameters.
 *
 * Getting this wrong fails in one of two ways: send `temperature` to a model
 * that rejects it and every review 400s; omit it from a model that accepts it
 * and reviews silently stop being deterministic. The near-miss IDs below are
 * the ones a naive "contains a 5" check gets wrong.
 */
import { describe, it, expect } from 'vitest';
import { acceptsSamplingParams } from './bedrock-provider';

describe('acceptsSamplingParams', () => {
  describe('rejects sampling (Opus 4.7+ and the 5 generation)', () => {
    const rejecting = [
      'us.anthropic.claude-sonnet-5',
      'global.anthropic.claude-sonnet-5',
      'us.anthropic.claude-opus-5',
      'global.anthropic.claude-opus-5',
      'us.anthropic.claude-opus-4-7',
      'us.anthropic.claude-opus-4-8-v1',
      'anthropic.claude-sonnet-5',
      'claude-sonnet-5',
      'claude-opus-5',
    ];
    for (const id of rejecting) {
      it(`${id}`, () => expect(acceptsSamplingParams(id)).toBe(false));
    }
  });

  describe('still accepts sampling (everything older)', () => {
    const accepting = [
      // Currently deployed in prod — must keep temperature: 0.
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      // Currently deployed in dev.
      'us.anthropic.claude-opus-4-6-v1',
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      'us.anthropic.claude-sonnet-4-6',
      'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      'amazon.titan-text-express-v1',
    ];
    for (const id of accepting) {
      it(`${id}`, () => expect(acceptsSamplingParams(id)).toBe(true));
    }
  });

  describe('near misses — contain a "5" but are not the 5 generation', () => {
    it('claude-haiku-4-5 keeps its sampling params', () => {
      expect(acceptsSamplingParams('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
    });

    it('claude-sonnet-4-5 keeps its sampling params', () => {
      expect(acceptsSamplingParams('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    });

    it('claude-opus-4-5 keeps its sampling params', () => {
      // Opus 4.5 predates the removal; only 4.7+ rejects.
      expect(acceptsSamplingParams('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe(true);
    });

    it('claude-opus-4-6 keeps its sampling params', () => {
      expect(acceptsSamplingParams('us.anthropic.claude-opus-4-6-v1')).toBe(true);
    });
  });

  it('defaults an unknown model to accepting, so adoption fails loudly not silently', () => {
    // A future rejecting model not yet listed will 400 on every review, which
    // is immediately obvious. The inverse — silently dropping determinism —
    // would not be.
    expect(acceptsSamplingParams('us.anthropic.claude-something-new')).toBe(true);
  });
});
