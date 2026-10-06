/**
 * #699 — run a corpus through `runReviewPipeline` and grade it.
 *
 * Two fidelity decisions are load-bearing here, because without them a number
 * published as "shipped defaults" would come from a configuration no user has
 * ever run:
 *
 *  1. THE SKIP LAYER IS APPLIED. `shouldSkipPR` and `shouldSkipByRules` live
 *     in core but are only ever called from the Lambda handler
 *     (`review-agent.ts:636`) and the Express processor
 *     (`review-processor.ts:483`) — never from the pipeline. An offline run
 *     that omits them contains no skips at all, which silently inflates
 *     recall: in production a skipped PR contributes no comments, so it is a
 *     recall FAILURE, not a "correctly declined to review".
 *  2. THE REAL PR NUMBER IS USED. `context.prNumber` renders into every agent
 *     prompt (`reviewer.ts:252`), so a sentinel 0 would make every graded
 *     prompt differ from production's.
 */
import {
  DEFAULT_CONFIG,
  runReviewPipeline,
  shouldSkipByRules,
  shouldSkipPR,
  extractIncludePatterns,
  extractSkipPatterns,
} from '@mergewatch/core';
import type { ILLMProvider, MergeWatchConfig } from '@mergewatch/core';
import { computeMetrics, gradeCase, gradeSkippedCase } from './grader.js';
import { buildGrounding, disabledGrounding, type MinimalOctokit } from './grounding.js';
import {
  ModelEchoMismatchError,
  RecordingProvider,
  SpendCapExceededError,
  UnpricedModelError,
  projectCaseCostUsd,
} from './provider.js';
import type { BenchCase, BenchManifest, BenchResult, CaseResult } from './types.js';

/**
 * Split `owner/name`, failing loudly on anything else. Silently yielding
 * `undefined` for the repo would send the grounding fetch at a malformed
 * target and read back as "file not found" — indistinguishable from a real
 * miss, which is the failure mode this harness exists to rule out.
 */
export function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Case repo must be "owner/name", got "${repo}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

/** Files touched by a unified diff, from its `+++ b/...` headers. */
export function parseChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') files.push(m[1].trim());
  }
  return files;
}

export interface RunBenchOptions {
  manifest: BenchManifest;
  /** Reads a case's diff. Injected so tests need no filesystem. */
  readDiff: (diffPath: string) => Promise<string>;
  /**
   * The provider, or a per-case factory. A factory lets a stub be scripted
   * per case, which is how the smoke corpus gets a positive and a negative
   * control in one run.
   */
  llm: ILLMProvider | ((bcase: BenchCase) => ILLMProvider);
  /** Arm config, merged over DEFAULT_CONFIG. Omit for shipped defaults. */
  config?: Partial<MergeWatchConfig>;
  /** Name recorded in the artifact, e.g. "arm-a". */
  arm?: string;
  commitSha?: string;
  /** Total run budget in USD. Enforced pre-flight, per case. */
  maxSpendUsd?: number;
  /** Supplying this enables grounding; omitting it runs ungrounded. */
  octokit?: MinimalOctokit;
  /**
   * Fail when the provider does not echo a model id. Defaults to true: a
   * published number that cannot be attributed to a model is not evidence.
   */
  requireModelEcho?: boolean;
}

/**
 * Run every case. Throws on a cap breach, an unpriced model or a model-echo
 * mismatch — all three are conditions under which continuing would produce a
 * number that looks valid and is not.
 */
export async function runBench(opts: RunBenchOptions): Promise<BenchResult> {
  const config: MergeWatchConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const requireModelEcho = opts.requireModelEcho ?? true;
  const cases: CaseResult[] = [];
  let spendUsd = 0;
  // Captured before the loop. Read inside the `return` it would record the
  // END of the run, which is useless for elapsed time or for correlating a
  // long corpus run against external logs.
  const startedAt = new Date().toISOString();

  for (const bcase of opts.manifest.cases) {
    const diff = await opts.readDiff(bcase.diffPath);
    const result = await runOne(bcase, diff, config, opts, spendUsd, requireModelEcho);
    // Strict null check: a genuine 0 must still accumulate. A truthy test
    // would silently drop it, and a cap is only as good as its running total.
    if (result.estimatedCostUsd != null) spendUsd += result.estimatedCostUsd;
    cases.push(result);
  }

  const tp = cases.reduce((n, c) => n + c.grade.truePositives, 0);
  const fp = cases.reduce((n, c) => n + c.grade.falsePositives, 0);
  const fn = cases.reduce((n, c) => n + c.grade.falseNegatives, 0);
  const { precision, recall, f1 } = computeMetrics(tp, fp, fn);
  const casesSkipped = cases.filter((c) => c.skip).length;

  return {
    corpus: opts.manifest.name,
    commitSha: opts.commitSha,
    arm: opts.arm,
    startedAt,
    finishedAt: new Date().toISOString(),
    totals: {
      precision,
      recall,
      f1,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      casesAttempted: cases.length,
      casesGraded: cases.length - casesSkipped,
      casesSkipped,
      spendUsd,
    },
    cases,
  };
}

async function runOne(
  bcase: BenchCase,
  diff: string,
  config: MergeWatchConfig,
  opts: RunBenchOptions,
  spentSoFar: number,
  requireModelEcho: boolean,
): Promise<CaseResult> {
  const { owner, name: repoName } = parseRepo(bcase.repo);
  const files = parseChangedFiles(diff);

  // ── 1. The skip layer, exactly as the runtime handlers apply it ──────────
  const trivialSkip = shouldSkipPR(
    files,
    extractIncludePatterns(config),
    extractSkipPatterns(config),
  );
  const rulesSkip = shouldSkipByRules(config.rules, {
    isDraft: bcase.isDraft,
    labels: bcase.labels,
    changedFileCount: bcase.changedFileCount ?? files.length,
  });
  const skip = rulesSkip?.kind ?? (trivialSkip ? 'trivial' : undefined);

  if (skip) {
    return {
      id: bcase.id,
      skip,
      grade: gradeSkippedCase(bcase.groundTruth),
      grounding: disabledGrounding(),
      requestedModels: [config.model, config.lightModel],
      reportedModels: [],
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      findingCount: 0,
    };
  }

  // ── 2. Pre-flight spend cap, BEFORE any provider call ────────────────────
  if (opts.maxSpendUsd !== undefined) {
    const projected = projectCaseCostUsd(diff, config.model, config.pricing);
    if (projected === null) throw new UnpricedModelError([config.model], bcase.id);
    if (spentSoFar + projected > opts.maxSpendUsd) {
      throw new SpendCapExceededError(opts.maxSpendUsd, spentSoFar, projected, bcase.id);
    }
  }

  // ── 3. Grounding, with outcomes recorded rather than asserted ────────────
  const grounding = opts.octokit
    ? buildGrounding({
        octokit: opts.octokit,
        owner,
        repo: repoName,
        ref: bcase.headRef,
        maxContextKB: config.maxContextKB,
        maxRounds: config.maxFileRequestRounds,
      })
    : null;

  const inner = typeof opts.llm === 'function' ? opts.llm(bcase) : opts.llm;
  const provider = new RecordingProvider(inner);
  const pipeline = await runReviewPipeline(
    {
      diff,
      context: {
        owner,
        repo: repoName,
        prNumber: bcase.prNumber,
        prTitle: bcase.prTitle,
        prBody: bcase.prBody,
      },
      modelId: config.model,
      lightModelId: config.lightModel,
      maxFindings: config.maxFindings,
      enabledAgents: config.agents,
      customStyleRules: config.customStyleRules,
      tone: config.ux?.tone,
      customPricing: config.pricing,
      groundingFetch: grounding?.options,
      fileFetchOptions: config.codebaseAwareness ? grounding?.options : undefined,
    },
    { llm: provider },
  );

  // ── 4. Cost must be a number, or the cap has stopped enforcing ───────────
  if (pipeline.estimatedCostUsd === null) {
    // Either model can be the unpriced one, and the pipeline does not say
    // which — naming only the main model would send someone to the wrong
    // pricing entry.
    throw new UnpricedModelError([config.model, config.lightModel], bcase.id);
  }

  // ── 5. Attribute the number to models the PROVIDER named ─────────────────
  // Both models count: the finding agents use `model`, the cheaper passes use
  // `lightModel`, so every echoed id must be one of the two requested.
  const requestedModels = [config.model, config.lightModel];
  const unexpected = provider.reportedModels.filter((m) => !requestedModels.includes(m));
  if (requireModelEcho && (provider.reportedModels.length === 0 || unexpected.length > 0)) {
    throw new ModelEchoMismatchError(requestedModels, provider.reportedModels, bcase.id);
  }

  return {
    id: bcase.id,
    grade: gradeCase(pipeline.findings, bcase.groundTruth, opts.manifest.lineTolerance),
    grounding: grounding?.report ?? disabledGrounding(),
    requestedModels,
    reportedModels: provider.reportedModels,
    inputTokens: pipeline.inputTokens,
    outputTokens: pipeline.outputTokens,
    estimatedCostUsd: pipeline.estimatedCostUsd,
    findingCount: pipeline.findings.length,
  };
}
