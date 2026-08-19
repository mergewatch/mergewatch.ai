import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig } from '@mergewatch/core';

export class LiteLLMProvider implements ILLMProvider {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
  ) {}

  async invoke(
    modelId: string,
    prompt: string,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMInvokeResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    // top_k is not part of the OpenAI chat-completions spec — LiteLLM proxies
    // it through to providers that support it when present, so we forward it
    // rather than drop it.
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        temperature: sampling.temperature ?? 0,
        ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
        ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LiteLLM request failed (${response.status}): ${body}`);
    }

    const data = await response.json() as any;
    // Optional-chained throughout: a misbehaving LiteLLM upstream can return
    // an empty choices array or omit fields; an empty text degrades into the
    // pipeline's parse-failure disclosure instead of crashing the review.
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    const usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined;
    // OpenAI vocab says 'length' where Anthropic says 'max_tokens' — normalize.
    const finishReason = choice?.finish_reason;
    return { text, usage, stopReason: finishReason === 'length' ? 'max_tokens' : finishReason ?? undefined };
  }
}
