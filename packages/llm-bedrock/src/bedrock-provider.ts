/**
 * Amazon Bedrock implementation of ILLMProvider.
 *
 * Wraps the existing Bedrock client logic (model-family detection,
 * Anthropic vs Titan request building) behind the ILLMProvider interface.
 *
 * Authentication: Uses the default credential provider chain which resolves
 * credentials automatically from (in order):
 *   1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
 *   2. SSO / shared credentials file (~/.aws/credentials)
 *   3. ECS container credentials
 *   4. EC2/Lambda instance profile (IMDS)
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig, LLMStructuredResult, TokenUsage, PromptInput} from '@mergewatch/core';
import { StructuredOutputUnsupportedError, renderPrompt, toCacheableBlocks, hasCacheableBoundary } from '@mergewatch/core';

// ─── Supported model IDs ───────────────────────────────────────────────────
export const SUPPORTED_MODELS = {
  'claude-opus-4.6': 'us.anthropic.claude-opus-4-6-v1',
  'claude-sonnet-4.6': 'us.anthropic.claude-sonnet-4-6',
  'claude-sonnet-5.5': 'us.anthropic.claude-sonnet-5-5',
  'claude-sonnet-4.5': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-sonnet-4': 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-haiku-4.5': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'amazon-titan-text': 'amazon.titan-text-express-v1',
} as const;

export type ModelAlias = keyof typeof SUPPORTED_MODELS;

// ─── Request body builders per model family ────────────────────────────────

interface ModelRequestBody {
  body: string;
  contentType: string;
  accept: string;
}

/**
 * Model families that REJECT non-default sampling parameters (#262).
 *
 * Anthropic removed `temperature` / `top_p` / `top_k` from Opus 4.7 onward and
 * from the entire 5 generation; sending any of them returns a 400, not a
 * degraded response. Everything older still accepts them, and MergeWatch has
 * always sent `temperature: 0` for deterministic reviews — so this cannot be a
 * blanket removal. Dropping the parameter for a model that accepts it would
 * silently move reviews from deterministic to default sampling.
 *
 * Patterns are deliberately narrow so near-miss IDs keep their sampling:
 * `claude-haiku-4-5` and `claude-sonnet-4-5` contain a "5" but are not the 5
 * generation.
 */
const REJECTS_SAMPLING_PARAMS: readonly RegExp[] = [
  // Opus 4.7, 4.8, and any later 4.x
  /claude-opus-4-(?:[7-9]|\d{2,})/,
  // The 5 generation, including its point releases (#721): Sonnet 5.5 and
  // Haiku 5.5 reject non-default values, Opus 5.5 and Fable 5.1 reject the
  // parameters outright. The optional `-\d+` takes in `-5-5` / `-5-1`; the
  // negative lookahead still keeps `claude-haiku-4-5` out of this pattern.
  /claude-(?:sonnet|opus|haiku|fable|mythos)-5(?:-\d+)?(?![\d-])/,
];

/**
 * #721 — models that return a 400 on a forced `tool_choice` (`tool` / `any`).
 * They get `auto` plus a final instruction naming the tool. Haiku 5.5 accepts
 * a forced tool and is deliberately absent. An unlisted rejecting model fails
 * loudly (400 → the caller's text fallback, logged), never silently.
 */
const REJECTS_FORCED_TOOL_CHOICE = /claude-(?:sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)(?![\d-])/;

/**
 * #721 — the only model that accepts `thinking: {type: 'between_tools'}`, its
 * thinking-off setting. Every other model rejects it with a 400. Reviews on
 * Sonnet 4.6 ran without thinking, so this keeps them like-for-like and keeps
 * adaptive thinking from spending the per-agent `max_tokens` budget.
 */
const THINKS_BETWEEN_TOOLS_ONLY = /claude-sonnet-5-5(?![\d-])/;

/** Final user block for models that cannot be forced onto the tool (#721). */
const EMIT_RESULT_INSTRUCTION = 'Return your result by calling the emit_result tool. Do not answer in text.';

/** #767 — follow-up turn when such a model answered in text anyway. */
const EMIT_RESULT_RETRY_INSTRUCTION = 'You answered in text. Call the emit_result tool now with your result; do not reply with text.';

/**
 * Whether this model accepts `temperature` / `top_p` / `top_k`.
 *
 * Unknown models default to **accepting**, preserving today's behavior. If a
 * newer model that rejects them is adopted without being added above, every
 * review fails with a loud 400 rather than drifting silently — the better of
 * the two failure modes, and the reason the flip to a new model is a
 * deliberate one-line repo edit (see infra/params/*.env).
 */
export function acceptsSamplingParams(modelId: string): boolean {
  return !REJECTS_SAMPLING_PARAMS.some((re) => re.test(modelId));
}

function buildAnthropicBody(
  prompt: PromptInput,
  maxTokens: number,
  sampling: LLMSamplingConfig,
  modelId: string,
): ModelRequestBody {
  // #490 — segments with more than one stability level become content blocks
  // with cache_control at the boundaries; anything else stays the plain string
  // it was, so a caller passing a string sees byte-identical behaviour.
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: hasCacheableBoundary(prompt) ? toCacheableBlocks(prompt) : renderPrompt(prompt),
    }],
  };
  if (THINKS_BETWEEN_TOOLS_ONLY.test(modelId)) body.thinking = { type: 'between_tools' };
  if (acceptsSamplingParams(modelId)) {
    body.temperature = sampling.temperature ?? 0;
    if (sampling.topP !== undefined) body.top_p = sampling.topP;
    if (sampling.topK !== undefined) body.top_k = sampling.topK;
  }
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    accept: 'application/json',
  };
}

/**
 * #390 — Anthropic-family body with a single forced tool: the model must call
 * `emit_result` and the API constrains its input against the JSON Schema.
 */
function buildAnthropicStructuredBody(
  prompt: PromptInput,
  schema: object,
  maxTokens: number,
  sampling: LLMSamplingConfig,
  modelId: string,
): ModelRequestBody {
  // #721 — a model that rejects forced tool use gets `auto`, steered by one
  // extra text block AFTER the cacheable blocks, so the cached prefix is the
  // same bytes it would otherwise be.
  const forced = !REJECTS_FORCED_TOOL_CHOICE.test(modelId);
  const content = forced
    ? (hasCacheableBoundary(prompt) ? toCacheableBlocks(prompt) : renderPrompt(prompt))
    : [...toCacheableBlocks(hasCacheableBoundary(prompt) ? prompt : renderPrompt(prompt)),
      { type: 'text', text: EMIT_RESULT_INSTRUCTION }];
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    // #490 — the STRUCTURED path needs the breakpoints too, and this is the
    // path that matters: since #390 the six finding agents PREFER
    // invokeStructured, so patching only buildAnthropicBody left every agent
    // call sending no cache_control at all. The first gate run after
    // breakpoints shipped showed cost unchanged and zero cache tokens, which
    // is exactly what a half-wired provider looks like.
    messages: [{ role: 'user', content }],
    tools: [{
      name: 'emit_result',
      description: 'Emit the structured result of your analysis.',
      input_schema: schema,
    }],
    tool_choice: forced ? { type: 'tool', name: 'emit_result' } : { type: 'auto' },
  };
  if (THINKS_BETWEEN_TOOLS_ONLY.test(modelId)) body.thinking = { type: 'between_tools' };
  if (acceptsSamplingParams(modelId)) {
    body.temperature = sampling.temperature ?? 0;
    if (sampling.topP !== undefined) body.top_p = sampling.topP;
    if (sampling.topK !== undefined) body.top_k = sampling.topK;
  }
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    accept: 'application/json',
  };
}

function buildTitanBody(
  prompt: PromptInput,
  maxTokens: number,
  sampling: LLMSamplingConfig,
): ModelRequestBody {
  return {
    body: JSON.stringify({
      inputText: renderPrompt(prompt),
      textGenerationConfig: {
        maxTokenCount: maxTokens,
        temperature: sampling.temperature ?? 0,
        topP: sampling.topP ?? 1,
      },
    }),
    contentType: 'application/json',
    accept: 'application/json',
  };
}

function isAnthropicModel(modelId: string): boolean {
  return modelId.includes('anthropic.');
}

function isTitanModel(modelId: string): boolean {
  return modelId.includes('amazon.titan');
}

function buildRequestBody(
  modelId: string,
  prompt: PromptInput,
  maxTokens: number,
  sampling: LLMSamplingConfig,
): ModelRequestBody {
  if (isAnthropicModel(modelId)) {
    return buildAnthropicBody(prompt, maxTokens, sampling, modelId);
  }
  if (isTitanModel(modelId)) {
    return buildTitanBody(prompt, maxTokens, sampling);
  }
  return buildAnthropicBody(prompt, maxTokens, sampling, modelId);
}

// ─── Response parsers per model family ─────────────────────────────────────

interface ParsedResponse {
  text: string;
  usage?: TokenUsage;
  /** #699 — model id echoed by the response body, when present. */
  modelId?: string;
  stopReason?: string;
}

/**
 * #721 — a refusal is HTTP 200 with `stop_reason: 'refusal'` and no usable
 * content, so without this it reads as "zero findings". Bedrock has no
 * server-side fallback; this is observability only.
 */
function logRefusal(modelId: string, parsed: { stop_reason?: string; stop_details?: { category?: string | null } }): void {
  if (parsed.stop_reason !== 'refusal') return;
  console.warn(`[refusal] model=${modelId} category=${parsed.stop_details?.category ?? 'unknown'}`);
}

function parseAnthropicResponse(raw: string, modelId: string): ParsedResponse {
  const parsed = JSON.parse(raw);
  logRefusal(modelId, parsed);
  // #721 — read text by block type, not position: with adaptive thinking the
  // first block can be an empty `thinking` block, and `content[0].text` was ''.
  const text = Array.isArray(parsed.content)
    ? parsed.content
      .filter((b: { type?: string; text?: unknown }) => b.type === 'text' && typeof b.text === 'string')
      .map((b: { text: string }) => b.text)
      .join('')
    : '';
  const usage: TokenUsage | undefined = parsed.usage
    ? {
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.output_tokens ?? 0,
        // #490 — the API reports these SEPARATELY from input_tokens, which
        // counts uncached input only. Unread, cached tokens vanish from the
        // bill entirely and reported cost falls further than true cost.
        cacheReadInputTokens: parsed.usage.cache_read_input_tokens ?? 0,
        cacheWriteInputTokens: parsed.usage.cache_creation_input_tokens ?? 0,
      }
    : undefined;
  return {
    text,
    usage,
    stopReason: parsed.stop_reason ?? undefined,
    // #699 — echoed by the Anthropic-on-Bedrock response body; absent for
    // model families whose body omits it, which reads as unverified.
    modelId: typeof parsed.model === 'string' ? parsed.model : undefined,
  };
}

function parseTitanResponse(raw: string): ParsedResponse {
  const parsed = JSON.parse(raw);
  const completionReason = parsed.results?.[0]?.completionReason;
  return {
    text: parsed.results?.[0]?.outputText ?? '',
    // Titan says LENGTH where Anthropic says max_tokens — normalize.
    stopReason: completionReason === 'LENGTH' ? 'max_tokens' : completionReason ?? undefined,
  };
}

function parseResponse(modelId: string, raw: string): ParsedResponse {
  if (isAnthropicModel(modelId)) return parseAnthropicResponse(raw, modelId);
  if (isTitanModel(modelId)) return parseTitanResponse(raw);
  return parseAnthropicResponse(raw, modelId);
}

// ─── Provider class ────────────────────────────────────────────────────────

export class BedrockLLMProvider implements ILLMProvider {
  private client: BedrockRuntimeClient;
  private readonly region: string;

  constructor(region?: string) {
    this.region = region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.client = this.createClient();
  }

  private createClient(): BedrockRuntimeClient {
    // maxAttempts: 10 with standard retry mode yields cumulative exponential
    // backoff of ~30-45s (with jitter) across a 429 burst — enough to span a
    // Bedrock TPM window where the SDK default of 3 attempts / ~0.6s is not.
    return new BedrockRuntimeClient({
      region: this.region,
      maxAttempts: 10,
      retryMode: 'standard',
    });
  }

  async invoke(
    modelId: string,
    prompt: PromptInput,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMInvokeResult> {
    const { body, contentType, accept } = buildRequestBody(modelId, prompt, maxTokens, sampling);

    const command = new InvokeModelCommand({
      modelId,
      body: new TextEncoder().encode(body),
      contentType,
      accept,
    });

    const response = await this.sendWithSignatureRecovery(command);
    const rawResponse = new TextDecoder().decode(response.body);
    const parsed = parseResponse(modelId, rawResponse);
    return { text: parsed.text, usage: parsed.usage, stopReason: parsed.stopReason, modelId: parsed.modelId };
  }

  // #390 — schema-constrained invocation via forced tool use. Only the
  // Anthropic model family supports tools on Bedrock; Titan throws
  // StructuredOutputUnsupportedError BEFORE any network call so the caller's
  // text fallback costs nothing.
  async invokeStructured(
    modelId: string,
    prompt: PromptInput,
    schema: object,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMStructuredResult> {
    if (isTitanModel(modelId)) {
      throw new StructuredOutputUnsupportedError(`Titan models have no tool support (${modelId})`);
    }
    const { body, contentType, accept } = buildAnthropicStructuredBody(prompt, schema, maxTokens, sampling, modelId);
    const send = async (json: string) => {
      const response = await this.sendWithSignatureRecovery(new InvokeModelCommand({
        modelId,
        body: new TextEncoder().encode(json),
        contentType,
        accept,
      }));
      const out = JSON.parse(new TextDecoder().decode(response.body));
      logRefusal(modelId, out);
      return out;
    };
    const toolUseOf = (r: { content?: unknown }) => (Array.isArray(r.content)
      ? r.content.find((b: { type?: string }) => b.type === 'tool_use')
      : undefined);
    let parsed = await send(body);
    let block = toolUseOf(parsed);
    // #767 — under `tool_choice: auto` the model can still end its turn in
    // text. Retry once, showing it its own answer and asking for the tool
    // call; both calls are billed, so both are counted.
    let priorUsage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    if (!block && parsed.stop_reason === 'end_turn' && REJECTS_FORCED_TOOL_CHOICE.test(modelId) && Array.isArray(parsed.content)) {
      console.warn(`[structured] model=${modelId} answered in text instead of emit_result — retrying once`);
      priorUsage = parsed.usage;
      const retry = JSON.parse(body);
      retry.messages.push(
        { role: 'assistant', content: parsed.content },
        { role: 'user', content: [{ type: 'text', text: EMIT_RESULT_RETRY_INSTRUCTION }] },
      );
      parsed = await send(JSON.stringify(retry));
      block = toolUseOf(parsed);
    }
    if (!block) {
      throw new Error(`Structured invocation returned no tool_use block (stop_reason: ${parsed.stop_reason})`);
    }
    const sum = (k: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens') =>
      (parsed.usage?.[k] ?? 0) + (priorUsage?.[k] ?? 0);
    return {
      object: block.input,
      usage: parsed.usage
        ? {
        inputTokens: sum('input_tokens'),
        outputTokens: sum('output_tokens'),
        // #490 — the API reports these SEPARATELY from input_tokens, which
        // counts uncached input only. Unread, cached tokens vanish from the
        // bill entirely and reported cost falls further than true cost.
        cacheReadInputTokens: sum('cache_read_input_tokens'),
        cacheWriteInputTokens: sum('cache_creation_input_tokens'),
      }
        : undefined,
      stopReason: parsed.stop_reason ?? undefined,
      // #721 — see parseAnthropicResponse; the probe checks this echo.
      modelId: typeof parsed.model === 'string' ? parsed.model : undefined,
    };
  }

  // Recover from SDK v3's poisoned systemClockOffset in long-lived warm Lambdas.
  private async sendWithSignatureRecovery(command: InvokeModelCommand) {
    try {
      return await this.client.send(command);
    } catch (err) {
      if (err instanceof Error && err.name === 'InvalidSignatureException') {
        console.warn('[bedrock] InvalidSignatureException — recreating client and retrying');
        this.client = this.createClient();
        return await this.client.send(command);
      }
      throw err;
    }
  }
}
