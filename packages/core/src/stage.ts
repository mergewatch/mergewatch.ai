/**
 * #416 — stage-scoped review identity.
 *
 * MergeWatch runs as two separate GitHub Apps (dev and prod). Installing both
 * on one repository is how dev and prod get compared: the same PR, at the same
 * commit, reviewed twice, side by side. That only works if the two stages can
 * tell their own artifacts apart.
 *
 * They currently cannot. `findExistingBotComment` matches on the comment marker
 * alone with no author filter, so the second app to run finds the first app's
 * comment and tries to update it — which GitHub rejects, because an App may
 * only edit comments it authored.
 *
 * These resolvers give each non-prod stage its own marker and check-run name.
 *
 * **Prod's values are frozen.** They are returned verbatim, never derived, and
 * pinned by tests asserting the literal strings. Changing
 * `<!-- mergewatch-review -->` even once would orphan every bot comment on
 * every open PR in the wild: the lookup returns null and the next review posts
 * a duplicate instead of updating in place.
 *
 * The stage is always passed in, never read from `process.env` here — this
 * package is deliberately environment-agnostic, the same way `llm/pricing.ts`
 * leaves env reading to its caller. The Lambda already has `STAGE` set.
 */

/**
 * Deployment stage. `'prod'` (or absent) selects the frozen production
 * identity; anything else gets a scoped variant.
 *
 * Typed as an open union so callers can pass `process.env.STAGE` — which is
 * `string | undefined` — without a cast, while `'prod'` still autocompletes.
 */
export type Stage = 'prod' | (string & {});

/** The production comment marker. Frozen — see the module docstring. */
const PROD_REVIEW_MARKER = '<!-- mergewatch-review -->';
/** The production inline-comment marker. Frozen. */
const PROD_INLINE_MARKER = '<!-- mergewatch-inline -->';
/** The production check-run name. Frozen. */
const PROD_CHECK_RUN_NAME = 'MergeWatch Review';

/**
 * Whether this stage uses the frozen production identity.
 *
 * Absent, empty, and whitespace all read as prod. That default matters: a
 * self-hosted deployment sets no `STAGE`, and a misconfigured one that silently
 * scoped its markers would stop finding its own comments and post a duplicate
 * on every review.
 */
function isProd(stage?: Stage): boolean {
  return !stage || stage.trim() === '' || stage.trim().toLowerCase() === 'prod';
}

/** Normalized suffix for a non-prod stage — lowercased, trimmed. */
function suffix(stage: Stage): string {
  return stage.trim().toLowerCase();
}

/**
 * HTML marker identifying this stage's main review comment.
 *
 * Written into every review comment and matched when looking one up, so both
 * sides must resolve it from the same stage or the lookup silently misses.
 */
export function reviewMarker(stage?: Stage): string {
  return isProd(stage) ? PROD_REVIEW_MARKER : `<!-- mergewatch-review:${suffix(stage!)} -->`;
}

/**
 * HTML marker identifying this stage's inline review comments.
 *
 * Also matched by the disposition writer and the inline-reply path when
 * deciding whether a thread is ours.
 */
export function inlineMarker(stage?: Stage): string {
  return isProd(stage) ? PROD_INLINE_MARKER : `<!-- mergewatch-inline:${suffix(stage!)} -->`;
}

/**
 * Check-run name for this stage.
 *
 * Read as well as written: `isMergeWatchCheckRun` compares an incoming
 * `check_run.rerequested` event's name against this to decide whether the
 * native "Re-run" button was ours. Scoping the write side alone would leave a
 * non-prod stage ignoring its own re-run clicks.
 */
export function checkRunName(stage?: Stage): string {
  return isProd(stage) ? PROD_CHECK_RUN_NAME : `${PROD_CHECK_RUN_NAME} (${suffix(stage!)})`;
}
