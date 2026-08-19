import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { AnthropicLLMProvider } from './anthropic-provider';

describe('AnthropicLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls client.messages.create with correct params', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const provider = new AnthropicLLMProvider('test-api-key');
    await provider.invoke('claude-sonnet-4-20250514', 'hello', 2048);

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('surfaces stop_reason as stopReason (truncation detection)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'cut off mid-JSON' }],
      usage: { input_tokens: 10, output_tokens: 4096 },
      stop_reason: 'max_tokens',
    });
    const provider = new AnthropicLLMProvider('test-api-key');
    const result = await provider.invoke('claude-sonnet-4-20250514', 'hello');
    expect((result as { stopReason?: string }).stopReason).toBe('max_tokens');
  });

  it('#390 — invokeStructured forces the emit_result tool and returns its input', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'emit_result', input: { valid: false, reason: 'r' } }],
      usage: { input_tokens: 5, output_tokens: 9 },
      stop_reason: 'tool_use',
    });
    const provider = new AnthropicLLMProvider('test-api-key');
    const schema = { type: 'object', properties: { valid: { type: 'boolean' } } };
    const result = await provider.invokeStructured('claude-sonnet-4-20250514', 'verify', schema);

    expect(result.object).toEqual({ valid: false, reason: 'r' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({ name: 'emit_result', input_schema: schema })],
      tool_choice: { type: 'tool', name: 'emit_result' },
    }));
  });

  it('#390 — invokeStructured throws when the response has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'prose' }],
      usage: { input_tokens: 5, output_tokens: 9 },
      stop_reason: 'end_turn',
    });
    const provider = new AnthropicLLMProvider('test-api-key');
    await expect(provider.invokeStructured('claude-sonnet-4-20250514', 'verify', {}))
      .rejects.toThrow(/no tool_use block/);
  });

  it('returns text from first content block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'The answer is 42' }],
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    const provider = new AnthropicLLMProvider('key');
    const result = await provider.invoke('claude-sonnet-4-20250514', 'prompt');

    expect(result.text).toBe('The answer is 42');
  });

  it('returns usage with inputTokens and outputTokens', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const provider = new AnthropicLLMProvider('key');
    const result = await provider.invoke('claude-sonnet-4-20250514', 'prompt');

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('uses default maxTokens of 4096', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = new AnthropicLLMProvider('key');
    await provider.invoke('claude-sonnet-4-20250514', 'prompt');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    );
  });

  it('throws on non-text content block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'image', source: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = new AnthropicLLMProvider('key');
    await expect(provider.invoke('claude-sonnet-4-20250514', 'prompt')).rejects.toThrow(
      'Unexpected response type: image',
    );
  });
});
