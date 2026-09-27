/**
 * #662 — the merge gate, defined once.
 *
 * Both runtimes used to compute it inline, after the pipeline, from finding
 * CATEGORIES: `countBlockingCriticals(findings, advisoryNames) > 0 ||
 * blockingCriticalAgents(orgAgents, findings).length > 0`. That definition had
 * three defects the pipeline could not see:
 *
 *   - A blocking org agent's critical that #510's verifier REFUTED still
 *     blocked: `blockingCriticalAgents` matched on severity and category only.
 *   - "Unverified" meant both "refuted" and "the verifier could not decide".
 *     Treating both as non-blocking would fail open on a verifier error (#382),
 *     so the two are now recorded separately (`verificationOutcome`).
 *   - A custom agent named like a built-in category (`security`) was
 *     indistinguishable from the built-in agent, because category was the only
 *     provenance. Findings now carry `source`.
 *
 * The gate is computed in `runReviewPipeline` from the posted findings and
 * returned as `result.gate`. Everything the runtimes report about it — check
 * conclusion, title, summary, review event, log line — is derived here.
 */
import { buildCheckTitle } from './comment-formatter.js';
import { mergeScoreToReviewEvent } from './github/client.js';

export { BUILTIN_FINDING_CATEGORIES, isReservedAgentName } from './builtin-categories.js';

/** Where a custom-agent finding came from. Built-in findings carry none. */
export type FindingSource =
  | { kind: 'org'; agent: string; enforcement: 'advisory' | 'blocking' }
  | { kind: 'repo'; agent: string };

/**
 * Why a custom finding is `verification: 'unverified'`. Only `refuted` stops a
 * blocking org agent's critical from blocking; `inconclusive` (the verifier
 * errored, gave no verdict, or refused an in-code intent claim) fails closed.
 */
export type VerificationOutcome = 'refuted' | 'inconclusive';

/** The minimum a finding needs to be classified. */
export interface GateFinding {
  severity: 'critical' | 'warning' | 'info' | string;
  verification?: 'verified' | 'unverified';
  verificationOutcome?: VerificationOutcome;
  source?: FindingSource;
}

export interface MergeGate {
  /** The check fails. Always `blockingCriticalCount > 0`. */
  fails: boolean;
  /** Criticals that block: built-in or repo not refuted, and org-blocking not refuted. */
  blockingCriticalCount: number;
  /** Criticals from advisory org agents: rendered, never blocking. */
  advisoryCriticalCount: number;
  /** Built-in/repo criticals the verifier could not confirm (#240), and refuted org-blocking ones. */
  unverifiedCriticalCount: number;
  /** Blocking org agents with at least one blocking critical. Distinct, sorted. */
  orgBlockedBy: string[];
  /** Blocking org criticals the verifier refuted, so they did not block. */
  refutedOrgBlockingCount: number;
  /** Blocking org agents whose criticals the author triaged away. Distinct, sorted. */
  authorWaivedBlocking: string[];
}

const sortedDistinct = (xs: Iterable<string>) => [...new Set(xs)].sort();

const isOrgBlocking = (f: GateFinding) => f.source?.kind === 'org' && f.source.enforcement === 'blocking';

/**
 * Classify the posted criticals. Pure: reads only severity, source and the
 * verification fields.
 *
 * @param posted the findings that will be posted (after triage and the cap)
 * @param triageSuppressed findings the author rebutted or deferred (W3)
 */
export function buildMergeGate(
  posted: ReadonlyArray<GateFinding>,
  triageSuppressed: ReadonlyArray<GateFinding> = [],
): MergeGate {
  let blocking = 0;
  let advisory = 0;
  let unverified = 0;
  let refuted = 0;
  const orgBlockedBy: string[] = [];
  for (const f of posted) {
    if (f.severity !== 'critical') continue;
    const s = f.source;
    if (s?.kind === 'org' && s.enforcement === 'advisory') {
      advisory++;
    } else if (s?.kind === 'org') {
      if (f.verificationOutcome === 'refuted') {
        unverified++;
        refuted++;
      } else {
        blocking++;
        orgBlockedBy.push(s.agent);
      }
    } else if (f.verification === 'unverified') {
      unverified++;
    } else {
      blocking++;
    }
  }
  const waived = triageSuppressed
    .filter((f) => f.severity === 'critical' && isOrgBlocking(f))
    .map((f) => (f.source as { agent: string }).agent);
  return {
    fails: blocking > 0,
    blockingCriticalCount: blocking,
    advisoryCriticalCount: advisory,
    unverifiedCriticalCount: unverified,
    orgBlockedBy: sortedDistinct(orgBlockedBy),
    refutedOrgBlockingCount: refuted,
    authorWaivedBlocking: sortedDistinct(waived),
  };
}

/** Check-run title prefix when a blocking org agent gates the merge. */
export const ORG_BLOCKED_TITLE_PREFIX = 'Blocked by org agent';

/** Check-run title when the review threw. */
export const REVIEW_FAILED_CHECK_TITLE = 'Review failed';

export interface CheckOutcomeInput {
  mergeScore?: number;
  findingCount: number;
  warningCount: number;
  infoCount: number;
  suppressedCount?: number;
  /** Repo custom agents dropped for a reserved name (#662). */
  rejectedCustomAgents?: ReadonlyArray<string>;
}

export interface CheckOutcome {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
}

/** Conclusion, title and summary of the completed check run. */
export function buildCheckOutcome(gate: MergeGate, input: CheckOutcomeInput): CheckOutcome {
  const parts: string[] = [];
  if (gate.blockingCriticalCount) parts.push(`${gate.blockingCriticalCount} critical`);
  if (gate.advisoryCriticalCount) parts.push(`${gate.advisoryCriticalCount} advisory`);
  if (gate.unverifiedCriticalCount) parts.push(`${gate.unverifiedCriticalCount} unverified`);
  if (input.warningCount) parts.push(`${input.warningCount} warning`);
  if (input.infoCount) parts.push(`${input.infoCount} info`);
  if (gate.orgBlockedBy.length) parts.push(`blocked by org agent: ${gate.orgBlockedBy.join(', ')}`);
  if (gate.authorWaivedBlocking.length) parts.push(`waived by author: ${gate.authorWaivedBlocking.join(', ')}`);
  if (input.rejectedCustomAgents?.length) {
    parts.push(`ignored custom agents (reserved names): ${input.rejectedCustomAgents.join(', ')}`);
  }
  return {
    conclusion: gate.fails ? 'failure' : 'success',
    title: buildCheckTitle({
      mergeScore: input.mergeScore,
      findingCount: input.findingCount,
      blockingCriticalCount: gate.blockingCriticalCount,
      orgBlocked: gate.orgBlockedBy.length > 0,
      orgBlockedBy: gate.orgBlockedBy,
      suppressedCount: input.suppressedCount,
    }),
    summary: parts.length ? `Found: ${parts.join(', ')}` : 'No issues detected in this PR.',
  };
}

/**
 * The formal review event. A blocking org agent requests changes whatever the
 * score (#235). A refuted blocking critical does not block, but it never lets
 * the review APPROVE: an org's blocking policy was overruled only by a light
 * model, so the PR gets a COMMENT. Otherwise the score decides. (#663 will make
 * any failing gate request changes; #640 maps a failing gate at 4-5 to COMMENT.)
 */
export function reviewEventForGate(
  gate: MergeGate,
  mergeScore: number,
): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  if (gate.orgBlockedBy.length > 0) return 'REQUEST_CHANGES';
  const byScore = mergeScoreToReviewEvent(mergeScore);
  if (gate.refutedOrgBlockingCount > 0 && byScore === 'APPROVE') return 'COMMENT';
  return byScore;
}

/** One grep-able log line per review. */
export function formatGateLog(gate: MergeGate): string {
  return `[gate] fails=${gate.fails} blocking=${gate.blockingCriticalCount} advisory=${gate.advisoryCriticalCount}`
    + ` unverified=${gate.unverifiedCriticalCount} refutedOrgBlocking=${gate.refutedOrgBlockingCount}`
    + ` orgBlockedBy=${gate.orgBlockedBy.join(',')} waived=${gate.authorWaivedBlocking.join(',')}`;
}
