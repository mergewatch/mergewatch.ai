/**
 * Amazon Bedrock implementation of ILLMProvider.
 *
 * Wraps the existing Bedrock client logic (model-family detection,
 * Anthropic vs Titan request building) behind the ILLMProvider interface.
 *
 * Authentication: Uses the default credential provider chain which resolves
 * credentials automatically from (in order):
 *   1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
 *   2. SSO / shared credentials file (~/.aws/credentials)
 *   3. ECS container credentials
 *   4. EC2/Lambda instance profile (IMDS)
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { ILLMProvider, LLMInvokeResult, LLMSamplingConfig, TokenUsage } from '@mergewatch/core';

// ─── Supported model IDs ───────────────────────────────────────────────────
export const SUPPORTED_MODELS = {
  'claude-opus-4.6': 'us.anthropic.claude-opus-4-6-v1',
  'claude-sonnet-4': 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-haiku-4.5': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'amazon-titan-text': 'amazon.titan-text-express-v1',
} as const;

export type ModelAlias = keyof typeof SUPPORTED_MODELS;

// ─── Request body builders per model family ────────────────────────────────

interface ModelRequestBody {
  body: string;
  contentType: string;
  accept: string;
}

function buildAnthropicBody(
  prompt: string,
  maxTokens: number,
  sampling: LLMSamplingConfig,
): ModelRequestBody {
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature: sampling.temperature ?? 0,
    messages: [{ role: 'user', content: prompt }],
  };
  if (sampling.topP !== undefined) body.top_p = sampling.topP;
  if (sampling.topK !== undefined) body.top_k = sampling.topK;
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    accept: 'application/json',
  };
}

function buildTitanBody(
  prompt: string,
  maxTokens: number,
  sampling: LLMSamplingConfig,
): ModelRequestBody {
  return {
    body: JSON.stringify({
      inputText: prompt,
      textGenerationConfig: {
        maxTokenCount: maxTokens,
        temperature: sampling.temperature ?? 0,
        topP: sampling.topP ?? 1,
      },
    }),
    contentType: 'application/json',
    accept: 'application/json',
  };
}

function isAnthropicModel(modelId: string): boolean {
  return modelId.includes('anthropic.');
}

function isTitanModel(modelId: string): boolean {
  return modelId.includes('amazon.titan');
}

function buildRequestBody(
  modelId: string,
  prompt: string,
  maxTokens: number,
  sampling: LLMSamplingConfig,
): ModelRequestBody {
  if (isAnthropicModel(modelId)) {
    return buildAnthropicBody(prompt, maxTokens, sampling);
  }
  if (isTitanModel(modelId)) {
    return buildTitanBody(prompt, maxTokens, sampling);
  }
  return buildAnthropicBody(prompt, maxTokens, sampling);
}

// ─── Response parsers per model family ─────────────────────────────────────

interface ParsedResponse {
  text: string;
  usage?: TokenUsage;
}

function parseAnthropicResponse(raw: string): ParsedResponse {
  const parsed = JSON.parse(raw);
  const text = parsed.content?.[0]?.text ?? '';
  const usage: TokenUsage | undefined = parsed.usage
    ? { inputTokens: parsed.usage.input_tokens ?? 0, outputTokens: parsed.usage.output_tokens ?? 0 }
    : undefined;
  return { text, usage };
}

function parseTitanResponse(raw: string): ParsedResponse {
  const parsed = JSON.parse(raw);
  return { text: parsed.results?.[0]?.outputText ?? '' };
}

function parseResponse(modelId: string, raw: string): ParsedResponse {
  if (isAnthropicModel(modelId)) return parseAnthropicResponse(raw);
  if (isTitanModel(modelId)) return parseTitanResponse(raw);
  return parseAnthropicResponse(raw);
}

// ─── Provider class ────────────────────────────────────────────────────────

export class BedrockLLMProvider implements ILLMProvider {
  private client: BedrockRuntimeClient;
  private readonly region: string;

  constructor(region?: string) {
    this.region = region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.client = this.createClient();
  }

  private createClient(): BedrockRuntimeClient {
    // maxAttempts: 10 with standard retry mode yields cumulative exponential
    // backoff of ~30-45s (with jitter) across a 429 burst — enough to span a
    // Bedrock TPM window where the SDK default of 3 attempts / ~0.6s is not.
    return new BedrockRuntimeClient({
      region: this.region,
      maxAttempts: 10,
      retryMode: 'standard',
    });
  }

  async invoke(
    modelId: string,
    prompt: string,
    maxTokens = 4096,
    sampling: LLMSamplingConfig = {},
  ): Promise<LLMInvokeResult> {
    const { body, contentType, accept } = buildRequestBody(modelId, prompt, maxTokens, sampling);

    const command = new InvokeModelCommand({
      modelId,
      body: new TextEncoder().encode(body),
      contentType,
      accept,
    });

    const response = await this.sendWithSignatureRecovery(command);
    const rawResponse = new TextDecoder().decode(response.body);
    const parsed = parseResponse(modelId, rawResponse);
    return { text: parsed.text, usage: parsed.usage };
  }

  // Recover from SDK v3's poisoned systemClockOffset in long-lived warm Lambdas.
  private async sendWithSignatureRecovery(command: InvokeModelCommand) {
    try {
      return await this.client.send(command);
    } catch (err) {
      if (err instanceof Error && err.name === 'InvalidSignatureException') {
        console.warn('[bedrock] InvalidSignatureException — recreating client and retrying');
        this.client = this.createClient();
        return await this.client.send(command);
      }
      throw err;
    }
  }
}
