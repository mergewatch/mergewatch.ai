/**
 * AWS Lambda handler for the MergeWatch review agent.
 *
 * Triggered asynchronously by the WebhookHandler Lambda via Lambda Invoke API.
 *
 * This handler wires together:
 *   - BedrockLLMProvider (ILLMProvider)
 *   - DynamoInstallationStore + DynamoReviewStore (IInstallationStore + IReviewStore)
 *   - SSMGitHubAuthProvider (IGitHubAuthProvider)
 *   - Core review pipeline (runReviewPipeline)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  getPRDiff,
  getPRContext,
  findExistingBotComment,
  postReviewComment,
  updateReviewComment,
  addPRReaction,
  removePRReaction,
  getCommentReactions,
  postReplyComment,
  createCheckRun,
  runReviewPipeline,
  formatReviewComment,
  countBlockingCriticals,
  buildCheckTitle,
  isThrottleError,
  computeDiffStats,
  mergeConfig,
  shouldSkipPR,
  extractIncludePatterns,
  shouldSkipByRules,
  isAutoReviewOff,
  filterDiff,
  RESPOND_PROMPT,
  BOT_COMMENT_MARKER,
  submitPRReview,
  dismissStaleReviews,
  mergeScoreToReviewEvent,
  buildInlineComments,
  extractInlineCommentTitle,
  fetchRepoConfig,
  fetchConventions,
  loadCategoryDisputeRates,
  handleInlineReply,
  persistInlineResolveMemory,
  fetchTriageComments,
  computeDisputedKeys,
  partitionDisputed,
  recordFindingSurfacings,
  recordDisputes,
  recordResolves,
  detectQuietDrops,
  recordQuietDrops,
  pollAndRecordInlineReactions,
  recordSummaryHelpfulVotes,
  selectOrgAgentsForReview,
  unionCustomAgents,
  blockingCriticalAgents,
  languagesFromFiles,
  findingMatchKeys,
  resolveReviewModelId,
  buildReviewTrace,
  buildReviewDetailUrl,
} from '@mergewatch/core';
import type { RejectCategory, FindingDispositionRecord } from '@mergewatch/core';
import type {
  ReviewJobPayload,
  ReviewItem,
  ReviewFinding,
  MergeWatchConfig,
  FileFetchOptions,
  ReviewDelta,
} from '@mergewatch/core';
import {
  buildWorkDoneSection, computeReviewDelta, resolveAppLogin,
  checkInputBudget, describeOverBudget,
} from '@mergewatch/core';
import { DynamoInstallationStore,
  DynamoReviewTraceStore,
} from '@mergewatch/storage-dynamo';
import {

  DynamoReviewStore,
  DynamoFindingDispositionStore,
  DEFAULT_FINDING_DISPOSITIONS_TABLE,
  DynamoFPInsightStore,
  DEFAULT_FP_INSIGHTS_TABLE,
  DynamoPRLifecycleStore,
  DEFAULT_PR_LIFECYCLE_TABLE,
  DynamoSatisfactionStore,
  DEFAULT_SATISFACTION_TABLE,
  DynamoReviewCostStore,
  DEFAULT_REVIEW_COSTS_TABLE,
} from '@mergewatch/storage-dynamo';
import { BedrockLLMProvider, SUPPORTED_MODELS } from '@mergewatch/llm-bedrock';
import { isSaas, billingCheck, recordReview, postBlockedCheckRun, ensureBillingIssue, updateBillingFields, getStripe, isLapsedOssGrant } from '@mergewatch/billing';
import { SSMGitHubAuthProvider } from '../github-auth-ssm.js';
import { payloadFromEvent, attemptFromEvent, rateLimitedCheckSummary, type ReviewAgentEvent } from './review-agent-event.js';
// #416 — deployment stage, so review artifacts (comment marker, check-run
// name) are scoped per stage. Absent means prod, which is the frozen
// production identity — see packages/core/src/stage.ts.
const STAGE = process.env.STAGE;

// -- Singletons (re-used across warm invocations) ----------------------------

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INSTALLATIONS_TABLE = process.env.INSTALLATIONS_TABLE ?? 'mergewatch-installations';
const REVIEWS_TABLE = process.env.REVIEWS_TABLE ?? 'mergewatch-reviews';
const FINDING_DISPOSITIONS_TABLE = process.env.FINDING_DISPOSITIONS_TABLE ?? DEFAULT_FINDING_DISPOSITIONS_TABLE;
const FP_INSIGHTS_TABLE = process.env.FP_INSIGHTS_TABLE ?? DEFAULT_FP_INSIGHTS_TABLE;
const PR_LIFECYCLE_TABLE = process.env.PR_LIFECYCLE_TABLE ?? DEFAULT_PR_LIFECYCLE_TABLE;
const SATISFACTION_TABLE = process.env.SATISFACTION_TABLE ?? DEFAULT_SATISFACTION_TABLE;
const REVIEW_COSTS_TABLE = process.env.REVIEW_COSTS_TABLE ?? DEFAULT_REVIEW_COSTS_TABLE;
// Last-resort model when the deploy-time parameter is unset. The deployed
// value comes from infra/params/{dev,prod}.env via DEFAULT_BEDROCK_MODEL_ID;
// this constant only applies to a stack that never received the parameter.
const FALLBACK_BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';
const DEFAULT_BEDROCK_MODEL_ID = process.env.DEFAULT_BEDROCK_MODEL_ID ?? FALLBACK_BEDROCK_MODEL_ID;
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL ?? 'https://mergewatch.ai';

const installationStore = new DynamoInstallationStore(dynamodb, INSTALLATIONS_TABLE);
const reviewStore = new DynamoReviewStore(dynamodb, REVIEWS_TABLE);
// #471 — separate table, separate store. Writes are best-effort (see below):
// a trace is a debugging artifact and must never be able to fail a review.
const REVIEW_TRACES_TABLE = process.env.REVIEW_TRACES_TABLE ?? 'mergewatch-review-traces';
const reviewTraceStore = new DynamoReviewTraceStore(dynamodb, REVIEW_TRACES_TABLE);
// FB-A — per-finding cross-PR dispositions. Best-effort writes; if the
// table doesn't exist yet (mid-deploy state) the store layer swallows.
const dispositionStore = new DynamoFindingDispositionStore(dynamodb, FINDING_DISPOSITIONS_TABLE);
// FP-J L1 — read-only on the review path; the FB-E rollup writes here
// nightly. loadCategoryDisputeRates returns `{}` on every failure path,
// so the verdict tier behaves identically to pre-FP-J when the table is
// empty or unprovisioned (back-compat for the SaaS rollout window).
const fpInsightStore = new DynamoFPInsightStore(dynamodb, FP_INSIGHTS_TABLE);
// TTM (#194) — marks reviewed/skipped on the PR-lifecycle row the webhook
// opened. Best-effort; swallows if the table isn't provisioned yet.
const prLifecycleStore = new DynamoPRLifecycleStore(dynamodb, PR_LIFECYCLE_TABLE);
// #195 Phase 4 — captures summary 👍/👎 helpful votes into the engagement
// rollup. Best-effort; swallows if the table isn't provisioned yet.
const satisfactionStore = new DynamoSatisfactionStore(dynamodb, SATISFACTION_TABLE);
// #193 — denormalizes per-review cost for the nightly cost rollup. Best-effort;
// swallows if the table isn't provisioned yet.
const costStore = new DynamoReviewCostStore(dynamodb, REVIEW_COSTS_TABLE);
const llm = new BedrockLLMProvider();
const authProvider = new SSMGitHubAuthProvider();

// -- Conversational response handler -----------------------------------------

async function handleRespondMode(
  octokit: Awaited<ReturnType<typeof authProvider.getInstallationOctokit>>,
  event: ReviewJobPayload,
): Promise<{ statusCode: number; body: string }> {
  const { owner, repo, prNumber, userComment, userCommentAuthor } = event;
  const repoFullName = `${owner}/${repo}`;

  try {
    const prevReviews = await reviewStore.queryByPR(repoFullName, `${prNumber}#`, 5);

    const latestReview = prevReviews.find((item) => item.status === 'complete');

    const findingsContext = latestReview?.findings
      ? JSON.stringify(latestReview.findings, null, 2)
      : 'No previous findings available.';
    const summaryContext = (latestReview?.summaryText as string) ?? 'No summary available.';

    if (latestReview?.commentId) {
      const reactions = await getCommentReactions(
        octokit, owner, repo, latestReview.commentId as number,
      );
      if (Object.keys(reactions).length > 0) {
        await reviewStore.updateStatus(
          repoFullName,
          latestReview.prNumberCommitSha as string,
          latestReview.status as 'complete',
          { reactions },
        ).catch(() => {});
      }
    }

    const modelId = DEFAULT_BEDROCK_MODEL_ID;

    const prompt = `${RESPOND_PROMPT}

--- Previous Review Summary ---
${summaryContext}

--- Previous Review Findings ---
${findingsContext}

--- Developer Comment (from @${userCommentAuthor ?? 'unknown'}) ---
${userComment}

Please respond to the developer's comment:`;

    const rawResponse = await llm.invoke(modelId, prompt);
    const response = typeof rawResponse === 'string' ? rawResponse : rawResponse.text;

    await postReplyComment(octokit, owner, repo, prNumber, response);

    console.log(`Posted conversational response for ${repoFullName}#${prNumber}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Response posted' }),
    };
  } catch (error) {
    console.error(`Respond failed for ${repoFullName}#${prNumber}:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Respond failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

// -- Inline reply mode -------------------------------------------------------

/**
 * Handle an inline thread reply: the core handler runs the LLM + posts the
 * reply (or resolves the thread), and this wrapper rolls the cost up onto the
 * parent review record so the PR's cumulative cost stays honest.
 */
async function handleInlineReplyMode(
  octokit: Awaited<ReturnType<typeof authProvider.getInstallationOctokit>>,
  event: ReviewJobPayload,
): Promise<{ statusCode: number; body: string }> {
  const { owner, repo, prNumber, installationId, inlineReplyCommentId } = event;
  const repoFullName = `${owner}/${repo}`;

  if (inlineReplyCommentId == null) {
    return { statusCode: 400, body: JSON.stringify({ message: 'inline_reply mode requires inlineReplyCommentId' }) };
  }

  try {
    // Look up the parent review so we can pass conventions (if configured) and
    // later roll cost up onto it.
    const prevReviews = await reviewStore.queryByPR(repoFullName, `${prNumber}#`, 5).catch(() => [] as ReviewItem[]);
    const latestReview = prevReviews.find((r) => r.status === 'complete');

    // Load repo config + conventions from the review's head SHA if we have one,
    // else default branch. The config read must use the same ref as the
    // conventions read, or `conventions:` set on the PR branch is looked up
    // against a path that only exists at head (#400).
    const ref = latestReview?.prNumberCommitSha
      ? (latestReview.prNumberCommitSha as string).split('#')[1]
      : undefined;
    const yamlConfig = await fetchRepoConfig(octokit, owner, repo, ref).catch(() => null);
    const conventionsResult = await fetchConventions(octokit, owner, repo, ref, yamlConfig?.conventions).catch(() => null);

    const result = await handleInlineReply(
      {
        owner,
        repo,
        prNumber,
        replyCommentId: inlineReplyCommentId,
        conventions: conventionsResult?.content,
      },
      {
        octokit,
        llm,
        lightModelId: process.env.DEFAULT_LIGHT_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    );

    // Roll cost up onto the parent review record so the PR's cumulative cost
    // reflects inline conversations too. We only update if we actually spent
    // tokens (the explicit-resolve fast path has zero cost).
    if (latestReview && (result.inputTokens > 0 || result.outputTokens > 0)) {
      const newInput = (latestReview.inputTokens ?? 0) + result.inputTokens;
      const newOutput = (latestReview.outputTokens ?? 0) + result.outputTokens;
      const newCost = (latestReview.estimatedCostUsd ?? 0) + (result.estimatedCostUsd ?? 0);
      await reviewStore.updateStatus(
        repoFullName,
        latestReview.prNumberCommitSha as string,
        latestReview.status as 'complete',
        {
          inputTokens: newInput,
          outputTokens: newOutput,
          estimatedCostUsd: newCost,
        },
      ).catch((err) => console.warn('Failed to roll up inline reply cost:', err));
    }

    // FP-F — persist inline-resolve memory + record dispute analytics.
    // The shared helper handles drop-point diagnostics, fingerprint
    // enrichment, the bounded merge, and the success-conditional log
    // (only fires on actual await completion via try/catch, not
    // `.then`-orphaned). recordDisputes runs independently — its
    // analytics signal is decoupled from inlineResolvedKeys persistence.
    if (result.action === 'resolved') {
      await persistInlineResolveMemory({
        reviewStore,
        latestReview,
        resolvedFindingKeys: result.resolvedFindingKeys,
        repoFullName,
        prNumber,
      });
      if (result.resolvedFindingKeys && result.resolvedFindingKeys.length > 0) {
        await recordDisputes(dispositionStore, installationId, repoFullName, result.resolvedFindingKeys);
        // #195 — also record the positive engagement signal (separate from the
        // FP-F dispute increment above) so command-usage / action KPIs see it.
        await recordResolves(dispositionStore, installationId, repoFullName, result.resolvedFindingKeys);
      }
    }

    // FB-D — `/mergewatch reject` persists a categorised rejection per
    // match key. Mirrors the server handler.
    if (
      installationId != null &&
      result.action === 'rejected' &&
      result.rejectedFindingKeys &&
      result.rejectedFindingKeys.length > 0 &&
      result.rejectCategory
    ) {
      const inst = String(installationId);
      const at = new Date().toISOString();
      // Reuse the exported RejectCategory + FindingDispositionRecord shapes
      // so the inline type can't drift if the categories are widened.
      const reason: NonNullable<FindingDispositionRecord['rejectReasons']>[number] = {
        category: result.rejectCategory as RejectCategory,
        ...(result.rejectText ? { text: result.rejectText } : {}),
        at,
      };
      // Parallel + summary-logged. See server/review-processor.ts for
      // the rationale (one log line for a batch of failures, not one per
      // key — easier to grep, sufficient for the analytics-volume scale).
      const settled = await Promise.allSettled(
        result.rejectedFindingKeys.map((key) =>
          dispositionStore.appendRejectReason(inst, repoFullName, key, reason),
        ),
      );
      const failed = settled.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(
          '[fb-d] %d/%d appendRejectReason write(s) failed for %s#%d (category=%s)',
          failed, settled.length, repoFullName, prNumber, result.rejectCategory,
        );
      }
      await recordDisputes(dispositionStore, installationId, repoFullName, result.rejectedFindingKeys);
      console.log(
        '[fb-d] recorded %d /mergewatch reject%s (category=%s) on %s#%d',
        result.rejectedFindingKeys.length,
        result.rejectedFindingKeys.length === 1 ? '' : 's',
        result.rejectCategory,
        repoFullName,
        prNumber,
      );
    }

    console.log(
      'Inline reply %s for %s#%d (reply=%d, cost=$%s)',
      result.action,
      repoFullName,
      prNumber,
      inlineReplyCommentId,
      result.estimatedCostUsd?.toFixed(4) ?? '0',
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ action: result.action }),
    };
  } catch (error) {
    console.error('Inline reply failed for %s#%d:', repoFullName, prNumber, error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Inline reply failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

// -- Lambda handler ----------------------------------------------------------

export async function handler(
  rawEvent: ReviewAgentEvent,
): Promise<{ statusCode: number; body: string }> {
  // #355 — jobs arrive via the SQS queue (Records-wrapped) or legacy direct
  // invoke; normalize before anything touches the payload. #370 — the SQS
  // receive count numbers the throttle-parked check's attempts.
  const event = payloadFromEvent(rawEvent);
  const deliveryAttempt = attemptFromEvent(rawEvent);
  const { installationId, owner, repo, prNumber, mode, existingCommentId, userComment, userCommentAuthor } = event;
  const repoFullName = `${owner}/${repo}`;

  console.log(`Starting ${mode} for ${repoFullName}#${prNumber}`);

  const octokit = await authProvider.getInstallationOctokit(installationId);

  // ── Handle "respond" mode: conversational follow-up ────────────────────
  if (mode === 'respond' && userComment) {
    return handleRespondMode(octokit, event);
  }

  // ── Handle "inline_reply" mode: threaded conversation on a finding ─────
  if (mode === 'inline_reply') {
    return handleInlineReplyMode(octokit, event);
  }

  // ── Handle "review" / "summary" modes ──────────────────────────────────

  // Load .mergewatch.yml first so we can evaluate autoReview before any
  // GitHub-visible side effect (eyes reaction, in-progress check run, PR
  // review). A repo with `rules.autoReview: false` is a parked install —
  // we go fully silent: no reactions, no check runs, no storage write.
  // Other skip kinds (draft, maxFiles, labels) still surface a check run
  // via shouldSkipByRules below; only autoReviewOff goes silent.
  //
  // Read at the PR's headSha when we have it, so config changes on the PR
  // branch take effect. Falls back to the default branch when headSha is
  // absent (e.g. legacy job payloads in flight from before this change).
  const yamlConfig = await fetchRepoConfig(octokit, owner, repo, event.headSha).catch((err) => {
    // Static format string; user-controlled values pass as separate args
    // to avoid feeding repo names through Node's printf-style formatter.
    console.warn('Failed to fetch .mergewatch.yml — proceeding without YAML config:', `${repoFullName}#${prNumber}`, err);
    return null;
  });

  if (isAutoReviewOff(yamlConfig, event.mentionTriggered)) {
    console.log(`autoReview off — silently skipping ${repoFullName}#${prNumber}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Skipped silently (autoReview off)' }),
    };
  }

  const prContext = await getPRContext(octokit, owner, repo, prNumber);
  const headSha = prContext.headSha;
  const shortSha = headSha.slice(0, 7);
  const prNumberCommitSha = `${prNumber}#${shortSha}`;

  const includePatterns = extractIncludePatterns(yamlConfig);

  // ── Smart skip — bypass when user explicitly requested a review via @mergewatch ────
  const skipReason = event.mentionTriggered ? null : shouldSkipPR(prContext.files, includePatterns);
  if (skipReason) {
    console.log(`Skipping ${repoFullName}#${prNumber}: ${skipReason}`);

    const skippedRecord: ReviewItem = {
      repoFullName,
      prNumberCommitSha,
      status: 'skipped',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      prTitle: prContext.title,
      prAuthor: prContext.prAuthor,
      prAuthorAvatar: prContext.prAuthorAvatar,
      headBranch: prContext.headBranch,
      baseBranch: prContext.baseBranch,
      installationId: String(installationId),
      skipReason,
      source: event.source,
      agentKind: event.agentKind,
    };
    await reviewStore.upsert(skippedRecord);
    await prLifecycleStore.markSkipped(String(installationId), repoFullName, prNumber, new Date().toISOString());

    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'neutral',
      title: 'Review skipped',
      summary: skipReason,
    }, STAGE);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Skipped', reason: skipReason }),
    };
  }

  // ── Billing gate (SaaS only) ────
  //
  // OSS Program (#261): repo context is only present when the webhook carried
  // it. Absent (older in-flight jobs), the gate skips OSS evaluation and
  // behaves exactly as it did pre-#261.
  const ossRepoContext = event.repoId != null && event.isPublic != null
    ? { repoId: event.repoId, repoFullName, isPublic: event.isPublic }
    : undefined;

  if (isSaas()) {
    const billing = await billingCheck(
      dynamodb,
      INSTALLATIONS_TABLE,
      String(installationId),
      ossRepoContext,
    );
    if (billing.status === 'block') {
      console.log(`Billing blocked for installation ${installationId}`);

      // #261 — a maintainer whose OSS grant lapsed or hit its cap gets copy
      // pointing at renewal / BYOK, not "add a credit card".
      const blockVariant = isLapsedOssGrant(billing.ossReason) ? 'oss' as const : 'credits' as const;

      await postBlockedCheckRun(octokit, owner, repo, headSha, blockVariant);

      if (billing.firstBlock) {
        await ensureBillingIssue(octokit, owner, repo, String(installationId), dynamodb, INSTALLATIONS_TABLE, blockVariant);
        await updateBillingFields(dynamodb, INSTALLATIONS_TABLE, String(installationId), {
          blockedAt: new Date().toISOString(),
        });
      }

      return {
        statusCode: 402,
        body: JSON.stringify({ message: 'Billing: credits required' }),
      };
    }
  }

  // Atomically claim this review — prevents duplicate processing
  const reviewStartedAt = new Date().toISOString();
  const reviewRecord: ReviewItem = {
    repoFullName,
    prNumberCommitSha,
    status: 'in_progress',
    createdAt: reviewStartedAt,
    prTitle: prContext.title,
    prAuthor: prContext.prAuthor,
    prAuthorAvatar: prContext.prAuthorAvatar,
    headBranch: prContext.headBranch,
    baseBranch: prContext.baseBranch,
    installationId: String(installationId),
    source: event.source,
    agentKind: event.agentKind,
  };
  const claimed = await reviewStore.claimReview(reviewRecord);
  if (!claimed) {
    console.log(`Review already in progress for ${repoFullName}#${prNumber}@${shortSha}, skipping`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Already in progress', prNumberCommitSha }),
    };
  }

  // Capture the eyes reaction ID so we can clear it once the review completes,
  // so the PR doesn't stay in a "MergeWatch is still looking" state forever.
  const eyesReactionId = await addPRReaction(octokit, owner, repo, prNumber, 'eyes');

  await createCheckRun(octokit, owner, repo, headSha, {
    status: 'in_progress',
    title: 'Review in progress',
    summary: `MergeWatch is reviewing PR #${prNumber}...`,
  }, STAGE);

  try {
    const diff = await getPRDiff(octokit, owner, repo, prNumber);

    const installation = await installationStore.get(String(installationId), repoFullName);

    const instSettings = await installationStore.getSettings(String(installationId));
    // #235 — org custom agents (dashboard-defined). Best-effort; never break a
    // review on a store read failure.
    const orgCustomAgents = await installationStore
      .getCustomAgents(String(installationId))
      .catch((err) => {
        console.warn('Failed to load org custom agents:', err);
        return [];
      });

    const severityMap = { Low: 'info', Med: 'warning', High: 'critical' } as const;
    const settingsOverrides: Partial<MergeWatchConfig> = {
      minSeverity: severityMap[instSettings.severityThreshold],
      maxFindings: instSettings.maxComments,
      agents: {
        security: instSettings.commentTypes.logic,
        bugs: instSettings.commentTypes.syntax,
        style: instSettings.commentTypes.style,
        summary: instSettings.summary.prSummary,
        diagram: true,
        errorHandling: true,
        testCoverage: true,
        commentAccuracy: true,
      },
      customStyleRules: instSettings.customInstructions
        ? [instSettings.customInstructions]
        : [],
    };

    // yamlConfig was loaded earlier for the smart-skip includePatterns
    // override; reuse it here instead of paying another GitHub round-trip.
    // Precedence: defaults < dashboard settings < the repo's committed
    // .mergewatch.yml — the yml wins per the documented configuration
    // contract; dashboard values apply only where the yml is silent.
    const runtimeConfig = mergeConfig({
      ...settingsOverrides,
      ...(yamlConfig ?? {}),
      agents: { ...settingsOverrides.agents, ...(yamlConfig?.agents ?? {}) },
    });

    // ── Rules-based skip (skipDrafts, maxFiles, ignoreLabels, autoReview, reviewOnMention) ────
    const rulesSkip = shouldSkipByRules(runtimeConfig.rules, {
      isDraft: event.isDraft,
      labels: event.prLabels,
      changedFileCount: event.changedFileCount ?? prContext?.files?.length,
      mode,
      mentionTriggered: event.mentionTriggered,
    });
    if (rulesSkip) {
      console.log(`Rules skip ${repoFullName}#${prNumber} (${rulesSkip.kind}): ${rulesSkip.reason}`);

      await reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'skipped', {
        completedAt: new Date().toISOString(),
        skipReason: rulesSkip.reason,
      });
      await prLifecycleStore.markSkipped(String(installationId), repoFullName, prNumber, new Date().toISOString());

      // autoReviewOff is handled silently earlier (before any GitHub side
      // effect). Any rulesSkip seen here is a visible-skip kind: draft,
      // maxFiles, labelIgnored, reviewOnMentionOff.
      await createCheckRun(octokit, owner, repo, headSha, {
        status: 'completed',
        conclusion: 'neutral',
        title: 'Review skipped',
        summary: rulesSkip.reason,
      }, STAGE);

      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped', reason: rulesSkip.reason, kind: rulesSkip.kind }),
      };
    }

    // ── Filter excluded files from the diff ────
    // mergeConfig has already folded any deprecated rules.ignorePatterns
    // entries into excludePatterns, so this single list is authoritative.
    const { filteredDiff, excludedFiles, oversizedFiles } = filterDiff(
      diff, runtimeConfig.excludePatterns, runtimeConfig.maxFileDiffKB,
    );
    if (excludedFiles.length > 0) {
      console.log(`Excluded ${excludedFiles.length} file(s) from diff: ${excludedFiles.join(', ')}`);
    }
    if (oversizedFiles.length > 0) {
      // #423 — reported separately from pattern exclusions: a size drop is our
      // decision, not the operator's, so it must be visible as ours.
      console.log(
        `[input-budget] dropped ${oversizedFiles.length} oversized file(s) over `
        + `${runtimeConfig.maxFileDiffKB}KB: `
        + oversizedFiles.map((f) => `${f.file} (${Math.round(f.bytes / 1024)}KB)`).join(', '),
      );
    }

    // Model resolution (#264). Precedence, highest first:
    //   1. .mergewatch.yml `model:`  — the repository's committed intent
    //   2. DEFAULT_BEDROCK_MODEL_ID  — the deploy-time default
    //
    // (#310 removed the `installation.modelId` tier that sat between them —
    // nothing ever wrote it, and 0 of 525 production rows carried it.)
    //
    // Read the RAW yamlConfig, never runtimeConfig.model: mergeConfig always
    // fills DEFAULT_CONFIG.model, so the merged value is truthy for every repo
    // and using it here would silently override the deployed default
    // everywhere. Only an explicitly-authored `model:` should win.
    //
    // Until #264 this line read `installation?.modelId ?? DEFAULT_...`, which
    // ignored `model:` entirely — while the very next line honored
    // `lightModel:`.
    const resolvedModel = resolveReviewModelId({
      repoConfigModel: yamlConfig?.model,
      deployDefault: DEFAULT_BEDROCK_MODEL_ID,
      fallback: FALLBACK_BEDROCK_MODEL_ID,
    });
    const modelId = resolvedModel.modelId;
    console.log(`[model] ${repoFullName}#${prNumber} using ${modelId} (source=${resolvedModel.source})`);

    // ── #423 — input budget ────────────────────────────────────────────────
    // Checked here because it needs the resolved model: the budget is a
    // property of that model's context window, not a constant. Before this,
    // an oversized diff reached Bedrock and came back as
    // `ValidationException: Input is too long for requested model` after every
    // fallback collapsed — no findings, no partial result, no guidance.
    //
    // A skip is strictly better than that: it names the cause, the size, and
    // what to do. It is still a bound rather than a fix — the durable answer
    // is retrieval over a checkout (#424).
    const budget = checkInputBudget(filteredDiff, modelId, runtimeConfig.maxTokensPerAgent);
    if (!budget.fits) {
      const reason = describeOverBudget(budget, modelId);
      console.warn(`[input-budget] skipping ${repoFullName}#${prNumber}: ${reason}`);

      await createCheckRun(octokit, owner, repo, headSha, {
        status: 'completed',
        conclusion: 'neutral',
        title: 'Review skipped — diff too large',
        summary: reason,
      }, STAGE);

      await reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'skipped', {
        completedAt: new Date().toISOString(),
        skipReason: reason,
      });
      await prLifecycleStore.markSkipped(
        String(installationId), repoFullName, prNumber, new Date().toISOString(),
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped', reason, kind: 'diffTooLarge' }),
      };
    }
    const lightModelId = runtimeConfig.lightModel;

    const modelName = Object.entries(SUPPORTED_MODELS)
      .find(([, id]) => id === modelId)?.[0] ?? modelId;

    // Build agentic file fetch options (agents will request files they need)
    const fileFetchOptions: FileFetchOptions | undefined = runtimeConfig.codebaseAwareness
      ? {
          octokit,
          owner,
          repo,
          ref: headSha,
          maxContextKB: runtimeConfig.maxContextKB,
          maxRounds: runtimeConfig.maxFileRequestRounds,
        }
      : undefined;
    // Grounding/verification fetch context — always available, independent of
    // the codebaseAwareness feature flag. maxRounds is irrelevant here (no
    // agentic loop); these stages just read the cited files once.
    const groundingFetch: FileFetchOptions = {
      octokit,
      owner,
      repo,
      ref: headSha,
      maxContextKB: runtimeConfig.maxContextKB,
      maxRounds: 0,
    };

    // Fetch previous reviews before pipeline (used for diagram consistency + delta computation)
    let prevReviews: ReviewItem[] = [];
    let prevComplete: ReviewItem | undefined;
    try {
      prevReviews = await reviewStore.queryByPR(repoFullName, `${prNumber}#`, 5);
      prevComplete = prevReviews.find(
        (r) => r.status === 'complete' && r.prNumberCommitSha !== prNumberCommitSha && r.findings && r.findings.length > 0,
      );
    } catch (err) {
      console.warn('Failed to fetch previous reviews:', err);
    }

    const previousDiagram = typeof prevComplete?.diagramText === 'string' ? prevComplete.diagramText : undefined;

    // W3 convergence guard: map a prior `## mergewatch triage` reply onto
    // stable finding keys so rebutted/deferred findings aren't re-raised.
    // Best-effort, fail-open (suppresses nothing on any error).
    let disputedKeys: string[] = [];
    if (prevComplete?.findings && prevComplete.findings.length > 0) {
      // Author-filtered: a third-party drive-by commenter cannot suppress
      // findings on someone else's PR (the security boundary for W3).
      const triageComments = await fetchTriageComments(octokit, owner, repo, prNumber, prContext.prAuthor);
      if (triageComments.length > 0) {
        disputedKeys = await computeDisputedKeys(
          triageComments,
          prevComplete.findings,
          llm,
          lightModelId,
        );
        // FB-A — record one dispute per W3-disputed key.
        await recordDisputes(dispositionStore, installationId, repoFullName, disputedKeys);
      }
    }
    // FP-F — union with the persisted inline-resolve memory; mirrors the
    // server handler. Findings the developer explicitly resolved on inline
    // threads shouldn't be re-raised under a slightly-different framing.
    if (prevComplete?.inlineResolvedKeys && prevComplete.inlineResolvedKeys.length > 0) {
      const merged = new Set(disputedKeys);
      for (const k of prevComplete.inlineResolvedKeys) merged.add(k);
      const before = disputedKeys.length;
      disputedKeys = Array.from(merged);
      if (disputedKeys.length > before) {
        console.log(
          '[fp-f] unioned %d inline-resolved key%s into disputedKeys (now %d total)',
          disputedKeys.length - before,
          disputedKeys.length - before === 1 ? '' : 's',
          disputedKeys.length,
        );
      }
    }

    // FP-B — pre-filter `previousFindings` by `disputedKeys`. Mirrors the
    // server handler; see review-processor.ts for the rationale (orchestrator
    // input shouldn't carry findings the author already dispositioned).
    const priorForOrchestrator = prevComplete?.findings && disputedKeys.length > 0
      ? partitionDisputed(prevComplete.findings, disputedKeys).kept
      : prevComplete?.findings;
    if (
      prevComplete?.findings &&
      priorForOrchestrator &&
      priorForOrchestrator.length < prevComplete.findings.length
    ) {
      console.warn(
        '[fp-b] excluded %d disputed prior finding%s from the orchestrator input',
        prevComplete.findings.length - priorForOrchestrator.length,
        prevComplete.findings.length - priorForOrchestrator.length === 1 ? '' : 's',
      );
    }

    // Load repo conventions + (FP-J L1) category dispute rates in parallel.
    // The dispute helper returns `{}` on every failure path, identical to
    // "no down-weighting" downstream.
    const [conventionsResult, categoryDisputeRates] = await Promise.all([
      fetchConventions(octokit, owner, repo, headSha, runtimeConfig.conventions),
      loadCategoryDisputeRates(fpInsightStore, installationId),
    ]);
    if (conventionsResult) {
      console.log(`Loaded repo conventions from ${conventionsResult.sourcePath}${conventionsResult.truncated ? ' (truncated)' : ''}`);
    }

    // #235 — org custom agents that apply to this PR (enabled, in repo scope,
    // matching path/language targeting), run in union with the repo's
    // `.mergewatch.yml` customAgents (org wins on name clash).
    const changedFiles = prContext.files ?? [];
    const selectedOrgAgents = selectOrgAgentsForReview(orgCustomAgents, {
      repoFullName,
      changedFiles,
      languages: languagesFromFiles(changedFiles),
    });
    if (selectedOrgAgents.length > 0) {
      console.log('[org-agents] %d org custom agent(s) apply to %s', selectedOrgAgents.length, repoFullName);
    }
    // Author triage of a blocking org agent's finding is allowed but recorded
    // (every triage already lands in the disposition store); emit an explicit
    // blocking-tagged signal for admins.
    const blockingAgentNames = new Set(
      selectedOrgAgents.filter((a) => a.enforcement === 'blocking').map((a) => a.name),
    );
    if (disputedKeys.length > 0 && blockingAgentNames.size > 0 && prevComplete?.findings) {
      const disputedSet = new Set(disputedKeys);
      const triagedBlocking = prevComplete.findings.filter(
        (f) => blockingAgentNames.has(f.category) && findingMatchKeys(f).some((k) => disputedSet.has(k)),
      );
      if (triagedBlocking.length > 0) {
        console.warn(
          '[org-agents] author triaged %d finding(s) from blocking org agent(s) on %s#%d — recorded for admin review',
          triagedBlocking.length, repoFullName, prNumber,
        );
      }
    }

    const result = await runReviewPipeline({
      diff: filteredDiff,
      context: {
        owner,
        repo,
        prNumber,
        prTitle: prContext.title,
        prBody: prContext.description ?? undefined,
      },
      modelId,
      lightModelId,
      customStyleRules: runtimeConfig.customStyleRules,
      maxFindings: runtimeConfig.maxFindings,
      // #310 — merged from yml `minSeverity:` + dashboard severityThreshold.
      minSeverity: runtimeConfig.minSeverity,
      // FP-A floor from yml `minConfidence:` (default 75).
      minConfidence: runtimeConfig.minConfidence,
      // #350 — per-invocation output-token cap from yml `maxTokensPerAgent:`.
      maxTokensPerAgent: runtimeConfig.maxTokensPerAgent,
      enabledAgents: mode === 'summary'
        ? { security: false, bugs: false, style: false, summary: true, diagram: false, errorHandling: false, testCoverage: false, commentAccuracy: false }
        : { ...runtimeConfig.agents, diagram: instSettings.summary.diagram },
      fileFetchOptions,
      groundingFetch,
      customAgents: unionCustomAgents(selectedOrgAgents, runtimeConfig.customAgents),
      tone: runtimeConfig.ux.tone,
      customPricing: runtimeConfig.pricing,
      previousDiagram,
      previousFindings: priorForOrchestrator,
      disputedKeys,
      conventions: conventionsResult?.content,
      agentAuthored: event.source === 'agent',
      categoryDisputeRates,
    }, { llm });

    // #486 — shared with the self-hosted server so the two cannot drift.
    const reviewDetailUrl = buildReviewDetailUrl(DASHBOARD_BASE_URL, repoFullName, prNumberCommitSha);

    // Build work-done section from the FILTERED diff (#358) — the tallies
    // must describe what the agents actually reviewed. Raw PR totals counted
    // excludePatterns-removed files as "scanned".
    const diffStats = computeDiffStats(filteredDiff);
    const workDone = buildWorkDoneSection(
      diffStats.files,
      diffStats.additions,
      diffStats.deletions,
      result.enabledAgentCount,
    );

    // Compute delta from previous review (reusing prevComplete fetched earlier)
    let delta: ReviewDelta | null = null;
    if (prevComplete?.findings) {
      delta = computeReviewDelta(result.findings, prevComplete.findings);
    }

    // FB-A / FB-B / FB-C — best-effort analytics writes. Mirrors the server
    // handler; see packages/server/src/review-processor.ts for the
    // rationale. All failures are caught + logged inside the helpers
    // and never block the review path.
    const nowIso = new Date().toISOString();
    await recordFindingSurfacings(dispositionStore, installationId, repoFullName, result.findings, nowIso);
    if (prevComplete?.findings && prevComplete.findings.length > 0) {
      const quietDrops = detectQuietDrops(result.findings, prevComplete.findings, result.changedLines);
      if (quietDrops.length > 0) {
        console.log('[fb-b] %d quiet drop%s detected', quietDrops.length, quietDrops.length === 1 ? '' : 's');
        await recordQuietDrops(dispositionStore, installationId, repoFullName, quietDrops);
      }
    }
    const updatedReactionsSnapshot = await pollAndRecordInlineReactions(
      octokit, owner, repo, prNumber,
      prevComplete?.inlineReactionsSnapshot,
      dispositionStore,
      installationId,
      repoFullName,
    STAGE);

    const durationMs = Date.now() - new Date(reviewStartedAt).getTime();

    // Compute cumulative cost across all reviews on this PR
    const prevCost = prevReviews.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
    const cumulativeCostUsd = (result.estimatedCostUsd ?? 0) + prevCost;

    const commentBody = formatReviewComment({
      summary: result.summary,
      findings: result.findings,
      commentFooter: instSettings.commentHeader || undefined,
      showSummary: instSettings.summary.prSummary,
      showIssuesTable: instSettings.summary.issuesTable,
      showConfidence: instSettings.summary.confidenceScore,
      diagram: result.diagram || undefined,
      diagramCaption: result.diagramCaption || undefined,
      showDiagram: instSettings.summary.diagram,
      reviewDetailUrl,
      mergeScore: result.mergeScore,
      mergeScoreReason: result.mergeScoreReason || undefined,
      disputeDisclosure: result.disputeDisclosure,
      ux: runtimeConfig.ux,
      workDone,
      delta,
      deltaCaption: result.deltaCaption,
      suppressedCount: result.suppressedCount,
      // #382 — disclose unparsed agent responses (findings may be missing).
      parseFailureCount: result.parseFailureCount,
      degenerateResponseCount: result.degenerateResponseCount,
      enabledAgentCount: result.enabledAgentCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      cumulativeCostUsd: cumulativeCostUsd > 0 ? cumulativeCostUsd : undefined,
      durationMs,
      model: modelName,
      conventionsSource: conventionsResult?.sourcePath,
      conventionsTruncated: conventionsResult?.truncated,
    });

    // #235 — a critical finding from a *blocking* org agent gates the merge
    // regardless of the overall score (REQUEST_CHANGES + failing check run).
    const orgBlockedBy = blockingCriticalAgents(selectedOrgAgents, result.findings);
    const orgBlocked = orgBlockedBy.length > 0;
    if (orgBlocked) {
      console.log('[org-agents] blocking gate fired for %s#%d via: %s', repoFullName, prNumber, orgBlockedBy.join(', '));
    }

    // ── Step A: Upsert issue comment (full review — primary artifact) ──────
    const reviewEvent = orgBlocked ? 'REQUEST_CHANGES' : mergeScoreToReviewEvent(result.mergeScore);
    let commentId: number | undefined;

    // Look up existing comment: job payload → DynamoDB → API scan
    let targetCommentId = existingCommentId;

    if (!targetCommentId) {
      for (const item of prevReviews) {
        if (item.commentId && item.prNumberCommitSha !== prNumberCommitSha) {
          targetCommentId = item.commentId as number;
          break;
        }
      }
    }

    if (!targetCommentId) {
      targetCommentId = (await findExistingBotComment(octokit, owner, repo, prNumber, STAGE)) ?? undefined;
    }

    // #350 — postSummaryOnClean: false means a clean PR gets no comment. Only
    // the INITIAL post is gated: an existing MergeWatch comment is always
    // updated, so a previously-dirty PR that comes back clean never keeps a
    // stale review claiming old findings.
    const stayingSilent =
      result.findings.length === 0 && runtimeConfig.postSummaryOnClean === false && !targetCommentId;
    if (stayingSilent) {
      console.log(`[post-summary] clean PR and postSummaryOnClean=false — staying silent on ${repoFullName}#${prNumber}`);
    } else if (targetCommentId) {
      await updateReviewComment(octokit, owner, repo, targetCommentId, commentBody, STAGE);
      commentId = targetCommentId;
    } else {
      commentId = await postReviewComment(octokit, owner, repo, prNumber, commentBody, STAGE);
    }

    if (!commentId && !stayingSilent) {
      throw new Error('Failed to create or update issue comment');
    }

    // ── Step B: Build inline comments for critical findings ──────────────
    let inlineComments = buildInlineComments(result.findings, prContext.files, result.changedLines, STAGE);

    // Filter out carried-over findings (same file+line+title as previous review)
    if (prevComplete?.findings && inlineComments.length > 0) {
      const prevKeys = new Set(
        (prevComplete.findings as Array<{ file: string; line: number; title: string }>)
          .map((f) => `${f.file}:${f.line}:${f.title}`),
      );
      inlineComments = inlineComments.filter(
        (c) => !prevKeys.has(`${c.path}:${c.line}:${extractInlineCommentTitle(c.body)}`),
      );
    }

    // Severity counts — used both for the check-run rendering below and
    // (previously) for the PR-review verdict body.
    const criticalCount = result.findings.filter((f) => f.severity === 'critical').length;
    const warningCount = result.findings.filter((f) => f.severity === 'warning').length;
    const infoCount = result.findings.filter((f) => f.severity === 'info').length;

    // ── Step C: Surface verdict + inline findings ──────────────────────────
    // Branching policy:
    // W6 — single authoritative review comment. Pass an empty body for
    // every event; submitPRReview handles the GitHub API constraint
    // (APPROVE → body omitted; REQUEST_CHANGES / COMMENT → an HTML-
    // comment-only stub that renders as nothing). The paired upserted
    // summary comment is the sole place the verdict / findings / etc. live;
    // the formal Review object now only carries the event label + the
    // batched inline comments — no duplicate "Critical issues found" body.
    const reviewBody = '';
    try {
      // #418 — dismiss only OUR reviews. Our App login is read from the summary
      // comment we just posted (cached per process); without it we skip
      // dismissal rather than risk dismissing another App's or vendor's review.
      const selfLogin = commentId
        ? await resolveAppLogin(octokit, owner, repo, commentId, `lambda:${STAGE ?? 'prod'}`)
        : null;
      await dismissStaleReviews(octokit, owner, repo, prNumber, selfLogin);
      await submitPRReview(octokit, owner, repo, prNumber, reviewBody, reviewEvent, inlineComments);
    } catch (err) {
      console.warn('PR review submission failed — issue comment has the full review:', err);
    }

    await addPRReaction(octokit, owner, repo, prNumber, '+1');

    let reactions: Record<string, number> | undefined;
    // #195 Phase 4 — next-poll baseline for the summary-comment helpful prompt.
    let updatedSummaryReactionsSnapshot: Record<string, number> = prevComplete?.summaryReactionsSnapshot ?? {};
    if (commentId) {
      const reactionCounts = await getCommentReactions(octokit, owner, repo, commentId);
      if (Object.keys(reactionCounts).length > 0) {
        reactions = reactionCounts;
      }
      // Fold the summary 👍/👎 delta into the engagement rollup (best-effort).
      updatedSummaryReactionsSnapshot = await recordSummaryHelpfulVotes(
        satisfactionStore,
        installationId,
        repoFullName,
        prNumber,
        reactionCounts,
        prevComplete?.summaryReactionsSnapshot,
        new Date().toISOString(),
      );
    }

    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    const topSeverity = result.findings.length > 0
      ? result.findings.reduce((top, f) =>
          severityRank[f.severity] < severityRank[top] ? f.severity : top,
        result.findings[0].severity)
      : undefined;

    const completedAt = new Date().toISOString();

    // #471 — persist the filter ledger. Deliberately AFTER the comment is
    // posted and wrapped so it cannot fail the review: the developer getting
    // their review matters, the debugging artifact does not.
    await reviewTraceStore
      .put(buildReviewTrace(repoFullName, prNumberCommitSha, result.filterOutcomes, new Date()))
      .catch((err: unknown) => {
        console.warn('[filter-trace] failed to persist trace for %s %s:', repoFullName, prNumberCommitSha, err);
      });

    await reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'complete', {
      commentId,
      completedAt,
      model: modelName,
      settingsUsed: {
        severityThreshold: instSettings.severityThreshold,
        commentTypes: instSettings.commentTypes,
        maxComments: instSettings.maxComments,
        summaryEnabled: instSettings.summary.prSummary,
        customInstructions: !!instSettings.customInstructions,
      },
      findingCount: result.findings.length,
      topSeverity,
      durationMs,
      summaryText: result.summary || undefined,
      diagramText: result.diagram || undefined,
      findings: result.findings as ReviewFinding[],
      reactions,
      mergeScore: result.mergeScore,
      mergeScoreReason: result.mergeScoreReason || undefined,
      inputTokens: result.inputTokens || undefined,
      outputTokens: result.outputTokens || undefined,
      estimatedCostUsd: result.estimatedCostUsd ?? undefined,
      // FB-C — persist the new reaction snapshot for delta-vs-snapshot
      // reconciliation on the next review run. See server/review-processor.ts
      // for the rationale.
      ...(Object.keys(updatedReactionsSnapshot).length > 0
        ? { inlineReactionsSnapshot: updatedReactionsSnapshot }
        : {}),
      // #195 Phase 4 — persist the summary-comment reaction baseline for the
      // next review's helpful-vote delta.
      ...(Object.keys(updatedSummaryReactionsSnapshot).length > 0
        ? { summaryReactionsSnapshot: updatedSummaryReactionsSnapshot }
        : {}),
    });

    // TTM (#194) — anchor the first-review timestamp (set-once) for the
    // time-from-first-review-to-merge metric.
    await prLifecycleStore.markReviewed(String(installationId), repoFullName, prNumber, completedAt);

    // #193 — denormalize this review's cost for the nightly cost rollup.
    // Best-effort; unknown-model cost (null) is recorded as unpriced, not 0.
    await costStore.recordCost({
      installationId: String(installationId),
      repoFullName,
      prNumber,
      commitSha: headSha,
      completedAt,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      costUsd: result.estimatedCostUsd ?? null,
      findingCount: result.findings.length,
      model: modelName,
    });

    // ── Record billing (SaaS only) ────
    // Retry once on failure. If both attempts fail, log as ERROR (not warn)
    // so CloudWatch alarms can catch revenue leaks. We don't throw because
    // the review comment is already posted — crashing would retry the entire
    // review pipeline which is worse than a missed billing record.
    // #262 — an unpriced model makes estimatedCostUsd null, which skips
    // recordReview entirely: no free-tier increment, no balance deduction, no
    // error. Every review becomes free, silently. The REVENUE LEAK log below
    // only covers recordReview *throwing*, not being skipped — so log the skip
    // loudly too. Adding a model without a DEFAULT_PRICING row is the way this
    // happens.
    if (isSaas() && result.estimatedCostUsd == null) {
      console.error(
        `[billing] UNPRICED MODEL: no cost for ${modelId} on ${repoFullName}#${prNumber} — `
        + 'review NOT billed and free tier NOT consumed. Add a DEFAULT_PRICING entry '
        + '(packages/core/src/llm/pricing.ts) or a `pricing:` override in .mergewatch.yml.',
      );
    }

    if (isSaas() && result.estimatedCostUsd != null) {
      let stripe;
      try { stripe = await getStripe(); } catch (err) {
        console.warn('[billing] Stripe not configured, skipping balance debit:', err instanceof Error ? err.message : err);
      }
      let billingRecorded = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await recordReview(dynamodb, INSTALLATIONS_TABLE, String(installationId), result.estimatedCostUsd, prNumberCommitSha, stripe, ossRepoContext);
          billingRecorded = true;
          break;
        } catch (err) {
          if (attempt === 1) {
            console.warn(`[billing] recordReview attempt 1 failed for ${repoFullName}#${prNumber}, retrying:`, err);
          }
        }
      }
      if (!billingRecorded) {
        console.error(`[billing] REVENUE LEAK: recordReview failed after 2 attempts for ${repoFullName}#${prNumber} install=${installationId} cost=$${result.estimatedCostUsd}`);
      }
    }

    // #235 — a blocking org agent fails the check too.
    // #240 — only VERIFIED criticals fail the check. Unverified ones are
    // advisory everywhere else (W7 clamps the score, FP-L renders them under
    // "Unverified concerns"); the check must agree instead of going red on a
    // critical the review event refuses to block on.
    const blockingCriticalCount = countBlockingCriticals(result.findings);
    const unverifiedCriticalCount = criticalCount - blockingCriticalCount;
    const hasCritical = blockingCriticalCount > 0;
    const checkConclusion = (hasCritical || orgBlocked) ? 'failure' as const : 'success' as const;
    const findingSummaryParts: string[] = [];
    if (blockingCriticalCount) findingSummaryParts.push(`${blockingCriticalCount} critical`);
    if (unverifiedCriticalCount) findingSummaryParts.push(`${unverifiedCriticalCount} unverified`);
    if (warningCount) findingSummaryParts.push(`${warningCount} warning`);
    if (infoCount) findingSummaryParts.push(`${infoCount} info`);
    if (orgBlocked) findingSummaryParts.push(`blocked by org agent: ${orgBlockedBy.join(', ')}`);

    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: checkConclusion,
      // #380 — the title leads with the merge score so a 3/5-with-warnings
      // verdict is visible in the checks tab despite the green conclusion.
      title: buildCheckTitle({
        mergeScore: result.mergeScore,
        findingCount: result.findings.length,
        blockingCriticalCount,
        orgBlocked,
        orgBlockedBy,
      }),
      summary: findingSummaryParts.length > 0
        ? `Found: ${findingSummaryParts.join(', ')}`
        : 'No issues detected in this PR.',
      detailsUrl: reviewDetailUrl,
    }, STAGE);

    console.log(
      `Review complete for ${repoFullName}#${prNumber}: ${result.findings.length} findings`,
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Review complete',
        findingsCount: result.findings.length,
      }),
    };
  } catch (error) {
    // #355 — a provider throttle is retriable work, not a failure. Park the
    // review back at 'pending' (claimable — see claimReview), keep the check
    // run advisory-in-progress instead of terminally red, and RETHROW so the
    // async invocation is retried by Lambda (returning without throwing is
    // what suppressed every retry and silently lost 32/57 burst reviews).
    if (isThrottleError(error)) {
      console.warn(`Review throttled for ${repoFullName}#${prNumber} — parking for retry`);

      await reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'pending').catch((updateErr) => {
        console.error('Failed to park throttled review as pending:', updateErr);
      });

      await createCheckRun(octokit, owner, repo, headSha, {
        status: 'in_progress',
        title: `Review queued — rate limited (attempt ${deliveryAttempt})`,
        // #370 — attempt + parked-at + expectations: a parked review must be
        // distinguishable from a hung one at a glance.
        summary: rateLimitedCheckSummary(deliveryAttempt, new Date().toISOString()),
      }, STAGE).catch((checkErr) => {
        console.error('Failed to post rate-limited check run:', checkErr);
      });

      throw error;
    }

    console.error(`Review failed for ${repoFullName}#${prNumber}:`, error);

    await reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'failed', {
      completedAt: new Date().toISOString(),
    }).catch((updateErr) => {
      console.error('Failed to update review status to failed:', updateErr);
    });

    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'failure',
      title: 'Review failed',
      summary: `MergeWatch encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, STAGE);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Review failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  } finally {
    // Always clear the eyes reaction — success or failure — so the PR doesn't
    // get stuck looking like MergeWatch is still mid-review.
    if (eyesReactionId != null) {
      await removePRReaction(octokit, owner, repo, prNumber, eyesReactionId);
    }
  }
}
