import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #544 — the inline-reply call site must pass the deployment stage.
 *
 * This is a source assertion, and it is deliberate. The bug was NOT in
 * `handleInlineReply`: that function has accepted a `stage` since #416 and
 * behaves correctly for every value of it, which is why the core unit tests
 * passed throughout the entire period the feature was broken. The bug was that
 * the self-hosted handler never passed one.
 *
 * An absent stage IS prod (`stage.ts:51`), so the omission had no type error,
 * no runtime error, and no failing test — a non-prod App simply looked for the
 * prod marker, failed to recognise a thread it had written itself, and
 * discarded the user's reply. It took driving a fixture by hand against a
 * deployed stage to notice.
 *
 * Testing the call site is the only level at which that class of bug is
 * visible. #416 wired STAGE through the check-run call sites in this file and
 * missed this one; nothing could have told us.
 */
describe('#544 — the inline-reply call site passes the stage', () => {
  const src = readFileSync(join(__dirname, 'review-processor.ts'), 'utf-8');

  /** The `handleInlineReply({...})` context argument, as written in source. */
  function inlineReplyContext(): string {
    const at = src.indexOf('handleInlineReply(');
    expect(at, 'handleInlineReply is no longer called from review-processor.ts').toBeGreaterThan(-1);
    // The context object is the first argument: from the first `{` to its match.
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error('could not find the end of the inline-reply context object');
  }

  it('passes `stage` into the context', () => {
    expect(inlineReplyContext()).toMatch(/\bstage:/);
  });

  it('passes the module STAGE constant, not a literal', () => {
    // `stage: 'prod'` or `stage: undefined` would satisfy the check above while
    // reintroducing exactly this bug.
    expect(inlineReplyContext()).toMatch(/\bstage:\s*STAGE\b/);
  });

  it('STAGE is read from the environment', () => {
    expect(src).toMatch(/const STAGE = process\.env\.STAGE/);
  });

  it('logs the skip reason alongside the action', () => {
    // The reason was computed on every skip and thrown away, so the log could
    // not distinguish "not our thread" from "already answered". That is why
    // this cost a hand-driven investigation rather than a log read.
    expect(src).toMatch(/result\.reason/);
  });
});
