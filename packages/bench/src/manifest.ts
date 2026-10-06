/**
 * #699 — runtime validation for a corpus manifest.
 *
 * `JSON.parse(...) as BenchManifest` is a cast, not a check, and the failures
 * it lets through are the quiet kind this milestone exists to rule out:
 *
 *  - A missing `lineTolerance` makes every `Math.abs(d) <= undefined`
 *    comparison false, so NOTHING ever location-matches and the published
 *    recall is silently 0 — a number that looks measured and is an artefact.
 *  - A missing `causeKeywords` makes every cause check vacuously false, so
 *    every catch is downgraded to right-line-wrong-reason.
 *  - A `diffPath` of `../../../../etc/passwd` reads outside the corpus.
 *
 * None of those raise anything on their own. They just produce a wrong
 * benchmark, which is worse than a crash.
 */
import { resolve, sep } from 'node:path';
import type { BenchCase, BenchManifest, GroundTruth, StubFinding } from './types.js';

const SEVERITIES = new Set(['info', 'warning', 'critical']);

function fail(path: string, detail: string): never {
  throw new Error(`Invalid corpus manifest at ${path}: ${detail}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, `expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Resolve a corpus-relative path and refuse to leave the corpus directory.
 * Applied to every `diffPath`, not just to `--corpus`: containing the
 * manifest but not the paths inside it would be a gap, since the manifest is
 * the untrusted part.
 */
export function resolveInCorpus(manifestDir: string, diffPath: string): string {
  const resolved = resolve(manifestDir, diffPath);
  if (!resolved.startsWith(manifestDir + sep)) {
    throw new Error(
      `diffPath must stay inside the corpus directory: "${diffPath}" resolves to ${resolved}`,
    );
  }
  return resolved;
}

function validateGroundTruth(raw: unknown, path: string): GroundTruth {
  if (typeof raw !== 'object' || raw === null) fail(path, 'expected an object');
  const gt = raw as Record<string, unknown>;
  const keywords = gt.causeKeywords;
  if (!Array.isArray(keywords) || keywords.length === 0) {
    // Vacuously-false cause matching would downgrade every catch rather than
    // error, so this has to be a hard failure.
    fail(`${path}.causeKeywords`, 'expected a non-empty array of keywords');
  }
  keywords.forEach((k, i) => requireString(k, `${path}.causeKeywords[${i}]`));
  if (gt.severity !== undefined && !SEVERITIES.has(gt.severity as string)) {
    fail(`${path}.severity`, `expected one of info|warning|critical, got ${JSON.stringify(gt.severity)}`);
  }
  return {
    id: requireString(gt.id, `${path}.id`),
    file: requireString(gt.file, `${path}.file`),
    line: requireNumber(gt.line, `${path}.line`),
    cause: requireString(gt.cause, `${path}.cause`),
    causeKeywords: keywords as string[],
    severity: gt.severity as GroundTruth['severity'],
  };
}

function validateStubFinding(raw: unknown, path: string): StubFinding {
  if (typeof raw !== 'object' || raw === null) fail(path, 'expected an object');
  const f = raw as Record<string, unknown>;
  if (!SEVERITIES.has(f.severity as string)) {
    fail(`${path}.severity`, `expected one of info|warning|critical, got ${JSON.stringify(f.severity)}`);
  }
  return {
    file: requireString(f.file, `${path}.file`),
    line: requireNumber(f.line, `${path}.line`),
    severity: f.severity as StubFinding['severity'],
    title: requireString(f.title, `${path}.title`),
    description: requireString(f.description, `${path}.description`),
    confidence: f.confidence === undefined ? undefined : requireNumber(f.confidence, `${path}.confidence`),
    suggestion: f.suggestion === undefined ? undefined : String(f.suggestion),
  };
}

function validateCase(raw: unknown, path: string, manifestDir?: string): BenchCase {
  if (typeof raw !== 'object' || raw === null) fail(path, 'expected an object');
  const c = raw as Record<string, unknown>;

  const repo = requireString(c.repo, `${path}.repo`);
  if (repo.split('/').filter(Boolean).length !== 2) {
    fail(`${path}.repo`, `expected "owner/name", got ${JSON.stringify(repo)}`);
  }

  const diffPath = requireString(c.diffPath, `${path}.diffPath`);
  if (manifestDir) {
    // Throws if it escapes; surfaced with the manifest path for context.
    try {
      resolveInCorpus(manifestDir, diffPath);
    } catch (err) {
      fail(`${path}.diffPath`, (err as Error).message);
    }
  }

  if (!Array.isArray(c.groundTruth)) fail(`${path}.groundTruth`, 'expected an array');

  return {
    id: requireString(c.id, `${path}.id`),
    repo,
    prNumber: requireNumber(c.prNumber, `${path}.prNumber`),
    prTitle: c.prTitle === undefined ? undefined : String(c.prTitle),
    prBody: c.prBody === undefined ? undefined : String(c.prBody),
    headRef: requireString(c.headRef, `${path}.headRef`),
    diffPath,
    changedFileCount:
      c.changedFileCount === undefined
        ? undefined
        : requireNumber(c.changedFileCount, `${path}.changedFileCount`),
    isDraft: c.isDraft === undefined ? undefined : Boolean(c.isDraft),
    labels: Array.isArray(c.labels) ? c.labels.map(String) : undefined,
    groundTruth: c.groundTruth.map((gt, i) => validateGroundTruth(gt, `${path}.groundTruth[${i}]`)),
    stubFindings: Array.isArray(c.stubFindings)
      ? c.stubFindings.map((f, i) => validateStubFinding(f, `${path}.stubFindings[${i}]`))
      : undefined,
  };
}

/**
 * Validate a parsed manifest, returning a value that genuinely has the shape
 * its type claims. `manifestDir` enables `diffPath` containment; omit it only
 * where no file will be read (tests of shape alone).
 */
export function validateManifest(raw: unknown, manifestDir?: string): BenchManifest {
  if (typeof raw !== 'object' || raw === null) fail('(root)', 'expected an object');
  const m = raw as Record<string, unknown>;

  if (!Array.isArray(m.cases) || m.cases.length === 0) {
    fail('cases', 'expected a non-empty array');
  }

  const manifest: BenchManifest = {
    name: requireString(m.name, 'name'),
    // Explicitly required: a missing tolerance silently zeroes recall.
    lineTolerance: requireNumber(m.lineTolerance, 'lineTolerance'),
    cases: m.cases.map((c, i) => validateCase(c, `cases[${i}]`, manifestDir)),
  };

  if (manifest.lineTolerance < 0) fail('lineTolerance', 'must not be negative');

  const ids = manifest.cases.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    // Duplicate ids make the per-case table ambiguous and let one case
    // silently overwrite another in any id-keyed consumer.
    fail('cases', `duplicate case ids: ${[...new Set(dupes)].join(', ')}`);
  }

  return manifest;
}
