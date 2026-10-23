import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: class {
      send = mockSend;
    },
    InvokeModelCommand: class {
      modelId: string;
      body: Uint8Array;
      contentType: string;
      accept: string;
      constructor(params: any) {
        this.modelId = params.modelId;
        this.body = params.body;
        this.contentType = params.contentType;
        this.accept = params.accept;
      }
    },
  };
});

import { BedrockLLMProvider, SUPPORTED_MODELS } from './bedrock-provider';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

function makeResponse(body: object): { body: Uint8Array } {
  return { body: new TextEncoder().encode(JSON.stringify(body)) };
}

/** Extract the JSON body from the last InvokeModelCommand call */
function getLastCommandBody(): any {
  const lastCall = mockSend.mock.calls[0][0];
  return JSON.parse(new TextDecoder().decode(lastCall.body));
}

describe('BedrockLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds correct Anthropic request body for Claude models', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'Hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));

    const provider = new BedrockLLMProvider('us-east-1');
    await provider.invoke('us.anthropic.claude-sonnet-4-20250514-v1:0', 'test prompt', 2048);

    const command = mockSend.mock.calls[0][0];
    expect(command.modelId).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0');
    expect(command.contentType).toBe('application/json');
    expect(command.accept).toBe('application/json');

    const body = getLastCommandBody();
    expect(body).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user', content: 'test prompt' }],
    });
  });

  it('builds correct Titan request body', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      results: [{ outputText: 'Titan says hello' }],
    }));

    const provider = new BedrockLLMProvider();
    await provider.invoke('amazon.titan-text-express-v1', 'test prompt', 1024);

    const body = getLastCommandBody();
    expect(body).toEqual({
      inputText: 'test prompt',
      textGenerationConfig: {
        maxTokenCount: 1024,
        temperature: 0,
        topP: 1,
      },
    });
  });

  it('parses Anthropic response correctly with usage', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'Review result' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke('us.anthropic.claude-opus-4-6-v1', 'prompt');

    expect(result.text).toBe('Review result');
    // #490 — cache fields are reported even when the response carries none,
    // so an absent cache is an explicit zero rather than a missing number.
    expect(result.usage).toEqual({
      inputTokens: 100, outputTokens: 50,
      cacheReadInputTokens: 0, cacheWriteInputTokens: 0,
    });
  });

  it('parses Titan response correctly (no usage)', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      results: [{ outputText: 'Titan output' }],
    }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke('amazon.titan-text-express-v1', 'prompt');

    expect(result.text).toBe('Titan output');
    expect(result.usage).toBeUndefined();
  });

  it('surfaces Anthropic stop_reason as stopReason (truncation detection)', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'cut off mid-JSON' }],
      usage: { input_tokens: 100, output_tokens: 4096 },
      stop_reason: 'max_tokens',
    }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke('us.anthropic.claude-opus-4-6-v1', 'prompt');
    expect(result.stopReason).toBe('max_tokens');
  });

  it("normalizes Titan completionReason 'LENGTH' to stopReason 'max_tokens'", async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      results: [{ outputText: 'cut off', completionReason: 'LENGTH' }],
    }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke('amazon.titan-text-express-v1', 'prompt');
    expect(result.stopReason).toBe('max_tokens');
  });

  it('uses default maxTokens of 4096', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const provider = new BedrockLLMProvider();
    await provider.invoke('us.anthropic.claude-sonnet-4-20250514-v1:0', 'prompt');

    const body = getLastCommandBody();
    expect(body.max_tokens).toBe(4096);
  });

  it('passes custom maxTokens through', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const provider = new BedrockLLMProvider();
    await provider.invoke('us.anthropic.claude-sonnet-4-20250514-v1:0', 'prompt', 8192);

    const body = getLastCommandBody();
    expect(body.max_tokens).toBe(8192);
  });

  it('#390 — invokeStructured forces the emit_result tool and returns its input', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'tool_use', name: 'emit_result', input: { findings: [] } }],
      usage: { input_tokens: 50, output_tokens: 20 },
      stop_reason: 'tool_use',
    }));

    const provider = new BedrockLLMProvider();
    const schema = { type: 'object', properties: { findings: { type: 'array' } } };
    const result = await provider.invokeStructured('us.anthropic.claude-opus-4-6-v1', 'prompt', schema);

    expect(result.object).toEqual({ findings: [] });
    expect(result.stopReason).toBe('tool_use');
    const body = getLastCommandBody();
    expect(body.tools[0].name).toBe('emit_result');
    expect(body.tools[0].input_schema).toEqual(schema);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_result' });
  });

  it('#390 — invokeStructured throws when no tool_use block came back', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'prose instead' }],
      stop_reason: 'end_turn',
    }));
    const provider = new BedrockLLMProvider();
    await expect(provider.invokeStructured('us.anthropic.claude-opus-4-6-v1', 'prompt', {}))
      .rejects.toThrow(/no tool_use block/);
  });

  it('#390 — Titan throws StructuredOutputUnsupportedError before any network call', async () => {
    const provider = new BedrockLLMProvider();
    await expect(provider.invokeStructured('amazon.titan-text-express-v1', 'prompt', {}))
      .rejects.toMatchObject({ name: 'StructuredOutputUnsupportedError' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('has correct SUPPORTED_MODELS mapping', () => {
    expect(SUPPORTED_MODELS['claude-opus-4.6']).toBe('us.anthropic.claude-opus-4-6-v1');
    expect(SUPPORTED_MODELS['claude-sonnet-4']).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0');
    expect(SUPPORTED_MODELS['claude-haiku-4.5']).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(SUPPORTED_MODELS['amazon-titan-text']).toBe('amazon.titan-text-express-v1');
  });

  it('falls back to Anthropic request format for unknown models', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'fallback' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke('some.unknown.model-v1', 'prompt');

    const body = getLastCommandBody();
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(result.text).toBe('fallback');
  });

  it('defaults region to us-east-1 when not specified', () => {
    // Just verify the provider can be constructed without a region
    const provider = new BedrockLLMProvider();
    expect(provider).toBeDefined();
  });

  it('forwards sampling config (temperature, top_p, top_k) to Anthropic bodies', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const provider = new BedrockLLMProvider();
    await provider.invoke(
      'us.anthropic.claude-sonnet-4-6',
      'prompt',
      2048,
      { temperature: 0.3, topP: 0.95, topK: 40 },
    );

    const body = getLastCommandBody();
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.95);
    expect(body.top_k).toBe(40);
  });

  it('defaults sampling to temperature 0 when no config passed', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const provider = new BedrockLLMProvider();
    await provider.invoke('us.anthropic.claude-sonnet-4-6', 'prompt');

    const body = getLastCommandBody();
    expect(body.temperature).toBe(0);
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });

  it('self-heals from InvalidSignatureException with a client retry', async () => {
    const sigErr = new Error('Signature expired: 20260422T222327Z is now earlier than ...');
    sigErr.name = 'InvalidSignatureException';
    mockSend
      .mockRejectedValueOnce(sigErr)
      .mockResolvedValueOnce(makeResponse({
        content: [{ type: 'text', text: 'after retry' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke(
      'us.anthropic.claude-sonnet-4-20250514-v1:0', 'prompt',
    );

    expect(result.text).toBe('after retry');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-signature errors without retry', async () => {
    const err = new Error('ThrottlingException: Rate exceeded');
    err.name = 'ThrottlingException';
    mockSend.mockRejectedValueOnce(err);

    const provider = new BedrockLLMProvider();
    await expect(
      provider.invoke('us.anthropic.claude-sonnet-4-20250514-v1:0', 'prompt'),
    ).rejects.toThrow('ThrottlingException: Rate exceeded');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('handles Anthropic response with missing usage gracefully', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'no usage' }],
    }));

    const provider = new BedrockLLMProvider();
    const result = await provider.invoke('us.anthropic.claude-sonnet-4-20250514-v1:0', 'prompt');

    expect(result.text).toBe('no usage');
    expect(result.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #490 — BOTH request paths must carry cache breakpoints
//
// The bug this locks down: `buildAnthropicBody` was patched and
// `buildAnthropicStructuredBody` was not. Since #390 the six finding agents
// PREFER invokeStructured, so every agent call shipped with no cache_control
// at all. The first gate run after breakpoints landed showed cost unchanged at
// $4.53 and zero cache tokens — precisely what a half-wired provider looks
// like, and indistinguishable from "Bedrock ignored our breakpoints".
//
// Testing only the text path would have passed while the product cached
// nothing, which is why both are asserted here.
// ---------------------------------------------------------------------------
describe('#490 — cache breakpoints on every path', () => {
  const MODEL = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
  const SEGMENTS = [
    { id: 'shared', stability: 'static', text: 'DIRECTIVES' },
    { id: 'diff', stability: 'per-pr', text: '\n\nDIFF' },
    { id: 'agent', stability: 'per-call', text: '\n\nAGENT' },
  ] as never;

  beforeEach(() => vi.clearAllMocks());

  it('the TEXT path sends content blocks with cache_control', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = new BedrockLLMProvider('us-east-1');
    await provider.invoke(MODEL, SEGMENTS, 100);

    const content = getLastCommandBody().messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.filter((b: { cache_control?: unknown }) => b.cache_control).length).toBeGreaterThan(0);
  });

  it('the STRUCTURED path sends them too — the path the agents actually use', async () => {
    mockSend.mockResolvedValueOnce(makeResponse({
      content: [{ type: 'tool_use', name: 'emit_result', input: { ok: true } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = new BedrockLLMProvider('us-east-1');
    await provider.invokeStructured!(MODEL, SEGMENTS, { type: 'object' }, 100);

    const body = getLastCommandBody();
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content.filter((b: { cache_control?: unknown }) => b.cache_control).length)
      .toBeGreaterThan(0);
    // …and the forced tool is still there; caching must not disturb #390.
    expect(body.tools[0].name).toBe('emit_result');
  });

  it('both paths leave a plain string as a plain string', async () => {
    // An unmigrated caller must not start paying the 1.25x write premium.
    for (const structured of [false, true]) {
      vi.clearAllMocks();
      mockSend.mockResolvedValueOnce(makeResponse({
        content: [structured ? { type: 'tool_use', name: 'emit_result', input: {} } : { type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
      const provider = new BedrockLLMProvider('us-east-1');
      if (structured) await provider.invokeStructured!(MODEL, 'plain', { type: 'object' }, 100);
      else await provider.invoke(MODEL, 'plain', 100);
      expect(getLastCommandBody().messages[0].content).toBe('plain');
    }
  });
});

// ---------------------------------------------------------------------------
// #721 — the 5.5 generation
//
// At 4bb75f3, pointing a review at Sonnet 5.5 broke it three ways at once:
// `temperature: 0` and a forced `tool_choice` are both 400s on that model,
// and with adaptive thinking on by default `content[0]` is an empty thinking
// block, so the text path read ''. Each test below fails on main.
// ---------------------------------------------------------------------------
describe('#721 — Sonnet 5.5 and the rest of the 5.5 generation', () => {
  const SONNET_55 = 'us.anthropic.claude-sonnet-5-5';
  const SONNET_46 = 'us.anthropic.claude-sonnet-4-6';
  const SCHEMA = { type: 'object', properties: { findings: { type: 'array' } } };
  const SEGMENTS = [
    { id: 'shared', stability: 'static', text: 'DIRECTIVES' },
    { id: 'diff', stability: 'per-pr', text: '\n\nDIFF' },
    { id: 'agent', stability: 'per-call', text: '\n\nAGENT' },
  ] as never;
  const toolUse = () => makeResponse({
    content: [{ type: 'tool_use', name: 'emit_result', input: { findings: [] } }],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'tool_use',
  });
  const text = () => makeResponse({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const rawBody = (): string => new TextDecoder().decode(mockSend.mock.calls[0][0].body);

  beforeEach(() => vi.clearAllMocks());

  it('aliases Sonnet 5.5, so review rows record claude-sonnet-5.5 rather than the raw id', () => {
    // review-agent.ts persists this alias as the review row's `model`.
    expect(SUPPORTED_MODELS['claude-sonnet-5.5' as keyof typeof SUPPORTED_MODELS]).toBe(SONNET_55);
  });

  describe('structured body on a model that rejects forced tool use', () => {
    it('sends tool_choice auto, no temperature, and a final emit_result instruction', async () => {
      mockSend.mockResolvedValueOnce(toolUse());
      await new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA);
      const body = getLastCommandBody();
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body).not.toHaveProperty('temperature');
      const content = body.messages[0].content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[content.length - 1].text).toContain('emit_result');
      // The prompt itself is still there, ahead of the instruction.
      expect(content[0]).toEqual({ type: 'text', text: 'prompt' });
    });

    it('appends the instruction AFTER the cacheable blocks, leaving the cache prefix unchanged', async () => {
      mockSend.mockResolvedValueOnce(toolUse());
      await new BedrockLLMProvider().invokeStructured(SONNET_55, SEGMENTS, SCHEMA);
      const content = getLastCommandBody().messages[0].content;
      // The first three blocks are exactly what Sonnet 4.6 receives.
      expect(content.slice(0, -1)).toEqual([
        { type: 'text', text: 'DIRECTIVES', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nDIFF', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nAGENT' },
      ]);
      const last = content[content.length - 1];
      expect(last.text).toContain('emit_result');
      expect(last).not.toHaveProperty('cache_control');
    });

    for (const id of ['us.anthropic.claude-opus-5-5', 'global.anthropic.claude-fable-5-1']) {
      it(`${id} also gets tool_choice auto`, async () => {
        mockSend.mockResolvedValueOnce(toolUse());
        await new BedrockLLMProvider().invokeStructured(id, 'prompt', SCHEMA);
        expect(getLastCommandBody().tool_choice).toEqual({ type: 'auto' });
      });
    }

    it('Haiku 5.5 accepts a forced tool, so it keeps it', async () => {
      mockSend.mockResolvedValueOnce(toolUse());
      await new BedrockLLMProvider().invokeStructured('us.anthropic.claude-haiku-5-5', 'prompt', SCHEMA);
      expect(getLastCommandBody().tool_choice).toEqual({ type: 'tool', name: 'emit_result' });
    });
  });

  describe('#767 — retry once when an auto-tool_choice model answers in text', () => {
    const prose = (usage = { input_tokens: 10, output_tokens: 3 }) => makeResponse({
      content: [{ type: 'text', text: 'Here are my findings: none.' }],
      usage,
      stop_reason: 'end_turn',
    });
    const bodyOf = (n: number) => JSON.parse(new TextDecoder().decode(mockSend.mock.calls[n][0].body));

    it('retries with its own answer and an emit_result follow-up, and returns the tool result', async () => {
      mockSend.mockResolvedValueOnce(prose()).mockResolvedValueOnce(toolUse());
      const r = await new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA);
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(r.object).toEqual({ findings: [] });
      const retry = bodyOf(1);
      // Same first turn (same cached prefix), then the model's answer, then the nudge.
      expect(retry.messages[0]).toEqual(bodyOf(0).messages[0]);
      expect(retry.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Here are my findings: none.' }] });
      expect(retry.messages[2].role).toBe('user');
      expect(retry.messages[2].content[0].text).toContain('emit_result');
      expect(retry.tool_choice).toEqual({ type: 'auto' });
    });

    it('counts the usage of both billed calls', async () => {
      mockSend.mockResolvedValueOnce(prose()).mockResolvedValueOnce(toolUse());
      const r = await new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA);
      expect(r.usage).toMatchObject({ inputTokens: 11, outputTokens: 4 });
    });

    it('throws after one retry, never loops', async () => {
      mockSend.mockResolvedValueOnce(prose()).mockResolvedValueOnce(prose());
      await expect(new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA))
        .rejects.toThrow(/no tool_use block \(stop_reason: end_turn\)/);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('does not retry a stop other than end_turn (max_tokens, refusal)', async () => {
      for (const stop_reason of ['max_tokens', 'refusal']) {
        mockSend.mockReset();
        mockSend.mockResolvedValueOnce(makeResponse({ content: [{ type: 'text', text: 'x' }], stop_reason }));
        await expect(new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA)).rejects.toThrow(/no tool_use block/);
        expect(mockSend).toHaveBeenCalledTimes(1);
      }
    });

    it('does not retry a forced-tool model (Sonnet 4.6), whose miss is a real failure', async () => {
      mockSend.mockResolvedValueOnce(prose());
      await expect(new BedrockLLMProvider().invokeStructured(SONNET_46, 'prompt', SCHEMA)).rejects.toThrow(/no tool_use block/);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('[pin] the Sonnet 4.6 bodies are byte-identical to main', () => {
    it('structured, plain string', async () => {
      mockSend.mockResolvedValueOnce(toolUse());
      await new BedrockLLMProvider().invokeStructured(SONNET_46, 'prompt', SCHEMA, 4096);
      expect(rawBody()).toBe(JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'prompt' }],
        tools: [{ name: 'emit_result', description: 'Emit the structured result of your analysis.', input_schema: SCHEMA }],
        tool_choice: { type: 'tool', name: 'emit_result' },
        temperature: 0,
      }));
    });

    it('structured, cacheable segments', async () => {
      mockSend.mockResolvedValueOnce(toolUse());
      await new BedrockLLMProvider().invokeStructured(SONNET_46, SEGMENTS, SCHEMA, 4096);
      expect(rawBody()).toBe(JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'DIRECTIVES', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '\n\nDIFF', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '\n\nAGENT' },
        ] }],
        tools: [{ name: 'emit_result', description: 'Emit the structured result of your analysis.', input_schema: SCHEMA }],
        tool_choice: { type: 'tool', name: 'emit_result' },
        temperature: 0,
      }));
    });

    it('text', async () => {
      mockSend.mockResolvedValueOnce(text());
      await new BedrockLLMProvider().invoke(SONNET_46, 'prompt', 4096);
      expect(rawBody()).toBe(JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'prompt' }],
        temperature: 0,
      }));
    });
  });

  describe('thinking: between_tools on Sonnet 5.5 only', () => {
    it('Sonnet 5.5 carries thinking between_tools on both paths', async () => {
      mockSend.mockResolvedValueOnce(text());
      await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(getLastCommandBody().thinking).toEqual({ type: 'between_tools' });

      vi.clearAllMocks();
      mockSend.mockResolvedValueOnce(toolUse());
      await new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA);
      expect(getLastCommandBody().thinking).toEqual({ type: 'between_tools' });
    });

    // Every other model rejects between_tools with a 400.
    for (const id of [
      'us.anthropic.claude-opus-5-5',
      'us.anthropic.claude-fable-5-1',
      'us.anthropic.claude-haiku-5-5',
      'us.anthropic.claude-sonnet-4-6',
    ]) {
      it(`${id} has no thinking key on either path`, async () => {
        mockSend.mockResolvedValueOnce(text());
        await new BedrockLLMProvider().invoke(id, 'prompt');
        expect(getLastCommandBody()).not.toHaveProperty('thinking');

        vi.clearAllMocks();
        mockSend.mockResolvedValueOnce(toolUse());
        await new BedrockLLMProvider().invokeStructured(id, 'prompt', SCHEMA);
        expect(getLastCommandBody()).not.toHaveProperty('thinking');
      });
    }
  });

  describe('text is read by block type, not position', () => {
    it('skips a leading empty thinking block', async () => {
      mockSend.mockResolvedValueOnce(makeResponse({
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'X' }],
      }));
      const r = await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(r.text).toBe('X');
    });

    it('joins every text block around a thinking block', async () => {
      mockSend.mockResolvedValueOnce(makeResponse({
        content: [{ type: 'text', text: 'A' }, { type: 'thinking', thinking: '' }, { type: 'text', text: 'B' }],
      }));
      const r = await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(r.text).toBe('AB');
    });

    it('still returns empty text when there are no text blocks', async () => {
      mockSend.mockResolvedValueOnce(makeResponse({ content: [{ type: 'thinking', thinking: '' }] }));
      const r = await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(r.text).toBe('');
    });
  });

  describe('the reported model is returned', () => {
    it('text path', async () => {
      mockSend.mockResolvedValueOnce(makeResponse({
        model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }],
      }));
      const r = await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(r.modelId).toBe('claude-sonnet-5-5');
    });

    it('structured path', async () => {
      mockSend.mockResolvedValueOnce(makeResponse({
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', name: 'emit_result', input: {} }],
        stop_reason: 'tool_use',
      }));
      const r = await new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA);
      expect(r.modelId).toBe('claude-sonnet-5-5');
    });

    it('is undefined, not a guess, when the body carries no model', async () => {
      mockSend.mockResolvedValueOnce(toolUse());
      const r = await new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA);
      expect(r.modelId).toBeUndefined();
    });
  });

  describe('refusals are logged', () => {
    const refusal = (content: unknown[]) => makeResponse({
      content,
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' },
      usage: { input_tokens: 1, output_tokens: 0 },
    });

    it('text path logs [refusal] with model and category', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSend.mockResolvedValueOnce(refusal([]));
      const r = await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(r.stopReason).toBe('refusal');
      expect(warn).toHaveBeenCalledWith(`[refusal] model=${SONNET_55} category=cyber`);
      warn.mockRestore();
    });

    it('structured path logs [refusal] before throwing for the missing tool_use', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSend.mockResolvedValueOnce(refusal([]));
      await expect(new BedrockLLMProvider().invokeStructured(SONNET_55, 'prompt', SCHEMA))
        .rejects.toThrow(/stop_reason: refusal/);
      expect(warn).toHaveBeenCalledWith(`[refusal] model=${SONNET_55} category=cyber`);
      warn.mockRestore();
    });

    it('a refusal with no stop_details still logs, with category=unknown', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSend.mockResolvedValueOnce(makeResponse({ content: [], stop_reason: 'refusal' }));
      await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(warn).toHaveBeenCalledWith(`[refusal] model=${SONNET_55} category=unknown`);
      warn.mockRestore();
    });

    it('logs nothing for an ordinary stop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSend.mockResolvedValueOnce(text());
      await new BedrockLLMProvider().invoke(SONNET_55, 'prompt');
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
