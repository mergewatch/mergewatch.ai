/**
 * #699 — bench-side ILLMProvider wrappers.
 *
 * The spend cap HAS to live here. `TokenAccumulator` is constructed inside
 * `runReviewPipeline` (`reviewer.ts:3232`) and surfaces only through the
 * returned totals, so there is no mid-run hook: from the return value a
 * caller can only abort BETWEEN cases, by which point the first case has
 * already been paid for. Enforcing pre-flight — projecting a case's cost and
 * refusing to invoke at all — is the only way `--max-spend-usd 0` can mean
 * "spend nothing".
 */
import { StructuredOutputUnsupportedError, estimateCost, normalizeLLMResult } from '@mergewatch/core';
import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig, PromptInput } from '@mergewatch/core';

/** Thrown pre-flight when a case would push the run past its cap. */
export class SpendCapExceededError extends Error {
  constructor(
    readonly capUsd: number,
    readonly spentUsd: number,
    readonly projectedUsd: number,
    readonly caseId: string,
  ) {
    super(
      `Spend cap exceeded before case "${caseId}": cap $${capUsd.toFixed(4)}, ` +
        `already spent $${spentUsd.toFixed(4)}, this case projected at ` +
        `$${projectedUsd.toFixed(4)}. Nothing was invoked for this case.`,
    );
    this.name = 'SpendCapExceededError';
  }
}

/** Thrown when cost cannot be computed, rather than being read as zero spend. */
export class UnpricedModelError extends Error {
  constructor(readonly modelId: string, readonly caseId: string) {
    super(
      `Case "${caseId}" returned estimatedCostUsd = null, which means at least ` +
        `one model used has no pricing entry (requested: "${modelId}"). Treating ` +
        `that as zero spend would let a cap silently stop enforcing, so the run ` +
        `fails instead. Add pricing via customPricing or DEFAULT_PRICING.`,
    );
    this.name = 'UnpricedModelError';
  }
}

/**
 * Thrown when the provider echoed a model that was never requested.
 *
 * Note the plural: the pipeline uses TWO models — `modelId` for the finding
 * agents and `lightModelId` for the cheaper passes — so "the" reported model
 * does not exist. Every id the provider echoes must be one of the two asked
 * for; checking against only the main model would fail every real run.
 */
export class ModelEchoMismatchError extends Error {
  constructor(
    readonly requested: string[],
    readonly reported: string[],
    readonly caseId: string,
  ) {
    const unexpected = reported.filter((m) => !requested.includes(m));
    super(
      reported.length === 0
        ? `Case "${caseId}": the provider reported no model id at all, so the ` +
          `number cannot be attributed to a model. Requested: ${requested.join(', ')}.`
        : `Case "${caseId}": provider reported model(s) that were not requested: ` +
          `${unexpected.join(', ')}. Requested: ${requested.join(', ')}.`,
    );
    this.name = 'ModelEchoMismatchError';
  }
}

/**
 * How many agents' worth of prompt a case is assumed to cost, for the
 * pre-flight projection. The pipeline runs 6 finding agents plus summary,
 * diagram, orchestrator and verification; 10 is a deliberate slight
 * over-estimate, because a cap that under-projects does not cap.
 */
const PROJECTED_INVOCATIONS = 10;
/** Rough chars-per-token for prompt sizing. */
const CHARS_PER_TOKEN = 4;
/** Assumed output tokens per invocation, near the 4096 default cap. */
const PROJECTED_OUTPUT_TOKENS = 1500;

/**
 * Project a case's cost from its diff size, BEFORE invoking anything.
 *
 * This is an estimate and is documented as one: it exists to stop a run, not
 * to report spend. Actual spend is read from `result.estimatedCostUsd`.
 * Returns null when the model has no pricing, which the caller must treat as
 * a failure rather than as free.
 */
export function projectCaseCostUsd(
  diff: string,
  modelId: string,
  customPricing?: Parameters<typeof estimateCost>[3],
): number | null {
  const inputTokens = Math.ceil((diff.length / CHARS_PER_TOKEN) * PROJECTED_INVOCATIONS);
  const outputTokens = PROJECTED_OUTPUT_TOKENS * PROJECTED_INVOCATIONS;
  return estimateCost(modelId, inputTokens, outputTokens, customPricing);
}

/**
 * Wraps a provider to count invocations and capture the model id it echoes.
 *
 * The invocation count is what makes the cap testable: a test can assert
 * ZERO invocations at `--max-spend-usd 0`, which is a claim about behaviour
 * rather than about a log line.
 */
export class RecordingProvider implements ILLMProvider {
  invocations = 0;
  /** Every distinct model id the provider echoed, in first-seen order. */
  readonly reportedModels: string[] = [];

  constructor(private readonly inner: ILLMProvider) {}

  private record(modelId?: string): void {
    if (modelId && !this.reportedModels.includes(modelId)) {
      this.reportedModels.push(modelId);
    }
  }

  async invoke(
    modelId: string,
    prompt: PromptInput,
    maxTokens?: number,
    sampling?: LLMSamplingConfig,
  ): Promise<string | LLMInvokeResult> {
    this.invocations++;
    const result = await this.inner.invoke(modelId, prompt, maxTokens, sampling);
    this.record(normalizeLLMResult(result).modelId);
    return result;
  }

  async invokeStructured(
    modelId: string,
    prompt: PromptInput,
    schema: object,
    maxTokens?: number,
    sampling?: LLMSamplingConfig,
  ) {
    if (!this.inner.invokeStructured) {
      // Core's contract: this must be raised BEFORE any network call so the
      // pipeline's fallback to the text path costs nothing and stays silent.
      // Throwing a plain Error here instead makes core log a stack trace on
      // every orchestrator call.
      throw new StructuredOutputUnsupportedError('wrapped provider has no invokeStructured');
    }
    this.invocations++;
    const result = await this.inner.invokeStructured(modelId, prompt, schema, maxTokens, sampling);
    this.record(result.modelId);
    return result;
  }
}

/** One scripted stub reply. */
export interface StubReply {
  /** Matched against the rendered prompt; first match wins. */
  when: RegExp;
  /** Raw text the "model" returns. */
  text: string;
}

/**
 * Deterministic stub provider for zero-cost runs.
 *
 * It FABRICATES `usage` on a priced model id deliberately. A usage-less stub
 * yields `estimatedCostUsd = 0`, and then the spend cap can never fire and
 * its test cannot fail — so the obvious stub would ship an untestable cap.
 */
export class StubProvider implements ILLMProvider {
  invocations = 0;

  constructor(
    private readonly replies: StubReply[],
    private readonly opts: {
      /** Returned as the echoed model. Defaults to whatever was requested. */
      reportModelAs?: string;
      /** Omit the echo entirely, to exercise the unverified path. */
      omitModelEcho?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      /** Reply used when nothing matches. Defaults to an empty findings set. */
      fallbackText?: string;
    } = {},
  ) {}

  async invoke(modelId: string, prompt: PromptInput): Promise<LLMInvokeResult> {
    this.invocations++;
    const rendered = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    const hit = this.replies.find((r) => r.when.test(rendered));
    return {
      text: hit ? hit.text : (this.opts.fallbackText ?? '{"findings": []}'),
      usage: {
        inputTokens: this.opts.inputTokens ?? 1000,
        outputTokens: this.opts.outputTokens ?? 500,
      },
      modelId: this.opts.omitModelEcho ? undefined : (this.opts.reportModelAs ?? modelId),
    };
  }
}
