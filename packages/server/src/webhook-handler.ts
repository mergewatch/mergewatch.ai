import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import type { IInstallationStore, IReviewStore, IFindingDispositionStore, IFPInsightStore, IPRLifecycleStore, ISatisfactionStore, IReviewCostStore, IGitHubAuthProvider, ILLMProvider, AgentReviewConfig,
  IReviewTraceStore,
} from '@mergewatch/core';
import type { ReviewJobPayload, ReviewMode, PullRequestEvent, IssueCommentEvent, PullRequestReviewCommentEvent, InstallationEvent, CheckRunEvent, CheckSuiteEvent, GitHubRepository, IReviewJobQueue } from '@mergewatch/core';
import { REVIEW_TRIGGERING_ACTIONS, COMMENT_LOOKUP_ACTIONS, MERGEWATCH_CHECK_RUN_NAME, checkRunName, decideCheckSuiteRereview, findExistingBotComment, classifyPrSource, fetchRepoConfig, mergeConfig, isBotActor, sweepInlineReactionsOnClose } from '@mergewatch/core';
import { processReviewJob } from './review-processor.js';
// #416 — deployment stage, so review artifacts (comment marker, check-run
// name) are scoped per stage. Absent means prod, which is the frozen
// production identity — see packages/core/src/stage.ts.
const STAGE = process.env.STAGE;


/**
 * #355 — route a review job through the durable queue when wired, else run
 * it in-process (legacy/test path). Fire-and-forget either way: the webhook
 * response must not wait on a review.
 */
function dispatchReviewJob(job: ReviewJobPayload, deps: WebhookDeps, label: string): void {
  if (deps.reviewQueue) {
    deps.reviewQueue.enqueue(job).catch((err) => {
      console.error('Failed to enqueue %s:', label, err);
    });
    return;
  }
  processReviewJob(job, deps).catch((err) => {
    console.error('%s failed:', label, err);
  });
}


export interface WebhookDeps {
  webhookSecret: string;
  installationStore: IInstallationStore;
  reviewStore: IReviewStore;
  /**
   * #355 — durable admission-control queue. When set, review jobs are
   * enqueued and drained by the bounded worker (startReviewWorker) instead
   * of spawning an unbounded fire-and-forget pipeline per webhook. When
   * unset (older wiring, unit tests), dispatch falls back to the direct
   * in-process call.
   */
  reviewQueue?: IReviewJobQueue;
  /**
   * #471 — optional filter-trace store. Best-effort by design: when unset,
   * traces are simply not written and the review is unaffected. A trace is a
   * debugging artifact, so it must never be able to fail a review.
   */
  reviewTraceStore?: IReviewTraceStore;
  /** FB-A — optional disposition store. Best-effort: when unset, writes are
   *  no-ops and the review pipeline runs unchanged. */
  dispositionStore?: IFindingDispositionStore;
  /**
   * FP-J L1 — optional FP-insight store. Read-only on the review path; the
   * processor projects `perCategory` rates into the verdict-tier softener.
   * When unset (or empty rollup), the verdict tier behaves identically to
   * the pre-FP-J shape — no down-weighting.
   */
  fpInsightStore?: IFPInsightStore;
  /**
   * TTM (#194) — optional PR-lifecycle store. Best-effort: when unset, merge
   * tracking is a no-op and the review pipeline runs unchanged.
   */
  prLifecycleStore?: IPRLifecycleStore;
  /**
   * #195 Phase 4 — optional satisfaction store. Best-effort: when unset, the
   * summary 👍/👎 helpful-vote capture is a no-op and the review runs unchanged.
   */
  satisfactionStore?: ISatisfactionStore;
  /**
   * #193 — optional review-cost store. Best-effort: when unset, per-review cost
   * isn't recorded and the `cost` insight block stays absent.
   */
  costStore?: IReviewCostStore;
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
      } else if (event === 'check_suite') {
        // #657 — the Checks-UI "Re-run" button fires check_suite.rerequested,
        // not check_run.rerequested (#558). Until this branch existed the event
        // matched nothing here, so on self-hosted the button did nothing at all.
        await handleCheckSuite(payload as CheckSuiteEvent, deps);
      } else if (event === 'installation') {
        await handleInstallation(payload as InstallationEvent, deps);
      }
    } catch (err) {
      console.error(`Error processing ${event} webhook:`, err);
    }
  };
}

/**
 * TTM (#194) — record PR-lifecycle transitions on the webhook path. Best-effort
 * (the store swallows its own errors) and a no-op when no store is wired.
 *
 *   opened / reopened / ready_for_review → upsertOpened (anchors prCreatedAt)
 *   synchronize                          → recordPush (round-trip proxy)
 *   closed (merged)                      → markMerged (terminal)
 *   closed (unmerged)                    → markClosedUnmerged (terminal)
 */
async function recordPrLifecycle(payload: PullRequestEvent, deps: WebhookDeps) {
  const store = deps.prLifecycleStore;
  if (!store || !payload.installation) return;
  const { action, pull_request: pr, repository, installation } = payload;
  const installationId = String(installation.id);
  const repoFullName = repository.full_name;
  const prNumber = pr.number;
  try {
    if (action === 'closed') {
      if (pr.merged && pr.merged_at) {
        await store.markMerged({ installationId, repoFullName, prNumber, prCreatedAt: pr.created_at, at: pr.merged_at });
      } else {
        // GitHub always sends closed_at on a `closed` action; a missing value
        // signals an unexpected payload, so surface it rather than silently
        // substituting now() (which would skew the cycle-time stat).
        if (!pr.closed_at) {
          console.warn('[ttm] closed PR missing closed_at — using now() (%s#%d):', repoFullName, prNumber);
        }
        await store.markClosedUnmerged({
          installationId, repoFullName, prNumber,
          prCreatedAt: pr.created_at,
          at: pr.closed_at ?? new Date().toISOString(),
        });
      }
    } else if (action === 'synchronize') {
      await store.recordPush(installationId, repoFullName, prNumber);
    } else if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
      await store.upsertOpened({ installationId, repoFullName, prNumber, prCreatedAt: pr.created_at });
    }
  } catch (err) {
    console.warn('[ttm] lifecycle record failed for %s#%d (%s):', repoFullName, prNumber, action, err);
  }
}

/**
 * OSS Program (#261) — repo identity carried on every review job.
 *
 * Self-hosted doesn't run the billing gate (it's behind `isSaas()`), so these
 * are inert here. They're populated anyway to keep `ReviewJobPayload` honest
 * across both runtimes — a payload that means different things depending on
 * which webhook built it is a trap for the next person.
 */
function ossRepoFields(repository: { id: number; private: boolean }) {
  return { repoId: repository.id, isPublic: !repository.private };
}

async function handlePullRequest(payload: PullRequestEvent, deps: WebhookDeps) {
  const { action, pull_request, repository, installation } = payload;
  if (!installation) return;

  // Record lifecycle for every relevant action (incl. `closed`) before the
  // review gate — merges/closes terminate the lifecycle without a review.
  await recordPrLifecycle(payload, deps);

  // FB-C (#189) — reactions don't emit webhooks and the in-review poll can't see
  // a reaction added after the final review (the common case). On the terminal
  // `closed` event, sweep once so end-of-PR 👍/👎 aren't lost.
  if (action === 'closed') {
    try {
      const octokit = await deps.authProvider.getInstallationOctokit(installation.id);
      await sweepInlineReactionsOnClose({
        octokit,
        owner: repository.owner.login,
        repo: repository.name,
        prNumber: pull_request.number,
        reviewStore: deps.reviewStore,
        dispositionStore: deps.dispositionStore,
        installationId: String(installation.id),
        repoFullName: repository.full_name,
      });
    } catch (err) {
      console.warn('[fb-c] close reaction sweep failed to start:', err);
    }
  }

  if (!(REVIEW_TRIGGERING_ACTIONS as readonly string[]).includes(action)) return;

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
      const commentId = await findExistingBotComment(octokit, owner, repo, prNumber, STAGE);
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
    // Head SHA, not the default branch: agentReview is commonly enabled on the
    // PR branch itself, and reading base made every such PR classify as 'human' (#399).
    const yamlConfig = await fetchRepoConfig(octokit, owner, repo, pull_request.head?.sha).catch(() => null);
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
    ...ossRepoFields(repository),
  };

  // Process in background (#355 — via the durable queue when wired)
  dispatchReviewJob(job, deps, `review job ${repository.full_name}#${pull_request.number}`);
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

  // #400 — issue_comment payloads carry no head SHA. Without it the job's
  // config reads fall back to the default branch, so the PR branch's
  // `.mergewatch.yml` (excludePatterns, ux, codebaseAwareness, customAgents)
  // is silently ignored on every mention-triggered review. Best-effort: keep
  // the review going with the old behavior if the lookup fails.
  const headSha = await deps.authProvider
    .getInstallationOctokit(installation.id)
    .then((octokit) =>
      octokit.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: issue.number,
      }),
    )
    .then(({ data }) => data.head?.sha)
    .catch((err) => {
      console.warn(
        'Failed to resolve head SHA for mention-triggered review — config will read from the default branch:',
        `${repository.full_name}#${issue.number}`,
        err,
      );
      return undefined;
    });

  const job: ReviewJobPayload = {
    installationId: installation.id,
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: issue.number,
    mode,
    mentionTriggered: true,
    headSha,
    ...ossRepoFields(repository),
    ...(userComment ? { userComment, userCommentAuthor: comment.user.login } : {}),
  };

  dispatchReviewJob(job, deps, `review job ${repository.full_name}#${issue.number}`);
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
    ...ossRepoFields(repository),
  };

  dispatchReviewJob(job, deps, `inline reply job ${repository.full_name}#${pull_request.number}`);
}

/**
 * True when a check_run event describes a MergeWatch-created check. Matches
 * by name since check_run.app.id requires knowing the GitHub App ID at runtime.
 */
export function isMergeWatchCheckRun(event: CheckRunEvent, stage?: string): boolean {
  // #416 — must resolve from the same stage `createCheckRun` wrote with. A
  // non-prod stage publishes "MergeWatch Review (dev)"; matching only the prod
  // name here would make it ignore its own "Re-run" clicks.
  return event.check_run?.name === checkRunName(stage);
}

/**
 * Handle the "Re-run" button in GitHub's PR Checks UI. GitHub fires
 * check_run.rerequested on our App — we run the same dispatch as a
 * pull_request.synchronize on the PR the check was created for.
 */
async function handleCheckRun(payload: CheckRunEvent, deps: WebhookDeps) {
  if (payload.action !== 'rerequested') return;
  if (!isMergeWatchCheckRun(payload, STAGE)) return;

  const installationId = payload.installation?.id;
  if (!installationId) return;

  const prRef = payload.check_run.pull_requests?.[0];
  if (!prRef) {
    console.warn(
      `check_run rerequested with no attached PR on ${payload.repository.full_name} @ ${payload.check_run.head_sha}`,
    );
    return;
  }

  await enqueueRereview({
    deps,
    installationId,
    repository: payload.repository,
    prNumber: prRef.number,
    trigger: 'check_run rerequested',
  });
}

/**
 * #657 — the Checks-UI "Re-run" button.
 *
 * GitHub fires `check_suite.rerequested` for it, not `check_run.rerequested`
 * (#558). `handleCheckRun` was complete the whole time on this runtime too; the
 * event simply never reached it, so the button was a no-op on every
 * self-hosted install.
 *
 * `check_run.rerequested` is kept: GitHub sends it when a SINGLE run is re-run,
 * which is a different affordance with a different payload shape.
 *
 * The decision — action, installation, attached PR, ownership, fail-closed — is
 * `decideCheckSuiteRereview` in @mergewatch/core, the same call the Lambda
 * webhook makes. Copying that logic here instead is how the ownership rule
 * would drift between the two runtimes.
 */
async function handleCheckSuite(payload: CheckSuiteEvent, deps: WebhookDeps) {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;

  // Resolved inside the callback, which core calls at most once and only for a
  // rerequested suite with a PR attached. `check_suite.requested` fires on
  // every push, and resolving an installation client for each of those would be
  // a token exchange per push for an event we always drop.
  let octokit: Awaited<ReturnType<IGitHubAuthProvider['getInstallationOctokit']>> | undefined;
  const decision = await decideCheckSuiteRereview(payload, {
    stage: STAGE,
    listCheckRunNames: async (ref, checkName) => {
      octokit = await deps.authProvider.getInstallationOctokit(payload.installation!.id);
      const { data } = await octokit.checks.listForRef({
        owner, repo, ref, check_name: checkName, per_page: 100,
      });
      return data.check_runs.map((c: { name: string }) => c.name);
    },
  });

  if (!decision.rereview) {
    // `notable` keeps this off the every-push path: `check_suite.requested`
    // fires on each push, and another App's suite being re-run is routine.
    // Everything else here followed a human clicking Re-run, so it is logged.
    if (decision.notable) console.warn('check_suite not re-reviewed:', decision.reason);
    return;
  }

  await enqueueRereview({
    deps,
    installationId: decision.installationId,
    repository: payload.repository,
    prNumber: decision.prNumber,
    trigger: 'check_suite rerequested',
    // Already resolved by the ownership check — re-resolving would be a second
    // token exchange per click, and a second place to fail after ownership has
    // already passed (#562).
    octokit,
  });
}

/**
 * Shared tail for both re-run entry points (#657).
 *
 * Extracted from `handleCheckRun` rather than copied into the new
 * `check_suite` path: the two must produce an identical review job, and two
 * copies of the PR refetch + classification + comment lookup would drift the
 * first time one of them was touched. The Lambda webhook has the same
 * extraction for the same reason.
 *
 * Deliberately NOT unified with the Lambda's version: this one uses the PR's
 * head SHA (not the event's) and lets `pulls.get` throw, which is what this
 * runtime has always done. Changing that here would be an unrelated behaviour
 * change smuggled into a fix for a dead button (#657 keeps it as a follow-up).
 */
async function enqueueRereview(args: {
  deps: WebhookDeps;
  installationId: number;
  repository: GitHubRepository;
  prNumber: number;
  trigger: string;
  /**
   * An already-resolved client, when the caller needed one anyway (the
   * check_suite ownership check does).
   */
  octokit?: Awaited<ReturnType<IGitHubAuthProvider['getInstallationOctokit']>>;
}) {
  const { deps, installationId, repository, prNumber, trigger } = args;
  const owner = repository.owner.login;
  const repo = repository.name;

  let octokit = args.octokit;
  if (!octokit) {
    try {
      octokit = await deps.authProvider.getInstallationOctokit(installationId);
    } catch (err) {
      console.warn(`Failed to obtain installation Octokit for ${trigger} dispatch:`, err);
      return;
    }
  }

  // Refetch the PR so we get labels/draft/changed_files for the job payload.
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });

  // Read config at the head SHA — an agentReview block on the PR branch is
  // invisible from the default branch (#399).
  const yamlConfig = await fetchRepoConfig(octokit, owner, repo, pr.head?.sha).catch(() => null);
  const agentReviewConfig: AgentReviewConfig | undefined = yamlConfig?.agentReview
    ? mergeConfig(yamlConfig).agentReview
    : undefined;
  const classification = await classifyPrSource(pr as never, octokit, agentReviewConfig);

  const existingCommentId =
    (await findExistingBotComment(octokit, owner, repo, prNumber, STAGE).catch(() => null)) ?? undefined;

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
    // #639 — the identity of the check run this re-run owns, minted once per
    // click and written as the run's `external_id` by the review processor.
    //
    // A re-run reviews the SAME commit, so #526's "update the latest run for
    // this (sha, name)" lookup resolves to the PREVIOUS review's completed run:
    // every write for the re-run lands on it, no fresh run appears, and branch
    // protection keeps reporting the old verdict. Minted here rather than in the
    // processor because one enqueue can be processed more than once (the queue
    // worker redelivers a throttled job, replaying this exact payload), and all
    // of those attempts must converge on one run.
    //
    // Only the re-run paths get a key; every other path keeps #526's behaviour.
    checkRunKey: randomUUID(),
    ...ossRepoFields(repository),
  };

  dispatchReviewJob(job, deps, `review job (${trigger}) ${repository.full_name}#${prNumber}`);
}

async function handleInstallation(payload: InstallationEvent, deps: WebhookDeps) {
  const { action, installation, repositories } = payload;
  if (action !== 'created' || !repositories) return;

  for (const repo of repositories) {
    await deps.installationStore.upsert({
      installationId: String(installation.id),
      repoFullName: repo.full_name as string,
      installedAt: new Date().toISOString(),
    });
  }
}
