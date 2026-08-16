/**
 * Repo-wide source hygiene.
 *
 * A NUL byte anywhere in a text file makes git classify that file as binary.
 * Diffs then render as `Bin 44577 -> 45080 bytes` instead of a patch, so the
 * file becomes unreviewable — on GitHub, in `git diff`, and to MergeWatch's own
 * reviewer, which reads diffs.
 *
 * That is not hypothetical: `packages/server/src/review-processor.ts` (45KB, on
 * the self-hosted review path) carried two literal NUL bytes as a cache-key
 * delimiter. It went unnoticed until an external contributor's PR to that file
 * arrived with an undiffable payload, and the review that ran against it only
 * flagged the half of the change living in a different file.
 *
 * Escape sequences are identical at runtime and keep the file text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

// vitest runs with cwd = the package root (packages/core), so the monorepo
// root is two levels up.
const REPO_ROOT = resolve(process.cwd(), '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', 'build', '.sam',
]);

const TEXT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.yml', '.yaml', '.sh',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (TEXT_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

describe('source hygiene', () => {
  it('no text source file contains a NUL byte', () => {
    const offenders: string[] = [];

    for (const file of walk(REPO_ROOT)) {
      const buf = readFileSync(file);
      const first = buf.indexOf(0);
      if (first === -1) continue;

      let count = 0;
      for (const byte of buf) if (byte === 0) count++;
      const line = buf.subarray(0, first).toString('utf8').split('\n').length;
      offenders.push(
        `${relative(REPO_ROOT, file)} — ${count} NUL byte(s), first at line ${line}`,
      );
    }

    expect(
      offenders,
      'NUL bytes make git treat these files as binary, so their diffs become '
        + 'unreviewable. Use an escape sequence instead — identical at runtime.',
    ).toEqual([]);
  });
});
