/**
 * AWS Lambda handler for incoming GitHub webhook events.
 *
 * This is the entry point for all GitHub webhooks. It:
 *  1. Verifies the webhook signature to ensure the request is authentic.
 *  2. Parses the event type from the `X-GitHub-Event` header.
 *  3. Routes the event to the appropriate handler logic.
 *  4. Returns 200 immediately — the actual review work is done by an async
 *     invocation of the ReviewAgent Lambda.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { LambdaClient, InvokeCommand, InvocationType } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  findExistingBotComment,
  REVIEW_TRIGGERING_ACTIONS,
  COMMENT_LOOKUP_ACTIONS,
  MERGEWATCH_CHECK_RUN_NAME,
  classifyPrSource,
  fetchRepoConfig,
  mergeConfig,
  isBotActor,
  sweepInlineReactionsOnClose,
} from '@mergewatch/core';
import type {
  PullRequestEvent,
  IssueCommentEvent,
  PullRequestReviewCommentEvent,
  InstallationEvent,
  CheckRunEvent,
  ReviewMode,
  ReviewJobPayload,
  AgentReviewConfig,
} from '@mergewatch/core';
import {
  DynamoPRLifecycleStore, DEFAULT_PR_LIFECYCLE_TABLE,
  DynamoReviewStore, DynamoFindingDispositionStore, DEFAULT_FINDING_DISPOSITIONS_TABLE,
} from '@mergewatch/storage-dynamo';
import { SSMGitHubAuthProvider, getWebhookSecret } from '../github-auth-ssm.js';

// ---------------------------------------------------------------------------
// AWS clients (re-used across warm invocations)
// ---------------------------------------------------------------------------

const lambda = new LambdaClient({});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const authProvider = new SSMGitHubAuthProvider();

// TTM (#194) — PR-lifecycle store. The webhook records open/push/close
// transitions directly (no review needed); ReviewAgent marks reviewed/skipped.
const PR_LIFECYCLE_TABLE = process.env.PR_LIFECYCLE_TABLE ?? DEFAULT_PR_LIFECYCLE_TABLE;
const prLifecycleStore = new DynamoPRLifecycleStore(dynamodb, PR_LIFECYCLE_TABLE);

// FB-C (#189) — review + disposition stores for the close-time reaction sweep.
const reviewStore = new DynamoReviewStore(dynamodb, process.env.REVIEWS_TABLE ?? 'mergewatch-reviews');
const dispositionStore = new DynamoFindingDispositionStore(
  dynamodb,
  process.env.FINDING_DISPOSITIONS_TABLE ?? DEFAULT_FINDING_DISPOSITIONS_TABLE,
);

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 */
export function verifySignature(
  secret: string,
  body: string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) return false;

  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "utf8"
  );
  const actual = Buffer.from(signatureHeader, "utf8");

  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Event routing helpers
// ---------------------------------------------------------------------------

/**
 * Determine the review mode from an `@mergewatch` mention in a comment body.
 */
export function parseReviewMode(commentBody: string): ReviewMode | null {
  if (!/@mergewatch/i.test(commentBody)) return null;

  if (/@mergewatch\s+review\b/i.test(commentBody)) return "review";
  if (/@mergewatch\s+summary\b/i.test(commentBody)) return "summary";
  if (/@mergewatch\s*$/im.test(commentBody)) return "review";

  return "respond";
}

/**
 * Asynchronously invoke the ReviewAgent Lambda with the given payload.
 */
async function enqueueReviewJob(payload: ReviewJobPayload): Promise<void> {
  const functionName =
    process.env.REVIEW_AGENT_FUNCTION_NAME ?? "mergewatch-review-agent";

  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

/**
 * Store or update installation records in DynamoDB.
 */
async function storeInstallation(event: InstallationEvent): Promise<void> {
  const tableName =
    process.env.INSTALLATIONS_TABLE ?? "mergewatch-installations";

  const repos = event.repositories ?? [];

  if (repos.length === 0) {
    await dynamodb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          installationId: String(event.installation.id),
          repoFullName: event.installation.account.login,
          installedAt: event.installation.created_at,
          config: {},
        },
      })
    );
    return;
  }

  for (const repo of repos) {
    await dynamodb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          installationId: String(event.installation.id),
          repoFullName: repo.full_name,
          installedAt: event.installation.created_at,
          config: {},
        },
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Pull request event handler
// ---------------------------------------------------------------------------

/**
 * TTM (#194) — record PR-lifecycle transitions. Best-effort (the store
 * swallows its own errors); mirrors the self-hosted webhook handler.
 */
async function recordPrLifecycle(event: PullRequestEvent, installationId: number): Promise<void> {
  const { action, pull_request: pr, repository } = event;
  const instId = String(installationId);
  const repoFullName = repository.full_name;
  const prNumber = pr.number;
  try {
    if (action === 'closed') {
      if (pr.merged && pr.merged_at) {
        await prLifecycleStore.markMerged({ installationId: instId, repoFullName, prNumber, prCreatedAt: pr.created_at, at: pr.merged_at });
      } else {
        // GitHub always sends closed_at on a `closed` action; a missing value
        // signals an unexpected payload, so surface it rather than silently
        // substituting now() (which would skew the cycle-time stat).
        if (!pr.closed_at) {
          console.warn('[ttm] closed PR missing closed_at — using now() (%s#%d):', repoFullName, prNumber);
        }
        await prLifecycleStore.markClosedUnmerged({
          installationId: instId, repoFullName, prNumber,
          prCreatedAt: pr.created_at,
          at: pr.closed_at ?? new Date().toISOString(),
        });
      }
    } else if (action === 'synchronize') {
      await prLifecycleStore.recordPush(instId, repoFullName, prNumber);
    } else if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
      await prLifecycleStore.upsertOpened({ installationId: instId, repoFullName, prNumber, prCreatedAt: pr.created_at });
    }
  } catch (err) {
    console.warn('[ttm] lifecycle record failed for %s#%d (%s):', repoFullName, prNumber, action, err);
  }
}

async function handlePullRequestEvent(
  event: PullRequestEvent
): Promise<void> {
  const { action, pull_request: pr, repository, installation } = event;

  const installationId = installation?.id;
  if (!installationId) {
    console.warn("pull_request event missing installation ID — skipping");
    return;
  }

  // Record lifecycle for every relevant action (incl. `closed`) before the
  // review gate — merges/closes terminate the lifecycle without a review.
  await recordPrLifecycle(event, installationId);

  // FB-C (#189) — reactions don't emit webhooks and the in-review poll can't see
  // a reaction added after the final review (the common case). On the terminal
  // `closed` event, sweep once so end-of-PR 👍/👎 aren't lost.
  if (action === 'closed') {
    try {
      const octokit = await authProvider.getInstallationOctokit(installationId);
      await sweepInlineReactionsOnClose({
        octokit,
        owner: repository.owner.login,
        repo: repository.name,
        prNumber: pr.number,
        reviewStore,
        dispositionStore,
        installationId: String(installationId),
        repoFullName: repository.full_name,
      });
    } catch (err) {
      console.warn('[fb-c] close reaction sweep failed to start:', err);
    }
  }

  if (!(REVIEW_TRIGGERING_ACTIONS as readonly string[]).includes(action)) return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pr.number;

  // We always need an Octokit now for classification (and, for re-open /
  // synchronize actions, also for the existing-comment lookup).
  const octokit = await authProvider.getInstallationOctokit(installationId);

  let existingCommentId: number | undefined;
  if ((COMMENT_LOOKUP_ACTIONS as readonly string[]).includes(action)) {
    const commentId = await findExistingBotComment(octokit, owner, repo, prNumber);
    if (commentId) {
      existingCommentId = commentId;
    }
  }

  // Resolve agentReview config (repo YAML overrides defaults) and classify
  // the PR source. Only opt-in via .mergewatch.yml triggers detection —
  // when the repo has no agentReview block we pass undefined, which short-
  // circuits the classifier to 'human'.
  const yamlConfig = await fetchRepoConfig(octokit, owner, repo).catch(() => null);
  const agentReviewConfig: AgentReviewConfig | undefined = yamlConfig?.agentReview
    ? mergeConfig(yamlConfig).agentReview
    : undefined;
  const classification = await classifyPrSource(pr, octokit, agentReviewConfig);

  await enqueueReviewJob({
    installationId,
    owner,
    repo,
    prNumber,
    mode: "review",
    existingCommentId,
    isDraft: pr.draft ?? false,
    prLabels: pr.labels?.map((l) => l.name) ?? [],
    changedFileCount: pr.changed_files,
    source: classification.source,
    agentKind: classification.agentKind,
    headSha: pr.head?.sha,
  });

  console.log(
    `Classified ${owner}/${repo}#${prNumber} as ${classification.source}${classification.agentKind ? ' (' + classification.agentKind + ')' : ''} via ${classification.matchedRule ?? 'default'}`,
  );
  console.log(
    `Enqueued review job: ${owner}/${repo}#${prNumber} (action=${action}, existingComment=${existingCommentId ?? "none"})`
  );
}

// ---------------------------------------------------------------------------
// Issue comment event handler
// ---------------------------------------------------------------------------

async function handleIssueCommentEvent(
  event: IssueCommentEvent
): Promise<void> {
  if (event.action !== "created") return;
  if (!event.issue.pull_request) return;

  // Ignore comments from any bot (prevents self-triggering loops and replies
  // to other reviewers like CopilotAI / dependabot). We check both the sender
  // and the comment author since OAuth-driven Apps may surface as type=User
  // while still carrying a `[bot]` login suffix.
  if (isBotActor(event.sender) || isBotActor(event.comment.user)) return;

  const mode = parseReviewMode(event.comment.body);
  if (!mode) return;

  const installationId = event.installation?.id;
  if (!installationId) {
    console.warn("issue_comment event missing installation ID — skipping");
    return;
  }

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const prNumber = event.issue.number;

  const octokit = await authProvider.getInstallationOctokit(installationId);
  const existingCommentId =
    (await findExistingBotComment(octokit, owner, repo, prNumber)) ?? undefined;

  const payload: ReviewJobPayload = {
    installationId,
    owner,
    repo,
    prNumber,
    mode,
    existingCommentId,
    mentionTriggered: true,
  };

  if (mode === "respond") {
    payload.userComment = event.comment.body;
    payload.userCommentAuthor = event.sender.login;
  }

  await enqueueReviewJob(payload);

  console.log(
    `Enqueued ${mode} job from comment: ${owner}/${repo}#${prNumber} (existingComment=${existingCommentId ?? "none"})`
  );
}

// ---------------------------------------------------------------------------
// Pull request review comment event handler (inline thread replies)
// ---------------------------------------------------------------------------

/**
 * Decide whether this review-comment event warrants engagement. Extracted as
 * a pure predicate so the cheap filter branches can be unit-tested without
 * stubbing Lambda and DynamoDB clients.
 *
 * Rules: only `created` action, only human senders (bots are filtered to
 * prevent reply loops — checked across both sender and comment author so
 * GitHub Apps with `[bot]` login suffixes are caught even when surfaced as
 * type=User), only replies with `in_reply_to_id` set (skip top-level inline
 * comments on new findings that humans start themselves), and only when
 * installation metadata is present.
 */
export function shouldHandleReviewCommentEvent(
  event: PullRequestReviewCommentEvent,
): boolean {
  if (event.action !== 'created') return false;
  if (isBotActor(event.sender) || isBotActor(event.comment.user)) return false;
  if (event.comment.in_reply_to_id == null) return false;
  if (!event.installation?.id) return false;
  return true;
}

/**
 * Handle an inline review-comment reply. We only engage when a human replies
 * inside a thread whose root comment was authored by MergeWatch.
 */
async function handleReviewCommentEvent(
  event: PullRequestReviewCommentEvent,
): Promise<void> {
  if (!shouldHandleReviewCommentEvent(event)) return;
  const installationId = event.installation!.id;

  const payload: ReviewJobPayload = {
    installationId,
    owner: event.repository.owner.login,
    repo: event.repository.name,
    prNumber: event.pull_request.number,
    mode: 'inline_reply',
    inlineReplyCommentId: event.comment.id,
  };

  await enqueueReviewJob(payload);

  console.log(
    `Enqueued inline_reply job: ${payload.owner}/${payload.repo}#${payload.prNumber} (reply=${event.comment.id})`,
  );
}

// ---------------------------------------------------------------------------
// Check run event handler
// ---------------------------------------------------------------------------

/**
 * True when a check_run event describes a MergeWatch-created check.
 * Exported for unit testing. We match by name (stable across deploys) since
 * check_run.app.id requires knowing our GitHub App ID at runtime.
 */
export function isMergeWatchCheckRun(event: CheckRunEvent): boolean {
  return event.check_run?.name === MERGEWATCH_CHECK_RUN_NAME;
}

/**
 * Handle the "Re-run" button in GitHub's PR Checks UI. GitHub fires a
 * check_run.rerequested event on our App; we treat it the same as a
 * `pull_request.synchronize` on the PR the check was created for.
 */
async function handleCheckRunEvent(event: CheckRunEvent): Promise<void> {
  if (event.action !== 'rerequested') return;
  if (!isMergeWatchCheckRun(event)) return;

  const installationId = event.installation?.id;
  if (!installationId) {
    console.warn('check_run event missing installation ID — skipping');
    return;
  }

  const prRef = event.check_run.pull_requests?.[0];
  if (!prRef) {
    // Check was created on a commit not associated with any PR (rare for
    // MergeWatch checks, but guard anyway so we don't throw).
    console.warn(
      `check_run rerequested with no attached PR on ${event.repository.full_name} @ ${event.check_run.head_sha}`,
    );
    return;
  }

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const prNumber = prRef.number;

  const octokit = await authProvider.getInstallationOctokit(installationId);

  // Classification: refetch the PR so we get a full object + labels for
  // agentReview detection, mirroring the pull_request.synchronize path.
  const yamlConfig = await fetchRepoConfig(octokit, owner, repo).catch(() => null);
  const agentReviewConfig: AgentReviewConfig | undefined = yamlConfig?.agentReview
    ? mergeConfig(yamlConfig).agentReview
    : undefined;
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const classification = await classifyPrSource(pr as never, octokit, agentReviewConfig);

  const existingCommentId =
    (await findExistingBotComment(octokit, owner, repo, prNumber)) ?? undefined;

  await enqueueReviewJob({
    installationId,
    owner,
    repo,
    prNumber,
    mode: 'review',
    existingCommentId,
    isDraft: pr.draft ?? false,
    prLabels: pr.labels?.map((l: { name: string }) => l.name) ?? [],
    changedFileCount: pr.changed_files,
    source: classification.source,
    agentKind: classification.agentKind,
    headSha: pr.head?.sha,
  });

  console.log(
    `Enqueued review job from check_run rerequested: ${owner}/${repo}#${prNumber} (existingComment=${existingCommentId ?? 'none'})`,
  );
}

// ---------------------------------------------------------------------------
// Installation event handler
// ---------------------------------------------------------------------------

async function handleInstallationEvent(
  event: InstallationEvent
): Promise<void> {
  await storeInstallation(event);
  console.log(
    `Installation ${event.action}: ${event.installation.account.login} (id=${event.installation.id})`
  );
}

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const body = event.body ?? "";
  const secret = await getWebhookSecret();

  const signatureHeader =
    event.headers["X-Hub-Signature-256"] ??
    event.headers["x-hub-signature-256"];

  if (!verifySignature(secret, body, signatureHeader)) {
    console.error("Webhook signature verification failed");
    return { statusCode: 401, body: "Invalid signature" };
  }

  const githubEvent =
    event.headers["X-GitHub-Event"] ?? event.headers["x-github-event"];

  if (!githubEvent) {
    return { statusCode: 400, body: "Missing X-GitHub-Event header" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON body" };
  }

  try {
    switch (githubEvent) {
      case "pull_request":
        await handlePullRequestEvent(payload as PullRequestEvent);
        break;

      case "issue_comment":
        await handleIssueCommentEvent(payload as IssueCommentEvent);
        break;

      case "pull_request_review_comment":
        await handleReviewCommentEvent(payload as PullRequestReviewCommentEvent);
        break;

      case "check_run":
        await handleCheckRunEvent(payload as CheckRunEvent);
        break;

      case "installation":
        await handleInstallationEvent(payload as InstallationEvent);
        break;

      default:
        console.log(`Ignoring unhandled event type: ${githubEvent}`);
    }
  } catch (error) {
    console.error(`Error handling ${githubEvent} event:`, error);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}
