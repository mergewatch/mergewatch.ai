/**
 * FB-A / FB-B — write fan-out for FindingDispositionRecord.
 *
 * Both handlers (server + lambda) call the same helpers below after the
 * review pipeline runs and after triage / inline-resolve persists, so the
 * counter semantics stay identical across deployment shapes.
 *
 * Best-effort by design: every helper catches and logs (the store
 * implementations also catch internally — this is belt-and-braces). A
 * disposition write must never block a review.
 *
 * Idempotency: counters are monotonic; each helper call corresponds to one
 * "event". Callers should not loop the same event with the same key set.
 */

import type { IFindingDispositionStore } from '../storage/types.js';
import type { OrchestratedFinding, PreviousFinding } from '../agents/reviewer.js';
import { findingMatchKeys, fingerprintFromCode } from '../review-delta.js';
import { extractSignificantTokens } from '../finding-clustering.js';
import { INLINE_BOT_COMMENT_MARKER, extractInlineCommentTitle } from '../github/client.js';
import type { Octokit } from '@octokit/rest';

/**
 * FB-A — record one surfacing per finding. Writes one upsertSurface call per
 * key returned by `findingMatchKeys(finding)` (typically 2: a title key
 * plus a fingerprint key when one is available). The cluster step in FB-E
 * merges sibling rows by sigTokens overlap.
 *
 * Also writes the W2 verification counter when the finding carries a
 * `verification` tag (`verified` → incrementVerified; `unverified` →
 * incrementUnverified). The same fan-out per match-key.
 */
export async function recordFindingSurfacings(
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  findings: OrchestratedFinding[],
  nowIso: string,
): Promise<void> {
  if (!store || installationId == null) return;
  const inst = String(installationId);
  for (const f of findings) {
    const keys = findingMatchKeys(f);
    const attribution = {
      // OrchestratedFinding's `category` field carries values like
      // 'security' / 'bug' / 'style' / etc. as set by the agent prompts.
      // Pass it through verbatim; the store accepts the wider union and
      // narrows via the `FindingDispositionRecord['category']` type at
      // read time.
      ...(f.category ? { category: f.category as never } : {}),
      // FB-I — severity drives the severity-shopping detector rollup. Pass
      // it through so the store records the bucket; missing values flow as
      // 'uncategorized' downstream (rollup defaults).
      ...(f.severity ? { severity: f.severity } : {}),
      // Best-effort token bag — falls back to title-only if description
      // is empty. extractSignificantTokens strips stop-words for us; the
      // Array.from + slice trims to a reasonable cap (W10 clusters are
      // tight, more than ~16 tokens is just noise).
      sigTokens: Array.from(extractSignificantTokens(`${f.title} ${f.description ?? ''}`)).slice(0, 16),
    };
    for (const key of keys) {
      // Fire-and-await; per-call error swallow lives inside the store. We
      // sequence (not Promise.all) so a single store hiccup doesn't bury
      // the rest of the writes in one rejected promise.
      try {
        await store.upsertSurface(inst, repoFullName, key, nowIso, attribution);
        if (f.verification === 'verified') {
          await store.incrementVerified(inst, repoFullName, key);
        } else if (f.verification === 'unverified') {
          await store.incrementUnverified(inst, repoFullName, key);
        }
      } catch (err) {
        // Defense in depth — the store layer already catches; this is the
        // umbrella around the entire (upsert + verify) sequence for this key.
        console.warn('[fb-a] recordFindingSurfacings: write failed for %s', key, err);
      }
    }
  }
}

/**
 * FB-A — record one dispute per key. Used for both:
 *   • W3 disputedKeys (from `## mergewatch triage` mapping)
 *   • FP-F inline-resolve match keys
 *
 * Idempotency note: this MAY double-count when the same dispute arrives via
 * two channels (e.g. author rebutted via triage AND clicked /resolve on
 * the inline thread). We accept the rare double-count rather than maintain
 * an event-source table to dedupe — analytically a "double-disputed"
 * finding is still a strong FP signal, so the bias is in the safe direction.
 */
export async function recordDisputes(
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  matchKeys: readonly string[],
): Promise<void> {
  if (!store || installationId == null || matchKeys.length === 0) return;
  const inst = String(installationId);
  for (const key of matchKeys) {
    try {
      await store.incrementDispute(inst, repoFullName, key);
    } catch (err) {
      console.warn('[fb-a] recordDisputes: write failed for %s', key, err);
    }
  }
}

// ─── FB-B — quiet-drop derived counter ─────────────────────────────────────

/**
 * Detect quiet drops: findings that were present in the prior review,
 * are NOT present in the current review, AND whose cited code was not
 * changed by this PR. A strong implicit FP signal — the orchestrator
 * looked at the same code with the same prior context and chose to
 * drop the finding without the code itself moving.
 *
 * Definition of "code didn't change" — the prior finding's `line` is NOT
 * in `changedLines.get(file)`. We deliberately don't require the file to
 * be in the diff at all; even on a re-review of an unchanged file the
 * orchestrator has the previous finding in its prompt via
 * `buildPreviousFindingsBlock` and choosing to drop it counts.
 *
 * Returns the subset of `priorFindings` that meet all three conditions.
 * Stable per-finding identity uses `findingMatchKeys` (title key always,
 * fingerprint key when available) — same as W3 / FP-F.
 */
export function detectQuietDrops(
  currentFindings: readonly OrchestratedFinding[],
  priorFindings: readonly PreviousFinding[],
  changedLines: Map<string, Set<number>> | undefined,
): PreviousFinding[] {
  if (priorFindings.length === 0) return [];
  // Defensive: when the pipeline didn't return changedLines (older mocks,
  // legacy callers), conservatively report NO quiet drops. Better to under-
  // count silentDrop signal than to false-positive on a "this finding
  // vanished" without proof the cited code was untouched.
  if (!changedLines) return [];

  // Build a set of EVERY key any current finding carries, so the resolved-
  // set check below uses the same union-matching W3 / FP-F use.
  const currentKeySet = new Set<string>();
  for (const f of currentFindings) {
    for (const k of findingMatchKeys(f)) currentKeySet.add(k);
  }

  const quietDrops: PreviousFinding[] = [];
  for (const p of priorFindings) {
    const priorKeys = findingMatchKeys(p);
    // Still present (under any of its keys)? Not a drop at all.
    if (priorKeys.some((k) => currentKeySet.has(k))) continue;

    // Was the cited code touched on this commit? If yes → legitimate
    // resolve via code change. If no → quiet drop.
    const fileChanges = changedLines.get(p.file);
    const lineChanged = fileChanges?.has(p.line) ?? false;
    if (lineChanged) continue;

    quietDrops.push(p);
  }
  return quietDrops;
}

/**
 * FB-B — record one silentDropCount increment per match key of each quiet-
 * dropped finding.
 */
export async function recordQuietDrops(
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  quietDrops: readonly PreviousFinding[],
): Promise<void> {
  if (!store || installationId == null || quietDrops.length === 0) return;
  const inst = String(installationId);
  for (const p of quietDrops) {
    for (const key of findingMatchKeys(p)) {
      try {
        await store.incrementSilentDrop(inst, repoFullName, key);
      } catch (err) {
        console.warn('[fb-b] recordQuietDrops: write failed for %s', key, err);
      }
    }
  }
}

// ─── FB-C — inline-comment reactions → disputes / agreements ───────────────

/**
 * GitHub reaction content types we map onto FindingDispositionRecord counters.
 *   - `-1` (👎) / `confused` (🤔)      → disputeCount
 *   - `+1` (👍) / `heart` (❤️) / `rocket` (🚀) → agreementCount
 *
 * `eyes` (👀) is filtered out — the bot itself uses it as the "I'm
 * looking at it" read-receipt on inline-reply threads, and a user 👀
 * is ambiguous (interest, not agreement/disagreement).
 *
 * `laugh` (😄) and `hooray` (🎉) are also ignored; they're celebratory
 * but don't cleanly express agreement with a *finding*.
 */
const REACTION_DISPUTE_TYPES = ['-1', 'confused'] as const;
const REACTION_AGREEMENT_TYPES = ['+1', 'heart', 'rocket'] as const;
const REACTION_TRACKED_TYPES = [...REACTION_DISPUTE_TYPES, ...REACTION_AGREEMENT_TYPES] as readonly string[];

/** Per-reaction-type count summary as GitHub returns it in the listReviewComments payload. */
type ReactionCounts = Record<string, number>;

interface InlineCommentForReactionPoll {
  id: number;
  body: string;
  path?: string;
  reactions?: ReactionCounts | null;
  /** GitHub user type: 'Bot' for the bot's own comments; we keep only those. */
  userType?: string | null;
}

/**
 * FB-C — poll reaction counts on every MergeWatch inline comment on a PR,
 * compute the delta vs the prior snapshot, and emit dispute/agreement
 * increments on the corresponding `FindingDispositionRecord`s.
 *
 * Why polling: GitHub does NOT emit a webhook event for reactions added
 * to a review comment. The cheapest reliable capture is to fold a single
 * `pulls.listReviewComments` call into the existing post-pipeline path —
 * the summary `reactions` field on each comment already carries per-type
 * counts, so no extra per-comment API calls are needed.
 *
 * Counters are monotonic — we never decrement on reaction removal. The
 * snapshot prevents double-counting on subsequent polls: only positive
 * deltas vs the prior snapshot turn into increments.
 *
 * Returns the new snapshot for the caller to persist on the latest review
 * record. When no FindingDispositionStore is provided (back-compat path
 * with the analytics layer not yet wired), returns an empty snapshot and
 * skips the writes — same fail-safe shape as the other FB-A helpers.
 */
export async function pollAndRecordInlineReactions(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  prevSnapshot: Record<string, Record<string, number>> | undefined,
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
): Promise<Record<string, Record<string, number>>> {
  const newSnapshot: Record<string, Record<string, number>> = {};
  if (!store || installationId == null) return newSnapshot;

  // Single API call, listing every review comment on the PR. The summary
  // `reactions` field on each comment gives per-type counts directly —
  // no per-comment reaction-list call needed.
  let comments: InlineCommentForReactionPoll[];
  try {
    const { data } = await octokit.pulls.listReviewComments({
      owner, repo, pull_number: prNumber, per_page: 100,
    });
    comments = (data as Array<Record<string, unknown>>).map((c) => ({
      id: Number(c.id),
      body: String(c.body ?? ''),
      path: typeof c.path === 'string' ? c.path : undefined,
      reactions: (c.reactions as ReactionCounts | undefined) ?? null,
      userType: (c.user as Record<string, unknown> | undefined)?.type as string | undefined,
    }));
  } catch (err) {
    console.warn('[fb-c] failed to list review comments for %s/%s#%d:', owner, repo, prNumber, err);
    return newSnapshot;
  }

  const inst = String(installationId);
  // Collect every increment operation across all comments, all types, all
  // deltas, all match-keys into a single Promise.allSettled batch. Three
  // wins over the prior per-call sequential `await + catch + continue`:
  //   1. Parallel I/O (cheap but real on large reaction-active PRs).
  //   2. One greppable failure-summary log line per poll instead of N
  //      individual warns scrolling past in CloudWatch.
  //   3. Matches the same shape as the FB-D appendRejectReason batch in
  //      both handlers (review-processor.ts + review-agent.ts) — one
  //      pattern for "best-effort fan-out of analytics writes".
  const incrementOps: Promise<void>[] = [];
  for (const c of comments) {
    // Restrict to MergeWatch inline findings: bot-authored AND carrying
    // the inline marker. Same guard the inline-reply path uses (so
    // CopilotAI / dependabot / human review comments don't sneak in).
    if (c.userType !== 'Bot') continue;
    if (!c.body.includes(INLINE_BOT_COMMENT_MARKER)) continue;
    if (!c.reactions) continue;

    // Capture current counts for the next-poll baseline regardless of
    // whether we can derive match keys (the snapshot is keyed by
    // commentId; key-derivation failure shouldn't drop us out of sync).
    const currentForComment: Record<string, number> = {};
    for (const type of REACTION_TRACKED_TYPES) {
      const n = Number(c.reactions[type] ?? 0);
      if (n > 0) currentForComment[type] = n;
    }
    newSnapshot[String(c.id)] = currentForComment;

    // Recover the finding's stable identity keys. Same shape as
    // FP-F's deriveResolvedFindingKeys (path + extracted title).
    if (!c.path) continue;
    const title = extractInlineCommentTitle(c.body);
    if (!title) continue;
    const matchKeys = findingMatchKeys({ file: c.path, line: 0, title });

    const prior = prevSnapshot?.[String(c.id)] ?? {};
    for (const type of REACTION_TRACKED_TYPES) {
      const now = currentForComment[type] ?? 0;
      const before = Number(prior[type] ?? 0);
      const delta = now - before;
      if (delta <= 0) continue; // monotonic: ignore removals
      const isDispute = (REACTION_DISPUTE_TYPES as readonly string[]).includes(type);
      const increment = isDispute
        ? store.incrementDispute.bind(store)
        : store.incrementAgreement.bind(store);
      // Queue up `delta` increments fanned out across the finding's match
      // keys (typically 2: title + fingerprint). Counter writes are
      // idempotent at the wire level so the parallel-batch shape is safe;
      // the store layer's internal try/catch handles per-call failures.
      for (let i = 0; i < delta; i++) {
        for (const key of matchKeys) {
          incrementOps.push(increment(inst, repoFullName, key));
        }
      }
    }
  }

  // Single batch + single failure-summary log line. Best-effort —
  // counters never block the review and rejections still get the
  // verified snapshot return value below.
  if (incrementOps.length > 0) {
    const settled = await Promise.allSettled(incrementOps);
    const failed = settled.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      console.warn(
        '[fb-c] %d/%d reaction increment write(s) failed on %s',
        failed, settled.length, repoFullName,
      );
    }
  }

  return newSnapshot;
}

// Re-exported so external callers don't need to dip into review-delta.js
// just to inspect the same helper the writers use.
export { fingerprintFromCode };
