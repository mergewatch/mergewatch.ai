import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaLLMProvider } from './ollama-provider';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe('OllamaLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes done_reason 'length' to stopReason 'max_tokens'", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'cut off' },
        done_reason: 'length',
        prompt_eval_count: 10,
        eval_count: 4096,
      }),
    );
    const provider = new OllamaLLMProvider('http://myhost:11434');
    const result = await provider.invoke('llama3', 'prompt');
    expect((result as { stopReason?: string }).stopReason).toBe('max_tokens');
  });

  it('#390 — invokeStructured sends the schema as `format` and parses the content object', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: '{"findings": []}' },
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 4,
      }),
    );
    const provider = new OllamaLLMProvider('http://myhost:11434');
    const schema = { type: 'object', properties: { findings: { type: 'array' } } };
    const result = await provider.invokeStructured('llama3', 'prompt', schema);

    expect(result.object).toEqual({ findings: [] });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.format).toEqual(schema);
  });

  it('#390 — invokeStructured throws on prose content (older Ollama ignoring `format`)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'no json here' }, done_reason: 'stop' }),
    );
    const provider = new OllamaLLMProvider('http://myhost:11434');
    await expect(provider.invokeStructured('llama3', 'prompt', {})).rejects.toThrow();
  });

  it('constructs correct URL: {baseUrl}/api/chat', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'hello' },
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    );

    const provider = new OllamaLLMProvider('http://myhost:11434');
    await provider.invoke('llama3', 'prompt');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://myhost:11434/api/chat',
      expect.anything(),
    );
  });

  it('uses default baseUrl of http://localhost:11434', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'hello' },
      }),
    );

    const provider = new OllamaLLMProvider();
    await provider.invoke('llama3', 'prompt');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.anything(),
    );
  });

  it('sends correct body format with stream: false and num_predict', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'hi' },
      }),
    );

    const provider = new OllamaLLMProvider();
    await provider.invoke('llama3', 'test prompt', 2048);

    const callArgs = mockFetch.mock.calls[0][1];
    const body = JSON.parse(callArgs.body);
    expect(body).toEqual({
      model: 'llama3',
      stream: false,
      options: { num_predict: 2048, temperature: 0 },
      messages: [{ role: 'user', content: 'test prompt' }],
    });
  });

  it('parses response and extracts message content', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'Ollama says hello' },
        prompt_eval_count: 20,
        eval_count: 15,
      }),
    );

    const provider = new OllamaLLMProvider();
    const result = await provider.invoke('llama3', 'prompt');

    expect(result.text).toBe('Ollama says hello');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
  });

  it('handles missing usage fields gracefully', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'no usage data' },
      }),
    );

    const provider = new OllamaLLMProvider();
    const result = await provider.invoke('llama3', 'prompt');

    expect(result.text).toBe('no usage data');
    expect(result.usage).toBeUndefined();
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'model not found' }, 404),
    );

    const provider = new OllamaLLMProvider();
    await expect(provider.invoke('nonexistent', 'prompt')).rejects.toThrow(
      'Ollama request failed (404)',
    );
  });
});
