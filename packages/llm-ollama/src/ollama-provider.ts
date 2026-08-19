import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig, LLMStructuredResult } from '@mergewatch/core';

export class OllamaLLMProvider implements ILLMProvider {
  constructor(private baseUrl: string = 'http://localhost:11434') {}

  async invoke(
    modelId: string,
    prompt: string,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMInvokeResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/chat`;
    const options: Record<string, unknown> = {
      num_predict: maxTokens,
      temperature: sampling.temperature ?? 0,
    };
    if (sampling.topP !== undefined) options.top_p = sampling.topP;
    if (sampling.topK !== undefined) options.top_k = sampling.topK;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        stream: false,
        options,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${body}`);
    }

    const data = await response.json() as any;
    const text = data.message.content;
    const usage = (data.prompt_eval_count != null || data.eval_count != null)
      ? { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 }
      : undefined;
    // Ollama says 'length' where Anthropic says 'max_tokens' — normalize.
    return { text, usage, stopReason: data.done_reason === 'length' ? 'max_tokens' : data.done_reason ?? undefined };
  }

  // #390 — schema-constrained invocation via Ollama structured outputs: the
  // request's `format` field carries the JSON Schema and constrained decoding
  // guarantees conformant output (Ollama ≥ 0.5). Older servers ignore the
  // field and may return prose — the JSON.parse below then throws and the
  // caller falls back to the hardened text path.
  async invokeStructured(
    modelId: string,
    prompt: string,
    schema: object,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMStructuredResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/chat`;
    const options: Record<string, unknown> = {
      num_predict: maxTokens,
      temperature: sampling.temperature ?? 0,
    };
    if (sampling.topP !== undefined) options.top_p = sampling.topP;
    if (sampling.topK !== undefined) options.top_k = sampling.topK;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        stream: false,
        options,
        format: schema,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama structured request failed (${response.status}): ${body}`);
    }
    const data = await response.json() as any;
    const object = JSON.parse(data.message?.content ?? '');
    const usage = (data.prompt_eval_count != null || data.eval_count != null)
      ? { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 }
      : undefined;
    return { object, usage, stopReason: data.done_reason === 'length' ? 'max_tokens' : data.done_reason ?? undefined };
  }
}
