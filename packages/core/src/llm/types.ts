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

export interface ILLMProvider {
  invoke(
    modelId: string,
    prompt: string,
    maxTokens?: number,
    sampling?: LLMSamplingConfig,
  ): Promise<string | LLMInvokeResult>;
}

/** Normalize a string or LLMInvokeResult to always get an LLMInvokeResult. */
export function normalizeLLMResult(result: string | LLMInvokeResult): LLMInvokeResult {
  if (typeof result === 'string') {
    return { text: result };
  }
  return result;
}
