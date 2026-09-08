import { renderPrompt, toCacheableBlocks, hasCacheableBoundary } from '@mergewatch/core';
import Anthropic from '@anthropic-ai/sdk';
import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig, LLMStructuredResult, PromptInput} from '@mergewatch/core';

export class AnthropicLLMProvider implements ILLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async invoke(
    modelId: string,
    prompt: PromptInput,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMInvokeResult> {
    const response = await this.client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature: sampling.temperature ?? 0,
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
      // #489 — rendered here rather than upstream. This provider does not yet
      // place cache breakpoints, so segments collapse to exactly the string
      // it built before.
      messages: [{
        role: 'user',
        content: hasCacheableBoundary(prompt) ? toCacheableBlocks(prompt) : renderPrompt(prompt),
      }] as never,
    });
    const block = response.content[0];
    if (block.type !== 'text') {
      throw new Error(`Unexpected response type: ${block.type}`);
    }
    return {
      text: block.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // #490 — separate fields; input_tokens is uncached input only.
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: response.stop_reason ?? undefined,
    };
  }

  // #390 — schema-constrained invocation via forced tool use: the model MUST
  // call the single tool, and the API validates/constrains its input against
  // the JSON Schema — no free-text JSON to parse.
  async invokeStructured(
    modelId: string,
    prompt: PromptInput,
    schema: object,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMStructuredResult> {
    const response = await this.client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature: sampling.temperature ?? 0,
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
      tools: [{
        name: 'emit_result',
        description: 'Emit the structured result of your analysis.',
        input_schema: schema as Anthropic.Messages.Tool['input_schema'],
      }],
      tool_choice: { type: 'tool', name: 'emit_result' },
      // #489 — rendered here rather than upstream. This provider does not yet
      // place cache breakpoints, so segments collapse to exactly the string
      // it built before.
      messages: [{
        role: 'user',
        content: hasCacheableBoundary(prompt) ? toCacheableBlocks(prompt) : renderPrompt(prompt),
      }] as never,
    });
    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new Error(`Structured invocation returned no tool_use block (stop_reason: ${response.stop_reason})`);
    }
    return {
      object: block.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // #490 — separate fields; input_tokens is uncached input only.
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: response.stop_reason ?? undefined,
    };
  }
}
