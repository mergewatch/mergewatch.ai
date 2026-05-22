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
  detectLinters,
  type DetectedLinter,
  handleInlineReply,
  fetchTriageComments,
  computeDisputedKeys,
  partitionDisputed,
  recordFindingSurfacings,
  recordDisputes,
  detectQuietDrops,
  recordQuietDrops,
  pollAndRecordInlineReactions,
} from '@mergewatch/core';
import type {
  ReviewJobPayload,
  ReviewItem,
  ReviewFinding,
  MergeWatchConfig,
  FileFetchOptions,
  ReviewDelta,
} from '@mergewatch/core';
import { buildWorkDoneSection, computeReviewDelta } from '@mergewatch/core';
import { DynamoInstallationStore } from '@mergewatch/storage-dynamo';
import { DynamoReviewStore, DynamoFindingDispositionStore, DEFAULT_FINDING_DISPOSITIONS_TABLE } from '@mergewatch/storage-dynamo';
import { BedrockLLMProvider, SUPPORTED_MODELS } from '@mergewatch/llm-bedrock';
import { isSaas, billingCheck, recordReview, postBlockedCheckRun, ensureBillingIssue, updateBillingFields, getStripe } from '@mergewatch/billing';
import { SSMGitHubAuthProvider } from '../github-auth-ssm.js';

// -- Singletons (re-used across warm invocations) ----------------------------

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INSTALLATIONS_TABLE = process.env.INSTALLATIONS_TABLE ?? 'mergewatch-installations';
const REVIEWS_TABLE = process.env.REVIEWS_TABLE ?? 'mergewatch-reviews';
const FINDING_DISPOSITIONS_TABLE = process.env.FINDING_DISPOSITIONS_TABLE ?? DEFAULT_FINDING_DISPOSITIONS_TABLE;
const DEFAULT_BEDROCK_MODEL_ID = process.env.DEFAULT_BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL ?? 'https://mergewatch.ai';

const installationStore = new DynamoInstallationStore(dynamodb, INSTALLATIONS_TABLE);
const reviewStore = new DynamoReviewStore(dynamodb, REVIEWS_TABLE);
// FB-A — per-finding cross-PR dispositions. Best-effort writes; if the
// table doesn't exist yet (mid-deploy state) the store layer swallows.
const dispositionStore = new DynamoFindingDispositionStore(dynamodb, FINDING_DISPOSITIONS_TABLE);
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

    // Load repo conventions from the review's head SHA if we have one, else default branch.
    const ref = latestReview?.prNumberCommitSha
      ? (latestReview.prNumberCommitSha as string).split('#')[1]
      : undefined;
    const yamlConfig = await fetchRepoConfig(octokit, owner, repo).catch(() => null);
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

    // FP-F — persist inline-resolve memory; mirrors the server handler. See
    // packages/server/src/review-processor.ts for the rationale.
    if (
      latestReview &&
      result.action === 'resolved' &&
      result.resolvedFindingKeys &&
      result.resolvedFindingKeys.length > 0
    ) {
      const existing = new Set(latestReview.inlineResolvedKeys ?? []);
      for (const k of result.resolvedFindingKeys) existing.add(k);
      const merged = Array.from(existing).slice(0, 500);
      await reviewStore.updateStatus(
        repoFullName,
        latestReview.prNumberCommitSha as string,
        latestReview.status as 'complete',
        { inlineResolvedKeys: merged },
      ).catch((err) => console.warn('[fp-f] failed to persist inline-resolve keys:', err));
      console.log(
        '[fp-f] persisted %d inline-resolved key%s on %s#%d',
        result.resolvedFindingKeys.length,
        result.resolvedFindingKeys.length === 1 ? '' : 's',
        repoFullName,
        prNumber,
      );
      // FB-A — every inline-resolve is also an explicit dispute for analytics.
      await recordDisputes(dispositionStore, installationId, repoFullName, result.resolvedFindingKeys);
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
      const reason: { category: 'already-handled' | 'out-of-scope' | 'wrong-target' | 'style-disagreement' | 'other'; text?: string; at: string } = {
        category: result.rejectCategory,
        ...(result.rejectText ? { text: result.rejectText } : {}),
        at,
      };
      for (const key of result.rejectedFindingKeys) {
        await dispositionStore.appendRejectReason(inst, repoFullName, key, reason)
          .catch((err) => console.warn('[fb-d] appendRejectReason failed for %s:', key, err));
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
  event: ReviewJobPayload,
): Promise<{ statusCode: number; body: string }> {
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

    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'neutral',
      title: 'Review skipped',
      summary: skipReason,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Skipped', reason: skipReason }),
    };
  }

  // ── Billing gate (SaaS only) ────
  if (isSaas()) {
    const billing = await billingCheck(dynamodb, INSTALLATIONS_TABLE, String(installationId));
    if (billing.status === 'block') {
      console.log(`Billing blocked for installation ${installationId}`);

      await postBlockedCheckRun(octokit, owner, repo, headSha);

      if (billing.firstBlock) {
        await ensureBillingIssue(octokit, owner, repo, String(installationId), dynamodb, INSTALLATIONS_TABLE);
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
  });

  try {
    const diff = await getPRDiff(octokit, owner, repo, prNumber);

    const installation = await installationStore.get(String(installationId), repoFullName);

    const instSettings = await installationStore.getSettings(String(installationId));

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
    const runtimeConfig = mergeConfig({ ...(yamlConfig ?? {}), ...settingsOverrides });

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

      // autoReviewOff is handled silently earlier (before any GitHub side
      // effect). Any rulesSkip seen here is a visible-skip kind: draft,
      // maxFiles, labelIgnored, reviewOnMentionOff.
      await createCheckRun(octokit, owner, repo, headSha, {
        status: 'completed',
        conclusion: 'neutral',
        title: 'Review skipped',
        summary: rulesSkip.reason,
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped', reason: rulesSkip.reason, kind: rulesSkip.kind }),
      };
    }

    // ── Filter excluded files from the diff ────
    // mergeConfig has already folded any deprecated rules.ignorePatterns
    // entries into excludePatterns, so this single list is authoritative.
    const { filteredDiff, excludedFiles } = filterDiff(diff, runtimeConfig.excludePatterns);
    if (excludedFiles.length > 0) {
      console.log(`Excluded ${excludedFiles.length} file(s) from diff: ${excludedFiles.join(', ')}`);
    }

    const modelId = installation?.modelId ?? DEFAULT_BEDROCK_MODEL_ID;
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

    // Load repo conventions + (FP-G) probe the repo root for known linter
    // marker files in parallel. detectLinters performs at most one
    // root-listing API call + one extra pyproject.toml fetch on Python
    // repos; both are bounded and best-effort.
    const [conventionsResult, detectedLinters] = await Promise.all([
      fetchConventions(octokit, owner, repo, headSha, runtimeConfig.conventions),
      detectLinters(octokit, owner, repo, headSha).catch((err) => {
        // Fail-open by design — see server/review-processor.ts for the
        // rationale. Surface the status code when available so post-
        // mortem grep can distinguish 404 / 403 / 5xx at a glance.
        const status = (err && typeof err === 'object' && 'status' in err)
          ? (err as { status?: number }).status
          : undefined;
        console.warn('[fp-g] linter detection failed (status=%s):', status ?? 'n/a', err);
        return [] as DetectedLinter[];
      }),
    ]);
    if (conventionsResult) {
      console.log(`Loaded repo conventions from ${conventionsResult.sourcePath}${conventionsResult.truncated ? ' (truncated)' : ''}`);
    }
    if (detectedLinters.length > 0) {
      console.log('[fp-g] detected linters: %s', detectedLinters.join(', '));
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
      enabledAgents: mode === 'summary'
        ? { security: false, bugs: false, style: false, summary: true, diagram: false, errorHandling: false, testCoverage: false, commentAccuracy: false }
        : { ...runtimeConfig.agents, diagram: instSettings.summary.diagram },
      fileFetchOptions,
      groundingFetch,
      customAgents: runtimeConfig.customAgents,
      tone: runtimeConfig.ux.tone,
      customPricing: runtimeConfig.pricing,
      previousDiagram,
      previousFindings: priorForOrchestrator,
      disputedKeys,
      conventions: conventionsResult?.content,
      agentAuthored: event.source === 'agent',
      detectedLinters,
    }, { llm });

    const reviewDetailUrl = `${DASHBOARD_BASE_URL}/dashboard/reviews/${encodeURIComponent(`${repoFullName}:${prNumberCommitSha}`)}`;

    // Build work-done section from PR context stats
    const workDone = buildWorkDoneSection(
      prContext.files,
      prContext.totalAdditions,
      prContext.totalDeletions,
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
    );

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
      ux: runtimeConfig.ux,
      workDone,
      delta,
      deltaCaption: result.deltaCaption,
      suppressedCount: result.suppressedCount,
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

    // ── Step A: Upsert issue comment (full review — primary artifact) ──────
    const reviewEvent = mergeScoreToReviewEvent(result.mergeScore);
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
      targetCommentId = (await findExistingBotComment(octokit, owner, repo, prNumber)) ?? undefined;
    }

    if (targetCommentId) {
      await updateReviewComment(octokit, owner, repo, targetCommentId, commentBody);
      commentId = targetCommentId;
    } else {
      commentId = await postReviewComment(octokit, owner, repo, prNumber, commentBody);
    }

    if (!commentId) {
      throw new Error('Failed to create or update issue comment');
    }

    // ── Step B: Build inline comments for critical findings ──────────────
    let inlineComments = buildInlineComments(result.findings, prContext.files, result.changedLines);

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
      await dismissStaleReviews(octokit, owner, repo, prNumber);
      await submitPRReview(octokit, owner, repo, prNumber, reviewBody, reviewEvent, inlineComments);
    } catch (err) {
      console.warn('PR review submission failed — issue comment has the full review:', err);
    }

    await addPRReaction(octokit, owner, repo, prNumber, '+1');

    let reactions: Record<string, number> | undefined;
    if (commentId) {
      const reactionCounts = await getCommentReactions(octokit, owner, repo, commentId);
      if (Object.keys(reactionCounts).length > 0) {
        reactions = reactionCounts;
      }
    }

    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    const topSeverity = result.findings.length > 0
      ? result.findings.reduce((top, f) =>
          severityRank[f.severity] < severityRank[top] ? f.severity : top,
        result.findings[0].severity)
      : undefined;

    const completedAt = new Date().toISOString();

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
    });

    // ── Record billing (SaaS only) ────
    // Retry once on failure. If both attempts fail, log as ERROR (not warn)
    // so CloudWatch alarms can catch revenue leaks. We don't throw because
    // the review comment is already posted — crashing would retry the entire
    // review pipeline which is worse than a missed billing record.
    if (isSaas() && result.estimatedCostUsd != null) {
      let stripe;
      try { stripe = await getStripe(); } catch (err) {
        console.warn('[billing] Stripe not configured, skipping balance debit:', err instanceof Error ? err.message : err);
      }
      let billingRecorded = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await recordReview(dynamodb, INSTALLATIONS_TABLE, String(installationId), result.estimatedCostUsd, prNumberCommitSha, stripe);
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

    const hasCritical = criticalCount > 0;
    const checkConclusion = hasCritical ? 'failure' as const : 'success' as const;
    const findingSummaryParts: string[] = [];
    if (criticalCount) findingSummaryParts.push(`${criticalCount} critical`);
    if (warningCount) findingSummaryParts.push(`${warningCount} warning`);
    if (infoCount) findingSummaryParts.push(`${infoCount} info`);

    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: checkConclusion,
      title: hasCritical
        ? `${criticalCount} critical issue${criticalCount > 1 ? 's' : ''} found`
        : result.findings.length > 0
          ? `${result.findings.length} finding${result.findings.length > 1 ? 's' : ''} (no critical)`
          : 'No issues found',
      summary: findingSummaryParts.length > 0
        ? `Found: ${findingSummaryParts.join(', ')}`
        : 'No issues detected in this PR.',
      detailsUrl: reviewDetailUrl,
    });

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
    });

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
