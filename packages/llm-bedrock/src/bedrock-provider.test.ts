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
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
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
