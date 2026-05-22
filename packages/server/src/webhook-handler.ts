import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { IInstallationStore, IReviewStore, IFindingDispositionStore, IGitHubAuthProvider, ILLMProvider, AgentReviewConfig } from '@mergewatch/core';
import type { ReviewJobPayload, ReviewMode, PullRequestEvent, IssueCommentEvent, PullRequestReviewCommentEvent, InstallationEvent, CheckRunEvent } from '@mergewatch/core';
import { REVIEW_TRIGGERING_ACTIONS, COMMENT_LOOKUP_ACTIONS, MERGEWATCH_CHECK_RUN_NAME, findExistingBotComment, classifyPrSource, fetchRepoConfig, mergeConfig, isBotActor } from '@mergewatch/core';
import { processReviewJob } from './review-processor.js';

export interface WebhookDeps {
  webhookSecret: string;
  installationStore: IInstallationStore;
  reviewStore: IReviewStore;
  /** FB-A — optional disposition store. Best-effort: when unset, writes are
   *  no-ops and the review pipeline runs unchanged. */
  dispositionStore?: IFindingDispositionStore;
  authProvider: IGitHubAuthProvider;
  llm: ILLMProvider;
  dashboardBaseUrl: string;
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function parseReviewMode(body: string): { mode: ReviewMode; userComment?: string } | null {
  const lower = body.toLowerCase().trim();
  if (lower.includes('@mergewatch review')) return { mode: 'review' };
  if (lower.includes('@mergewatch summary')) return { mode: 'summary' };
  if (lower.includes('@mergewatch')) return { mode: 'respond', userComment: body };
  return null;
}

export function createWebhookHandler(deps: WebhookDeps) {
  return async (req: Request, res: Response) => {
    const signature = req.headers['x-hub-signature-256'] as string;
    const event = req.headers['x-github-event'] as string;
    const rawBody = (req as any).rawBody as string;

    if (!signature || !rawBody || !verifySignature(rawBody, signature, deps.webhookSecret)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const payload = req.body;

    // Acknowledge immediately
    res.status(200).json({ ok: true });

    try {
      if (event === 'pull_request') {
        await handlePullRequest(payload as PullRequestEvent, deps);
      } else if (event === 'issue_comment') {
        await handleIssueComment(payload as IssueCommentEvent, deps);
      } else if (event === 'pull_request_review_comment') {
        await handleReviewComment(payload as PullRequestReviewCommentEvent, deps);
      } else if (event === 'check_run') {
        await handleCheckRun(payload as CheckRunEvent, deps);
      } else if (event === 'installation') {
        await handleInstallation(payload as InstallationEvent, deps);
      }
    } catch (err) {
      console.error(`Error processing ${event} webhook:`, err);
    }
  };
}

async function handlePullRequest(payload: PullRequestEvent, deps: WebhookDeps) {
  const { action, pull_request, repository, installation } = payload;
  if (!installation || !(REVIEW_TRIGGERING_ACTIONS as readonly string[]).includes(action)) return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;

  // Resolve an Octokit up front — we need it for classification and,
  // conditionally, for the existing-comment lookup on re-open / sync.
  let octokit: Awaited<ReturnType<IGitHubAuthProvider['getInstallationOctokit']>> | null = null;
  try {
    octokit = await deps.authProvider.getInstallationOctokit(installation.id);
  } catch (err) {
    console.warn('Failed to obtain installation Octokit for classification:', err);
  }

  let existingCommentId: number | undefined;
  if (octokit && (COMMENT_LOOKUP_ACTIONS as readonly string[]).includes(action)) {
    try {
      const commentId = await findExistingBotComment(octokit, owner, repo, prNumber);
      if (commentId) existingCommentId = commentId;
    } catch (err) {
      console.warn('Failed to look up existing bot comment:', err);
    }
  }

  // Classify PR source when we have an Octokit. The classifier itself handles
  // API failures internally and falls back to 'human'.
  let source: 'agent' | 'human' | undefined;
  let agentKind: ReviewJobPayload['agentKind'];
  if (octokit) {
    const yamlConfig = await fetchRepoConfig(octokit, owner, repo).catch(() => null);
    const agentReviewConfig: AgentReviewConfig | undefined = yamlConfig?.agentReview
      ? mergeConfig(yamlConfig).agentReview
      : undefined;
    const classification = await classifyPrSource(pull_request, octokit, agentReviewConfig);
    source = classification.source;
    agentKind = classification.agentKind;
    console.log(
      `Classified ${owner}/${repo}#${prNumber} as ${classification.source}${classification.agentKind ? ' (' + classification.agentKind + ')' : ''} via ${classification.matchedRule ?? 'default'}`,
    );
  }

  const job: ReviewJobPayload = {
    installationId: installation.id,
    owner,
    repo,
    prNumber,
    mode: 'review',
    existingCommentId,
    isDraft: pull_request.draft ?? false,
    prLabels: pull_request.labels?.map((l) => l.name) ?? [],
    changedFileCount: pull_request.changed_files,
    source,
    agentKind,
    headSha: pull_request.head?.sha,
  };

  // Process in background
  processReviewJob(job, deps).catch((err) => {
    console.error('Review job failed for %s#%d:', repository.full_name, pull_request.number, err);
  });
}

async function handleIssueComment(payload: IssueCommentEvent, deps: WebhookDeps) {
  const { action, comment, issue, repository, installation, sender } = payload;
  if (action !== 'created' || !installation || !issue.pull_request) return;

  // Ignore comments from any bot — both the webhook sender and the comment
  // author. GitHub Apps acting via OAuth may surface as type=User but still
  // carry a `[bot]` login suffix; we want to catch those too so MergeWatch
  // never replies to CopilotAI / dependabot / other reviewer bots.
  if (isBotActor(sender) || isBotActor(comment.user)) return;

  const parsed = parseReviewMode(comment.body);
  if (!parsed) return; // No @mergewatch mention — ignore comment

  const { mode, userComment } = parsed;

  const job: ReviewJobPayload = {
    installationId: installation.id,
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: issue.number,
    mode,
    mentionTriggered: true,
    ...(userComment ? { userComment, userCommentAuthor: comment.user.login } : {}),
  };

  processReviewJob(job, deps).catch((err) => {
    console.error('Review job failed for %s#%d:', repository.full_name, issue.number, err);
  });
}

async function handleReviewComment(payload: PullRequestReviewCommentEvent, deps: WebhookDeps) {
  const { action, comment, pull_request, repository, installation, sender } = payload;
  if (action !== 'created' || !installation) return;
  if (isBotActor(sender) || isBotActor(comment.user)) return; // loop guard — checks both
  if (comment.in_reply_to_id == null) return; // not a reply

  const job: ReviewJobPayload = {
    installationId: installation.id,
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: pull_request.number,
    mode: 'inline_reply',
    inlineReplyCommentId: comment.id,
  };

  processReviewJob(job, deps).catch((err) => {
    console.error('Inline reply job failed for %s#%d:', repository.full_name, pull_request.number, err);
  });
}

/**
 * True when a check_run event describes a MergeWatch-created check. Matches
 * by name since check_run.app.id requires knowing the GitHub App ID at runtime.
 */
export function isMergeWatchCheckRun(event: CheckRunEvent): boolean {
  return event.check_run?.name === MERGEWATCH_CHECK_RUN_NAME;
}

/**
 * Handle the "Re-run" button in GitHub's PR Checks UI. GitHub fires
 * check_run.rerequested on our App — we run the same dispatch as a
 * pull_request.synchronize on the PR the check was created for.
 */
async function handleCheckRun(payload: CheckRunEvent, deps: WebhookDeps) {
  if (payload.action !== 'rerequested') return;
  if (!isMergeWatchCheckRun(payload)) return;

  const installationId = payload.installation?.id;
  if (!installationId) return;

  const prRef = payload.check_run.pull_requests?.[0];
  if (!prRef) {
    console.warn(
      `check_run rerequested with no attached PR on ${payload.repository.full_name} @ ${payload.check_run.head_sha}`,
    );
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = prRef.number;

  let octokit: Awaited<ReturnType<IGitHubAuthProvider['getInstallationOctokit']>> | null = null;
  try {
    octokit = await deps.authProvider.getInstallationOctokit(installationId);
  } catch (err) {
    console.warn('Failed to obtain installation Octokit for check_run dispatch:', err);
    return;
  }

  // Refetch the PR so we get labels/draft/changed_files for the job payload.
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });

  const yamlConfig = await fetchRepoConfig(octokit, owner, repo).catch(() => null);
  const agentReviewConfig: AgentReviewConfig | undefined = yamlConfig?.agentReview
    ? mergeConfig(yamlConfig).agentReview
    : undefined;
  const classification = await classifyPrSource(pr as never, octokit, agentReviewConfig);

  const existingCommentId =
    (await findExistingBotComment(octokit, owner, repo, prNumber).catch(() => null)) ?? undefined;

  const job: ReviewJobPayload = {
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
  };

  processReviewJob(job, deps).catch((err) => {
    console.error('Review job (check_run rerequested) failed for %s#%d:', payload.repository.full_name, prNumber, err);
  });
}

async function handleInstallation(payload: InstallationEvent, deps: WebhookDeps) {
  const { action, installation, repositories } = payload;
  if (action !== 'created' || !repositories) return;

  for (const repo of repositories) {
    await deps.installationStore.upsert({
      installationId: String(installation.id),
      repoFullName: repo.full_name as string,
      installedAt: new Date().toISOString(),
      config: {},
    });
  }
}
