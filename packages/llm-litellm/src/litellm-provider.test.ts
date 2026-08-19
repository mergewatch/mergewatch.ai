import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiteLLMProvider } from './litellm-provider';

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

describe('LiteLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes OpenAI finish_reason 'length' to stopReason 'max_tokens'", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 1, completion_tokens: 4096 },
      }),
    );
    const provider = new LiteLLMProvider('http://localhost:4000');
    const result = await provider.invoke('gpt-4', 'prompt');
    expect((result as { stopReason?: string }).stopReason).toBe('max_tokens');
  });

  it('#390 — invokeStructured sends response_format json_schema and parses the content object', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: '{"findings": []}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const provider = new LiteLLMProvider('http://localhost:4000');
    const schema = { type: 'object', properties: { findings: { type: 'array' } } };
    const result = await provider.invokeStructured('gpt-4', 'prompt', schema);

    expect(result.object).toEqual({ findings: [] });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'result', schema, strict: false } });
  });

  it('#390 — invokeStructured throws when the upstream ignored response_format (prose content)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: 'I found no issues.' }, finish_reason: 'stop' }] }),
    );
    const provider = new LiteLLMProvider('http://localhost:4000');
    await expect(provider.invokeStructured('gpt-4', 'prompt', {})).rejects.toThrow();
  });

  it('constructs correct URL from baseUrl + /chat/completions', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const provider = new LiteLLMProvider('http://localhost:4000');
    await provider.invoke('gpt-4', 'prompt');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/chat/completions',
      expect.anything(),
    );
  });

  it('strips trailing slash from baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const provider = new LiteLLMProvider('http://localhost:4000/');
    await provider.invoke('gpt-4', 'prompt');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/chat/completions',
      expect.anything(),
    );
  });

  it('includes Authorization header when apiKey provided', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const provider = new LiteLLMProvider('http://localhost:4000', 'my-secret-key');
    await provider.invoke('gpt-4', 'prompt');

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['Authorization']).toBe('Bearer my-secret-key');
  });

  it('does not include Authorization header when apiKey omitted', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const provider = new LiteLLMProvider('http://localhost:4000');
    await provider.invoke('gpt-4', 'prompt');

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['Authorization']).toBeUndefined();
  });

  it('sends correct OpenAI-compatible request body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const provider = new LiteLLMProvider('http://localhost:4000');
    await provider.invoke('gpt-4', 'test prompt', 2048);

    const callArgs = mockFetch.mock.calls[0][1];
    const body = JSON.parse(callArgs.body);
    expect(body).toEqual({
      model: 'gpt-4',
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user', content: 'test prompt' }],
    });
  });

  it('parses response and extracts usage', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'LLM response text' } }],
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      }),
    );

    const provider = new LiteLLMProvider('http://localhost:4000');
    const result = await provider.invoke('gpt-4', 'prompt');

    expect(result.text).toBe('LLM response text');
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'rate limited' }, 429),
    );

    const provider = new LiteLLMProvider('http://localhost:4000');
    await expect(provider.invoke('gpt-4', 'prompt')).rejects.toThrow(
      'LiteLLM request failed (429)',
    );
  });
});
