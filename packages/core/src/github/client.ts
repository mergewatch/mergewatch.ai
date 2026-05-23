/**
 * GitHub API client for MergeWatch.
 *
 * This module handles:
 *  1. Fetching PR diffs and metadata.
 *  2. Creating, updating, and finding MergeWatch review comments.
 *
 * Authentication is handled externally via IGitHubAuthProvider — this module
 * only contains portable Octokit operations that work with any auth strategy.
 */

import { Octokit } from "@octokit/rest";
import yaml from 'js-yaml';
import type { PRContext } from "../types/github.js";
import type {
  MergeWatchConfig,
  CustomAgentDef,
  UXConfig,
  RulesConfig,
  AgentReviewConfig,
  AgentReviewDetectionConfig,
  PassThreshold,
} from '../config/defaults.js';
import { PASS_THRESHOLDS } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HTML comment injected at the top of every MergeWatch review comment.
 * Used as a stable marker to locate an existing bot comment on a PR.
 */
export const BOT_COMMENT_MARKER = "<!-- mergewatch-review -->";

/**
 * HTML comment injected at the top of every MergeWatch inline review comment.
 * Used by the inline-reply flow to verify a thread is rooted in a comment we
 * authored — so we never barge into threads started by CopilotAI, dependabot,
 * or any other reviewer bot. The marker is invisible to humans in the GitHub
 * UI but reliably distinguishes our inline findings from third-party ones,
 * regardless of the App name (SaaS or self-hosted).
 */
export const INLINE_BOT_COMMENT_MARKER = "<!-- mergewatch-inline -->";

// ---------------------------------------------------------------------------
// PR data fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the unified diff for a pull request.
 *
 * We request the diff via the GitHub API using the `application/vnd.github.v3.diff`
 * media type, which returns a plain-text unified diff — the same format you
 * would get from `git diff`.
 *
 * @returns The full diff as a string.
 */
export async function getPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  // When the diff media type is requested, `data` comes back as a raw string
  // even though the TypeScript type says otherwise.
  return data as unknown as string;
}

/**
 * Fetch high-level context about a pull request: title, description,
 * base/head branches, and the list of changed file paths.
 *
 * This is used by the review agent to understand *what* the PR is about
 * before it dives into the diff.
 */
export async function getPRContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRContext> {
  // Fetch the PR metadata and the list of changed files in parallel.
  // GitHub caps listFiles at 100 per page, so paginate to get all files.
  const [pr, files] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 }),
  ]);
  return {
    owner,
    repo,
    prNumber,
    title: pr.data.title,
    description: pr.data.body,
    baseBranch: pr.data.base.ref,
    headBranch: pr.data.head.ref,
    headSha: pr.data.head.sha,
    prAuthor: pr.data.user?.login,
    prAuthorAvatar: pr.data.user?.avatar_url,
    files: files.map((f) => f.filename),
    totalAdditions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
    totalDeletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * Add a reaction to a PR (which is an issue in GitHub's API).
 * Used to signal review start (eyes) and completion (thumbs up).
 *
 * Returns the reaction ID so callers can later remove it (e.g. clearing the
 * "eyes" reaction once the review completes). Returns null when the request
 * fails — reactions are non-critical and never block a review.
 */
export async function addPRReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
): Promise<number | null> {
  try {
    const { data } = await octokit.reactions.createForIssue({
      owner,
      repo,
      issue_number: prNumber,
      content: reaction,
    });
    return data.id;
  } catch (err) {
    // Non-critical — don't fail the review if reaction fails
    console.warn('Failed to add %s reaction to %s/%s#%d:', reaction, owner, repo, prNumber, err);
    return null;
  }
}

/**
 * Remove a previously-added reaction from a PR. Used to clear the eyes
 * reaction once review completes, so the PR doesn't stay in a "MergeWatch
 * is still looking" state forever.
 */
export async function removePRReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reactionId: number,
): Promise<void> {
  try {
    await octokit.reactions.deleteForIssue({
      owner,
      repo,
      issue_number: prNumber,
      reaction_id: reactionId,
    });
  } catch (err) {
    console.warn('Failed to remove reaction %d from %s/%s#%d:', reactionId, owner, repo, prNumber, err);
  }
}

// ---------------------------------------------------------------------------
// Comment management
// ---------------------------------------------------------------------------

/**
 * Post a new review comment on a pull request.
 *
 * The comment body is always prefixed with {@link BOT_COMMENT_MARKER} so
 * we can locate it later via {@link findExistingBotComment}.
 *
 * @returns The numeric ID of the newly created comment.
 */
export async function postReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<number> {
  const markedBody = `${BOT_COMMENT_MARKER}\n${body}`;

  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: markedBody,
  });

  return data.id;
}

/**
 * Update an existing review comment in-place.
 *
 * This is called when a `synchronize` event fires on a PR that already has
 * a MergeWatch comment — we edit the comment rather than posting a new one
 * to keep the PR timeline clean.
 *
 * @param commentId - The numeric ID of the comment to update.
 * @param body      - The new body (the marker is prepended automatically).
 */
export async function updateReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<void> {
  const markedBody = `${BOT_COMMENT_MARKER}\n${body}`;

  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: markedBody,
  });
}

/**
 * Search for an existing MergeWatch review comment on a pull request.
 *
 * We paginate through all issue comments and look for our
 * {@link BOT_COMMENT_MARKER} HTML comment in the body. Returns the comment
 * ID if found, or `null` if MergeWatch hasn't commented yet.
 */
export async function findExistingBotComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  const iterator = octokit.paginate.iterator(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  for await (const { data: comments } of iterator) {
    for (const comment of comments) {
      if (comment.body?.includes(BOT_COMMENT_MARKER)) {
        return comment.id;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reactions on comments
// ---------------------------------------------------------------------------

/**
 * Fetch reaction counts on a specific comment.
 * Returns a map of reaction type → count.
 */
export async function getCommentReactions(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
): Promise<Record<string, number>> {
  try {
    const { data: comment } = await octokit.issues.getComment({
      owner,
      repo,
      comment_id: commentId,
    });

    const reactions = comment.reactions;
    if (!reactions) return {};

    const counts: Record<string, number> = {};
    const keys = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'] as const;
    for (const key of keys) {
      const val = (reactions as Record<string, unknown>)[key];
      if (typeof val === 'number' && val > 0) {
        counts[key] = val;
      }
    }
    return counts;
  } catch (err) {
    console.warn('Failed to fetch reactions for comment %d:', commentId, err);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Check runs (status checks)
// ---------------------------------------------------------------------------

/**
 * Check Run name reported to GitHub. Also used by the webhook handler to
 * identify MergeWatch check runs in check_run.rerequested events so the
 * native "Re-run" button in the PR Checks UI triggers a fresh review.
 */
export const MERGEWATCH_CHECK_RUN_NAME = 'MergeWatch Review';

/**
 * Create or update a GitHub Check Run on a specific commit.
 *
 * Used to show pass/fail status directly in the PR merge box.
 * Call once with status "in_progress" when the review starts,
 * then again with status "completed" + conclusion when done.
 */
export async function createCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  params: {
    status: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'neutral' | 'action_required';
    title: string;
    summary: string;
    detailsUrl?: string;
  },
): Promise<void> {
  try {
    await octokit.checks.create({
      owner,
      repo,
      head_sha: headSha,
      name: MERGEWATCH_CHECK_RUN_NAME,
      status: params.status,
      ...(params.conclusion && { conclusion: params.conclusion }),
      ...(params.detailsUrl && { details_url: params.detailsUrl }),
      output: {
        title: params.title,
        summary: params.summary,
      },
    });
  } catch (err) {
    // Non-critical — don't fail the review if the check run fails.
    console.warn('Failed to create check run for %s/%s@%s:', owner, repo, headSha, err);
  }
}

// ---------------------------------------------------------------------------
// PR Reviews API
// ---------------------------------------------------------------------------

/**
 * Map a merge readiness score (1–5) to a GitHub review event type.
 *
 *  1-2 → REQUEST_CHANGES (critical issues)
 *  3   → COMMENT (feedback without blocking)
 *  4-5 → APPROVE (looks good)
 */
export function mergeScoreToReviewEvent(
  mergeScore: number,
): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  if (mergeScore >= 4) return 'APPROVE';
  if (mergeScore <= 2) return 'REQUEST_CHANGES';
  return 'COMMENT';
}

/**
 * Submit a PR review with a short verdict and optionally batched inline
 * comments on critical findings. The full review lives in the paired
 * issue comment. Batching all inline comments in one API call means
 * GitHub sends only 1 notification.
 */
export async function submitPRReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  comments?: Array<{ path: string; line: number; side: string; body: string }>,
): Promise<void> {
  // W6 — single authoritative review comment. The paired upserted issue
  // comment (carrying `BOT_COMMENT_MARKER`) is the canonical place for the
  // verdict, findings, diagram, etc. The formal PR Review object only
  // exists to carry (a) the APPROVE / REQUEST_CHANGES / COMMENT event and
  // (b) the inline comments. Its body should add NO duplicate content.
  //
  // GitHub's API constraints differ by event:
  //   - APPROVE        → body is optional. Omit the field entirely.
  //   - REQUEST_CHANGES / COMMENT → body is REQUIRED. We pass an HTML-
  //     comment-only stub (`<!-- mergewatch-review -->`); GitHub's markdown
  //     renderer strips HTML comments, so the Review object renders with
  //     no visible body text and the timeline shows only the event label
  //     ("requested changes" / "left a comment") plus the inline comments.
  //
  // A caller may still pass real body text — we pass it through unchanged
  // for forward-compatibility (e.g., a future tier that genuinely wants a
  // verbatim Review body).
  const trimmed = (body ?? '').trim();
  let effectiveBody: string | undefined;
  if (trimmed) {
    effectiveBody = body;
  } else if (event === 'APPROVE') {
    effectiveBody = undefined;
  } else {
    effectiveBody = '<!-- mergewatch-review -->';
  }

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    ...(effectiveBody === undefined ? {} : { body: effectiveBody }),
    event,
    ...(comments && comments.length > 0 ? { comments } : {}),
  });
}

/**
 * Post a single inline comment on a PR without wrapping it in a formal
 * Review. Used when the merge-readiness verdict doesn't warrant an APPROVE
 * (score 1-3) — we still want to surface per-line findings, but submitting
 * a REQUEST_CHANGES / COMMENT Review would post the noisy verdict body that
 * GitHub's API forces for those states.
 *
 * Each call creates a top-level inline comment thread on the Files Changed
 * tab. Reviewers see the comment in the same place they'd see Review-bundled
 * inline comments; the only difference is that it's not grouped under a
 * Review header.
 */
export async function createStandaloneReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  comment: { path: string; line: number; side: string; body: string; commitId: string },
): Promise<void> {
  await octokit.pulls.createReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: comment.commitId,
    path: comment.path,
    line: comment.line,
    side: comment.side as 'LEFT' | 'RIGHT',
    body: comment.body,
  });
}

// ---------------------------------------------------------------------------
// Hybrid review helpers
// ---------------------------------------------------------------------------

interface InlineCommentCandidate {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  suggestion: string;
  /**
   * FP-L — W2 verification verdict. When `'unverified'` the finding is dropped
   * from the inline-comment surface entirely (it still appears in the top-level
   * review comment under "Unverified concerns"). Absent → treated as a pre-W2
   * record and surfaces normally for back-compat.
   */
  verification?: 'verified' | 'unverified';
}

/**
 * Build inline review comments from critical findings on changed files.
 *
 * Only critical-severity findings whose file is in the changed file list
 * become inline comments. All are batched in a single createReview call
 * so GitHub sends only one notification.
 *
 * FP-L — unverified criticals (W2 couldn't confirm the defect) are skipped
 * here so the most-disruptive surface (inline red-emoji comment at the cited
 * line) doesn't fire on advisory-confidence findings. They still render in
 * the top-level review comment under the "Unverified concerns" sub-section.
 */
export function buildInlineComments(
  findings: InlineCommentCandidate[],
  changedFiles: string[],
  changedLines?: Map<string, Set<number>>,
): Array<{ path: string; line: number; side: string; body: string }> {
  const changedSet = new Set(changedFiles);

  return findings
    .filter((f) => {
      if (f.severity !== 'critical' || !changedSet.has(f.file) || f.line <= 0) return false;
      // FP-L — unverified criticals are demoted off the inline-comment surface.
      // They still appear in the top-level review body under "Unverified
      // concerns" so the finding isn't lost — just no inline red marker.
      if (f.verification === 'unverified') return false;
      // When changedLines is available, require line to be exactly on a changed line
      if (changedLines) {
        const fileLines = changedLines.get(f.file);
        if (!fileLines || !fileLines.has(f.line)) return false;
      }
      return true;
    })
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: `${INLINE_BOT_COMMENT_MARKER}\n**🔴 ${f.title}**\n\n${f.description}${f.suggestion ? `\n\n> **Suggestion:** ${f.suggestion}` : ''}`,
    }));
}

const INLINE_TITLE_REGEX = /\*\*🔴 (.+?)\*\*/;

/**
 * Extract the plain finding title from an inline comment body.
 * Returns the title string, or empty string if the format doesn't match.
 */
export function extractInlineCommentTitle(body: string): string {
  return body.match(INLINE_TITLE_REGEX)?.[1] ?? '';
}

/**
 * Dismiss any existing bot reviews on a PR so they don't conflict
 * with a new review on a later commit.
 *
 * Called on `synchronize` events before submitting a fresh review.
 */
export async function dismissStaleReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const reviews = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
  });

  for (const review of reviews.data) {
    if (review.user?.type === 'Bot' && review.state !== 'DISMISSED') {
      await octokit.pulls.dismissReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: review.id,
        message: 'Superseded by new review on latest commit.',
      }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Reply comments (for conversational responses)
// ---------------------------------------------------------------------------

/**
 * Post a reply comment on a PR (without the bot marker).
 * Used for conversational follow-up responses, not review comments.
 */
export async function postReplyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

// ---------------------------------------------------------------------------
// Inline review comment operations (for threaded reply conversations)
// ---------------------------------------------------------------------------

/** A single inline review comment in a thread. */
export interface ReviewThreadComment {
  id: number;
  body: string;
  authorLogin: string;
  isBot: boolean;
  createdAt: string;
  inReplyToId?: number;
  /**
   * File path this inline comment is anchored to (the `path` field on
   * GitHub's review-comment object). Present on review-comment threads;
   * absent on PR-level threads / older callers that pre-date FP-F.
   * Used by `handleInlineReply` to derive the resolved finding's
   * `findingMatchKeys` for the inline-resolve memory.
   */
  path?: string;
}

/**
 * Fetch the review-comment thread containing a given leaf comment and return
 * it in chronological order (oldest first).
 *
 * GitHub's REST API returns review comments flat — threads are an emergent
 * property of `in_reply_to_id` parent pointers. Replies in a single thread
 * typically all point directly to the root comment rather than forming a
 * linear parent chain, so to reconstruct the full conversation we: (1) walk
 * from the leaf up to find the root, then (2) collect every comment whose
 * ancestor chain bottoms out at that root.
 */
export async function fetchReviewCommentThread(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  leafCommentId: number,
): Promise<ReviewThreadComment[]> {
  const { data } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const byId = new Map<number, ReviewThreadComment>();
  for (const c of data) {
    byId.set(c.id, {
      id: c.id,
      body: c.body,
      authorLogin: c.user?.login ?? 'unknown',
      isBot: c.user?.type === 'Bot',
      createdAt: c.created_at,
      inReplyToId: c.in_reply_to_id,
      // FP-F — preserve the anchored file path so inline-resolve can
      // recover the finding's stable match keys.
      path: c.path,
    });
  }

  // Find the root by walking `in_reply_to_id` back from the leaf.
  let rootId = leafCommentId;
  const visitedOnWalk = new Set<number>();
  while (!visitedOnWalk.has(rootId)) {
    visitedOnWalk.add(rootId);
    const node = byId.get(rootId);
    if (!node?.inReplyToId) break;
    rootId = node.inReplyToId;
  }

  // Collect every comment that transitively descends from the root.
  const inThread = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of byId.values()) {
      if (c.inReplyToId != null && inThread.has(c.inReplyToId) && !inThread.has(c.id)) {
        inThread.add(c.id);
        grew = true;
      }
    }
  }

  return Array.from(inThread)
    .map((id) => byId.get(id))
    .filter((c): c is ReviewThreadComment => c != null)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/**
 * Reply inside an existing review-comment thread. Uses GitHub's dedicated
 * reply endpoint so the new comment is threaded under the root rather than
 * floating as a new top-level review comment.
 */
export async function replyToReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  rootCommentId: number,
  body: string,
): Promise<number> {
  const { data } = await octokit.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: rootCommentId,
    body,
  });
  return data.id;
}

/**
 * Add an "eyes" reaction to an inline review comment to signal MergeWatch is
 * processing the reply. Returns the reaction ID so callers can remove it
 * after the reply is posted.
 */
export async function addReviewCommentReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes' = 'eyes',
): Promise<number | null> {
  try {
    const { data } = await octokit.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content: reaction,
    });
    return data.id;
  } catch (err) {
    console.warn('Failed to add %s reaction to review comment %d:', reaction, commentId, err);
    return null;
  }
}

/**
 * Remove a reaction from a review comment. Used to clear the eyes reaction
 * once MergeWatch has posted its reply.
 */
export async function removeReviewCommentReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  reactionId: number,
): Promise<void> {
  try {
    await octokit.reactions.deleteForPullRequestComment({
      owner,
      repo,
      comment_id: commentId,
      reaction_id: reactionId,
    });
  } catch (err) {
    console.warn('Failed to remove reaction %d from review comment %d:', reactionId, commentId, err);
  }
}

/**
 * Resolve a pull request review thread via GraphQL. The REST API has no
 * equivalent — only the GraphQL `resolveReviewThread` mutation can mark a
 * thread as resolved.
 */
export async function resolveReviewThread(
  octokit: Octokit,
  threadNodeId: string,
): Promise<void> {
  const mutation = `
    mutation ResolveThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }
  `;
  await octokit.graphql(mutation, { threadId: threadNodeId });
}

/**
 * Look up the GraphQL node ID of the review thread that contains a given
 * review comment. GitHub's REST review-comment payload exposes `node_id` for
 * the comment itself but not for its containing thread — so we fetch all
 * threads on the PR and locate the one containing this comment.
 */
export async function findReviewThreadIdForComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
): Promise<string | null> {
  const query = `
    query FindThread($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              comments(first: 100) { nodes { databaseId } }
            }
          }
        }
      }
    }
  `;
  type Resp = {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{ id: string; comments: { nodes: Array<{ databaseId: number }> } }>;
        };
      };
    };
  };
  const data = await octokit.graphql<Resp>(query, { owner, repo, number: prNumber });
  for (const thread of data.repository.pullRequest.reviewThreads.nodes) {
    if (thread.comments.nodes.some((c) => c.databaseId === commentId)) {
      return thread.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repository config (.mergewatch.yml)
// ---------------------------------------------------------------------------

/**
 * Fetch and parse .mergewatch.yml from a repository's default branch.
 * Returns null if the file doesn't exist.
 */
/**
 * Parse a raw YAML string into a partial MergeWatchConfig.
 * Exported for testability — `fetchRepoConfig` handles the GitHub API call.
 */
export function parseRepoConfigYaml(content: string): Partial<MergeWatchConfig> | null {
  const parsed = yaml.load(content) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const config: Partial<MergeWatchConfig> = {};


    if (typeof parsed.model === 'string') config.model = parsed.model;
    if (typeof parsed.lightModel === 'string') config.lightModel = parsed.lightModel;
    if (typeof parsed.maxTokensPerAgent === 'number') config.maxTokensPerAgent = parsed.maxTokensPerAgent;
    if (typeof parsed.minSeverity === 'string' && ['info', 'warning', 'critical'].includes(parsed.minSeverity)) {
      config.minSeverity = parsed.minSeverity as 'info' | 'warning' | 'critical';
    }
    if (typeof parsed.maxFindings === 'number') config.maxFindings = parsed.maxFindings;
    if (typeof parsed.postSummaryOnClean === 'boolean') config.postSummaryOnClean = parsed.postSummaryOnClean;
    if (typeof parsed.conventions === 'string' && parsed.conventions.trim()) {
      config.conventions = parsed.conventions.trim();
    }
    if (Array.isArray(parsed.customStyleRules)) {
      config.customStyleRules = parsed.customStyleRules.filter((r: unknown) => typeof r === 'string');
    }
    if (Array.isArray(parsed.excludePatterns)) {
      config.excludePatterns = parsed.excludePatterns.filter((p: unknown) => typeof p === 'string');
    }
    if (Array.isArray(parsed.includePatterns)) {
      config.includePatterns = parsed.includePatterns.filter((p: unknown) => typeof p === 'string');
    }
    if (parsed.agents && typeof parsed.agents === 'object') {
      const a = parsed.agents as Record<string, unknown>;
      config.agents = {
        security: typeof a.security === 'boolean' ? a.security : true,
        bugs: typeof a.bugs === 'boolean' ? a.bugs : true,
        style: typeof a.style === 'boolean' ? a.style : true,
        summary: typeof a.summary === 'boolean' ? a.summary : true,
        diagram: typeof a.diagram === 'boolean' ? a.diagram : true,
        errorHandling: typeof a.errorHandling === 'boolean' ? a.errorHandling : true,
        testCoverage: typeof a.testCoverage === 'boolean' ? a.testCoverage : true,
        commentAccuracy: typeof a.commentAccuracy === 'boolean' ? a.commentAccuracy : true,
      };
    }

    // Codebase awareness fields
    if (typeof parsed.codebaseAwareness === 'boolean') config.codebaseAwareness = parsed.codebaseAwareness;
    if (typeof parsed.maxFileRequestRounds === 'number') config.maxFileRequestRounds = parsed.maxFileRequestRounds;
    if (typeof parsed.maxContextKB === 'number') config.maxContextKB = parsed.maxContextKB;

    // Custom agents
    if (Array.isArray(parsed.customAgents)) {
      const validSeverities = new Set(['info', 'warning', 'critical']);
      config.customAgents = (parsed.customAgents as unknown[])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter((a) => typeof a.name === 'string' && typeof a.prompt === 'string')
        .map((a): CustomAgentDef => ({
          name: a.name as string,
          prompt: a.prompt as string,
          severityDefault: validSeverities.has(a.severityDefault as string)
            ? (a.severityDefault as 'info' | 'warning' | 'critical')
            : 'warning',
          enabled: typeof a.enabled === 'boolean' ? a.enabled : true,
        }));
    }

    // UX config
    if (parsed.ux && typeof parsed.ux === 'object') {
      const u = parsed.ux as Record<string, unknown>;
      const ux: Partial<UXConfig> = {};
      const validTones = new Set(['collaborative', 'direct', 'advisory']);
      if (typeof u.tone === 'string' && validTones.has(u.tone)) {
        ux.tone = u.tone as UXConfig['tone'];
      }
      if (typeof u.showWorkDone === 'boolean') ux.showWorkDone = u.showWorkDone;
      if (typeof u.showSuppressedCount === 'boolean') ux.showSuppressedCount = u.showSuppressedCount;
      if (typeof u.reviewerChecklist === 'boolean') ux.reviewerChecklist = u.reviewerChecklist;
      if (typeof u.allClearMessage === 'boolean') ux.allClearMessage = u.allClearMessage;
      if (typeof u.commentHeader === 'string') ux.commentHeader = u.commentHeader;
      config.ux = ux as UXConfig;
    }

    // Rules config
    if (parsed.rules && typeof parsed.rules === 'object') {
      const r = parsed.rules as Record<string, unknown>;
      const rules: Partial<RulesConfig> = {};
      if (typeof r.maxFiles === 'number') rules.maxFiles = r.maxFiles;
      if (Array.isArray(r.ignorePatterns)) {
        rules.ignorePatterns = r.ignorePatterns.filter((p: unknown) => typeof p === 'string');
      }
      if (typeof r.autoReview === 'boolean') rules.autoReview = r.autoReview;
      if (typeof r.reviewOnMention === 'boolean') rules.reviewOnMention = r.reviewOnMention;
      if (typeof r.skipDrafts === 'boolean') rules.skipDrafts = r.skipDrafts;
      if (Array.isArray(r.ignoreLabels)) {
        rules.ignoreLabels = r.ignoreLabels.filter((l: unknown) => typeof l === 'string');
      }
      config.rules = rules as RulesConfig;
    }

    // Agent review config
    if (parsed.agentReview && typeof parsed.agentReview === 'object') {
      const ar = parsed.agentReview as Record<string, unknown>;
      const agentReview: Partial<AgentReviewConfig> = {};
      if (typeof ar.enabled === 'boolean') agentReview.enabled = ar.enabled;
      if (typeof ar.strictChecks === 'boolean') agentReview.strictChecks = ar.strictChecks;
      if (typeof ar.autoIterate === 'boolean') agentReview.autoIterate = ar.autoIterate;
      if (
        typeof ar.maxIterations === 'number' &&
        Number.isInteger(ar.maxIterations) &&
        ar.maxIterations >= 1 &&
        ar.maxIterations <= 20
      ) {
        agentReview.maxIterations = ar.maxIterations;
      }
      if (typeof ar.passThreshold === 'string' && (PASS_THRESHOLDS as readonly string[]).includes(ar.passThreshold)) {
        agentReview.passThreshold = ar.passThreshold as PassThreshold;
      }
      if (ar.detection && typeof ar.detection === 'object') {
        const d = ar.detection as Record<string, unknown>;
        const detection: Partial<AgentReviewDetectionConfig> = {};
        if (Array.isArray(d.commitTrailers)) {
          detection.commitTrailers = d.commitTrailers.filter((t: unknown) => typeof t === 'string');
        }
        if (Array.isArray(d.branchPrefixes)) {
          detection.branchPrefixes = d.branchPrefixes.filter((p: unknown) => typeof p === 'string');
        }
        if (Array.isArray(d.labels)) {
          detection.labels = d.labels.filter((l: unknown) => typeof l === 'string');
        }
        if (Object.keys(detection).length > 0) {
          agentReview.detection = detection as AgentReviewDetectionConfig;
        }
      }
      if (Object.keys(agentReview).length > 0) {
        config.agentReview = agentReview as AgentReviewConfig;
      }
    }

  return config;
}

/**
 * Fetch `.mergewatch.yml` from a repo. When `ref` is provided, reads the file
 * at that commit / branch — required for the silent autoReview-off gate to
 * honor changes made on the PR branch, since GitHub's default is to read from
 * the repo's default branch.
 */
export async function fetchRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<Partial<MergeWatchConfig> | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: '.mergewatch.yml',
      ...(ref ? { ref } : {}),
    });

    if (Array.isArray(data) || data.type !== 'file' || !data.content) {
      return null;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return parseRepoConfigYaml(content);
  } catch (err: unknown) {
    // 404 means no config file — that's fine
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) {
      return null;
    }
    console.warn('Failed to fetch .mergewatch.yml from %s/%s:', owner, repo, err);
    return null;
  }
}
