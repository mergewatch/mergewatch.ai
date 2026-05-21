/**
 * Repository conventions loader.
 *
 * Fetches a markdown file documenting repo-specific conventions and injects it
 * into every review agent's prompt. Lets users document patterns like "errors
 * are handled via middleware, don't flag missing try/catch in route handlers"
 * so MergeWatch respects repo conventions over generic best practices.
 *
 * Resolution order:
 *   1. Explicit `conventions:` path in `.mergewatch.yml`
 *   2. Auto-discovery at repo root — AGENTS.md, CONVENTIONS.md, .mergewatch/conventions.md
 *   3. No conventions context injected
 */

import { Octokit } from '@octokit/rest';

/** Well-known filenames tried in order when `conventions:` is unset. */
export const DEFAULT_CONVENTIONS_PATHS = [
  'AGENTS.md',
  'CONVENTIONS.md',
  '.mergewatch/conventions.md',
];

/**
 * Maximum bytes of conventions content to inject into prompts. Content beyond
 * this is truncated with a visible marker so the LLM knows context was cut.
 */
export const CONVENTIONS_MAX_BYTES = 16 * 1024;

/** Successful load result — the file content plus where it came from. */
export interface ConventionsLoadResult {
  /** Decoded file content, truncated if it exceeded `CONVENTIONS_MAX_BYTES`. */
  content: string;
  /** Path of the file that was loaded (for display in the review comment). */
  sourcePath: string;
  /** True when content was truncated to fit the size cap. */
  truncated: boolean;
}

/**
 * Apply the size cap, returning the possibly-truncated content and a flag.
 * Exported so the same truncation logic is testable without a GitHub mock.
 */
export function truncateConventions(content: string): { content: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  if (bytes.byteLength <= CONVENTIONS_MAX_BYTES) {
    return { content, truncated: false };
  }
  // Slice by bytes, then decode back — TextDecoder with `fatal: false` replaces
  // any partial multi-byte char at the boundary with U+FFFD, which is fine.
  const sliced = bytes.slice(0, CONVENTIONS_MAX_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const truncated = decoder.decode(sliced);
  return {
    content: `${truncated}\n\n[truncated — showing first ${CONVENTIONS_MAX_BYTES / 1024} KB]`,
    truncated: true,
  };
}

/**
 * Fetch a single file from a repo and decode its base64 content. Returns null
 * for 404s and for non-file responses (directories, submodules, symlinks).
 */
async function fetchFileAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string | undefined,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data) || !data.content) {
      return null;
    }
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) {
      return null;
    }
    console.warn('Failed to fetch %s from %s/%s:', path, owner, repo, err);
    return null;
  }
}

/**
 * Resolve and fetch repo conventions. When `explicitPath` is provided, only
 * that path is tried. Otherwise the default candidates are tried in order
 * until one resolves.
 *
 * Content is size-capped to {@link CONVENTIONS_MAX_BYTES} — callers can rely
 * on the return value being safe to inject into prompts.
 */
export async function fetchConventions(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string | undefined,
  explicitPath?: string,
): Promise<ConventionsLoadResult | null> {
  const candidates = explicitPath ? [explicitPath] : DEFAULT_CONVENTIONS_PATHS;

  for (const path of candidates) {
    const raw = await fetchFileAt(octokit, owner, repo, path, ref);
    if (raw === null) continue;
    const { content, truncated } = truncateConventions(raw);
    return { content, sourcePath: path, truncated };
  }

  return null;
}

// ─── FP-G — linter detection ───────────────────────────────────────────────

/**
 * Known linters MergeWatch can defer to. Used by the style agent prompt to
 * suppress lint-equivalent findings (semicolons, quote style, import order,
 * unused imports, etc.) when one of these is configured.
 */
export type DetectedLinter =
  | 'eslint' | 'biome'
  | 'ruff'   | 'flake8'
  | 'clippy'
  | 'golangci'
  | 'stylelint';

/**
 * Root-level marker files per linter. Order within a linter doesn't matter
 * (any single hit detects it). Kept flat-and-explicit rather than using
 * glob patterns so the detection list is greppable and easy to extend.
 *
 * `pyproject.toml` for ruff is handled separately — its presence alone is
 * not enough (most Python projects have one), we additionally probe for a
 * `[tool.ruff]` section.
 */
const LINTER_MARKERS: Record<Exclude<DetectedLinter, 'ruff'>, string[]> & { ruff: string[] } = {
  eslint: [
    '.eslintrc',
    '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs',
    '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    'eslint.config.js', 'eslint.config.ts',
    'eslint.config.mjs', 'eslint.config.cjs',
  ],
  biome:    ['biome.json', 'biome.jsonc'],
  ruff:     ['ruff.toml', '.ruff.toml'], // pyproject.toml handled with content inspection
  flake8:   ['.flake8'],
  clippy:   ['clippy.toml', '.clippy.toml'],
  golangci: ['.golangci.yml', '.golangci.yaml', '.golangci.toml'],
  stylelint: [
    '.stylelintrc',
    '.stylelintrc.json', '.stylelintrc.js', '.stylelintrc.cjs',
    '.stylelintrc.yml',  '.stylelintrc.yaml',
    'stylelint.config.js', 'stylelint.config.cjs',
  ],
};

/**
 * List the file/folder entries at the repo's root for a given ref. Returns
 * `null` on any non-404 error; an empty list on 404 (most likely the repo
 * doesn't exist or the ref is bad — caller treats that as "no detection").
 */
async function listRepoRoot(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<string[] | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner, repo, path: '', ...(ref ? { ref } : {}),
    });
    if (!Array.isArray(data)) return [];
    return data.map((entry) => entry.name);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) {
      return [];
    }
    console.warn('[detect-linters] failed to list %s/%s root contents:', owner, repo, err);
    return null;
  }
}

/**
 * FP-G — detect which linters the repo has configured. Used by the style
 * agent prompt to enumerate "defer to these" tools so the LLM stops
 * conservatively re-reporting lint-equivalent concerns (semicolons,
 * `prefer const`, import order, unused imports, …).
 *
 * Single root-listing API call + at most one extra fetch when a
 * `pyproject.toml` is present (to inspect for `[tool.ruff]`). Returns
 * `[]` on any non-recoverable error — the prompt path is fully
 * back-compatible with "no linters detected" (no directive injected).
 *
 * Returned linter names are sorted lexicographically so the directive
 * is deterministic across calls (helps with prompt caching downstream).
 */
export async function detectLinters(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<DetectedLinter[]> {
  const rootNames = await listRepoRoot(octokit, owner, repo, ref);
  if (!rootNames || rootNames.length === 0) return [];
  const present = new Set(rootNames);
  const detected = new Set<DetectedLinter>();

  for (const linter of Object.keys(LINTER_MARKERS) as DetectedLinter[]) {
    if (LINTER_MARKERS[linter].some((m) => present.has(m))) {
      detected.add(linter);
    }
  }

  // pyproject.toml — only counts toward ruff when a `[tool.ruff]` section
  // is present. Costs one extra fetch on Python repos that have a
  // pyproject.toml but DON'T already match `ruff.toml`/`.ruff.toml`.
  if (!detected.has('ruff') && present.has('pyproject.toml')) {
    const content = await fetchFileAt(octokit, owner, repo, 'pyproject.toml', ref);
    if (content && /^\[tool\.ruff(?:\.|\])/m.test(content)) {
      detected.add('ruff');
    }
  }

  return Array.from(detected).sort();
}
