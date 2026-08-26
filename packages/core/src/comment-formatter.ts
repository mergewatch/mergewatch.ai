/**
 * Formats the final GitHub PR comment from orchestrated review findings.
 *
 * The comment uses a hidden HTML marker (<!-- mergewatch-review -->) so the
 * handler can find and update an existing comment instead of posting duplicates.
 */

import type { UXConfig } from './config/defaults.js';
import type { ReviewDelta } from './review-delta.js';
import type { FindingEvidence } from './types/db.js';
import { isValidMermaidDiagram } from './agents/reviewer.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Finding {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  confidence?: number;
  category: string;
  title: string;
  description: string;
  suggestion: string;
  /**
   * FP-L — W2 verification verdict. When `'unverified'` and severity is
   * critical, the finding is rendered in the "Unverified concerns" sub-section
   * (advisory) instead of the "Critical" section, and excluded from the
   * top-level "Requires your attention" table. The W7 score-clamp uses the
   * same field; FP-L closes the propagation gap between scoring and rendering.
   * Absent → treated as a pre-W2 record and rendered as a normal critical.
   */
  verification?: 'verified' | 'unverified';
  /**
   * #469 — per-finding proof. Rendering is severity-asymmetric because the
   * data is: the verifier never runs on info findings, so they have no reason
   * to show and get no evidence affordance at all.
   */
  evidence?: FindingEvidence;
}

export interface WorkDoneSection {
  filesScanned: number;
  linesScanned: number;
  agentsRan: number;
  hasDependencyFiles: boolean;
}

/**
 * #369 — render repo/installation-controlled text as LITERAL text.
 *
 * `ux.commentHeader` (from `.mergewatch.yml` — anyone with repo write
 * access) and the dashboard's comment header/footer setting are injected
 * into every review comment the bot posts. Unescaped, they are an
 * org-wide markdown/HTML injection surface (live headings, links, <img>
 * tags — the E2E-79 payload). HTML metacharacters become entities and
 * markdown-active punctuation is backslash-escaped, so GitHub renders
 * exactly the characters the author typed, styling none of them.
 */
export function escapeUserContent(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Backslash-escape markdown punctuation. Valid CommonMark: an escaped
    // punctuation char renders as the bare char. Covers headings (#),
    // emphasis (*_~), code (`), links/images ([]()!), tables (|), block
    // quotes handled via > above, and list/rule starters (+-.).
    .replace(/[\\`*_{}[\]()#+\-.!|~=]/g, '\\$&');
}

/**
 * #240 — criticals that may legitimately block a PR: severity 'critical' AND
 * not tagged `verification: 'unverified'` by the W2 pass. The W7 score clamp
 * and FP-L rendering already treat unverified criticals as advisory; this is
 * the shared count both runtimes use for the check-run conclusion so the
 * check can never fail on a critical the score refuses to block on. A
 * finding with no `verification` field is a pre-W2 record and counts as
 * blocking (unchanged behavior).
 */
export function countBlockingCriticals(
  findings: ReadonlyArray<Pick<Finding, 'severity' | 'verification'>>,
): number {
  return findings.filter(
    (f) => f.severity === 'critical' && f.verification !== 'unverified',
  ).length;
}

/**
 * #380 — completion check-run title, shared by both runtimes. The conclusion
 * only fails on blocking criticals (#240), which means a 3/5 "review
 * recommended" verdict renders a green check indistinguishable from a clean
 * 5/5 in the checks tab — PR #363 merged with an unaddressed warning exactly
 * that way. The title therefore always leads with the merge score (the
 * pipeline's W7-reconciled score, same value the comment verdict renders),
 * so the checks tab carries the signal without changing gating behavior.
 * No score (legacy/edge case) → the pre-#380 title, unprefixed.
 */
export function buildCheckTitle(input: {
  mergeScore?: number;
  findingCount: number;
  blockingCriticalCount: number;
  orgBlocked?: boolean;
  orgBlockedBy?: string[];
}): string {
  const { mergeScore, findingCount, blockingCriticalCount, orgBlocked, orgBlockedBy } = input;
  const prefix = mergeScore != null
    ? `${Math.max(1, Math.min(5, mergeScore))}/5 — `
    : '';
  if (orgBlocked) return `${prefix}Blocked by org agent: ${(orgBlockedBy ?? []).join(', ')}`;
  if (blockingCriticalCount > 0) {
    return `${prefix}${blockingCriticalCount} critical issue${blockingCriticalCount > 1 ? 's' : ''} found`;
  }
  if (findingCount > 0) {
    return `${prefix}${findingCount} finding${findingCount > 1 ? 's' : ''} (no blocking critical)`;
  }
  return `${prefix}No issues found`;
}

interface FormatOptions {
  /** Markdown summary text from the summary agent */
  summary: string;
  /** Deduplicated + ranked findings from the orchestrator */
  findings: Finding[];
  /** Optional custom footer line from installation settings */
  commentFooter?: string;
  /** Whether to show the summary section */
  showSummary?: boolean;
  /** Whether to show the issues table */
  showIssuesTable?: boolean;
  /** Whether to show confidence scores per finding */
  showConfidence?: boolean;
  /** Mermaid diagram code from the diagram agent */
  diagram?: string;
  /** Caption for the diagram */
  diagramCaption?: string;
  /** Whether to show the diagram section */
  showDiagram?: boolean;
  /** URL to the review detail page on the MergeWatch dashboard */
  reviewDetailUrl?: string;
  /** Overall merge readiness score (1-5) */
  mergeScore?: number;
  /** One-line reason for the merge score */
  mergeScoreReason?: string;
  /**
   * FP-J L3 — transparent dispute-rate disclosure rendered as a small
   * annotation beneath the merge-score line. Set by `reconcileMergeScore`
   * when one or more action findings come from chronically-disputed
   * categories (rate ≥ 75% over the 30d FB-E window, surfacings ≥ 5).
   * Surfaced separately from `mergeScoreReason` so the verdict line stays
   * concise and the context renders as an opt-in audit trail rather than
   * a primary verdict signal. Omitted when no disputed categories qualify.
   */
  disputeDisclosure?: string;
  /** UX configuration */
  ux?: UXConfig;
  /** Work done stats for the work-done section */
  workDone?: WorkDoneSection;
  /** Delta from previous review (null if first review) */
  delta?: ReviewDelta | null;
  /**
   * One-sentence caption summarising what changed since the prior review.
   * Generated by the delta-caption agent on re-reviews; rendered between
   * the delta strip and the merge-readiness verdict.
   */
  deltaCaption?: string | null;
  /** Number of findings suppressed by orchestrator */
  suppressedCount?: number;
  /**
   * #382 — findings-bearing agent responses that failed to parse this run.
   * Rendered as a reliability warning (not gated by showSuppressedCount):
   * a non-zero value means findings may be missing from this review.
   */
  parseFailureCount?: number;
  /**
   * #401 — agents whose response parsed but was not a usable findings array
   * (a non-array, or mostly-empty entries). Rendered as a reliability warning
   * alongside unparsed output: findings may be missing, and the cause is an
   * agent malfunction rather than a parse error.
   */
  degenerateResponseCount?: number;
  /** Number of enabled agents that ran */
  enabledAgentCount?: number;
  /** Total input tokens used */
  inputTokens?: number;
  /** Total output tokens used */
  outputTokens?: number;
  /** Estimated cost in USD for this run */
  estimatedCostUsd?: number | null;
  /** Cumulative cost in USD across all reviews on this PR */
  cumulativeCostUsd?: number | null;
  /** Review wall-clock time in milliseconds */
  durationMs?: number;
  /** LLM model name */
  model?: string;
  /** Path to the repo conventions file that was loaded, if any. */
  conventionsSource?: string;
  /** True when the loaded conventions file was truncated to fit the size cap. */
  conventionsTruncated?: boolean;
  /**
   * #195 Phase 4 — render the "Was this review helpful? 👍 / 👎" prompt in the
   * footer. The review path polls the summary comment's 👍/👎 reactions into
   * the engagement rollup. Defaults to on; set false to suppress.
   */
  showHelpfulPrompt?: boolean;
}

// ─── Severity display config ───────────────────────────────────────────────

const SEVERITY_META: Record<Finding['severity'], { emoji: string; label: string; order: number }> = {
  critical: { emoji: '\uD83D\uDD34', label: 'Critical', order: 0 },
  warning:  { emoji: '\uD83D\uDFE1', label: 'Warnings', order: 1 },
  info:     { emoji: '\uD83D\uDD35', label: 'Info',     order: 2 },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const MERGE_SCORE_META: Record<number, { emoji: string; label: string }> = {
  5: { emoji: '\uD83D\uDFE2', label: 'Safe to merge' },
  4: { emoji: '\uD83D\uDFE2', label: 'Generally safe' },
  3: { emoji: '\uD83D\uDFE1', label: 'Review recommended' },
  2: { emoji: '\uD83D\uDFE0', label: 'Needs fixes' },
  1: { emoji: '\uD83D\uDD34', label: 'Do not merge' },
};

/**
 * #486 — the dashboard URL for one review, built the SAME way by both runtimes.
 *
 * They had drifted into two different shapes. SaaS produced a single encoded
 * segment; self-hosted produced `.../{encodedRepo}/{prNumberCommitSha}` — two
 * segments against a one-segment `[id]` route, so it 404'd. Worse, the `#` in
 * `42#abc` went unencoded, which a browser treats as a fragment: the commit SHA
 * never reached the server at all.
 *
 * Returns undefined when there is no dashboard, which is the normal
 * self-hosted case — the comment then omits the link rather than rendering a
 * dead one.
 */
export function buildReviewDetailUrl(
  dashboardBaseUrl: string | undefined,
  repoFullName: string,
  prNumberCommitSha: string,
): string | undefined {
  if (!dashboardBaseUrl) return undefined;
  const base = dashboardBaseUrl.replace(/\/+$/, '');
  return `${base}/dashboard/reviews/${encodeURIComponent(`${repoFullName}:${prNumberCommitSha}`)}`;
}

/**
 * The verdict wording for a merge score, clamped to 1–5.
 *
 * Exported so the dashboard (#472) shows the SAME verdict as the PR comment.
 * Two copies of this table would drift, and a review that reads "Needs fixes"
 * on GitHub and something else on the dashboard is worse than either alone.
 */
export function mergeScoreMeta(score: number): { emoji: string; label: string; score: number } {
  // Round before the lookup. MERGE_SCORE_META is keyed 1–5, so a fractional
  // score — the orchestrator clamps but does not round, so a model returning
  // 2.5 reaches here — missed the table entirely and produced
  // `undefined **2.5/5 — undefined**` in the rendered comment.
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  return { ...MERGE_SCORE_META[clamped], score: clamped };
}

/** Render the merge score as a prominent badge line. */
function renderMergeScore(score: number): string {
  const { emoji, label, score: clamped } = mergeScoreMeta(score);
  return `${emoji} **${clamped}/5 — ${label}**`;
}

/** Group findings by severity, preserving intra-group order. */
function groupBySeverity(findings: Finding[]): Map<Finding['severity'], Finding[]> {
  const groups = new Map<Finding['severity'], Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.severity) ?? [];
    list.push(f);
    groups.set(f.severity, list);
  }
  return groups;
}

/** Truncate summary to 2-3 sentences of plain prose. */
function truncateSummary(summary: string): string {
  // Strip markdown headings
  let text = summary.replace(/^#{1,6}\s+.*/gm, '');
  // Strip bold headings like **Key Changes:**
  text = text.replace(/\*\*[^*]+:\*\*/g, '');
  // Strip bullet markers
  text = text.replace(/^[\s]*[-*]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');
  // Collapse whitespace
  text = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  // Split on sentence boundaries and take first 2
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text;
  return sentences.slice(0, 2).join(' ').trim();
}

/** Shorten a file path to last 2 segments. */
function shortenPath(path: string): string {
  const parts = path.split('/');
  return parts.slice(-2).join('/');
}

/** Render a single finding as a detailed markdown list item. */
/**
 * #469 — render a finding's proof, inline and short.
 *
 * Severity decides how much, because availability does. Criticals get all
 * three elements uncollapsed: they already render open, and hiding proof
 * behind a click on the highest-stakes finding is backwards. Warnings get the
 * reason alone — a code block per warning is more chrome than signal at that
 * volume. Info gets nothing, because `verifyFindings` skips info entirely and
 * an empty evidence shell would imply a check that never ran.
 */
function renderEvidence(f: Finding): string {
  const e = f.evidence;
  if (!e) return '';
  if (f.severity === 'info') return '';

  const reason = e.reason?.trim();
  if (f.severity === 'warning') {
    return reason ? `\n  ↳ ${reason}` : '';
  }

  // Critical: cited code, then the reason, then convergence.
  let out = '';
  if (e.code?.trim()) {
    const startLine = e.codeStartLine;
    const gutter = startLine != null ? ` \`${f.file}:${startLine}\`` : '';
    // #477 — two rendering hazards, both reachable because the cited code is
    // raw source from the file at head:
    //
    //  1. A triple backtick in the code closes the fence early and the rest of
    //     the review renders as broken markdown. #469 deliberately cites .md
    //     files like any other, so this is not theoretical. CommonMark allows
    //     any fence length >= 3 and requires the closer to be at least as long,
    //     so open with one longer than the longest run in the code itself.
    //  2. The finding is a `-` bullet, and in GFM a blank line followed by
    //     unindented content ends the list — an unindented fence escapes the
    //     bullet and detaches the `↳ reason` line below from its finding.
    //     Indent the fence and its content to the list content column.
    const longestRun = Math.max(
      0,
      ...(e.code.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    const indented = e.code.split('\n').map((l) => `  ${l}`).join('\n');
    out += `\n\n  <sub>Cited code${gutter}</sub>\n\n  ${fence}\n${indented}\n  ${fence}`;
  }
  if (reason) {
    out += `\n  ↳ ${reason}`;
  }
  // Only ever rendered on convergence — a single agent's name restates the
  // category and tells the reader nothing they cannot already see.
  if (e.agents && e.agents.length > 1) {
    out += `\n  ↳ <sub>${e.agents.join(' + ')} agreed independently</sub>`;
  }
  return out;
}

function renderFinding(f: Finding, showConfidence: boolean, showEvidence = true): string {
  const confidenceBadge = showConfidence && f.confidence != null
    ? ` \`${f.confidence}%\``
    : '';
  let line = `- **\`${f.file}:${f.line}\`** — ${f.title}${confidenceBadge}`;
  if (f.description) {
    line += `\n  ${f.description}`;
  }
  if (f.suggestion) {
    line += `\n  > **Suggestion:** ${f.suggestion}`;
  }
  if (showEvidence) {
    line += renderEvidence(f);
  }
  return line;
}

const DEPENDENCY_FILE_PATTERNS = [
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Gemfile\.lock$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /requirements\.txt$/,
  /poetry\.lock$/,
];

/** Build work-done section data from PR context file stats. */
export function buildWorkDoneSection(
  files: string[],
  totalAdditions: number,
  totalDeletions: number,
  enabledAgentCount: number,
): WorkDoneSection {
  const hasDependencyFiles = files.some((f) =>
    DEPENDENCY_FILE_PATTERNS.some((p) => p.test(f)),
  );

  return {
    filesScanned: files.length,
    linesScanned: totalAdditions + totalDeletions,
    agentsRan: enabledAgentCount,
    hasDependencyFiles,
  };
}

// ─── Comment size guard (#468) ─────────────────────────────────────────────

/**
 * Working budget for the assembled comment body.
 *
 * GitHub rejects an issue comment over 65,536 characters with a 422, and the
 * review then vanishes from the PR entirely — no truncated comment, no error,
 * nothing. That is the worst failure available here, because it is
 * indistinguishable from MergeWatch never having run.
 *
 * The budget sits below the hard cap (which lives in github/client.ts, with
 * the API call that enforces it) to leave room for two things the formatter
 * cannot see: the stage marker the client prepends, and the truncation notice
 * this module may add after measuring.
 */
export const COMMENT_BODY_BUDGET = 60_000;

/** A contiguous run of body lines that is kept or shed as a unit. */
interface Section {
  id: string;
  /**
   * Lower sheds first. {@link KEEP} marks a section that is never droppable —
   * the verdict, the summary, and every critical finding. Whatever survives is
   * what MergeWatch is asserting about this PR, so a surviving findings list
   * must never read as complete when it is not.
   */
  priority: number;
  /** Phrase naming what is lost, used by the truncation notice. */
  label?: string;
  lines: string[];
  dropped?: boolean;
}

const KEEP = Number.POSITIVE_INFINITY;

/**
 * Where the truncation notice goes, most-preferred first. It belongs high in
 * the comment: a reader who learns content is missing only after scrolling
 * past the findings has already drawn the wrong conclusion. Each anchor may be
 * absent (`showSummary: false`, no `mergeScore`), so this degrades down to the
 * header, which always renders.
 */
const NOTICE_ANCHORS = ['summary', 'score', 'header'];

function buildTruncationNotice(dropped: Section[], reviewDetailUrl?: string): string {
  const lost = dropped.map((s) => s.label ?? s.id).join(', ');
  if (reviewDetailUrl) {
    return `_This comment was truncated to fit GitHub's size limit — omitted: ${lost}. [View the full review](${reviewDetailUrl})._`;
  }
  // Self-hosted deployments have no dashboard, so `reviewDetailUrl` is absent
  // and there is no destination to point at. Never render a dead link, and
  // never imply a fuller version exists somewhere the reader can reach.
  return `_${dropped.length} section${dropped.length !== 1 ? 's' : ''} omitted to fit GitHub's comment size limit — ${lost}._`;
}

function assembleSections(sections: Section[], reviewDetailUrl?: string): string {
  const live = sections.filter((s) => !s.dropped);
  const dropped = sections.filter((s) => s.dropped);
  const notice = dropped.length > 0 ? buildTruncationNotice(dropped, reviewDetailUrl) : '';
  const anchorId = notice
    ? NOTICE_ANCHORS.find((id) => live.some((s) => s.id === id))
    : undefined;

  const out: string[] = [];
  for (const s of live) {
    out.push(...s.lines);
    if (notice && s.id === anchorId) {
      out.push(notice, '');
    }
  }
  return out.join('\n');
}

/**
 * Join the assembled sections, shedding the lowest-priority ones until the
 * body fits. The notice is recomputed on every pass because it names what was
 * dropped, so it grows as more goes — measuring once up front would undercount.
 */
function fitSections(sections: Section[], budget: number, reviewDetailUrl?: string): string {
  let body = assembleSections(sections, reviewDetailUrl);
  if (body.length <= budget) return body;

  const shed = sections
    .filter((s) => Number.isFinite(s.priority))
    .sort((a, b) => a.priority - b.priority);

  for (const s of shed) {
    s.dropped = true;
    body = assembleSections(sections, reviewDetailUrl);
    if (body.length <= budget) return body;
  }

  // Everything droppable is gone and the verdict plus the criticals alone
  // still exceed the budget. Cutting inside the critical list is the only
  // move left; the one thing that must not happen is it reading as complete.
  const notice = "\n\n_Truncated to fit GitHub's comment size limit — some findings are not shown._";
  return `${body.slice(0, Math.max(0, budget - notice.length))}${notice}`;
}


// ─── Main formatter ────────────────────────────────────────────────────────

/**
 * Build the full markdown comment body for a MergeWatch review.
 *
 * @returns A markdown string ready to be posted as a GitHub PR comment.
 */
export function formatReviewComment(options: FormatOptions): string {
  const {
    summary,
    findings,
    commentFooter,
    showSummary = true,
    showIssuesTable = true,
    showConfidence = true,
    diagram,
    diagramCaption,
    showDiagram = true,
    showHelpfulPrompt = true,
    reviewDetailUrl,
    mergeScore,
    mergeScoreReason,
    disputeDisclosure,
    ux,
    workDone,
    delta,
    deltaCaption,
    suppressedCount,
    parseFailureCount,
    degenerateResponseCount,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    cumulativeCostUsd,
    durationMs,
    model,
    conventionsSource,
    conventionsTruncated,
  } = options;

  const sections: Section[] = [];
  const section = (id: string, priority: number, label?: string): string[] => {
    const s: Section = { id, priority, lines: [], ...(label ? { label } : {}) };
    sections.push(s);
    return s.lines;
  };

  // Note: the hidden marker (<!-- mergewatch-review -->) is prepended by
  // postReviewComment / updateReviewComment in github/client.ts — not here.

  // 1. Header — custom or default logo wordmark
  const header = section('header', KEEP);
  if (ux?.commentHeader) {
    // #369 — repo-controlled: renders as literal text, never live markup.
    header.push(escapeUserContent(ux.commentHeader));
  } else {
    header.push('<img src="https://raw.githubusercontent.com/mergewatch/mergewatch.ai/main/assets/mergewatch-wordmark.svg" alt="mergewatch" height="48" />');
  }
  header.push('');

  // 2. Work Done section (stats bar)
  if (workDone && (ux?.showWorkDone !== false)) {
    const work = section('work-done', 20, 'the work-done stats');
    const parts: string[] = [
      `**${workDone.filesScanned}** file${workDone.filesScanned !== 1 ? 's' : ''} scanned`,
      `**${workDone.linesScanned.toLocaleString()}** lines reviewed`,
      `**${workDone.agentsRan}** specialized agent${workDone.agentsRan !== 1 ? 's' : ''} ran`,
    ];
    if (workDone.hasDependencyFiles) {
      parts.push('dependency files detected');
    }
    work.push(`> ${parts.join(' \u00B7 ')}`);
    work.push('');
  }

  // 3. Delta strip (re-review progress)
  if (delta) {
    const deltaStrip = section('delta', KEEP);
    const deltaParts: string[] = [];
    if (delta.resolvedCount > 0) {
      deltaParts.push(`\u2705 **${delta.resolvedCount}** resolved`);
    }
    if (delta.newCount > 0) {
      deltaParts.push(`\uD83C\uDD95 **${delta.newCount}** new`);
    }
    if (delta.carriedOverCount > 0) {
      deltaParts.push(`\u27A1\uFE0F **${delta.carriedOverCount}** carried over`);
    }
    if (deltaParts.length > 0) {
      deltaStrip.push(`> ${deltaParts.join(' \u00B7 ')}`);
      deltaStrip.push('');
    }
  }

  // 3b. Delta caption — one-sentence "what changed on this commit" summary.
  // Only present on re-reviews where something actually shifted; the agent
  // returns null for first reviews and unchanged re-reviews.
  if (deltaCaption && deltaCaption.trim()) {
    const deltaCap = section('delta-caption', KEEP);
    deltaCap.push(`> 📝 ${deltaCaption.trim()}`);
    deltaCap.push('');
  }

  // 4. Merge readiness score — highly visible
  if (mergeScore != null) {
    const score = section('score', KEEP);
    const scoreDisplay = renderMergeScore(mergeScore);
    const reasonSuffix = mergeScoreReason ? ` \u2014 ${mergeScoreReason}` : '';
    score.push(`> ${scoreDisplay}${reasonSuffix}`);
    // FP-J L3 \u2014 dispute-rate disclosure renders as a quieter sub-line so the
    // primary verdict stays the most visible signal. Only emitted when the
    // reconcile pass identified at least one action finding from a
    // chronically-disputed category (>= 5 surfacings AND >= 75% dispute rate
    // over the 30d window). Omitted on the clean path.
    if (disputeDisclosure && disputeDisclosure.trim()) {
      score.push(`> <sub>\ud83d\udcca ${disputeDisclosure.trim()}</sub>`);
    }
    score.push('');
  }

  // 5. Diagram (moved up — appears right after merge score)
  if (diagram && showDiagram && isValidMermaidDiagram(diagram)) {
    const diagramSec = section('diagram', 10, 'the diagram');
    const captionText = diagramCaption ? `**Diagram** \u2014 ${diagramCaption}` : '**Diagram**';
    diagramSec.push(captionText);
    diagramSec.push('');
    diagramSec.push('```mermaid');
    diagramSec.push(diagram);
    diagramSec.push('```');
    diagramSec.push('');
  }

  // 6. Summary — inline 2-sentence prose (not collapsible)
  if (summary && showSummary) {
    const summarySec = section('summary', KEEP);
    summarySec.push(truncateSummary(summary));
    summarySec.push('');
  }

  // #240 — computed up front so the all-clear branches below can defer to
  // the "Unverified concerns" section instead of contradicting it.
  const unverifiedCriticalCount = findings.filter(
    (f) => f.severity === 'critical' && f.verification === 'unverified',
  ).length;

  // #240 — the all-clear celebration is only honest when nothing below will
  // render an unverified-concerns section. With unverified criticals present
  // the score is W7-clamped to advisory, so say that instead.
  const action = section('action-items', KEEP);
  const pushAllClearOrAdvisory = () => {
    if (unverifiedCriticalCount > 0) {
      action.push('No blocking issues \u2014 see unverified concerns below.');
      action.push('');
    // `?? 5` keeps callers that omit mergeScore on the pre-#385 behavior.
    } else if (findings.length === 0 && (mergeScore ?? 5) <= 3) {
      // #385 \u2014 an empty finding list is not always a clean bill of health. When
      // every finding the orchestrator raised was filtered away, the verdict is
      // clamped to advisory and its subtitle says so; celebrating "All clear!"
      // four lines under that subtitle contradicts it, and a reader who skims
      // to the body merges on the strength of the wrong half. Defer to the
      // verdict line rather than talking over it.
      action.push('Nothing rendered \u2014 see the verdict above before merging.');
      action.push('');
    } else if (ux?.allClearMessage !== false) {
      action.push('\uD83C\uDF89 **All clear!** No issues found \u2014 this PR looks good to go.');
      action.push('');
    } else {
      action.push('No issues found \u2014 looking good! \u2705');
    }
  };

  // 7. Action items — critical + warning findings as checkboxes (single appearance)
  // FP-L — unverified criticals are excluded from the action-items table. They
  // render below under "Unverified concerns" instead, so the top-of-comment
  // "Requires your attention" surface stays aligned with the W7-clamped score.
  // #469 — evidence is a trust surface: on unless a repo opts out.
  const showEvidence = ux?.showEvidence !== false;

  const grouped = groupBySeverity(findings);
  const actionFindings = findings.filter((f) => {
    if (f.severity === 'warning') return true;
    if (f.severity === 'critical' && f.verification !== 'unverified') return true;
    return false;
  });
  const infoFindings = grouped.get('info') ?? [];

  if (findings.length === 0) {
    pushAllClearOrAdvisory();
  } else if (!showIssuesTable) {
    action.push(`${findings.length} issue${findings.length !== 1 ? 's' : ''} found.`);
  } else if (actionFindings.length > 0) {
    action.push('#### Requires your attention');
    action.push('');
    action.push('| | Location | Finding |');
    action.push('|---|---|---|');
    for (const f of actionFindings) {
      const emoji = f.severity === 'critical' ? '\uD83D\uDD34' : '\u26A0\uFE0F';
      const shortFile = shortenPath(f.file);
      action.push(`| ${emoji} | \`${shortFile}:${f.line}\` | ${f.title} |`);
    }
    action.push('');
  } else {
    // No action items (info-only, or #240: only unverified criticals) —
    // all-clear, unless unverified concerns render below.
    pushAllClearOrAdvisory();
  }

  // 8. Detailed findings — critical uncollapsed, warning/info collapsed
  if (showIssuesTable && findings.length > 0) {
    const allCriticals = grouped.get('critical') ?? [];
    // FP-L — split criticals on verification. Verified criticals keep the
    // 🔴 Critical header; unverified criticals render in a separate advisory
    // sub-section so the visual hierarchy matches the W7-clamped merge score.
    const criticalFindings = allCriticals.filter((f) => f.verification !== 'unverified');
    const unverifiedCriticals = allCriticals.filter((f) => f.verification === 'unverified');
    const warningFindings = grouped.get('warning') ?? [];

    // Critical (verified only) — shown open (not collapsed)
    if (criticalFindings.length > 0) {
      const crit = section('critical', KEEP);
      crit.push(`### ${SEVERITY_META.critical.emoji} Critical (${criticalFindings.length})`);
      for (const f of criticalFindings) {
        crit.push(renderFinding(f, showConfidence, showEvidence));
      }
      crit.push('');
    }

    // FP-L — Unverified concerns (advisory). Only emitted when at least one
    // unverified critical exists; otherwise the sub-section is omitted entirely
    // so there's no empty header on the clean path.
    if (unverifiedCriticals.length > 0) {
      const unver = section('unverified', KEEP);
      unver.push(`### ⚠️ Unverified concerns (${unverifiedCriticals.length})`);
      unver.push(
        "> The verifier couldn't confirm these against the source. Review carefully; the PR is not blocked on them.",
      );
      unver.push('');
      for (const f of unverifiedCriticals) {
        unver.push(renderFinding(f, showConfidence, showEvidence));
      }
      unver.push('');
    }

    // Warning — collapsed
    if (warningFindings.length > 0) {
      const warn = section('warnings', 50, `${warningFindings.length} warning detail${warningFindings.length !== 1 ? 's' : ''}`);
      warn.push(`<details><summary>${SEVERITY_META.warning.emoji} Warnings (${warningFindings.length})</summary>`);
      warn.push('');
      for (const f of warningFindings) {
        warn.push(renderFinding(f, showConfidence, showEvidence));
      }
      warn.push('');
      warn.push('</details>');
      warn.push('');
    }

    // Info — collapsed
    if (infoFindings.length > 0) {
      const info = section('info', 40, `${infoFindings.length} info finding${infoFindings.length !== 1 ? 's' : ''}`);
      info.push(`<details><summary>${SEVERITY_META.info.emoji} Info (${infoFindings.length})</summary>`);
      info.push('');
      for (const f of infoFindings) {
        info.push(renderFinding(f, showConfidence, showEvidence));
      }
      info.push('');
      info.push('</details>');
      info.push('');
    }
  }

  // 8b. Previously reported findings (collapsed) — resolved + carried-over
  // audit trail so authors can see what carried across and what was dropped
  // without cluttering the primary findings list.
  if (delta && (delta.resolved.length > 0 || delta.carriedOver.length > 0)) {
    const prev = section('previously-reported', 30, `the previously reported list (${delta.resolved.length + delta.carriedOver.length})`);
    const prevTotal = delta.resolved.length + delta.carriedOver.length;
    prev.push(`<details><summary>\uD83D\uDCCE Previously reported findings \u2014 ${prevTotal}</summary>`);
    prev.push('');
    if (delta.resolved.length > 0) {
      prev.push(`**\u2705 Resolved on this commit (${delta.resolved.length})**`);
      prev.push('');
      for (const f of delta.resolved) {
        prev.push(`- \`${f.file}:${f.line}\` — ${f.title}`);
      }
      prev.push('');
    }
    if (delta.carriedOver.length > 0) {
      prev.push(`**\u21BB Still present (${delta.carriedOver.length})**`);
      prev.push('');
      for (const f of delta.carriedOver) {
        prev.push(`- \`${f.file}:${f.line}\` — ${f.title}`);
      }
      prev.push('');
    }
    prev.push('</details>');
    prev.push('');
  }

  // 9. Review details drawer — collapsed: model, time, tokens, cost, suppressed
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  const hasSuppressed = (suppressedCount ?? 0) > 0 && (ux?.showSuppressedCount !== false);
  const hasParseFailures = (parseFailureCount ?? 0) > 0;
  const hasDegenerate = (degenerateResponseCount ?? 0) > 0;
  const hasDetails = totalTokens > 0 || durationMs != null || model || hasSuppressed || hasParseFailures || hasDegenerate || !!conventionsSource;
  if (hasDetails) {
    const details = section('details', KEEP);
    const detailParts: string[] = [];
    if (totalTokens > 0) {
      detailParts.push(`${totalTokens.toLocaleString()} tokens`);
    }
    if (cumulativeCostUsd != null && cumulativeCostUsd > 0) {
      detailParts.push(`~$${cumulativeCostUsd.toFixed(4)}`);
    } else if (estimatedCostUsd != null && estimatedCostUsd > 0) {
      detailParts.push(`~$${estimatedCostUsd.toFixed(4)}`);
    }
    if (durationMs != null) {
      detailParts.push(`${(durationMs / 1000).toFixed(1)}s`);
    }
    details.push(`<details><summary>\u2139\uFE0F Review details${detailParts.length > 0 ? ` \u2014 ${detailParts.join(' \u00B7 ')}` : ''}</summary>`);
    details.push('');
    details.push('| | |');
    details.push('|---|---|');
    if (model) {
      details.push(`| **Model** | ${model} |`);
    }
    if (durationMs != null) {
      details.push(`| **Review time** | ${(durationMs / 1000).toFixed(1)}s |`);
    }
    if (totalTokens > 0) {
      details.push(`| **Tokens** | ${(inputTokens ?? 0).toLocaleString()} in · ${(outputTokens ?? 0).toLocaleString()} out · ${totalTokens.toLocaleString()} total |`);
    }
    if (estimatedCostUsd != null && estimatedCostUsd > 0) {
      if (cumulativeCostUsd != null && cumulativeCostUsd > estimatedCostUsd) {
        details.push(`| **Est. cost** | ~$${estimatedCostUsd.toFixed(4)} this run · ~$${cumulativeCostUsd.toFixed(4)} total for PR (LLM only) |`);
      } else {
        details.push(`| **Est. cost** | ~$${estimatedCostUsd.toFixed(4)} (LLM only) |`);
      }
    }
    if (hasSuppressed) {
      details.push(`| **Suppressed** | ${suppressedCount} finding${suppressedCount !== 1 ? 's' : ''} removed by dedup & quality filters |`);
    }
    if (hasParseFailures) {
      details.push(`| **\u26A0\uFE0F Unparsed agent output** | ${parseFailureCount} agent response${parseFailureCount !== 1 ? 's' : ''} could not be parsed \u2014 findings may be missing from this review |`);
    }
    if (hasDegenerate) {
      // #401 — distinct from an unparsed response: this one parsed cleanly and
      // would otherwise have been reported as ordinary suppression.
      details.push(`| **\u26A0\uFE0F Malformed agent output** | ${degenerateResponseCount} agent response${degenerateResponseCount !== 1 ? 's' : ''} returned unusable findings \u2014 findings may be missing from this review |`);
    }
    if (conventionsSource) {
      const suffix = conventionsTruncated ? ' (truncated)' : '';
      details.push(`| **Conventions** | Loaded from \`${conventionsSource}\`${suffix} |`);
    }
    details.push('');
    details.push('</details>');
    details.push('');
  }

  // 10. Dashboard link + custom footer — compact, no horizontal rule
  const footer = section('footer', KEEP);
  // #195 Phase 4 — one-click satisfaction prompt. The review path polls these
  // 👍/👎 reactions on the summary comment into the engagement rollup
  // (helpful-rate KPI). Rendered above the footer link as a call-to-action.
  if (showHelpfulPrompt) {
    footer.push('<sub>Was this review helpful? React with 👍 or 👎 on this comment.</sub>');
  }

  const footerParts: string[] = [];
  if (reviewDetailUrl) {
    footerParts.push(`[View full details](${reviewDetailUrl})`);
  }
  if (commentFooter) {
    // #369 — installation-controlled: same escaping contract as the header.
    footerParts.push(escapeUserContent(commentFooter));
  }
  if (footerParts.length > 0) {
    footer.push(`<sub>${footerParts.join(' \u00B7 ')}</sub>`);
  }

  return fitSections(sections, COMMENT_BODY_BUDGET, reviewDetailUrl);
}
