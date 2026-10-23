/**
 * #716 — `@mergewatch safety <safe|caution|risky> [reason]`: a reviewer's own
 * band for the PR, recorded on the latest safety-scored review row.
 *
 * Handled in the webhook process, synchronously: one query, one append, one
 * reaction. It never enqueues a review and never calls an LLM.
 */
import type { Octokit } from '@octokit/rest';
import { SAFETY_LEVELS, type SafetyLevel } from './config/defaults.js';
import type { IReviewStore } from './storage/types.js';
import type { ReviewItem, SafetyFeedbackEntry } from './types/db.js';
import { addIssueCommentReaction } from './github/client.js';

export interface SafetyFeedbackCommand {
  band: SafetyLevel;
  reason?: string;
}

const MAX_REASON = 500;

/**
 * Line-anchored and closed: the band must be one of SAFETY_LEVELS, followed by
 * whitespace or the end of the line. `@mergewatch safety why so risky?`,
 * `risky-ish`, `safe?` and a quoted `> @mergewatch …` all fall through to the
 * normal `@mergewatch` handling.
 */
const SAFETY_LINE = new RegExp(
  `^[ \\t]*@mergewatch[ \\t]+safety[ \\t]+(${SAFETY_LEVELS.join('|')})(?=[ \\t]|$)[ \\t]*(.*)$`,
  'im',
);

export function parseSafetyFeedback(body: string): SafetyFeedbackCommand | null {
  const m = SAFETY_LINE.exec(body ?? '');
  if (!m) return null;
  const reason = m[2].trim().slice(0, MAX_REASON);
  return { band: m[1].toLowerCase() as SafetyLevel, ...(reason ? { reason } : {}) };
}

/**
 * The newest row that carries a safety band. Picked by `createdAt`, not by
 * position: DynamoDB `queryByPR` returns rows in descending SHA order (#732).
 */
export function latestScoredReview(rows: ReviewItem[]): ReviewItem | undefined {
  let best: ReviewItem | undefined;
  for (const r of rows) {
    if (!r.safetyBand) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best;
}

/** How many reviewed commits are searched for the target row. */
export const SAFETY_FEEDBACK_LOOKBACK = 50;

export interface RecordSafetyFeedbackInput {
  command: SafetyFeedbackCommand;
  user: string;
  repoFullName: string;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  octokit: Octokit;
  reviewStore: IReviewStore;
  now?: () => string;
}

/**
 * Appends the vote to the latest scored review and reacts `+1`; with no
 * scored review (the feature is off, or the PR was never scored) it reacts
 * `confused` and writes nothing. Reactions are best-effort.
 */
export async function recordSafetyFeedback(input: RecordSafetyFeedbackInput): Promise<'recorded' | 'no-scored-review'> {
  const { command, user, repoFullName, owner, repo, prNumber, commentId, octokit, reviewStore } = input;
  const rows = await reviewStore.queryByPR(repoFullName, `${prNumber}#`, SAFETY_FEEDBACK_LOOKBACK);
  const target = latestScoredReview(rows);
  if (!target) {
    await addIssueCommentReaction(octokit, owner, repo, commentId, 'confused');
    return 'no-scored-review';
  }
  const entry: SafetyFeedbackEntry = {
    band: command.band,
    user,
    at: (input.now ?? (() => new Date().toISOString()))(),
    ...(command.reason ? { reason: command.reason } : {}),
  };
  await reviewStore.appendSafetyFeedback(repoFullName, target.prNumberCommitSha, entry);
  await addIssueCommentReaction(octokit, owner, repo, commentId, '+1');
  return 'recorded';
}
