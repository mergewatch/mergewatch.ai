/**
 * Utility to filter files out of a unified diff string based on glob patterns.
 *
 * Used to respect `excludePatterns` and `rules.ignorePatterns` before sending
 * diffs to the review agents.
 */

import { minimatch } from 'minimatch';

/**
 * Split a unified diff string into per-file sections.
 * Each section starts with `diff --git a/... b/...`.
 */
function splitDiffByFile(diff: string): Array<{ file: string; section: string }> {
  const sections: Array<{ file: string; section: string }> = [];
  // Match the full diff header line — single .+ avoids polynomial backtracking
  // that two lazy (.+?) groups would cause when paths contain spaces.
  const headerRegex = /^diff --git a\/(.+)$/gm;

  let match: RegExpExecArray | null;
  const starts: Array<{ file: string; index: number }> = [];
  headerRegex.lastIndex = 0;

  while ((match = headerRegex.exec(diff)) !== null) {
    // The captured group is "<path1> b/<path2>". Extract the b/ path.
    const rest = match[1];
    const sepIdx = rest.indexOf(' b/');
    const file = sepIdx !== -1 ? rest.slice(sepIdx + 3) : rest;
    starts.push({ file, index: match.index });
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : diff.length;
    sections.push({
      file: starts[i].file,
      section: diff.slice(start, end),
    });
  }

  return sections;
}

/**
 * Filter a unified diff string, removing sections for files matching any of
 * the given glob patterns.
 *
 * Returns the filtered diff and the list of files that were excluded.
 */
export function filterDiff(
  diff: string,
  excludePatterns: string[],
): { filteredDiff: string; excludedFiles: string[] } {
  if (!excludePatterns.length || !diff) {
    return { filteredDiff: diff, excludedFiles: [] };
  }

  const sections = splitDiffByFile(diff);
  const excludedFiles: string[] = [];
  const kept: string[] = [];

  for (const { file, section } of sections) {
    const excluded = excludePatterns.some((pattern) => minimatch(file, pattern));
    if (excluded) {
      excludedFiles.push(file);
    } else {
      kept.push(section);
    }
  }

  return {
    filteredDiff: kept.join(''),
    excludedFiles,
  };
}

// ─── Changed-line extraction ───────────────────────────────────────────────

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff and return the set of new-side line numbers that were
 * actually added or modified (lines starting with `+`).
 *
 * The returned map is keyed by file path (the `b/` side).  Each value is a
 * `Set<number>` of 1-based line numbers in the new file.
 */
export function extractChangedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!diff) return result;

  const sections = splitDiffByFile(diff);

  for (const { file, section } of sections) {
    const lines = section.split('\n');
    const changedSet = new Set<number>();
    let newLine = 0; // current new-side line counter (set by hunk headers)

    for (const line of lines) {
      const hunkMatch = line.match(HUNK_HEADER);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[1], 10);
        continue;
      }

      // Only process lines inside a hunk (newLine > 0)
      if (newLine === 0) continue;

      if (line.startsWith('+')) {
        // Skip the +++ b/file header
        if (line.startsWith('+++')) continue;
        changedSet.add(newLine);
        newLine++;
      } else if (line.startsWith('-')) {
        // Removed line — does not advance new-side counter
        // Skip the --- a/file header
        if (line.startsWith('---')) continue;
        // newLine stays the same
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — skip
        continue;
      } else {
        // Context line (space prefix or empty) — advance new-side counter
        newLine++;
      }
    }

    result.set(file, changedSet);
  }

  return result;
}

/**
 * Check whether a given file:line is within `tolerance` lines of any actually
 * changed line.  Returns false if the file is not in the diff at all.
 */
export function isLineNearChange(
  changedLines: Map<string, Set<number>>,
  file: string,
  line: number,
  tolerance: number,
): boolean {
  const fileChanges = changedLines.get(file);
  if (!fileChanges || fileChanges.size === 0) return false;

  for (const cl of fileChanges) {
    if (Math.abs(line - cl) <= tolerance) return true;
  }
  return false;
}

/** #358 — stats of a (possibly already-filtered) unified diff. */
export interface DiffStats {
  /** Files present in the diff, in order of appearance. */
  files: string[];
  additions: number;
  deletions: number;
}

/**
 * #358 — compute file/line stats from the diff itself.
 *
 * The work-done header ("N files scanned · M lines reviewed") previously came
 * from raw PR-level totals, so files removed by `excludePatterns` were still
 * counted as scanned — on a fully-excluded PR the header claimed real work.
 * Deriving the stats from the FILTERED diff makes the tallies describe
 * exactly what the agents saw.
 *
 * Counting matches GitHub's additions/deletions semantics: `+`/`-` content
 * lines, excluding the `+++`/`---` file-header lines. Binary files appear in
 * `files` (they have a `diff --git` section) with zero line counts.
 */
export function computeDiffStats(diff: string): DiffStats {
  if (!diff) return { files: [], additions: 0, deletions: 0 };

  const sections = splitDiffByFile(diff);
  let additions = 0;
  let deletions = 0;
  for (const { section } of sections) {
    for (const line of section.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
  }
  return { files: sections.map((s) => s.file), additions, deletions };
}
