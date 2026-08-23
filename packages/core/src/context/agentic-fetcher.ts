/**
 * Agentic file fetching — lets LLM agents request files they need.
 *
 * Instead of pre-computing imports via regex, this module implements a
 * prompt-based tool protocol: the agent's first response may be a JSON
 * file request, which is fulfilled and injected before re-invoking.
 *
 * Works with any ILLMProvider (no tool-calling API required).
 */

import type { Octokit } from '@octokit/rest';
import type { ILLMProvider } from '../llm/types.js';
import { normalizeLLMResult } from '../llm/types.js';
import { fetchFileContents } from './file-fetcher.js';
import { sanitizeRelativePath } from './safe-path.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileFetchOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  maxContextKB: number;
  maxRounds: number;
}

export interface AgenticInvokeResult {
  response: string;
  fetchedFiles: Record<string, string>;
  roundsUsed: number;
}

// ─── Prompt instruction ─────────────────────────────────────────────────────

export const FILE_REQUEST_INSTRUCTION = `
## Requesting additional file context

If you need to see the full contents of files referenced in the diff (imports, type definitions, base classes, called functions, config files, etc.) to give a more accurate review, you may request them BEFORE providing your analysis.

To request files, respond with ONLY a JSON object in this exact format:
{ "requestFiles": ["path/to/file1.ts", "path/to/file2.py"] }

Rules:
- Request only files you genuinely need to understand the changes (e.g., imported modules, type definitions, base classes, utility functions being called).
- Use file paths as they would appear in the repository (relative to repo root).
- For relative imports in the diff, resolve them to full repo paths.
- Request at most 10 files.
- Do NOT request files whose contents are already visible in the diff.
- If you do NOT need additional context, skip this step and respond directly with your analysis.
- If files have already been provided in a "Related Files" section, do NOT re-request them.`;

// ─── Core logic ─────────────────────────────────────────────────────────────

/*
 * Path validation lives in `safe-path.ts` (#424). This module's paths are
 * resolved by the GitHub API against a repo tree, so lexical checks are
 * sufficient here — but the same strings will be joined onto a real worktree
 * once retrieval lands, and one validator with one set of tests is how the
 * two paths stay in step.
 */

/**
 * Parse a model response to check if it's a file request.
 * Returns the requested file paths, or null if the response is a normal analysis.
 */
function parseFileRequest(response: string): string[] | null {
  const trimmed = response.trim();

  // Strip markdown code fences if present
  let cleaned = trimmed;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Must look like a JSON object with requestFiles
  if (!cleaned.includes('"requestFiles"')) return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      Array.isArray(parsed.requestFiles) &&
      parsed.requestFiles.length > 0 &&
      parsed.requestFiles.every((p: unknown) => typeof p === 'string')
    ) {
      // Sanitize and filter paths, cap at 10 files
      const sanitized = parsed.requestFiles
        .map((p: string) => sanitizeRelativePath(p))
        .filter((p: string | null): p is string => p !== null)
        .slice(0, 10);

      return sanitized.length > 0 ? sanitized : null;
    }
  } catch {
    // Not valid JSON — treat as normal response
  }

  return null;
}

/**
 * Invoke an LLM with agentic file fetching.
 *
 * 1. Calls `llm.invoke()` with the base prompt (which includes FILE_REQUEST_INSTRUCTION).
 * 2. If the model responds with a `requestFiles` JSON, fetches those files via GitHub API.
 * 3. Re-invokes with the fetched files appended to the prompt.
 * 4. Returns the final response.
 *
 * If the model skips file requests and responds directly, no extra calls are made.
 */
export async function invokeWithFileFetching(
  llm: ILLMProvider,
  modelId: string,
  basePrompt: string,
  fetchOptions: FileFetchOptions,
  maxTokens?: number,
): Promise<AgenticInvokeResult> {
  const allFetchedFiles: Record<string, string> = {};
  let currentPrompt = basePrompt;
  let roundsUsed = 0;

  for (let round = 0; round < fetchOptions.maxRounds; round++) {
    let response: string;
    try {
      response = normalizeLLMResult(await llm.invoke(modelId, currentPrompt, maxTokens)).text;
    } catch (err) {
      console.warn('LLM invocation failed during agentic file fetching, falling back to no-context analysis:', err);
      // Fall back to a simple invoke without file fetching context
      if (round === 0) {
        throw err; // First round failure — let the caller handle it
      }
      // Subsequent round failure — return what we have from the previous round
      return { response: '', fetchedFiles: allFetchedFiles, roundsUsed };
    }
    roundsUsed++;

    const requestedFiles = parseFileRequest(response);
    if (!requestedFiles) {
      // Model responded with analysis — we're done
      return { response, fetchedFiles: allFetchedFiles, roundsUsed };
    }

    // Filter out files we already fetched
    const newFiles = requestedFiles.filter((f) => !(f in allFetchedFiles));
    if (newFiles.length === 0) {
      // Model requested files we already have — re-invoke without file request instruction
      // to force analysis output
      const forcePrompt = currentPrompt + '\n\nAll requested files have already been provided above. Please proceed with your analysis now.';
      const finalResponse = normalizeLLMResult(await llm.invoke(modelId, forcePrompt, maxTokens)).text;
      roundsUsed++;
      return { response: finalResponse, fetchedFiles: allFetchedFiles, roundsUsed };
    }

    // Calculate remaining budget
    const usedBytes = Object.values(allFetchedFiles)
      .reduce((sum, content) => sum + Buffer.byteLength(content, 'utf-8'), 0);
    const remainingKB = fetchOptions.maxContextKB - Math.ceil(usedBytes / 1024);

    if (remainingKB <= 0) {
      // Budget exhausted — re-invoke asking for analysis
      const budgetPrompt = currentPrompt + '\n\nContext budget exhausted. Please proceed with your analysis using the context already provided.';
      const finalResponse = normalizeLLMResult(await llm.invoke(modelId, budgetPrompt, maxTokens)).text;
      roundsUsed++;
      return { response: finalResponse, fetchedFiles: allFetchedFiles, roundsUsed };
    }

    // Fetch requested files
    let fetched: Record<string, string> = {};
    try {
      fetched = await fetchFileContents(
        fetchOptions.octokit,
        fetchOptions.owner,
        fetchOptions.repo,
        fetchOptions.ref,
        newFiles,
        remainingKB,
      );
    } catch (err) {
      console.warn(`Failed to fetch ${newFiles.length} requested file(s), proceeding without additional context:`, err);
    }

    if (Object.keys(fetched).length === 0) {
      console.warn(`None of the ${newFiles.length} requested file(s) could be fetched: ${newFiles.join(', ')}`);
      // No files fetched — force analysis without additional context
      const noFilesPrompt = currentPrompt + '\n\nThe requested files could not be fetched. Please proceed with your analysis using only the diff.';
      const finalResponse = normalizeLLMResult(await llm.invoke(modelId, noFilesPrompt, maxTokens)).text;
      roundsUsed++;
      return { response: finalResponse, fetchedFiles: allFetchedFiles, roundsUsed };
    }

    Object.assign(allFetchedFiles, fetched);

    // Build augmented prompt with fetched files
    const filesSection = Object.entries(allFetchedFiles)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n');

    currentPrompt = basePrompt
      + `\n\n--- Related Files ---\nThe following files were fetched at your request. Use them for context:\n\n${filesSection}`
      + '\n\nNow proceed with your analysis. Do NOT request more files.';
  }

  // Max rounds reached — do a final invoke forcing analysis
  const finalResponse = normalizeLLMResult(await llm.invoke(modelId, currentPrompt, maxTokens)).text;
  roundsUsed++;
  return { response: finalResponse, fetchedFiles: allFetchedFiles, roundsUsed };
}
