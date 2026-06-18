/**
 * TypeScript types for GitHub webhook payloads and related structures.
 *
 * These types cover the subset of GitHub's webhook API that MergeWatch
 * consumes: pull_request events, issue_comment events, and installation events.
 * They are intentionally narrower than the full GitHub API schema — we only
 * model the fields we actually read so the compiler can catch drift early.
 */

// ---------------------------------------------------------------------------
// Shared / common types
// ---------------------------------------------------------------------------

/** Minimal representation of a GitHub user (actor). */
export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  type: "User" | "Organization" | "Bot";
}

/** Minimal representation of a GitHub repository. */
export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUser;
  private: boolean;
  html_url: string;
  default_branch: string;
}

/** A Git ref attached to a pull request (head or base). */
export interface GitHubPullRequestRef {
  label: string;
  ref: string;
  sha: string;
  repo: GitHubRepository;
}

/** Minimal representation of a pull request. */
export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  /** The branch being merged *from*. */
  head: GitHubPullRequestRef;
  /** The branch being merged *into*. */
  base: GitHubPullRequestRef;
  user: GitHubUser;
  /** Whether the pull request is a draft. */
  draft?: boolean;
  /** Labels applied to the pull request. */
  labels?: Array<{ name: string }>;
  /** ISO-8601 timestamps. */
  created_at: string;
  updated_at: string;
  /**
   * Whether the PR has been merged. Present on `closed` webhook payloads
   * (true when the close was a merge, false when closed without merging)
   * and on the REST PR object. Absent on some narrower API responses.
   */
  merged?: boolean;
  /** ISO-8601 — set when the PR was merged; null otherwise. */
  merged_at?: string | null;
  /** ISO-8601 — set when the PR was closed (merged or not); null while open. */
  closed_at?: string | null;
  /** List of changed file paths — only present on certain API responses. */
  changed_files?: number;
}

/** Minimal representation of an issue comment. */
export interface GitHubIssueComment {
  id: number;
  body: string;
  user: GitHubUser;
  html_url: string;
  created_at: string;
  updated_at: string;
}

/** Minimal representation of an issue (used in issue_comment events). */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  /** A pull request key is present only when the issue *is* a pull request. */
  pull_request?: {
    url: string;
    html_url: string;
  };
  user: GitHubUser;
}

/** GitHub App installation (subset of fields we care about). */
export interface GitHubInstallation {
  id: number;
  account: GitHubUser;
  app_id: number;
  target_type: "User" | "Organization";
  /** Repositories the installation has access to (may be truncated). */
  repositories?: GitHubRepository[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Webhook event payloads
// ---------------------------------------------------------------------------

/** PR actions that trigger a new review. */
export const REVIEW_TRIGGERING_ACTIONS = ['opened', 'synchronize', 'ready_for_review', 'reopened'] as const;

/** PR actions where we look for an existing bot comment to update (not first-time opens). */
export const COMMENT_LOOKUP_ACTIONS = ['synchronize', 'ready_for_review', 'reopened'] as const;

/**
 * `pull_request` event.
 * We care about `opened` (new PR) and `synchronize` (new commits pushed).
 */
export interface PullRequestEvent {
  action:
    | "opened"
    | "synchronize"
    | "closed"
    | "reopened"
    | "edited"
    | "ready_for_review"
    | "converted_to_draft";
  number: number;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  installation?: { id: number };
  sender: GitHubUser;
}

/**
 * `issue_comment` event.
 * We trigger a review when the comment body contains `@mergewatch`.
 */
export interface IssueCommentEvent {
  action: "created" | "edited" | "deleted";
  comment: GitHubIssueComment;
  issue: GitHubIssue;
  repository: GitHubRepository;
  installation?: { id: number };
  sender: GitHubUser;
}

/**
 * `pull_request_review_comment` event.
 * Fires on inline review comment create/edit/delete. MergeWatch uses the
 * `created` action with `in_reply_to_id` set to engage in threaded
 * conversations where the root comment is bot-authored.
 */
export interface PullRequestReviewCommentEvent {
  action: "created" | "edited" | "deleted";
  comment: GitHubReviewComment;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  installation?: { id: number };
  sender: GitHubUser;
}

/**
 * A single review comment on a pull request (inline annotation on a diff line).
 */
export interface GitHubReviewComment {
  id: number;
  /** Full text of the comment body (markdown). */
  body: string;
  /** Parent review ID (the submitted review this comment belongs to). */
  pull_request_review_id: number | null;
  /** When set, this comment is a reply to another review comment. */
  in_reply_to_id?: number;
  /** Thread node id exposed on the REST payload for GraphQL correlation. */
  node_id: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  /** Path within the repo the comment was made on. */
  path: string;
  /** Commit SHA the comment was posted against. */
  commit_id: string;
}

/**
 * `installation` event.
 * Fired when a user installs / uninstalls the GitHub App.
 */
export interface InstallationEvent {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
  installation: GitHubInstallation;
  /** Repositories added during installation (only on `created`). */
  repositories?: GitHubRepository[];
  sender: GitHubUser;
}

/**
 * Minimal pull-request descriptor attached to a check_run event.
 * The full PR object isn't delivered on check_run webhooks — only a ref
 * pair + number. We resolve the full PR via the API when we need it.
 */
export interface CheckRunPullRequestRef {
  number: number;
  head: GitHubPullRequestRef;
  base: GitHubPullRequestRef;
}

/**
 * check_run webhook event — MergeWatch reacts to `rerequested` so the
 * native "Re-run" button in GitHub's Checks UI triggers a fresh review.
 */
export interface CheckRunEvent {
  action: "created" | "completed" | "rerequested" | "requested_action";
  check_run: {
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    /** The App that created the check — used to filter out other tools' check runs. */
    app?: { id: number; slug: string; name: string };
    pull_requests: CheckRunPullRequestRef[];
  };
  repository: GitHubRepository;
  installation?: { id: number };
  sender: GitHubUser;
}

// ---------------------------------------------------------------------------
// Discriminated union for routing
// ---------------------------------------------------------------------------

/** All webhook events MergeWatch handles, keyed by their X-GitHub-Event header. */
export type WebhookEvent =
  | { eventType: "pull_request"; payload: PullRequestEvent }
  | { eventType: "issue_comment"; payload: IssueCommentEvent }
  | { eventType: "pull_request_review_comment"; payload: PullRequestReviewCommentEvent }
  | { eventType: "check_run"; payload: CheckRunEvent }
  | { eventType: "installation"; payload: InstallationEvent };

// ---------------------------------------------------------------------------
// Internal types used by the review pipeline
// ---------------------------------------------------------------------------

/** The review "mode" derived from an @mergewatch mention or inbound webhook. */
export type ReviewMode = "review" | "summary" | "respond" | "inline_reply";

/** Context we extract from a PR before handing it to the review agent. */
export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  description: string | null;
  baseBranch: string;
  headBranch: string;
  /** Full SHA of the head commit */
  headSha: string;
  /** PR author login */
  prAuthor?: string;
  /** PR author avatar URL */
  prAuthorAvatar?: string;
  files: string[];
  /** Total lines added across all files */
  totalAdditions: number;
  /** Total lines deleted across all files */
  totalDeletions: number;
}

/** Shape of the async invocation payload sent to the ReviewAgent Lambda. */
export interface ReviewJobPayload {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  mode: ReviewMode;
  /** If we already found an existing bot comment, pass its ID so the agent can update it. */
  existingCommentId?: number;
  /** Whether the PR is a draft (passed from webhook for config-aware skip logic). */
  isDraft?: boolean;
  /** GitHub labels on the PR (passed from webhook for config-aware skip logic). */
  prLabels?: string[];
  /** Number of changed files in the PR (passed from webhook for config-aware skip logic). */
  changedFileCount?: number;
  /** True when triggered by an @mergewatch comment (force-bypasses skip logic). */
  mentionTriggered?: boolean;
  /**
   * Head commit SHA of the PR. Passed from the webhook so the review-agent
   * can fetch `.mergewatch.yml` at the PR's head (not the repo's default
   * branch) — required for the silent autoReview-off gate to honor config
   * changes made on the PR branch. Optional because pre-existing job payloads
   * in flight won't carry it; the silent-skip fetch falls back to the default
   * branch in that case.
   */
  headSha?: string;
  /** For "respond" mode: the user's comment body that triggered the response. */
  userComment?: string;
  /** For "respond" mode: the login of the user who commented. */
  userCommentAuthor?: string;
  /**
   * For "inline_reply" mode: the ID of the human's review comment that we are
   * responding to. The handler walks the thread from this comment back to the
   * root to reconstruct conversation context.
   */
  inlineReplyCommentId?: number;
  /**
   * PR source classification populated by the webhook handler via
   * classifyPrSource. When 'agent', the review agent injects the agent-mode
   * prompt suffix and persists source/agentKind onto the ReviewItem.
   */
  source?: 'agent' | 'human';
  /** Agent kind when source='agent' (derived from whichever detection rule matched). */
  agentKind?: 'claude' | 'cursor' | 'codex' | 'other';
}
