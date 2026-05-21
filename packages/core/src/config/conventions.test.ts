import { describe, it, expect, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import {
  fetchConventions,
  truncateConventions,
  detectLinters,
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

// ─── detectLinters (FP-G) ───────────────────────────────────────────────────

/**
 * Mock for detectLinters: needs to support both root listing (path === '')
 * which returns an array of `{ name, type }` entries AND single-file fetch
 * (the existing fetchFileAt path) for the pyproject.toml `[tool.ruff]` probe.
 */
function makeLinterOctokit(opts: {
  rootEntries: string[];
  fileContents?: Record<string, string>;
  rootError?: { status: number };
}): Octokit & { _calls: string[] } {
  const calls: string[] = [];
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    calls.push(path);
    if (path === '') {
      if (opts.rootError) throw Object.assign(new Error('boom'), opts.rootError);
      return { data: opts.rootEntries.map((name) => ({ name, type: 'file' })) };
    }
    const content = opts.fileContents?.[path];
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
  return { repos: { getContent }, _calls: calls } as unknown as Octokit & { _calls: string[] };
}

describe('detectLinters (FP-G)', () => {
  it('returns [] when the root listing is empty', async () => {
    const octokit = makeLinterOctokit({ rootEntries: [] });
    const result = await detectLinters(octokit, 'o', 'r', 'main');
    expect(result).toEqual([]);
  });

  it('returns [] when the API call fails (best-effort, no crash)', async () => {
    const octokit = makeLinterOctokit({ rootEntries: [], rootError: { status: 500 } });
    const result = await detectLinters(octokit, 'o', 'r', 'main');
    expect(result).toEqual([]);
  });

  it('detects eslint from .eslintrc.js', async () => {
    const octokit = makeLinterOctokit({ rootEntries: ['.eslintrc.js', 'package.json'] });
    const result = await detectLinters(octokit, 'o', 'r', 'main');
    expect(result).toEqual(['eslint']);
  });

  it('detects eslint from the flat-config form (eslint.config.ts)', async () => {
    const octokit = makeLinterOctokit({ rootEntries: ['eslint.config.ts'] });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual(['eslint']);
  });

  it('detects biome from biome.json', async () => {
    const octokit = makeLinterOctokit({ rootEntries: ['biome.json'] });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual(['biome']);
  });

  it('detects ruff from ruff.toml without needing pyproject inspection', async () => {
    const octokit = makeLinterOctokit({ rootEntries: ['ruff.toml', 'pyproject.toml'] });
    const result = await detectLinters(octokit, 'o', 'r', 'main');
    expect(result).toContain('ruff');
    // pyproject.toml should NOT be fetched when ruff is already detected
    expect((octokit as any)._calls).not.toContain('pyproject.toml');
  });

  it('detects ruff via pyproject.toml [tool.ruff] section', async () => {
    const pyproject = '[tool.poetry]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n';
    const octokit = makeLinterOctokit({ rootEntries: ['pyproject.toml'], fileContents: { 'pyproject.toml': pyproject } });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual(['ruff']);
  });

  it('detects ruff via pyproject.toml [tool.ruff.lint] (sub-table)', async () => {
    const pyproject = '[tool.ruff.lint]\nselect = ["E", "F"]\n';
    const octokit = makeLinterOctokit({ rootEntries: ['pyproject.toml'], fileContents: { 'pyproject.toml': pyproject } });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual(['ruff']);
  });

  it('does NOT detect ruff from a pyproject.toml that lacks a [tool.ruff] section', async () => {
    const pyproject = '[tool.poetry]\nname = "x"\n[tool.black]\nline-length = 100\n';
    const octokit = makeLinterOctokit({ rootEntries: ['pyproject.toml'], fileContents: { 'pyproject.toml': pyproject } });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual([]);
  });

  it('detects multiple linters and returns them sorted lexicographically', async () => {
    const octokit = makeLinterOctokit({
      rootEntries: ['.stylelintrc.json', 'biome.json', '.eslintrc.js', '.golangci.yml'],
    });
    const result = await detectLinters(octokit, 'o', 'r', 'main');
    expect(result).toEqual(['biome', 'eslint', 'golangci', 'stylelint']);
  });

  it('detects clippy from clippy.toml and flake8 from .flake8', async () => {
    const octokit = makeLinterOctokit({ rootEntries: ['clippy.toml', '.flake8'] });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual(['clippy', 'flake8']);
  });

  it('returns [] when no marker files are present (back-compat: prompt directive stripped)', async () => {
    const octokit = makeLinterOctokit({ rootEntries: ['README.md', 'src', 'package.json'] });
    expect(await detectLinters(octokit, 'o', 'r', 'main')).toEqual([]);
  });
});
