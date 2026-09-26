import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * #661 — a security patch must never arrive bundled with a test-tooling major.
 *
 * #587 is what this is about. Dependabot's repository-level "Grouped security
 * updates" setting bundled two unauthenticated Next.js RCE patches
 * (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) with the vitest 4 → 5 major. That
 * major breaks coverage collection — every file reports 0% and the threshold
 * fails (#590) — so the grouped PR went red and the RCE fix sat blocked behind
 * a tooling upgrade until it was split out by hand (#589), mid release cut.
 *
 * `.github/dependabot.yml` is the fix: a security-updates group that excludes
 * vitest by name, so vitest security updates arrive in their own PR and can go
 * red on their own without holding anything else up.
 *
 * ── WHAT THESE TESTS DO AND DO NOT OBSERVE ───────────────────────────────────
 *
 * Be clear about this, because this repo has a habit of shipping checks that
 * cannot fail (#626, #634, #640, #643).
 *
 * These are STRUCTURAL assertions about a config file that only GitHub's
 * servers execute. They cannot observe Dependabot's actual grouping behavior —
 * that is only visible when the next grouped security advisory lands. What they
 * do observe is the state that CAUSED #587: they all fail when
 * `.github/dependabot.yml` is absent, which is exactly `main` before this
 * change. They then keep failing if someone deletes the file, drops the vitest
 * exclusion, converts it to an `ignore` rule, or adds a vitest-carrying package
 * to a directory the config does not cover.
 *
 * That makes them a regression guard against reintroducing #587's setup, not
 * proof that Dependabot groups the way we intend.
 *
 * ── WHY THE FILE IS SHAPED THE WAY IT IS (docs, verified 2026-09-26) ─────────
 *
 * Quoted from GitHub's Dependabot options reference. Two of the three passages
 * the issue quoted are not what the docs actually say — corrected here:
 *
 *  1. NOT an `ignore` rule. The issue quoted "…when it opens pull requests for
 *     version updates and security updates"; that sentence is not in the docs.
 *     The documented fact is carried by the heading badges instead: `## ignore`
 *     is tagged with BOTH `aria-label="Version updates"` and
 *     `aria-label="Security updates"`, where an option that applies to one kind
 *     only is tagged `aria-label="Version updates only"` (as
 *     `open-pull-requests-limit` and `schedule` are). So `ignore` filters
 *     security updates too, and ignoring vitest majors would silently suppress
 *     a vitest security fix that ships only in a major. Same conclusion, real
 *     evidence.
 *
 *  2. NOT `update-types` inside the group. The issue attributed
 *     "`update-types` only affects _version_ updates, not _security updates_"
 *     to `groups.update-types`. That sentence is real but it documents
 *     `allow.update-types`. The `### update-types (groups)` section says
 *     nothing about security updates either way, and takes a different
 *     vocabulary (`major`/`minor`/`patch`, not `version-update:semver-major`).
 *     So its behavior for security updates is UNDOCUMENTED rather than
 *     documented-as-broken. Excluding by name needs no such guarantee, which is
 *     the reason to prefer it.
 *
 *  3. `open-pull-requests-limit: 0` is safe for security updates, and load
 *     bearing. "_Security update_ pull requests are not subject to this limit
 *     and do not count toward it. There is no limit on the number of open pull
 *     requests for security updates." And: "You can temporarily disable version
 *     updates for a package manager by setting this option to zero." This repo
 *     has never had routine version-update PRs, because version updates require
 *     a config file and there wasn't one. Adding this file would switch them on
 *     across 13 manifests; the zero keeps today's behavior.
 *
 *  4. Why the config must cover EVERY directory, not just the two in #587:
 *     "Dependabot will only group across those directories not configured in
 *     your `dependabot.yml` if the setting for grouped security updates at the
 *     organization or repository level is also enabled." An unlisted directory
 *     therefore keeps the old repo-setting grouping — the #587 behavior — so a
 *     partial config leaves the bug live wherever it didn't reach.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const CONFIG_PATH = resolve(REPO_ROOT, '.github/dependabot.yml');

interface Group {
  id: string;
  appliesTo: unknown;
  patterns: string[];
  excludePatterns: string[];
}

interface NpmEntry {
  /** Index in `updates`, so a failure names which block is wrong. */
  index: number;
  /** Normalized `directories` / `directory`, as written (globs intact). */
  directories: string[];
  openPullRequestsLimit: unknown;
  groups: Group[];
  /** Every `ignore[].dependency-name` in this block. */
  ignoredNames: string[];
}

interface Load {
  npmEntries: NpmEntry[];
  /** Anything that stopped the file being understood. Never thrown — see below. */
  errors: string[];
}

/**
 * Read the config once, and never throw.
 *
 * Total rather than throwing for the same reason `fixtures-lock.test.ts` is: a
 * throw at module load is a vitest COLLECTION error, so the file never loads
 * and none of the assertions below run — including the sentinel that exists to
 * catch exactly this. The absent-file case is the one that matters here, since
 * that is the state on `main`, and it must surface as a sentence about #661
 * rather than an ENOENT stack trace.
 */
function loadConfig(): Load {
  const errors: string[] = [];

  if (!existsSync(CONFIG_PATH)) {
    return {
      npmEntries: [],
      errors: [
        '.github/dependabot.yml is absent, so security updates are grouped by the ' +
          'repository-level "Grouped security updates" setting — the #587 setup, which ' +
          'bundles a vitest major with unrelated security patches (#661).',
      ],
    };
  }

  let cfg: any;
  try {
    cfg = yaml.load(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return { npmEntries: [], errors: [`.github/dependabot.yml: ${(err as Error).message}`] };
  }
  if (!cfg || typeof cfg !== 'object') {
    return { npmEntries: [], errors: ['.github/dependabot.yml did not parse to a mapping'] };
  }
  // Dependabot rejects anything else outright, and a rejected config is
  // indistinguishable from no config at all.
  if (cfg.version !== 2) {
    errors.push(`version must be 2, got ${JSON.stringify(cfg.version)}`);
  }
  if (!Array.isArray(cfg.updates)) {
    return { npmEntries: [], errors: [...errors, 'no `updates` array'] };
  }

  const npmEntries: NpmEntry[] = [];
  cfg.updates.forEach((entry: any, index: number) => {
    if (entry?.['package-ecosystem'] !== 'npm') return;

    const directories: string[] = Array.isArray(entry.directories)
      ? entry.directories.filter((d: unknown) => typeof d === 'string')
      : typeof entry.directory === 'string'
        ? [entry.directory]
        : [];
    if (!directories.length) {
      errors.push(`updates[${index}]: npm entry declares neither \`directory\` nor \`directories\``);
    }

    const groups: Group[] = Object.entries<any>(entry.groups ?? {}).map(([id, g]) => ({
      id,
      appliesTo: g?.['applies-to'],
      patterns: Array.isArray(g?.patterns) ? g.patterns : [],
      excludePatterns: Array.isArray(g?.['exclude-patterns']) ? g['exclude-patterns'] : [],
    }));

    const ignoredNames: string[] = (Array.isArray(entry.ignore) ? entry.ignore : [])
      .map((i: any) => i?.['dependency-name'])
      .filter((n: unknown): n is string => typeof n === 'string');

    npmEntries.push({
      index,
      directories,
      openPullRequestsLimit: entry['open-pull-requests-limit'],
      groups,
      ignoredNames,
    });
  });

  return { npmEntries, errors };
}

const load = loadConfig();

/** Dependabot treats `directories` globs as `*` = "one path segment". */
function directoryMatches(pattern: string, dir: string): boolean {
  const norm = (p: string) => '/' + p.replace(/^\/+/, '').replace(/\/+$/, '');
  const p = norm(pattern);
  const d = norm(dir);
  if (!p.includes('*')) return p === d;
  const rx = new RegExp(
    '^' +
      p
        .split('*')
        .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*') +
      '$',
  );
  return rx.test(d);
}

function isVitestPackage(name: string): boolean {
  return name === 'vitest' || name.startsWith('@vitest/');
}

/**
 * The directories that actually carry vitest, read off the manifests rather
 * than listed here.
 *
 * Derived so that moving vitest into a new package fails HERE — at the point
 * where that package's security updates silently revert to repo-setting
 * grouping — instead of months later, as a red security PR nobody can explain.
 */
function directoriesDeclaringVitest(): string[] {
  const candidates = ['/', ...listPackageDirs()];
  return candidates.filter((dir) => {
    const manifest = resolve(REPO_ROOT, dir === '/' ? 'package.json' : `${dir.slice(1)}/package.json`);
    if (!existsSync(manifest)) return false;
    let json: any;
    try {
      json = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      return false;
    }
    // Deps only. A `"test:watch": "vitest"` script does not make the package a
    // target for a vitest version bump.
    return Object.keys({ ...json.dependencies, ...json.devDependencies }).some(isVitestPackage);
  });
}

function listPackageDirs(): string[] {
  const packagesDir = resolve(REPO_ROOT, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `/packages/${e.name}`);
}

const vitestDirs = directoriesDeclaringVitest();

describe('.github/dependabot.yml exists and is understood', () => {
  it('parses as a valid Dependabot v2 config', () => {
    // On `main` this is the failure: the file is absent, and every assertion
    // below is vacuous without it. Fail on the parse rather than let the rest
    // iterate an empty list and report green.
    expect(load.errors).toEqual([]);
  });

  it('configures the npm ecosystem', () => {
    expect(load.npmEntries.length).toBeGreaterThan(0);
  });
});

describe('security updates are grouped with vitest excluded', () => {
  it('every npm entry has a security-updates group', () => {
    const without = load.npmEntries
      .filter((e) => !e.groups.some((g) => g.appliesTo === 'security-updates'))
      .map((e) => `updates[${e.index}]`);
    // A group defaults to `version-updates` when `applies-to` is undefined, so
    // omitting the key is the quiet way to configure nothing at all here.
    expect(without).toEqual([]);
  });

  it.each(load.npmEntries)(
    'updates[$index] excludes vitest from its security-updates group',
    (entry) => {
      const securityGroups = entry.groups.filter((g) => g.appliesTo === 'security-updates');
      for (const group of securityGroups) {
        // Both spellings. `vitest` alone leaves `@vitest/coverage-v8` — the
        // package that actually carries the coverage provider — free to be
        // bundled, which reproduces #590 by another route.
        expect(group.excludePatterns).toContain('vitest');
        expect(group.excludePatterns).toContain('@vitest/*');
      }
    },
  );

  it.each(load.npmEntries)('updates[$index] groups everything else together', (entry) => {
    const securityGroups = entry.groups.filter((g) => g.appliesTo === 'security-updates');
    for (const group of securityGroups) {
      // `*` is what makes this one group rather than a per-dependency PR storm.
      expect(group.patterns).toContain('*');
    }
  });

  it.each(load.npmEntries)('updates[$index] keeps routine version updates off', (entry) => {
    // Not cosmetic. Version updates only happen when a config file exists, so
    // before this file there were none; without the zero, adding the file turns
    // them on across every manifest at once.
    expect(entry.openPullRequestsLimit).toBe(0);
  });
});

describe('vitest is held back by exclusion, never by suppression', () => {
  it('no npm entry has an ignore rule for vitest', () => {
    // The whole point of the exclusion over an `ignore` rule: `ignore` applies
    // to security updates too, so it would drop a vitest security fix that
    // ships only in a major. An exclusion delays nothing — it just unbundles.
    //
    // Aggregate rather than `it.each` on purpose. An `it.each` over an empty
    // list registers no tests, and a describe block with nothing in it is a
    // vacuous pass — the defect this repo keeps shipping (#626, #634, #640,
    // #643). This form asserts something even when there are no npm entries.
    const offenders = load.npmEntries
      .flatMap((e) => e.ignoredNames.filter(isVitestPackage).map((n) => `updates[${e.index}]: ${n}`));
    expect(offenders).toEqual([]);
  });
});

describe('the config reaches every directory that carries vitest', () => {
  it('finds the vitest-carrying manifests', () => {
    // Inventory, not a count. If this detection breaks, the coverage assertion
    // below iterates nothing and passes while asserting nothing — the exact
    // failure mode this repo keeps producing. Update the list deliberately.
    expect(vitestDirs).toEqual(['/', '/packages/core', '/packages/dashboard', '/packages/mcp']);
  });

  it.each(vitestDirs)('%s is covered by an npm update entry', (dir) => {
    const covering = load.npmEntries.filter((e) =>
      e.directories.some((pattern) => directoryMatches(pattern, dir)),
    );
    expect(covering.length).toBeGreaterThan(0);
  });
});
