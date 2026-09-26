/**
 * #657 — the one decision behind the "Re-run" button, shared by both runtimes.
 *
 * GitHub's Checks-UI "Re-run" button fires `check_suite.rerequested`, not
 * `check_run.rerequested` (#558). The Lambda webhook learned that; the Express
 * webhook never did, so on self-hosted the button did nothing at all — the
 * event hit no branch in the dispatcher.
 *
 * The obvious fix is to copy the Lambda handler into the server. That is how
 * the two runtimes drift: the ownership rule here is subtle (a suite carries no
 * `name`, so the check-run identity rule has to be applied one level down) and
 * it is fail-closed on purpose. So the decision lives here, once, and each
 * runtime supplies only the I/O it already owns.
 *
 * What is deliberately NOT here: minting the check-run key, fetching the PR,
 * classifying it, or enqueuing. Those differ between the runtimes by more than
 * a callback (SQS vs. an in-process queue, best-effort vs. throwing
 * `pulls.get`), and #657 explicitly keeps each runtime's existing semantics.
 */

import type { CheckSuiteEvent } from '../types/github.js';
import { checkRunName, type Stage } from '../stage.js';

/**
 * Re-review this PR, or don't — with the reason, so each runtime can log it
 * without reconstructing why.
 *
 * A reason rather than a bare `false`: every skip below is silent from the
 * outside (the user clicked a button and nothing happened), which is the exact
 * failure #558 and #657 are about. A skip that cannot be read in the logs is
 * the same bug with a different cause.
 */
export type CheckSuiteRereviewDecision =
  | {
      rereview: true;
      installationId: number;
      prNumber: number;
      /** The suite's head SHA — the commit whose checks were re-run. */
      headSha: string;
    }
  | {
      rereview: false;
      reason: string;
      /**
       * Whether this skip is worth a log line.
       *
       * `check_suite` is a high-volume subscription: `requested` fires on every
       * push and `completed` on every suite finishing, and dropping those is
       * routine (`notable: false`). Every other skip can only follow a human
       * clicking Re-run and watching nothing happen, which is the failure #558
       * and #657 are about — those are `notable: true` and must be logged.
       *
       * Without this the caller either warns on every push or stays silent on a
       * dead button; both are how this bug hid.
       */
      notable: boolean;
    };

export interface CheckSuiteRereviewDeps {
  /** #416 — which stage's check-run name counts as ours. */
  stage?: Stage;
  /**
   * Names of the check runs on `ref`, for deciding whether the suite is ours.
   *
   * Takes `checkName` so the caller can hand it to the API as a filter
   * (`checks.listForRef({ check_name })`) instead of paging every run on the
   * commit: a busy repo can hold far more than one page of runs, and a
   * MergeWatch run sitting on page two reads exactly like "not ours".
   *
   * Called at most once, and only after the event is known to be a
   * `rerequested` suite with an installation id and an attached PR — so an
   * implementation may resolve an installation client inside it without
   * spending a token exchange on the `requested` suites that fire on every
   * push.
   *
   * May reject: the decision is then a skip (fail closed). A missed re-run is
   * recoverable by pushing a commit; reviewing another tool's suite spends real
   * money on work nobody asked for.
   */
  listCheckRunNames: (ref: string, checkName: string) => Promise<string[]>;
}

export async function decideCheckSuiteRereview(
  event: CheckSuiteEvent,
  deps: CheckSuiteRereviewDeps,
): Promise<CheckSuiteRereviewDecision> {
  // `requested` fires on every push and `completed` on every suite finishing.
  // Acting on either would double every review on the repo, so this is checked
  // first and costs no I/O.
  if (event.action !== 'rerequested') {
    return {
      rereview: false,
      reason: `check_suite action "${event.action}" is not rerequested`,
      notable: false,
    };
  }

  const installationId = event.installation?.id;
  if (!installationId) {
    return { rereview: false, reason: 'check_suite event has no installation id', notable: true };
  }

  const headSha = event.check_suite?.head_sha;
  if (!headSha) {
    return { rereview: false, reason: 'check_suite event has no head SHA', notable: true };
  }

  const prNumber = event.check_suite.pull_requests?.[0]?.number;
  if (prNumber == null) {
    // A suite on a commit with no PR (a branch push). Nothing to review.
    return {
      rereview: false,
      reason: `check_suite rerequested with no attached PR on ${event.repository?.full_name} @ ${headSha}`,
      notable: true,
    };
  }

  // A suite carries no `name`, so the `check_run` identity rule cannot be
  // applied to this payload. Apply the SAME rule one level down: our stage's
  // check run must exist on the suite's head. That survives a rename (unlike
  // `app.id`), keeps dev from acting on prod's suite, and costs one call on an
  // event that only fires when a human clicks a button.
  const name = checkRunName(deps.stage);
  let names: string[];
  try {
    names = await deps.listCheckRunNames(headSha, name);
  } catch (err) {
    // Fail closed — see `listCheckRunNames`.
    return {
      rereview: false,
      reason: `check_suite ownership check failed for ${event.repository?.full_name} @ ${headSha}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      notable: true,
    };
  }

  // Re-checked here even though the caller filtered by `check_name`: the filter
  // is an optimization, and a runtime that ignores it (or an API that treats it
  // loosely) must not turn another tool's suite into a paid review.
  if (!names.includes(name)) {
    return {
      rereview: false,
      reason: `no "${name}" check run on ${event.repository?.full_name} @ ${headSha} — suite is not ours`,
      // Another tool's suite being re-run is routine on a repo with several
      // Apps; ours not being found when it should be is not distinguishable
      // from here, so this stays quiet rather than warning on every re-run of
      // someone else's checks.
      notable: false,
    };
  }

  return { rereview: true, installationId, prNumber, headSha };
}
