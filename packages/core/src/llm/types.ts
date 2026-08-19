/**
 * Provider-agnostic LLM interface.
 *
 * Implementations:
 *   - BedrockLLMProvider (packages/llm-bedrock)
 *   - AnthropicLLMProvider (packages/llm-anthropic)
 *   - LiteLLMProvider (packages/llm-litellm)
 *   - OllamaLLMProvider (packages/llm-ollama)
 */

/** Token usage from a single LLM invocation. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Result from an LLM invocation, optionally including token usage. */
export interface LLMInvokeResult {
  text: string;
  usage?: TokenUsage;
  /**
   * Why generation stopped, normalized to Anthropic vocabulary where the
   * provider uses different names ('length' → 'max_tokens'). 'max_tokens'
   * means the response was TRUNCATED at the output cap — the tail was never
   * generated, so downstream JSON parsing cannot succeed and the pipeline
   * retries once with a doubled cap. Absent on providers/paths that don't
   * surface it (legacy behavior: truncation is undetectable).
   */
  stopReason?: string;
}

/**
 * Sampling controls for a single invocation. Individual providers map these
 * to their own parameter names and silently drop anything they don't support
 * (e.g. OpenAI-compatible endpoints have no top_k). When omitted, providers
 * default to temperature 0 / greedy decode — the right call for structured
 * finding agents where re-run consistency matters more than output variety.
 */
export interface LLMSamplingConfig {
  /** 0 (default) = deterministic. Bump for generative agents (summary, diagram). */
  temperature?: number;
  /** Nucleus sampling cutoff. Provider-dependent effect; ignored by some. */
  topP?: number;
  /** Top-k sampling. Provider-dependent; ignored by OpenAI-spec endpoints. */
  topK?: number;
}

/**
 * Result of a schema-constrained invocation (#390). `object` is the payload
 * the provider validated/constrained against the caller's JSON Schema — no
 * text parsing involved, so the #382 class of "could not parse agent JSON
 * response" finding loss is structurally impossible on this path.
 */
export interface LLMStructuredResult<T = unknown> {
  object: T;
  usage?: TokenUsage;
  stopReason?: string;
}

/**
 * Thrown by `invokeStructured` when the provider (or the specific model)
 * cannot do schema-constrained output — e.g. Bedrock Titan, or a LiteLLM
 * upstream without `json_schema` support. Callers catch this SILENTLY and
 * fall back to the text path; it must be raised before any network call so
 * the fallback costs nothing.
 */
export class StructuredOutputUnsupportedError extends Error {
  constructor(detail: string) {
    super(`Structured output not supported: ${detail}`);
    this.name = 'StructuredOutputUnsupportedError';
  }
}

export interface ILLMProvider {
  invoke(
    modelId: string,
    prompt: string,
    maxTokens?: number,
    sampling?: LLMSamplingConfig,
  ): Promise<string | LLMInvokeResult>;
  /**
   * #390 — schema-constrained invocation. The provider forces the model to
   * emit an object matching `schema` (forced tool use on Anthropic/Bedrock,
   * `response_format: json_schema` on OpenAI-compatible endpoints, `format`
   * on Ollama) instead of writing JSON as prose. Optional: providers that
   * cannot support it either omit the method or throw
   * StructuredOutputUnsupportedError before any network call.
   */
  invokeStructured?(
    modelId: string,
    prompt: string,
    schema: object,
    maxTokens?: number,
    sampling?: LLMSamplingConfig,
  ): Promise<LLMStructuredResult>;
}

/** Normalize a string or LLMInvokeResult to always get an LLMInvokeResult. */
export function normalizeLLMResult(result: string | LLMInvokeResult): LLMInvokeResult {
  if (typeof result === 'string') {
    return { text: result };
  }
  return result;
}
