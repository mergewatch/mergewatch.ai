import type { ReviewJobPayload, IInstallationStore, IReviewStore, IGitHubAuthProvider, ILLMProvider, FileFetchOptions, ReviewDelta, MergeWatchConfig, RejectCategory, FindingDispositionRecord } from '@mergewatch/core';
import {
  getPRDiff, getPRContext, addPRReaction, removePRReaction, postReviewComment, updateReviewComment,
  findExistingBotComment, getCommentReactions, createCheckRun,
  formatReviewComment, runReviewPipeline, shouldSkipPR, shouldSkipByRules, isAutoReviewOff, extractIncludePatterns,
  loadCategoryDisputeRates,
  filterDiff,
  DEFAULT_CONFIG, mergeConfig,
  BOT_COMMENT_MARKER, submitPRReview, dismissStaleReviews, mergeScoreToReviewEvent,
  buildInlineComments, extractInlineCommentTitle,
  fetchRepoConfig, fetchConventions, detectLinters, type DetectedLinter,
  buildWorkDoneSection, computeReviewDelta,
  RESPOND_PROMPT, postReplyComment,
  handleInlineReply,
  persistInlineResolveMemory,
  fetchTriageComments, computeDisputedKeys, partitionDisputed,
  recordFindingSurfacings, recordDisputes, recordResolves, detectQuietDrops, recordQuietDrops,
  pollAndRecordInlineReactions, recordSummaryHelpfulVotes,
  parseEnvModelPricing,
} from '@mergewatch/core';
import type { WebhookDeps } from './webhook-handler.js';

// -- LLM cost pricing (#233) -------------------------------------------------

type PricingMap = Record<string, { inputPer1M: number; outputPer1M: number }>;

let warnedEnvPricingInvalid = false;

function hasValue(v: string | undefined): boolean {
  return v != null && v.trim() !== '';
}

/**
 * #233 — custom pricing for the globally-configured `LLM_MODEL`, read from the
 * `LLM_MODEL_INPUT_PRICE_PER_1M` / `LLM_MODEL_OUTPUT_PRICE_PER_1M` env vars.
 * Returns undefined when not (validly) set. Warns once if `LLM_MODEL` is set and
 * the price vars are partial/invalid, so a typo doesn't silently read as $0.
 */
function envModelPricing(): PricingMap | undefined {
  const model = process.env.LLM_MODEL;
  const input = process.env.LLM_MODEL_INPUT_PRICE_PER_1M;
  const output = process.env.LLM_MODEL_OUTPUT_PRICE_PER_1M;
  const pricing = parseEnvModelPricing(model, input, output);
  if (!pricing && model && (hasValue(input) || hasValue(output)) && !warnedEnvPricingInvalid) {
    warnedEnvPricingInvalid = true;
    console.warn(
      '[cost] LLM_MODEL_INPUT_PRICE_PER_1M and LLM_MODEL_OUTPUT_PRICE_PER_1M must both be set ' +
      'to valid non-negative numbers to price LLM_MODEL — ignoring the partial/invalid value.',
    );
  }
  return pricing;
}

/**
 * Merge the global env price (base) with repo/installation/dashboard pricing
 * (more specific — wins). Returns undefined when neither contributes anything,
 * so callers pass `undefined` (not `{}`) and behaviour is unchanged.
 */
function mergePricing(env: PricingMap | undefined, repo: PricingMap | undefined): PricingMap | undefined {
  const merged = { ...(env ?? {}), ...(repo ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// -- Conversational response handler -----------------------------------------

async function handleRespondMode(
  octokit: Awaited<ReturnType<IGitHubAuthProvider['getInstallationOctokit']>>,
  job: ReviewJobPayload,
  deps: Pick<WebhookDeps, 'reviewStore' | 'llm'>,
): Promise<void> {
  const { owner, repo, prNumber, userComment, userCommentAuthor } = job;
  const repoFullName = `${owner}/${repo}`;

  const prevReviews = await deps.reviewStore.queryByPR(repoFullName, `${prNumber}#`, 5);
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
      await deps.reviewStore.updateStatus(
        repoFullName,
        latestReview.prNumberCommitSha as string,
        latestReview.status as 'complete',
        { reactions },
      ).catch((err) => console.warn('Failed to update review status with reactions:', err));
    }
  }

  const modelOverride = process.env.LLM_MODEL;
  const modelId = modelOverride ?? 'default';

  const prompt = `${RESPOND_PROMPT}

--- Previous Review Summary ---
${summaryContext}

--- Previous Review Findings ---
${findingsContext}

--- Developer Comment (from @${userCommentAuthor ?? 'unknown'}) ---
${userComment}

Please respond to the developer's comment:`;

  try {
    const rawResponse = await deps.llm.invoke(modelId, prompt);
    const response = typeof rawResponse === 'string' ? rawResponse : rawResponse.text;

    await postReplyComment(octokit, owner, repo, prNumber, response);

    console.log(`Posted conversational response for ${repoFullName}#${prNumber}`);
  } catch (err) {
    console.error('Respond failed for', repoFullName + '#' + prNumber, err);
    // Post a fallback comment so the user knows something went wrong
    await postReplyComment(
      octokit, owner, repo, prNumber,
      'Sorry, I encountered an error while processing your request. Please try again.',
    ).catch((postErr) => console.warn('Failed to post error reply:', postErr));
  }
}

// ─── Inline reply mode ──────────────────────────────────────────────────────

/**
 * Handle an inline thread reply: runs the core handler (which manages the
 * eyes reaction, LLM call, and thread resolution) and rolls the cost up onto
 * the parent review record so the PR's cumulative cost stays honest.
 */
async function handleInlineReplyJob(
  octokit: Awaited<ReturnType<IGitHubAuthProvider['getInstallationOctokit']>>,
  job: ReviewJobPayload,
  deps: Pick<WebhookDeps, 'installationStore' | 'reviewStore' | 'dispositionStore' | 'llm'>,
): Promise<void> {
  const { owner, repo, prNumber, installationId, inlineReplyCommentId } = job;
  const repoFullName = `${owner}/${repo}`;

  if (inlineReplyCommentId == null) {
    console.warn(`inline_reply job for ${repoFullName}#${prNumber} missing inlineReplyCommentId`);
    return;
  }

  try {
    // Parent review (for conventions path + cost rollup target).
    const prevReviews = await deps.reviewStore.queryByPR(repoFullName, `${prNumber}#`, 5).catch(() => []);
    const latestReview = prevReviews.find((r) => r.status === 'complete');

    const ref = latestReview?.prNumberCommitSha
      ? (latestReview.prNumberCommitSha as string).split('#')[1]
      : undefined;
    const yamlConfig = await fetchRepoConfig(octokit, owner, repo).catch(() => null);
    const conventionsResult = await fetchConventions(octokit, owner, repo, ref, yamlConfig?.conventions).catch(() => null);

    const lightModelId = process.env.LLM_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    // #233 — price the reply's tokens the same way the full review does: global
    // LLM_MODEL_*_PRICE env (base) + this repo's `.mergewatch.yml` pricing (wins).
    const customPricing = mergePricing(envModelPricing(), yamlConfig?.pricing);

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
        llm: deps.llm,
        lightModelId,
        customPricing,
      },
    );

    if (latestReview && (result.inputTokens > 0 || result.outputTokens > 0)) {
      const newInput = (latestReview.inputTokens ?? 0) + result.inputTokens;
      const newOutput = (latestReview.outputTokens ?? 0) + result.outputTokens;
      const newCost = (latestReview.estimatedCostUsd ?? 0) + (result.estimatedCostUsd ?? 0);
      await deps.reviewStore.updateStatus(
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
        reviewStore: deps.reviewStore,
        latestReview,
        resolvedFindingKeys: result.resolvedFindingKeys,
        repoFullName,
        prNumber,
      });
      if (result.resolvedFindingKeys && result.resolvedFindingKeys.length > 0) {
        await recordDisputes(deps.dispositionStore, installationId, repoFullName, result.resolvedFindingKeys);
        // #195 — also record the positive engagement signal (separate from the
        // FP-F dispute increment above) so command-usage / action KPIs see it.
        await recordResolves(deps.dispositionStore, installationId, repoFullName, result.resolvedFindingKeys);
      }
    }

    // FB-D — `/mergewatch reject` persists a categorised rejection per
    // match key. Mirrors the FP-F path but records `rejectReasons[]` +
    // increments `disputeCount`. Best-effort.
    if (
      deps.dispositionStore &&
      installationId != null &&
      result.action === 'rejected' &&
      result.rejectedFindingKeys &&
      result.rejectedFindingKeys.length > 0 &&
      result.rejectCategory
    ) {
      const inst = String(installationId);
      const at = new Date().toISOString();
      // Reuses the exported RejectCategory union from core so the inline
      // shape can't drift if the categories are widened. The reason shape
      // matches `FindingDispositionRecord['rejectReasons'][number]`.
      const reason: NonNullable<FindingDispositionRecord['rejectReasons']>[number] = {
        category: result.rejectCategory as RejectCategory,
        ...(result.rejectText ? { text: result.rejectText } : {}),
        at,
      };
      // Parallel + summary-logged: a per-key catch'd loop was sequential
      // and emitted one warn per failure. Promise.allSettled lets the
      // writes run in parallel and the failure count is emitted as a
      // single line — easier to grep + sufficient for the current
      // analytics-volume scale.
      const settled = await Promise.allSettled(
        result.rejectedFindingKeys.map((key) =>
          deps.dispositionStore!.appendRejectReason(inst, repoFullName, key, reason),
        ),
      );
      const failed = settled.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(
          '[fb-d] %d/%d appendRejectReason write(s) failed for %s#%d (category=%s)',
          failed, settled.length, repoFullName, prNumber, result.rejectCategory,
        );
      }
      await recordDisputes(deps.dispositionStore, installationId, repoFullName, result.rejectedFindingKeys);
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
  } catch (err) {
    console.error('Inline reply failed for %s#%d:', repoFullName, prNumber, err);
  }
}

export async function processReviewJob(
  job: ReviewJobPayload,
  deps: Pick<WebhookDeps, 'installationStore' | 'reviewStore' | 'dispositionStore' | 'fpInsightStore' | 'prLifecycleStore' | 'satisfactionStore' | 'costStore' | 'authProvider' | 'llm' | 'dashboardBaseUrl'>,
): Promise<void> {
  const { installationId, owner, repo, prNumber, mode } = job;
  const instId = String(installationId);
  const repoFullName = `${owner}/${repo}`;
  const octokit = await deps.authProvider.getInstallationOctokit(Number(installationId));

  // ── Handle "respond" mode: conversational follow-up ────────────────────
  if (mode === 'respond' && job.userComment) {
    return handleRespondMode(octokit, job, deps);
  }

  // ── Handle "inline_reply" mode: threaded conversation on a finding ─────
  if (mode === 'inline_reply') {
    return handleInlineReplyJob(octokit, job, deps);
  }

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
  const yamlConfig = await fetchRepoConfig(octokit, owner, repo, job.headSha).catch((err) => {
    // Static format string; user-controlled values pass as separate args
    // to avoid feeding repo names through Node's printf-style formatter.
    console.warn('Failed to fetch .mergewatch.yml — proceeding without YAML config:', `${repoFullName}#${prNumber}`, err);
    return null;
  });

  if (isAutoReviewOff(yamlConfig, job.mentionTriggered)) {
    console.log(`autoReview off — silently skipping ${repoFullName}#${prNumber}`);
    return;
  }

  // Fetch PR context and diff
  const prContext = await getPRContext(octokit, owner, repo, prNumber);
  const diff = await getPRDiff(octokit, owner, repo, prNumber);

  // Generate review key
  const headSha = prContext.headSha;
  const shortSha = headSha.slice(0, 7);
  const prNumberCommitSha = `${prNumber}#${shortSha}`;

  // Atomically claim this review — prevents duplicate processing
  const now = new Date().toISOString();
  const claimed = await deps.reviewStore.claimReview({
    repoFullName,
    prNumberCommitSha,
    status: 'in_progress',
    createdAt: now,
    prTitle: prContext.title,
    prAuthor: prContext.prAuthor,
    prAuthorAvatar: prContext.prAuthorAvatar,
    headBranch: prContext.headBranch,
    baseBranch: prContext.baseBranch,
    installationId: instId,
    source: job.source,
    agentKind: job.agentKind,
  });
  if (!claimed) {
    console.log(`Review already in progress for ${repoFullName}#${prNumber}@${shortSha}, skipping`);
    return;
  }

  // Add eyes reaction — capture the ID so we can clear it in every exit path
  // (smart skip, rules skip, success, error) and the PR doesn't get stuck in
  // a "MergeWatch is still looking" state.
  const eyesReactionId = await addPRReaction(octokit, owner, repo, prNumber, 'eyes');
  const clearEyes = async () => {
    if (eyesReactionId != null) {
      await removePRReaction(octokit, owner, repo, prNumber, eyesReactionId);
    }
  };

  // In-progress check run
  await createCheckRun(octokit, owner, repo, headSha, {
    status: 'in_progress',
    title: 'Review in progress',
    summary: `MergeWatch is reviewing PR #${prNumber}...`,
  }).catch((err) => console.warn('Failed to create in-progress check run:', err));

  // yamlConfig was fetched earlier for the autoReview silent-skip gate and
  // is reused below for includePatterns + runtimeConfig — no second round-trip.
  const includePatterns = extractIncludePatterns(yamlConfig);

  // Smart skip check — bypass when user explicitly requested a review via @mergewatch
  const skipReason = job.mentionTriggered
    ? null
    : shouldSkipPR(prContext.files || [], includePatterns);
  if (skipReason) {
    await deps.reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'skipped', { completedAt: now, skipReason });
    await deps.prLifecycleStore?.markSkipped(instId, repoFullName, prNumber, now);
    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'neutral',
      title: 'Review skipped',
      summary: skipReason,
    }).catch((err) => console.warn('Failed to create skip check run:', err));
    console.log(`Skipped ${repoFullName}#${prNumber}: ${skipReason}`);
    await clearEyes();
    return;
  }

  // Load installation config
  const installation = await deps.installationStore.get(instId, repoFullName);
  const instSettings = await deps.installationStore.getSettings(instId);

  // Apply dashboard InstallationSettings as config overrides (matches Lambda pattern)
  // Field mapping: logic → security agent, syntax → bugs agent, style → style agent
  // Severity: Low → info, Med → warning, High → critical
  const severityMap: Record<string, 'info' | 'warning' | 'critical'> = { Low: 'info', Med: 'warning', High: 'critical' };
  const settingsOverrides: Partial<MergeWatchConfig> = {
    minSeverity: severityMap[instSettings.severityThreshold] ?? 'warning',
    maxFindings: instSettings.maxComments,
    agents: {
      security: instSettings.commentTypes?.logic ?? true,
      bugs: instSettings.commentTypes?.syntax ?? true,
      style: instSettings.commentTypes?.style ?? true,
      summary: instSettings.summary?.prSummary ?? true,
      diagram: true,
      errorHandling: true,
      testCoverage: true,
      commentAccuracy: true,
    },
    customStyleRules: instSettings.customInstructions
      ? [instSettings.customInstructions]
      : [],
  };

  // Merge config: YAML provides base, dashboard settings override, env var model overrides all.
  // yamlConfig was fetched earlier for the smart-skip includePatterns override; reuse it here.
  const modelOverride = process.env.LLM_MODEL;
  const config = mergeConfig({
    ...(yamlConfig ?? {}),
    ...(installation?.config || {}),
    ...settingsOverrides,
    ...(modelOverride ? { model: modelOverride, lightModel: modelOverride } : {}),
  });

  // ── Rules-based skip (skipDrafts, maxFiles, ignoreLabels, autoReview, reviewOnMention) ────
  const rulesSkip = shouldSkipByRules(config.rules, {
    isDraft: job.isDraft,
    labels: job.prLabels,
    changedFileCount: job.changedFileCount ?? prContext?.files?.length,
    mode,
    mentionTriggered: job.mentionTriggered,
  });
  if (rulesSkip) {
    await deps.reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'skipped', { completedAt: now, skipReason: rulesSkip.reason });
    await deps.prLifecycleStore?.markSkipped(instId, repoFullName, prNumber, now);
    // autoReviewOff is handled silently earlier (before any GitHub side
    // effect). Any rulesSkip seen here is a visible-skip kind: draft,
    // maxFiles, labelIgnored, reviewOnMentionOff.
    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'neutral',
      title: 'Review skipped',
      summary: rulesSkip.reason,
    }).catch((err) => console.warn('Failed to create rules skip check run:', err));
    console.log(`Rules skip ${repoFullName}#${prNumber} (${rulesSkip.kind}): ${rulesSkip.reason}`);
    await clearEyes();
    return;
  }

  // ── Filter excluded files from the diff ────
  // mergeConfig folds the deprecated rules.ignorePatterns into excludePatterns
  // at parse time — this is the authoritative single list.
  const { filteredDiff, excludedFiles } = filterDiff(diff, config.excludePatterns);
  if (excludedFiles.length > 0) {
    console.log(`Excluded ${excludedFiles.length} file(s) from diff: ${excludedFiles.join(', ')}`);
  }

  const startTime = Date.now();

  try {
    // Build agentic file fetch options (agents will request files they need)
    const ref = headSha;
    const fileFetchOptions: FileFetchOptions | undefined = config.codebaseAwareness
      ? {
          octokit,
          owner,
          repo,
          ref,
          maxContextKB: config.maxContextKB,
          maxRounds: config.maxFileRequestRounds,
        }
      : undefined;
    // Grounding/verification fetch context — always available, independent of
    // the codebaseAwareness feature flag. maxRounds is irrelevant here (no
    // agentic loop); these stages just read the cited files once.
    const groundingFetch: FileFetchOptions = {
      octokit,
      owner,
      repo,
      ref,
      maxContextKB: config.maxContextKB,
      maxRounds: 0,
    };

    // Fetch previous reviews before pipeline (used for diagram consistency + delta computation)
    let prevComplete: typeof prevReviewsResult[number] | undefined;
    const prevReviewsResult = await deps.reviewStore.queryByPR(repoFullName, `${prNumber}#`, 5).catch((err) => {
      console.warn('Failed to fetch previous reviews:', err);
      return [] as Awaited<ReturnType<typeof deps.reviewStore.queryByPR>>;
    });
    prevComplete = prevReviewsResult.find(
      (r) => r.status === 'complete' && r.prNumberCommitSha !== prNumberCommitSha && r.findings && r.findings.length > 0,
    );

    const previousDiagram = typeof prevComplete?.diagramText === 'string' ? prevComplete.diagramText : undefined;

    // W3 convergence guard: if the author posted a `## mergewatch triage`
    // reply rebutting/deferring prior findings, map it to stable identity
    // keys so the pipeline doesn't re-raise them. Best-effort, fail-open.
    let disputedKeys: string[] = [];
    if (prevComplete?.findings && prevComplete.findings.length > 0) {
      // Author-filtered: a third-party drive-by commenter cannot suppress
      // findings on someone else's PR (the security boundary for W3).
      const triageComments = await fetchTriageComments(octokit, owner, repo, prNumber, prContext.prAuthor);
      if (triageComments.length > 0) {
        disputedKeys = await computeDisputedKeys(
          triageComments,
          prevComplete.findings,
          deps.llm,
          config.lightModel || config.model,
        );
        // FB-A — record one dispute per W3-disputed key. This runs in
        // ADDITION to the partitionDisputed suppression downstream; the
        // analytics rollup needs to see every dispute, not just net new ones.
        await recordDisputes(deps.dispositionStore, installationId, repoFullName, disputedKeys);
      }
    }
    // FP-F — union with the persisted inline-resolve memory. Findings the
    // developer explicitly resolved on inline threads (via `/resolve` or an
    // equivalent intent) shouldn't be re-raised by the next review just
    // because the framing drifts. Same identity scheme as W3 (`findingMatchKeys`).
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

    // FP-B — pre-filter `previousFindings` by `disputedKeys`. Without this,
    // the orchestrator's prompt (which includes prior findings via
    // `buildPreviousFindingsBlock` and tells the model to "carry forward if
    // still present") gets handed findings the author already dispositioned
    // — encouraging it to re-emit them in slightly-different framings that
    // W3's stable-key match downstream can miss. Pre-filtering at the
    // orchestrator's INPUT side closes the loop and saves prompt tokens.
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

    // Load repo conventions (AGENTS.md / CONVENTIONS.md or the `conventions:` path)
    // and (FP-G) probe the repo root for known linter marker files in parallel.
    // detectLinters performs at most one root-listing API call + one extra
    // pyproject.toml fetch on Python repos; both are bounded and best-effort.
    // FP-J L1 — fetch category dispute rates in parallel. The helper
    // returns `{}` on every failure path (no rollup yet, store unwired,
    // upstream-degraded), which is identical to "no down-weighting" in
    // the verdict-tier softener — so the await is safe to bundle here.
    const [conventionsResult, detectedLinters, categoryDisputeRates] = await Promise.all([
      fetchConventions(octokit, owner, repo, ref, config.conventions),
      detectLinters(octokit, owner, repo, ref).catch((err) => {
        // Fail-open by design: linter detection is best-effort and a
        // transient infra issue (rate-limit, 5xx, network blip) must not
        // block the review. Surface the status code when available so
        // post-mortem grep can distinguish 404 (ref gone) from 403 (token
        // scope) from 5xx (GitHub-side) without rifling through Sentry.
        const status = (err && typeof err === 'object' && 'status' in err)
          ? (err as { status?: number }).status
          : undefined;
        console.warn('[fp-g] linter detection failed (status=%s):', status ?? 'n/a', err);
        return [] as DetectedLinter[];
      }),
      loadCategoryDisputeRates(deps.fpInsightStore, job.installationId),
    ]);
    if (conventionsResult) {
      console.log(`Loaded repo conventions from ${conventionsResult.sourcePath}${conventionsResult.truncated ? ' (truncated)' : ''}`);
    }
    if (detectedLinters.length > 0) {
      console.log('[fp-g] detected linters: %s', detectedLinters.join(', '));
    }

    // Run review pipeline
    const result = await runReviewPipeline(
      {
        diff: filteredDiff,
        context: {
          owner,
          repo,
          prNumber,
          prTitle: prContext.title,
          prBody: prContext.description || '',
        },
        modelId: config.model,
        lightModelId: config.lightModel || config.model,
        customStyleRules: config.customStyleRules,
        maxFindings: config.maxFindings,
        enabledAgents: {
          ...config.agents,
          diagram: instSettings.summary?.diagram !== false,
        },
        fileFetchOptions,
        groundingFetch,
        customAgents: config.customAgents,
        tone: config.ux.tone,
        // #233 — global LLM_MODEL_*_PRICE env (base) + repo/dashboard pricing (wins).
        customPricing: mergePricing(envModelPricing(), config.pricing),
        previousDiagram,
        previousFindings: priorForOrchestrator,
        disputedKeys,
        conventions: conventionsResult?.content,
        agentAuthored: job.source === 'agent',
        detectedLinters,
        categoryDisputeRates,
      },
      { llm: deps.llm },
    );

    const durationMs = Date.now() - startTime;

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

    // FB-A / FB-B / FB-C — analytics writes. All best-effort; failures inside
    // the helpers are caught + logged and never block the review path.
    //
    //   surfacings (FB-A) — one upsertSurface + (verified|unverified) per
    //                       finding × match-key. Captures category, agent,
    //                       and W10 sigTokens for later clustering.
    //   quiet drops (FB-B) — findings that vanished without a code change at
    //                       the cited line → silentDropCount++. Strong
    //                       implicit FP signal.
    //   reactions (FB-C)  — fold a single listReviewComments call into the
    //                       post-pipeline path; delta vs the prior snapshot
    //                       drives dispute/agreement counter increments.
    //                       Returns the new snapshot for persistence below.
    //
    // FB-A and FB-B share `nowIso` so a re-review of the same commit
    // produces identical lastSeen timestamps on duplicate calls (rare but
    // possible on retries).
    const nowIso = new Date().toISOString();
    await recordFindingSurfacings(deps.dispositionStore, installationId, repoFullName, result.findings, nowIso);
    if (prevComplete?.findings && prevComplete.findings.length > 0) {
      const quietDrops = detectQuietDrops(result.findings, prevComplete.findings, result.changedLines);
      if (quietDrops.length > 0) {
        console.log('[fb-b] %d quiet drop%s detected', quietDrops.length, quietDrops.length === 1 ? '' : 's');
        await recordQuietDrops(deps.dispositionStore, installationId, repoFullName, quietDrops);
      }
    }
    const updatedReactionsSnapshot = await pollAndRecordInlineReactions(
      octokit, owner, repo, prNumber,
      prevComplete?.inlineReactionsSnapshot,
      deps.dispositionStore,
      installationId,
      repoFullName,
    );

    // Compute cumulative cost across all reviews on this PR
    const prevCost = prevReviewsResult.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
    const cumulativeCostUsd = (result.estimatedCostUsd ?? 0) + prevCost;

    // Format comment
    const comment = formatReviewComment({
      summary: result.summary,
      findings: result.findings,
      showSummary: instSettings.summary?.prSummary !== false,
      showIssuesTable: instSettings.summary?.issuesTable !== false,
      showConfidence: instSettings.summary?.confidenceScore !== false,
      diagram: result.diagram,
      diagramCaption: result.diagramCaption,
      showDiagram: instSettings.summary?.diagram !== false,
      mergeScore: result.mergeScore,
      mergeScoreReason: result.mergeScoreReason,
      disputeDisclosure: result.disputeDisclosure,
      commentFooter: instSettings.commentHeader || undefined,
      reviewDetailUrl: deps.dashboardBaseUrl
        ? `${deps.dashboardBaseUrl}/dashboard/reviews/${encodeURIComponent(repoFullName)}/${prNumberCommitSha}`
        : undefined,
      ux: config.ux,
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
      model: config.model,
      conventionsSource: conventionsResult?.sourcePath,
      conventionsTruncated: conventionsResult?.truncated,
    });

    // ── Step A: Upsert issue comment (full review — primary artifact) ──────
    const reviewEvent = mergeScoreToReviewEvent(result.mergeScore);
    let commentId: number | undefined;

    // Look up existing comment: job payload → store → API scan
    let targetCommentId = job.existingCommentId
      || (prevReviewsResult.find((r) => r.commentId && r.prNumberCommitSha !== prNumberCommitSha)?.commentId as number | undefined)
      || (await findExistingBotComment(octokit, owner, repo, prNumber)) || undefined;

    if (targetCommentId) {
      await updateReviewComment(octokit, owner, repo, targetCommentId, comment);
      commentId = targetCommentId;
    } else {
      commentId = await postReviewComment(octokit, owner, repo, prNumber, comment);
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
    const criticalCount = result.findings.filter((f: any) => f.severity === 'critical').length;
    const warningCount = result.findings.filter((f: any) => f.severity === 'warning').length;
    const infoCount = result.findings.filter((f: any) => f.severity === 'info').length;

    // ── Step C: Surface verdict + inline findings (W6 — single authoritative comment) ──
    // Pass an empty body for every event; submitPRReview handles the
    // GitHub API constraint (APPROVE → body omitted; REQUEST_CHANGES /
    // COMMENT → an HTML-comment-only stub that renders as nothing). The
    // paired upserted summary comment is the sole place the verdict /
    // findings / etc. live; the formal Review object now only carries the
    // event label + the batched inline comments — no duplicate "Critical
    // issues found" body.
    const reviewBody = '';
    try {
      await dismissStaleReviews(octokit, owner, repo, prNumber);
      await submitPRReview(octokit, owner, repo, prNumber, reviewBody, reviewEvent, inlineComments);
    } catch (err) {
      console.warn('PR review submission failed — issue comment has the full review:', err);
    }

    // Add +1 reaction after successful review
    await addPRReaction(octokit, owner, repo, prNumber, '+1').catch(() => {});

    // Collect reactions from the review comment
    let reactions: Record<string, number> | undefined;
    // #195 Phase 4 — the next-poll baseline for the summary-comment helpful
    // prompt. Recomputed from the current reaction counts even when no new
    // votes land, so deltas stay accurate; persisted on the review below.
    let updatedSummaryReactionsSnapshot: Record<string, number> = prevComplete?.summaryReactionsSnapshot ?? {};
    if (commentId) {
      const reactionCounts = await getCommentReactions(octokit, owner, repo, commentId).catch(() => ({}));
      if (Object.keys(reactionCounts).length > 0) {
        reactions = reactionCounts;
      }
      // Fold the summary 👍/👎 delta into the engagement rollup. Best-effort;
      // returns the new snapshot to persist for the next review's delta.
      updatedSummaryReactionsSnapshot = await recordSummaryHelpfulVotes(
        deps.satisfactionStore,
        installationId,
        repoFullName,
        prNumber,
        reactionCounts,
        prevComplete?.summaryReactionsSnapshot,
        new Date().toISOString(),
      );
    }

    // Compute topSeverity by ranking all findings (not just first)
    const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    const topSeverity = result.findings.length > 0
      ? result.findings.reduce((top, f) =>
          (severityRank[f.severity] ?? 99) < (severityRank[top] ?? 99) ? f.severity : top,
        result.findings[0].severity) as 'info' | 'warning' | 'critical'
      : undefined;

    await deps.reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'complete', {
      completedAt: new Date().toISOString(),
      commentId,
      model: config.model,
      settingsUsed: {
        severityThreshold: instSettings.severityThreshold,
        commentTypes: instSettings.commentTypes,
        maxComments: instSettings.maxComments,
        summaryEnabled: instSettings.summary.prSummary,
        customInstructions: !!instSettings.customInstructions,
      },
      durationMs,
      findingCount: result.findings.length,
      topSeverity,
      summaryText: result.summary,
      diagramText: result.diagram,
      mergeScore: result.mergeScore,
      mergeScoreReason: result.mergeScoreReason,
      findings: result.findings as any,
      reactions,
      inputTokens: result.inputTokens || undefined,
      outputTokens: result.outputTokens || undefined,
      estimatedCostUsd: result.estimatedCostUsd ?? undefined,
      // FB-C — persist the new reaction snapshot so the next review can
      // compute deltas without re-counting already-observed reactions.
      // Omit when empty so the field stays absent on freshly-reviewed
      // PRs with no inline comments yet (back-compat with the typed
      // ReviewItem shape).
      ...(Object.keys(updatedReactionsSnapshot).length > 0
        ? { inlineReactionsSnapshot: updatedReactionsSnapshot }
        : {}),
      // #195 Phase 4 — persist the summary-comment reaction baseline so the
      // next review computes helpful-vote deltas without re-counting.
      ...(Object.keys(updatedSummaryReactionsSnapshot).length > 0
        ? { summaryReactionsSnapshot: updatedSummaryReactionsSnapshot }
        : {}),
    });

    // TTM (#194) — anchor the first-review timestamp (set-once) for the
    // time-from-first-review-to-merge metric. Later re-reviews don't move it.
    await deps.prLifecycleStore?.markReviewed(instId, repoFullName, prNumber, new Date().toISOString());

    // #193 — denormalize this review's cost so the nightly rollup can aggregate
    // spend per installation without scanning the reviews table. Best-effort;
    // `estimatedCostUsd` undefined/null (unknown model) is recorded as a null
    // (unpriced) cost, never coerced to 0. The store swallows on failure.
    if (deps.costStore && installationId != null) {
      await deps.costStore.recordCost({
        installationId: String(installationId),
        repoFullName,
        prNumber,
        commitSha: headSha,
        completedAt: new Date().toISOString(),
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        costUsd: result.estimatedCostUsd ?? null,
        findingCount: result.findings.length,
        model: config.model,
      });
    }

    // Create structured check run (matches Lambda pattern)
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
      detailsUrl: deps.dashboardBaseUrl
        ? `${deps.dashboardBaseUrl}/dashboard/reviews/${encodeURIComponent(repoFullName)}/${encodeURIComponent(prNumberCommitSha)}`
        : undefined,
    }).catch((err) => console.warn('Failed to create completion check run:', err));

    console.log(`Review complete: ${repoFullName}#${prNumber} — score ${result.mergeScore}/5, ${result.findings.length} findings, ${durationMs}ms`);
  } catch (err) {
    await deps.reviewStore.updateStatus(repoFullName, prNumberCommitSha, 'failed', {
      completedAt: new Date().toISOString(),
    });
    // Error check run — use generic message to avoid leaking internal details
    await createCheckRun(octokit, owner, repo, headSha, {
      status: 'completed',
      conclusion: 'failure',
      title: 'Review failed',
      summary: 'MergeWatch encountered an error while reviewing this PR. Please try again or contact support if the issue persists.',
    }).catch((checkErr) => console.warn('Failed to create error check run:', checkErr));
    throw err;
  } finally {
    await clearEyes();
  }
}
