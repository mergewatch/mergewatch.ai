/**
 * #416 — stage-scoped review identity.
 *
 * Two failure modes drive these tests, and both are silent:
 *
 * 1. **Prod's strings drift.** Every bot comment on every open PR in the wild
 *    carries `<!-- mergewatch-review -->`. If the resolver ever returns
 *    anything else for prod, `findExistingBotComment` stops matching and the
 *    next review posts a duplicate instead of updating in place. The prod
 *    assertions below are deliberately written as literals — deriving them from
 *    the implementation would make them agree with a regression.
 *
 * 2. **Only one direction gets scoped.** The markers and the check-run name are
 *    read as well as written; if a writer scopes and its reader does not, the
 *    lookup silently misses.
 */
import { describe, it, expect } from 'vitest';
import { reviewMarker, inlineMarker, checkRunName } from './stage.js';
import {
  BOT_COMMENT_MARKER,
  INLINE_BOT_COMMENT_MARKER,
  MERGEWATCH_CHECK_RUN_NAME,
} from './github/client.js';

describe('production identity is frozen', () => {
  it('reviewMarker is exactly the legacy marker', () => {
    expect(reviewMarker('prod')).toBe('<!-- mergewatch-review -->');
    expect(reviewMarker()).toBe('<!-- mergewatch-review -->');
  });

  it('inlineMarker is exactly the legacy inline marker', () => {
    expect(inlineMarker('prod')).toBe('<!-- mergewatch-inline -->');
    expect(inlineMarker()).toBe('<!-- mergewatch-inline -->');
  });

  it('checkRunName is exactly the legacy check name', () => {
    expect(checkRunName('prod')).toBe('MergeWatch Review');
    expect(checkRunName()).toBe('MergeWatch Review');
  });

  it('still matches the exported constants callers may use directly', () => {
    // Self-hosted code and anything not yet threaded still reads these.
    // They must not diverge from what the prod resolver returns.
    expect(reviewMarker()).toBe(BOT_COMMENT_MARKER);
    expect(inlineMarker()).toBe(INLINE_BOT_COMMENT_MARKER);
    expect(checkRunName()).toBe(MERGEWATCH_CHECK_RUN_NAME);
  });
});

describe('absent / blank stage reads as prod', () => {
  // A self-hosted deployment sets no STAGE. Silently scoping its markers would
  // make it stop finding its own comments and duplicate on every review.
  for (const stage of [undefined, '', '   '] as const) {
    it(`${JSON.stringify(stage)} → prod identity`, () => {
      expect(reviewMarker(stage)).toBe('<!-- mergewatch-review -->');
      expect(inlineMarker(stage)).toBe('<!-- mergewatch-inline -->');
      expect(checkRunName(stage)).toBe('MergeWatch Review');
    });
  }

  it('is case-insensitive about "prod"', () => {
    expect(reviewMarker('PROD')).toBe('<!-- mergewatch-review -->');
    expect(checkRunName('Prod')).toBe('MergeWatch Review');
  });
});

describe('non-prod stages get a distinct identity', () => {
  it('dev markers and check name differ from prod', () => {
    expect(reviewMarker('dev')).toBe('<!-- mergewatch-review:dev -->');
    expect(inlineMarker('dev')).toBe('<!-- mergewatch-inline:dev -->');
    expect(checkRunName('dev')).toBe('MergeWatch Review (dev)');
  });

  it('a dev marker never collides with the prod marker', () => {
    // The whole point: with both apps on one repo, each must find only its own
    // comment. `includes()` is how the lookup matches, so a prefix collision
    // would be just as broken as an exact one.
    expect(reviewMarker('dev').includes(reviewMarker('prod'))).toBe(false);
    expect(reviewMarker('prod').includes(reviewMarker('dev'))).toBe(false);
    expect(inlineMarker('dev').includes(inlineMarker('prod'))).toBe(false);
  });

  it('normalizes stage casing and padding so config typos still match', () => {
    expect(reviewMarker(' DEV ')).toBe('<!-- mergewatch-review:dev -->');
    expect(checkRunName('Dev')).toBe('MergeWatch Review (dev)');
  });

  it('supports a stage beyond dev/prod', () => {
    expect(reviewMarker('staging')).toBe('<!-- mergewatch-review:staging -->');
    expect(checkRunName('staging')).toBe('MergeWatch Review (staging)');
  });

  it('distinct stages never share an identity', () => {
    const stages = ['prod', 'dev', 'staging'];
    const markers = stages.map((s) => reviewMarker(s));
    expect(new Set(markers).size).toBe(stages.length);
  });
});
