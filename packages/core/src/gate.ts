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
import { buildCheckTitle, escapeUserContent } from './comment-formatter.js';
import { mergeScoreToReviewEvent, withdrawnThreadKey } from './github/client.js';
import { BUILTIN_FINDING_CATEGORIES } from './builtin-categories.js';

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

/** `repo`, `org, blocking` or `org, advisory` — how logs and notices name a source. */
export function describeSource(source: FindingSource): string {
  return source.kind === 'repo' ? 'repo' : `org, ${source.enforcement}`;
}

/**
 * #664 — a custom agent that produced no usable answer: it threw (or a later
 * file-fetch round did), its response did not parse, or it parsed into
 * nothing usable. An agent that answered `{"findings":[]}` did not fail.
 */
export interface CustomAgentFailure {
  agent: string;
  source: FindingSource;
  reason: 'error' | 'unparseable' | 'degenerate';
}

/**
 * #664 — a failure that fails the check: a repo agent (repo agents have no
 * advisory mode, and their criticals block) or a blocking org agent. Only an
 * org agent explicitly set to advisory is merely disclosed — anything else,
 * including a malformed source, gates (fail closed, as #382).
 */
export const isGatingFailure = (f: CustomAgentFailure): boolean =>
  !(f.source?.kind === 'org' && f.source.enforcement === 'advisory');

/** The minimum a finding needs to be classified. */
export interface GateFinding {
  severity: 'critical' | 'warning' | 'info' | string;
  verification?: 'verified' | 'unverified';
  verificationOutcome?: VerificationOutcome;
  source?: FindingSource;
}

export interface MergeGate {
  /** The check fails: `blockingCriticalCount > 0 || failedGatingAgents.length > 0`. */
  fails: boolean;
  /**
   * Criticals that block: built-in or repo ones not tagged unverified, and
   * org-blocking ones not refuted — including those the verifier skipped (no
   * file content) or could not decide (`inconclusive`), which fail closed.
   */
  blockingCriticalCount: number;
  /** Criticals from advisory org agents: rendered, never blocking. */
  advisoryCriticalCount: number;
  /**
   * Built-in/repo criticals the verifier could not confirm (#240), and
   * org-blocking ones it explicitly refuted. Nothing else.
   */
  unverifiedCriticalCount: number;
  /** Blocking org agents with at least one blocking critical. Distinct, sorted. */
  orgBlockedBy: string[];
  /** Blocking org criticals the verifier refuted, so they did not block. */
  refutedOrgBlockingCount: number;
  /** Blocking org agents whose criticals the author triaged away. Distinct, sorted. */
  authorWaivedBlocking: string[];
  /**
   * #664 — gating custom agents (repo, or blocking org) that failed: their
   * policy was not evaluated, so the check fails. In no finding bucket and not
   * in `orgBlockedBy`. Distinct, sorted.
   */
  failedGatingAgents: string[];
  /** #664 — advisory org agents that failed: disclosed, never gating. Distinct, sorted. */
  failedAdvisoryAgents: string[];
}

/**
 * #664 — the priors of custom agents that failed this run. Their absence from
 * the current findings means the agent did not answer, not that the issue was
 * fixed, so they must not read as resolved (delta, caption) or lift the score.
 * Matched by source kind and agent name (not enforcement: an admin may have
 * changed it), or, for a legacy record without `source`, by a category that
 * is the agent's name and not a built-in's.
 */
export function failedAgentPriors<T extends { category: string; source?: FindingSource }>(
  previous: ReadonlyArray<T> | undefined,
  failures: ReadonlyArray<CustomAgentFailure>,
): T[] {
  if (failures.length === 0) return [];
  return (previous ?? []).filter((p) => (p.source
    ? failures.some((f) => f.source.kind === p.source!.kind && f.agent === p.source!.agent)
    : !BUILTIN_FINDING_CATEGORIES.has(p.category) && failures.some((f) => f.agent === p.category)));
}

/**
 * #664 — the prior review as a runtime should read it after this run: minus
 * the failed agents' priors (so the delta and quiet-drop analytics do not read
 * "the agent did not answer" as "fixed"), plus the inline-thread keys of those
 * priors, which must stay open rather than be resolved as withdrawn.
 */
export function runtimePriorView<T extends { category: string; source?: FindingSource; file?: unknown; title?: unknown }>(
  previous: ReadonlyArray<T> | undefined,
  failures: ReadonlyArray<CustomAgentFailure>,
): { priors: T[]; withheldThreadKeys: string[] } {
  const withheld = new Set(failedAgentPriors(previous, failures));
  return {
    priors: (previous ?? []).filter((p) => !withheld.has(p)),
    withheldThreadKeys: [...withheld]
      .filter((p) => typeof p.file === 'string' && p.file.length > 0
        && typeof p.title === 'string' && p.title.trim().length > 0)
      .map((p) => withdrawnThreadKey(p.file as string, p.title as string)),
  };
}

/**
 * #350 — `postSummaryOnClean: false` keeps a clean PR free of comments. Only
 * the first post is gated: an existing comment is always updated. #664 — a
 * failed gating agent is not clean: the author must be told why the check
 * failed, so it always breaks the silence.
 */
export function shouldStaySilent(input: {
  findingCount: number;
  agentFailures: ReadonlyArray<CustomAgentFailure>;
  postSummaryOnClean?: boolean;
  existingCommentId?: number | string | null;
}): boolean {
  return input.findingCount === 0
    && input.postSummaryOnClean === false
    && !input.existingCommentId
    && !input.agentFailures.some(isGatingFailure);
}

/** #664 — a gate with nothing in it; for callers and tests that build one by hand. */
export function emptyGate(): MergeGate {
  return {
    fails: false, blockingCriticalCount: 0, advisoryCriticalCount: 0, unverifiedCriticalCount: 0,
    orgBlockedBy: [], refutedOrgBlockingCount: 0, authorWaivedBlocking: [],
    failedGatingAgents: [], failedAdvisoryAgents: [],
  };
}

const sortedDistinct = (xs: Iterable<string>) => [...new Set(xs)].sort();

const isOrgBlocking = (f: GateFinding) => f.source?.kind === 'org' && f.source.enforcement === 'blocking';

/**
 * Classify the posted criticals. Pure: reads only severity, source and the
 * verification fields.
 *
 * @param posted the findings that will be posted (after triage and the cap)
 * @param triageSuppressed findings the author rebutted or deferred (W3)
 * @param agentFailures custom agents that failed (#664)
 */
export function buildMergeGate(
  posted: ReadonlyArray<GateFinding>,
  triageSuppressed: ReadonlyArray<GateFinding> = [],
  agentFailures: ReadonlyArray<CustomAgentFailure> = [],
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
  const failedGatingAgents = sortedDistinct(agentFailures.filter(isGatingFailure).map((f) => f.agent));
  return {
    fails: blocking > 0 || failedGatingAgents.length > 0,
    blockingCriticalCount: blocking,
    advisoryCriticalCount: advisory,
    unverifiedCriticalCount: unverified,
    orgBlockedBy: sortedDistinct(orgBlockedBy),
    refutedOrgBlockingCount: refuted,
    authorWaivedBlocking: sortedDistinct(waived),
    failedGatingAgents,
    failedAdvisoryAgents: sortedDistinct(agentFailures.filter((f) => !isGatingFailure(f)).map((f) => f.agent)),
  };
}

/** Check-run title prefix when a blocking org agent gates the merge. */
export const ORG_BLOCKED_TITLE_PREFIX = 'Blocked by org agent';

/** #664 — check-run title prefix when a gating custom agent failed. */
export const AGENT_FAILED_TITLE_PREFIX = 'Custom agent failed';

/** #664 — agent names are user text: long ones are cut to 40 characters. */
export function truncateAgentName(name: string): string {
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/** `name (source)` per failure, escaped for markdown; the form the summary and comment notice use. */
export function describeFailures(failures: ReadonlyArray<CustomAgentFailure>): string {
  return failures.map((f) => `${escapeUserContent(truncateAgentName(f.agent))} (${describeSource(f.source)})`).join(', ');
}

/**
 * #664 — what to do about gating failures. A thrown call is usually
 * transient; an unparseable or empty answer usually is not.
 */
export function agentFailureRetryHint(gating: ReadonlyArray<CustomAgentFailure>): string {
  return gating.every((f) => f.reason === 'error')
    ? 'Re-run the check to retry.'
    : "Re-run; if it persists, check the agent's prompt and model.";
}

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
  /** Custom agents that failed (#664). */
  agentFailures?: ReadonlyArray<CustomAgentFailure>;
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
  const failures = input.agentFailures ?? [];
  const gating = failures.filter(isGatingFailure);
  const advisory = failures.filter((f) => !isGatingFailure(f));

  const paragraphs: string[] = [
    parts.length ? `Found: ${parts.join(', ')}`
      : failures.length ? 'No findings from the agents that ran.'
        : 'No issues detected in this PR.',
  ];
  if (gating.length) {
    paragraphs.push(gating.length === 1
      ? `A custom agent failed, so its policy was not evaluated and this check fails: ${describeFailures(gating)}.`
      : `${gating.length} custom agents failed, so their policies were not evaluated and this check fails: ${describeFailures(gating)}.`);
    paragraphs.push(agentFailureRetryHint(gating));
  }
  if (advisory.length) {
    paragraphs.push(`Advisory org agent${advisory.length === 1 ? '' : 's'} failed (does not affect this check): ${describeFailures(advisory)}.`);
  }

  // Title precedence: org block > blocking criticals > a failed gating agent > the rest.
  const title = gate.orgBlockedBy.length === 0 && gate.blockingCriticalCount === 0 && gate.failedGatingAgents.length > 0
    ? `${input.mergeScore != null ? `${Math.max(1, Math.min(5, input.mergeScore))}/5 — ` : ''}`
      + `${AGENT_FAILED_TITLE_PREFIX}: ${failedAgentTitleNames(gate.failedGatingAgents)}`
    : buildCheckTitle({
      mergeScore: input.mergeScore,
      findingCount: input.findingCount,
      blockingCriticalCount: gate.blockingCriticalCount,
      orgBlocked: gate.orgBlockedBy.length > 0,
      orgBlockedBy: gate.orgBlockedBy,
      suppressedCount: input.suppressedCount,
    });

  return {
    conclusion: gate.fails ? 'failure' : 'success',
    title,
    summary: paragraphs.join('\n\n'),
  };
}

/** Up to three raw (truncated) names, then `and N more`: a check title is one line. */
function failedAgentTitleNames(names: ReadonlyArray<string>): string {
  const shown = names.slice(0, 3).map(truncateAgentName).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/**
 * The formal review event. A blocking org agent requests changes whatever the
 * score (#235). A refuted blocking critical does not block, but it never lets
 * the review APPROVE: an org's blocking policy was overruled only by a light
 * model, so the PR gets a COMMENT. A failed gating agent (#664) caps an APPROVE
 * at COMMENT the same way. Otherwise the score decides. (#663 will make any
 * failing gate request changes; #640 generalises the cap to any failing gate.)
 */
export function reviewEventForGate(
  gate: MergeGate,
  mergeScore: number,
): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  if (gate.orgBlockedBy.length > 0) return 'REQUEST_CHANGES';
  const byScore = mergeScoreToReviewEvent(mergeScore);
  // #664 — a gating agent that failed was not evaluated: never APPROVE on it,
  // but a failure alone never requests changes either (a score of 1-2 does).
  if (byScore === 'APPROVE' && (gate.refutedOrgBlockingCount > 0 || gate.failedGatingAgents.length > 0)) return 'COMMENT';
  return byScore;
}

/** One grep-able log line per review. */
export function formatGateLog(gate: MergeGate): string {
  return `[gate] fails=${gate.fails} blocking=${gate.blockingCriticalCount} advisory=${gate.advisoryCriticalCount}`
    + ` unverified=${gate.unverifiedCriticalCount} refutedOrgBlocking=${gate.refutedOrgBlockingCount}`
    + ` orgBlockedBy=${gate.orgBlockedBy.join(',')} waived=${gate.authorWaivedBlocking.join(',')}`
    + ` failedGating=${gate.failedGatingAgents.join(',')} failedAdvisory=${gate.failedAdvisoryAgents.join(',')}`;
}
