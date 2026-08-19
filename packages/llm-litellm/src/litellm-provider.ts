import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig, LLMStructuredResult } from '@mergewatch/core';

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

  // #390 — schema-constrained invocation via the OpenAI `response_format:
  // json_schema` contract. `strict: false` because upstream support for the
  // strict validator varies wildly across LiteLLM's 100+ providers; the
  // format constraint alone eliminates prose-wrapped/multi-object responses.
  // An upstream that rejects response_format entirely returns a 4xx, which
  // throws here — the caller falls back to the hardened text path.
  async invokeStructured(
    modelId: string,
    prompt: string,
    schema: object,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMStructuredResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        temperature: sampling.temperature ?? 0,
        ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
        ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
        response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LiteLLM structured request failed (${response.status}): ${body}`);
    }
    const data = await response.json() as any;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    // The format contract guarantees the content IS the object — a parse
    // failure here means the upstream ignored response_format; throwing
    // routes the caller to the text fallback.
    const object = JSON.parse(content);
    const usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined;
    const finishReason = choice?.finish_reason;
    return { object, usage, stopReason: finishReason === 'length' ? 'max_tokens' : finishReason ?? undefined };
  }
}
