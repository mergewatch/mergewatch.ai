import { describe, it, expect, vi } from 'vitest';
import { invokeWithFileFetching, type FileFetchOptions } from './agentic-fetcher.js';
import type { ILLMProvider } from '../llm/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLLM(responses: string[]): ILLMProvider & { calls: string[] } {
  let idx = 0;
  const calls: string[] = [];
  return {
    calls,
    async invoke(_modelId: string, prompt: string) {
      calls.push(prompt);
      return responses[idx++] ?? responses[responses.length - 1];
    },
  };
}

function createMockOctokit(files: Record<string, string>) {
  return {
    repos: {
      getContent: async ({ path }: { owner: string; repo: string; path: string; ref: string }) => {
        const content = files[path];
        if (!content) throw new Error(`File not found: ${path}`);
        return {
          data: {
            type: 'file',
            content: Buffer.from(content).toString('base64'),
            encoding: 'base64',
          },
        };
      },
    },
  } as any;
}

function makeFetchOptions(
  files: Record<string, string> = {},
  overrides: Partial<FileFetchOptions> = {},
): FileFetchOptions {
  return {
    octokit: createMockOctokit(files),
    owner: 'test-owner',
    repo: 'test-repo',
    ref: 'abc123',
    maxContextKB: 256,
    maxRounds: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// invokeWithFileFetching
// ---------------------------------------------------------------------------

describe('invokeWithFileFetching', () => {
  it('returns direct response when LLM does not request files', async () => {
    const llm = createMockLLM(['{"findings": []}']);
    const result = await invokeWithFileFetching(
      llm, 'model-id', 'Analyze this diff', makeFetchOptions(),
    );
    expect(result.response).toBe('{"findings": []}');
    expect(result.roundsUsed).toBe(1);
    expect(Object.keys(result.fetchedFiles)).toHaveLength(0);
  });

  it('fetches files and re-invokes when LLM requests files', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["src/foo.ts"]}',
      '{"findings": ["issue in foo"]}',
    ]);
    const opts = makeFetchOptions({ 'src/foo.ts': 'export const foo = 42;' });
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze this diff', opts);

    expect(result.roundsUsed).toBe(2);
    expect(result.fetchedFiles['src/foo.ts']).toBe('export const foo = 42;');
    expect(result.response).toBe('{"findings": ["issue in foo"]}');
    // Second prompt should include the fetched file content
    expect(llm.calls[1]).toContain('src/foo.ts');
    expect(llm.calls[1]).toContain('export const foo = 42;');
  });

  // #390 — structured mode folds requestFiles into the findings schema, so
  // the response carries BOTH keys. Non-empty requestFiles must still trigger
  // a fetch round; empty/absent requestFiles must read as a final response.
  it('fetches when requestFiles appears alongside findings (structured-mode shape)', async () => {
    const llm = createMockLLM([
      '{"findings": [], "requestFiles": ["src/foo.ts"]}',
      '{"findings": [{"file": "src/foo.ts", "line": 1, "severity": "warning", "title": "x"}]}',
    ]);
    const opts = makeFetchOptions({ 'src/foo.ts': 'export const foo = 42;' });
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze this diff', opts);
    expect(result.roundsUsed).toBe(2);
    expect(result.fetchedFiles['src/foo.ts']).toBe('export const foo = 42;');
  });

  it('treats an empty requestFiles array alongside findings as a final response (structured-mode shape)', async () => {
    const llm = createMockLLM(['{"findings": [], "requestFiles": []}']);
    const result = await invokeWithFileFetching(
      llm, 'model-id', 'Analyze this diff', makeFetchOptions(),
    );
    expect(result.roundsUsed).toBe(1);
    expect(result.response).toBe('{"findings": [], "requestFiles": []}');
  });

  it('rejects paths with ../ traversal', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["../secret/passwords.txt"]}',
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions({ '../secret/passwords.txt': 'secret' });
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // All paths rejected by sanitizeFilePath -> parseFileRequest returns null
    // -> response treated as normal analysis (roundsUsed=1)
    expect(result.fetchedFiles).not.toHaveProperty('../secret/passwords.txt');
    expect(result.roundsUsed).toBe(1);
  });

  it('rejects absolute paths like /etc/passwd', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["/etc/passwd"]}',
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions({ '/etc/passwd': 'root:x:0:0' });
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // Absolute path rejected -> parseFileRequest returns null -> treated as direct response
    expect(result.fetchedFiles).not.toHaveProperty('/etc/passwd');
    expect(result.roundsUsed).toBe(1);
  });

  it('handles file not found gracefully', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["src/nonexistent.ts"]}',
      '{"findings": []}',
    ]);
    // Empty file map — no files available
    const opts = makeFetchOptions({});
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // Should still complete — falls through to "no files fetched" path
    expect(result.roundsUsed).toBe(2);
    expect(Object.keys(result.fetchedFiles)).toHaveLength(0);
  });

  it('respects maxRounds=1 — stops after 1 round even if files requested', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["src/foo.ts"]}',
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions(
      { 'src/foo.ts': 'content' },
      { maxRounds: 1 },
    );
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // maxRounds=1 means the loop runs once, then falls through to final invoke
    // Round 1: LLM requests files, files are fetched
    // Then loop ends, final forced invoke happens
    expect(result.roundsUsed).toBe(2);
    expect(result.fetchedFiles).toHaveProperty('src/foo.ts');
  });

  it('caps file requests at 10 files', async () => {
    // Request 15 files — only first 10 should be processed
    const fileNames = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    const fileMap: Record<string, string> = {};
    for (const name of fileNames) {
      fileMap[name] = `content of ${name}`;
    }

    const llm = createMockLLM([
      JSON.stringify({ requestFiles: fileNames }),
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions(fileMap);
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // Should have at most 10 files fetched
    expect(Object.keys(result.fetchedFiles).length).toBeLessThanOrEqual(10);
  });

  it('does not re-fetch already-fetched files in subsequent rounds', async () => {
    const fetchSpy = vi.fn(async ({ path }: { owner: string; repo: string; path: string; ref: string }) => {
      return {
        data: {
          type: 'file',
          content: Buffer.from(`content of ${path}`).toString('base64'),
          encoding: 'base64',
        },
      };
    });

    const mockOctokit = { repos: { getContent: fetchSpy } } as any;

    const llm = createMockLLM([
      '{"requestFiles": ["src/a.ts"]}',
      '{"requestFiles": ["src/a.ts", "src/b.ts"]}',
      '{"findings": []}',
    ]);

    const opts: FileFetchOptions = {
      octokit: mockOctokit,
      owner: 'o',
      repo: 'r',
      ref: 'abc',
      maxContextKB: 256,
      maxRounds: 3,
    };

    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // src/a.ts fetched in round 1, should not be fetched again in round 2
    const aPaths = fetchSpy.mock.calls.filter((c: any) => c[0].path === 'src/a.ts');
    expect(aPaths).toHaveLength(1);
    expect(result.fetchedFiles).toHaveProperty('src/a.ts');
    expect(result.fetchedFiles).toHaveProperty('src/b.ts');
  });

  it('parses markdown-fenced JSON file requests', async () => {
    const llm = createMockLLM([
      '```json\n{"requestFiles": ["src/utils.ts"]}\n```',
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions({ 'src/utils.ts': 'export function util() {}' });
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    expect(result.fetchedFiles).toHaveProperty('src/utils.ts');
    expect(result.roundsUsed).toBe(2);
  });

  it('enforces context budget (maxContextKB)', async () => {
    // Create a file that exceeds budget
    const bigContent = 'x'.repeat(2048); // 2KB
    const llm = createMockLLM([
      '{"requestFiles": ["src/big.ts", "src/small.ts"]}',
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions(
      { 'src/big.ts': bigContent, 'src/small.ts': 'small' },
      { maxContextKB: 1 }, // 1KB budget — big.ts will be truncated, small.ts skipped
    );
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // big.ts should be truncated or at least budget respected
    const totalSize = Object.values(result.fetchedFiles)
      .reduce((sum, v) => sum + Buffer.byteLength(v, 'utf-8'), 0);
    expect(totalSize).toBeLessThanOrEqual(1024 + 100); // small tolerance for truncation marker
  });

  it('throws on first-round LLM failure', async () => {
    const llm: ILLMProvider = {
      async invoke() { throw new Error('LLM down'); },
    };
    await expect(
      invokeWithFileFetching(llm, 'model-id', 'Analyze', makeFetchOptions()),
    ).rejects.toThrow('LLM down');
  });

  it('handles all-invalid paths gracefully (forces analysis)', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["/abs/path", "../traversal", ""]}',
      '{"findings": []}',
    ]);
    const opts = makeFetchOptions({});
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // All paths rejected -> parseFileRequest returns null -> treated as normal response
    // Actually, the JSON is valid but all paths get sanitized away -> returns null from parseFileRequest
    // So the first response IS the result
    expect(result.roundsUsed).toBeGreaterThanOrEqual(1);
  });

  it('forces analysis when model re-requests already-fetched files', async () => {
    const llm = createMockLLM([
      '{"requestFiles": ["src/a.ts"]}',
      '{"requestFiles": ["src/a.ts"]}', // re-request same file
      '{"findings": ["done"]}',
    ]);
    const opts = makeFetchOptions({ 'src/a.ts': 'content' });
    const result = await invokeWithFileFetching(llm, 'model-id', 'Analyze', opts);

    // Round 1: request files -> fetch
    // Round 2: re-request same file -> forces analysis
    expect(result.roundsUsed).toBe(3);
    expect(llm.calls[2]).toContain('already been provided');
  });
});
