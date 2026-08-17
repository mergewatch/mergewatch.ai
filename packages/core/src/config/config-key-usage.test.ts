/**
 * #310 — config-key read tripwire.
 *
 * The #310 defect class: a `MergeWatchConfig` key that is documented, parsed
 * (github/client.ts), typed and defaulted (config/defaults.ts), and merged by
 * the runtimes — but never READ, so it silently does nothing. `minSeverity`
 * shipped that way for months; `config.model` before it (#264/#268). Tests
 * passed because they asserted the parse and the merge; only a grep for the
 * read revealed the hole.
 *
 * This test is that grep, run on every build (same repo-walking shape as
 * source-hygiene.test.ts from #307). For each top-level key of
 * `MergeWatchConfig` it requires at least one dot-access read (`.key`) in
 * package source OUTSIDE the three definition surfaces: the parser
 * (github/client.ts), the type/defaults/merge module (config/defaults.ts),
 * and test files. A key named only in those places parses and merges but is
 * never consumed — exactly the #310 shape.
 *
 * The dot-access heuristic deliberately does not count object-literal
 * property positions (`minSeverity: severityMap[...]` in a runtime's config
 * assembly is a WRITE and would not have saved minSeverity). It can be
 * satisfied by an unrelated object's same-named property — this is a
 * tripwire against the fully-dead case, not a proof of correct use.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { DEFAULT_CONFIG } from './defaults.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const PACKAGES_ROOT = join(REPO_ROOT, 'packages');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', 'build', '.sam',
]);

/** The definition surfaces a key must be referenced OUTSIDE of. */
const DEFINITION_FILES = new Set([
  'packages/core/src/config/defaults.ts',
  'packages/core/src/github/client.ts',
]);

/**
 * Keys with a tracked wiring decision pending. This list held
 * `maxTokensPerAgent` and `postSummaryOnClean` between the tripwire's first
 * run (#310) and their wiring (#350); it is now empty and should stay that
 * way — wire or remove new keys instead of adding entries.
 */
const KNOWN_DEAD_KEYS = new Set<string>();

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
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('MergeWatchConfig key usage (#310)', () => {
  it('every config key has a read outside the parser, defaults, and tests', () => {
    const sources = walk(PACKAGES_ROOT)
      .map((file) => ({ rel: relative(REPO_ROOT, file), file }))
      .filter(({ rel }) => !DEFINITION_FILES.has(rel));

    const contents = sources.map(({ rel, file }) => ({ rel, text: readFileSync(file, 'utf8') }));

    const dead: string[] = [];
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (KNOWN_DEAD_KEYS.has(key)) continue; // #350 — tracked, not silently passed
      // Dot-access read: `.key` at a property boundary. Writes in object
      // literals (`key: value`) intentionally do not match.
      const read = new RegExp(`\\.${key}\\b`);
      const hit = contents.find(({ text }) => read.test(text));
      if (!hit) dead.push(key);
    }

    expect(
      dead,
      'These MergeWatchConfig keys parse and merge but are never read — the '
        + '#310 defect class. Wire each into the behavior its docs promise, '
        + 'or remove it from the config surface (type, parser, docs).',
    ).toEqual([]);
  });
});
