/**
 * #423 — input budget.
 *
 * The bug this replaces was silent-then-fatal: no guard existed, the diff went
 * to the model unbounded, every fallback layer collapsed, and the user got a
 * raw `ValidationException` with no findings and no guidance. The tests that
 * matter here are the ones that keep the guard from failing the same way —
 * an unknown model must not be assumed generous, and the check must account
 * for output sharing the window.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTEXT_WINDOWS,
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  contextWindowFor,
  isKnownModel,
  estimateTokens,
  checkInputBudget,
  describeOverBudget,
} from './context-windows.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

describe('contextWindowFor', () => {
  it('knows the 1M-context models', () => {
    expect(contextWindowFor('us.anthropic.claude-sonnet-4-6')).toBe(1_000_000);
    expect(contextWindowFor('us.anthropic.claude-opus-4-6-v1')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000);
  });

  it('knows the 200K models — including the one that caused #423', () => {
    expect(contextWindowFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    expect(contextWindowFor('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(200_000);
  });

  it('assumes the SMALLER window for an unknown model', () => {
    // The two ways to be wrong are not symmetric. Too small → a visible,
    // actionable skip. Too large → exactly the opaque failure this replaces.
    expect(contextWindowFor('some.exotic.model-v9')).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW);
    expect(UNKNOWN_MODEL_CONTEXT_WINDOW).toBe(200_000);
  });

  it('assumes the smaller window for undefined', () => {
    expect(contextWindowFor(undefined)).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW);
  });

  it('reports whether the window was known or assumed', () => {
    expect(isKnownModel('us.anthropic.claude-sonnet-4-6')).toBe(true);
    expect(isKnownModel('some.exotic.model-v9')).toBe(false);
    expect(isKnownModel(undefined)).toBe(false);
  });
});

describe('the configured default model has a known context window', () => {
  it('DEFAULT_CONFIG.model is in the table', () => {
    // Mirrors the pricing guard from #414. A default that falls back to the
    // assumed window would silently halve the usable budget for everyone.
    expect(isKnownModel(DEFAULT_CONFIG.model)).toBe(true);
  });

  it('DEFAULT_CONFIG.lightModel is in the table', () => {
    expect(isKnownModel(DEFAULT_CONFIG.lightModel)).toBe(true);
  });
});

describe('checkInputBudget', () => {
  const MAX_OUT = 4096;

  it('accepts a diff that comfortably fits', () => {
    const b = checkInputBudget('x'.repeat(40_000), 'us.anthropic.claude-sonnet-4-6', MAX_OUT);
    expect(b.fits).toBe(true);
    expect(b.contextWindow).toBe(1_000_000);
  });

  it('rejects the diff that actually caused #423 on a 200K model', () => {
    // orca#117: 711,765 bytes ≈ 178K tokens against Sonnet 4.5's 200K.
    const b = checkInputBudget('x'.repeat(711_765), 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', MAX_OUT);
    expect(b.fits).toBe(false);
    expect(b.estimatedTokens).toBeGreaterThan(170_000);
  });

  it('accepts that same diff on a 1M model', () => {
    // Which is why Sonnet 4.6 is headroom: the guard still exists, the cliff
    // just moved.
    const b = checkInputBudget('x'.repeat(711_765), 'us.anthropic.claude-sonnet-4-6', MAX_OUT);
    expect(b.fits).toBe(true);
  });

  it('accepts #423 minus the build artifact, on the model that failed it', () => {
    // 80% of that diff was one tsconfig.tsbuildinfo. Excluding it alone would
    // have made the review succeed — which is why exclusion, not just a bigger
    // window, is the actual fix.
    const b = checkInputBudget('x'.repeat(139_939), 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', MAX_OUT);
    expect(b.fits).toBe(true);
  });

  it('reserves room for output, since it shares the window', () => {
    const diff = 'x'.repeat(400_000);
    const small = checkInputBudget(diff, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 1_000);
    const huge = checkInputBudget(diff, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 100_000);
    expect(huge.budgetTokens).toBeLessThan(small.budgetTokens);
  });

  it('never reports a negative budget when max_tokens swamps the window', () => {
    const b = checkInputBudget('x', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 10_000_000);
    expect(b.budgetTokens).toBe(0);
    expect(b.fits).toBe(false);
  });

  it('flags an assumed window so the caller can say so', () => {
    const b = checkInputBudget('x'.repeat(100), 'some.exotic.model-v9', MAX_OUT);
    expect(b.assumedWindow).toBe(true);
  });

  it('treats an empty diff as fitting', () => {
    expect(checkInputBudget('', 'us.anthropic.claude-sonnet-4-6', MAX_OUT).fits).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('approximates four characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });
});

describe('describeOverBudget', () => {
  it('names the cause, the sizes, and what to do', () => {
    // The message this replaces was "Input is too long for requested model",
    // which told the user none of those things.
    const b = checkInputBudget('x'.repeat(711_765), 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 4096);
    const msg = describeOverBudget(b, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');

    expect(msg).toContain('too large');
    expect(msg).toMatch(/\d+K tokens/);
    expect(msg).toContain('claude-sonnet-4-5');
    expect(msg).toContain('Split the PR');
    expect(msg).toContain('excludePatterns');
  });

  it('says when the window was assumed rather than known', () => {
    const b = checkInputBudget('x'.repeat(900_000), 'some.exotic.model-v9', 4096);
    expect(describeOverBudget(b, 'some.exotic.model-v9')).toContain('assumed');
  });
});
