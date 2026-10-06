/**
 * #699 — a scripted stub provider, so every acceptance criterion is
 * reachable at zero cost.
 *
 * It routes by prompt kind the same way the repo's own pipeline tests do
 * (`reviewer.test.ts` keys the orchestrator off `--- Findings from all
 * agents`), and it FABRICATES token usage on a priced model id on purpose:
 * a usage-less stub reports `estimatedCostUsd = 0`, and then the spend cap
 * can never fire and its test cannot fail.
 */
import type { ILLMProvider, LLMInvokeResult, PromptInput } from '@mergewatch/core';
import type { BenchCase, StubFinding } from './types.js';

/** Marker the orchestrator prompt carries; also used by core's own tests. */
const ORCHESTRATOR_MARKER = '--- Findings from all agents';
/** Distinctive line from DIAGRAM_PROMPT; its consumer wants a fence. */
const DIAGRAM_MARKER = 'produce a Mermaid diagram';

function renderPrompt(prompt: PromptInput): string {
  return typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
}

export interface StubOptions {
  /** Echo this model id instead of the requested one, to fail verification. */
  reportModelAs?: string;
  /** Echo no model id at all, to exercise the unattributable path. */
  omitModelEcho?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Build a provider that emits `bcase.stubFindings` for every finding agent
 * and for the orchestrator, and benign replies for summary and diagram.
 *
 * A case with no `stubFindings` yields an empty findings set — the negative
 * control.
 */
export function createCaseStub(bcase: BenchCase, opts: StubOptions = {}): ILLMProvider & {
  invocations: number;
} {
  const findings: StubFinding[] = bcase.stubFindings ?? [];
  /**
   * One reply shape that satisfies every JSON consumer in the pipeline.
   *
   * `safeParseJson` takes a REQUIRED KEY and warns when it is absent, so a
   * reply carrying only `findings` makes the caption path log a parse failure
   * on every single run — noise that would hide a real one. Carrying every
   * key the pipeline asks for is both quieter and less brittle than matching
   * each prompt by its wording.
   */
  const agentReply = JSON.stringify({
    findings: findings.map((f) => ({ confidence: 90, suggestion: '', ...f })),
    caption: 'Scripted stub caption.',
    summary: 'A scripted stub summary of the change under test.',
  });
  const orchestratorReply = JSON.stringify({
    findings: findings.map((f) => ({
      confidence: 90,
      suggestion: '',
      ...f,
      category: 'bug',
    })),
    caption: 'Scripted stub caption.',
    mergeScore: findings.length > 0 ? 3 : 5,
    mergeScoreReason: 'Scripted stub response.',
  });

  return {
    invocations: 0,
    async invoke(modelId: string, prompt: PromptInput): Promise<LLMInvokeResult> {
      this.invocations++;
      const rendered = renderPrompt(prompt);
      let text: string;
      if (rendered.includes(ORCHESTRATOR_MARKER)) {
        text = orchestratorReply;
      } else if (rendered.includes(DIAGRAM_MARKER)) {
        text = '```mermaid\ngraph TD\n  A[stub]\n```';
      } else {
        text = agentReply;
      }
      return {
        text,
        // Fabricated on purpose — see the file header.
        usage: {
          inputTokens: opts.inputTokens ?? 1000,
          outputTokens: opts.outputTokens ?? 500,
        },
        modelId: opts.omitModelEcho ? undefined : (opts.reportModelAs ?? modelId),
      };
    },
  };
}
