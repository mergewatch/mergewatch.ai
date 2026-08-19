import { describe, it, expect, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import {
  fetchConventions,
  truncateConventions,
  DEFAULT_CONVENTIONS_PATHS,
  CONVENTIONS_MAX_BYTES,
} from './conventions.js';

// ─── truncateConventions ───────────────────────────────────────────────────

describe('truncateConventions', () => {
  it('passes through small content unchanged', () => {
    const input = '# Conventions\nUse middleware for errors.';
    const result = truncateConventions(input);
    expect(result.content).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it('truncates content larger than the cap and appends a marker', () => {
    const input = 'x'.repeat(CONVENTIONS_MAX_BYTES + 500);
    const result = truncateConventions(input);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[truncated — showing first');
    // The truncated body plus the marker will be slightly larger than the cap.
    expect(result.content.length).toBeLessThan(input.length);
  });

  it('handles utf-8 multi-byte characters at the boundary without crashing', () => {
    // Build content that crosses the cap exactly where a multi-byte char would be.
    const prefix = 'a'.repeat(CONVENTIONS_MAX_BYTES - 1);
    const input = `${prefix}${'é'.repeat(1000)}`;
    expect(() => truncateConventions(input)).not.toThrow();
    const result = truncateConventions(input);
    expect(result.truncated).toBe(true);
  });
});

// ─── fetchConventions ──────────────────────────────────────────────────────

type MockOctokit = Octokit & { _calls: string[] };

function makeMockOctokit(files: Record<string, string | null>): MockOctokit {
  const calls: string[] = [];
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    calls.push(path);
    const content = files[path];
    if (content == null) {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    return {
      data: {
        type: 'file',
        content: Buffer.from(content, 'utf-8').toString('base64'),
      },
    };
  });
  // Cast through unknown since we only use repos.getContent
  return {
    repos: { getContent },
    _calls: calls,
  } as unknown as MockOctokit;
}

describe('fetchConventions', () => {
  it('returns null when no known conventions files exist', async () => {
    const octokit = makeMockOctokit({});
    const result = await fetchConventions(octokit, 'o', 'r', 'main');
    expect(result).toBeNull();
    expect(octokit._calls).toEqual(DEFAULT_CONVENTIONS_PATHS);
  });

  it('returns the first matching default path (AGENTS.md wins)', async () => {
    const octokit = makeMockOctokit({
      'AGENTS.md': '# Repo rules',
      'CONVENTIONS.md': '# Other rules',
    });
    const result = await fetchConventions(octokit, 'o', 'r', 'main');
    expect(result).not.toBeNull();
    expect(result!.sourcePath).toBe('AGENTS.md');
    expect(result!.content).toBe('# Repo rules');
    expect(result!.truncated).toBe(false);
    // It should not have kept probing once a match was found
    expect(octokit._calls).toEqual(['AGENTS.md']);
  });

  it('falls back to CONVENTIONS.md when AGENTS.md is absent', async () => {
    const octokit = makeMockOctokit({ 'CONVENTIONS.md': '# Fallback' });
    const result = await fetchConventions(octokit, 'o', 'r', 'main');
    expect(result?.sourcePath).toBe('CONVENTIONS.md');
  });

  it('uses the explicit path exclusively when provided', async () => {
    const octokit = makeMockOctokit({
      'AGENTS.md': 'should be ignored',
      'docs/rules.md': 'explicit rules',
    });
    const result = await fetchConventions(octokit, 'o', 'r', 'main', 'docs/rules.md');
    expect(result?.sourcePath).toBe('docs/rules.md');
    expect(result?.content).toBe('explicit rules');
    expect(octokit._calls).toEqual(['docs/rules.md']);
  });

  it('returns null when the explicit path is missing (no fallback)', async () => {
    const octokit = makeMockOctokit({ 'AGENTS.md': 'has default' });
    const result = await fetchConventions(octokit, 'o', 'r', 'main', 'docs/missing.md');
    expect(result).toBeNull();
    expect(octokit._calls).toEqual(['docs/missing.md']);
  });

  it('applies the size cap and marks truncated', async () => {
    const big = 'x'.repeat(CONVENTIONS_MAX_BYTES + 1000);
    const octokit = makeMockOctokit({ 'AGENTS.md': big });
    const result = await fetchConventions(octokit, 'o', 'r', 'main');
    expect(result?.truncated).toBe(true);
    expect(result?.content).toContain('[truncated — showing first');
  });
});



