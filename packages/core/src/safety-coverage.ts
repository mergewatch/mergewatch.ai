/**
 * #717 — new top-level folders that no safety area covers.
 *
 * Deterministic and advisory: no LLM call, and it never changes the score.
 * A folder is NEW when the PR adds files under a first path segment that is
 * not a directory at the base branch's root, and UNCOVERED when no area
 * pattern matches any of the PR's files under it. Uses #712's matcher, so
 * "covered" means exactly what area matching means.
 */
import type { SafetyArea } from './config/defaults.js';
import { matchAreas } from './agents/safety.js';

/**
 * @param changedFiles the PR's files after excludePatterns / maxFileDiffKB
 * @param baseRootDirs directory names at the base branch's root
 * @param areas the effective safety areas
 * @returns the uncovered new top-level folders, sorted. Empty when no area
 *   has patterns: then every folder would be "uncovered", which is noise.
 */
export function findUncoveredTopLevelFolders(
  changedFiles: string[],
  baseRootDirs: string[],
  areas: SafetyArea[],
): string[] {
  const patterned = areas.filter((a) => a.patterns?.length);
  if (patterned.length === 0) return [];
  const existing = new Set(baseRootDirs);
  const byFolder = new Map<string, string[]>();
  for (const file of changedFiles) {
    const slash = file.indexOf('/');
    if (slash <= 0) continue; // a root file
    const folder = file.slice(0, slash);
    if (folder.startsWith('.') || existing.has(folder)) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  return [...byFolder]
    .filter(([, files]) => matchAreas(patterned, files).length === 0)
    .map(([folder]) => folder)
    .sort();
}
