import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';

/**
 * #550 — release notes said how the release was TESTED, never what CHANGED.
 *
 * v0.6.1's notes omitted all eight of its fixes, two of which had made
 * features silently non-functional (#526, #544). Someone deciding whether to
 * upgrade learned only how thoroughly it had been graded.
 *
 * The provenance block is kept in full — it is the evidence this gate exists
 * to produce, and it is the differentiator. What changed goes above it.
 */
const ROOT = resolve(__dirname, '../../..');
const gate = yaml.load(readFileSync(resolve(ROOT, '.github/workflows/release-gate.yml'), 'utf8')) as any;
const releaseSh = readFileSync(resolve(ROOT, 'scripts/release.sh'), 'utf8');
const notesStep = JSON.stringify(
  gate.jobs.release.steps.find((s: any) => s.name === 'Tag and release'),
);

/**
 * A throwaway repo with known commits and a tag.
 *
 * These used to run against this repo's own history. That exercised real
 * `git log` — which was the point — but made the tests environment-dependent:
 * CI checks out shallow and WITHOUT tags, so `--since v0.6.1` failed there
 * while passing locally. Building the history keeps the real-git property and
 * removes the dependency on whatever the checkout happens to contain.
 */
function repoWithHistory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  const commit = (msg: string) => {
    writeFileSync(join(dir, 'f.txt'), msg);
    git('add', '-A');
    git('commit', '--quiet', '-m', msg);
  };
  commit('chore: before the tag');
  git('tag', 'v0.6.1');
  commit('feat(core): a new capability (#101) (#102)');
  commit('fix(core): a real defect (#103)');
  commit('chore: not user-facing');
  return dir;
}

const REPO = repoWithHistory();

const gen = (args: string[], cwd = REPO) =>
  execFileSync(resolve(ROOT, 'scripts/changelog-section.sh'), args, { cwd, encoding: 'utf8' });

describe('#550 — one generator feeds both', () => {
  it('release.sh calls the shared script rather than inlining git log', () => {
    // Two implementations of "what changed" would disagree the first time
    // either was touched — and the notes are the copy a user reads.
    expect(releaseSh).toContain('changelog-section.sh');
    expect(releaseSh).not.toContain('--grep="^feat"');
  });

  it('the release notes call the same script', () => {
    expect(notesStep).toContain('changelog-section.sh');
  });

  it('the notes omit the heading, because the release title is the version', () => {
    expect(notesStep).toContain('--no-heading');
  });
});

describe('#550 — the notes carry both halves', () => {
  it('leads with what changed', () => {
    expect(notesStep).toContain('What changed');
  });

  it('retains the provenance block in full', () => {
    // The graded SHA, the suite grade, and the approver. This is the evidence
    // the gate exists to produce; adding changes must not cost it.
    expect(notesStep).toContain('via the release gate');
    expect(notesStep).toContain('Graded fixture suite');
    expect(notesStep).toContain('approved by @');
  });

  it('carries the NOT VERIFIED count, not just the pass line', () => {
    // A green grade without the count of what was NOT run recreates the
    // coverage illusion the gate was built to remove.
    const grade = JSON.stringify(gate.jobs.suite.steps.find((s: any) => s.id === 'grade'));
    expect(grade).toContain('NOT VERIFIED');
  });
});

describe('#550 review — the generator is called safely', () => {
  it('does not mask a generator failure with `|| true`', () => {
    // Review finding on #580. `|| true` conflated the generator FAILING with
    // there being nothing to report — and the generator already emits an
    // explicit line for the second case, so an empty result can only mean the
    // first. Printing a placeholder would ship notes that look complete.
    expect(notesStep).toContain('refusing to publish notes that omit what changed');
    expect(notesStep).not.toContain('changelog-section.sh "$VERSION" --no-heading || true');
  });

  it('quotes the revision range and closes it with --', () => {
    // Not shell injection: an expanded variable is an ARGUMENT and bash does
    // not re-parse it, so `HEAD; rm -rf /` reaches git as one bad ref. The real
    // hazard is a `-`-prefixed value being read as an OPTION, plus word
    // splitting on whitespace.
    const gen = readFileSync(resolve(ROOT, 'scripts/changelog-section.sh'), 'utf8');
    expect(gen).toContain('git log "$RANGE"');
    expect(gen).not.toMatch(/git log \$RANGE/);
  });

  it('rejects a --since that is not a plain ref', () => {
    for (const bad of ['--output=/tmp/pwn', 'a b', 'x;y']) {
      expect(() => gen(['0.6.2', '--since', bad])).toThrow();
    }
  });

  it('still accepts ordinary refs', () => {
    expect(() => gen(['0.6.2', '--since', 'v0.6.1'])).not.toThrow();
    expect(() => gen(['0.6.2', '--since', 'HEAD~1'])).not.toThrow();
  });
});

describe('#550 — the generator itself', () => {
  it('groups commits by type with their short sha', () => {
    const out = gen(['0.6.2', '--since', 'v0.6.1', '--no-heading']);
    expect(out).toContain('### Features');
    expect(out).toMatch(/- feat\(.+\) \([0-9a-f]{7}\)/);
  });

  it('carries the issue numbers the commit convention already includes', () => {
    // `fix(core): … (#544) (#547)` — GitHub autolinks these, so nothing has to
    // construct a URL.
    expect(gen(['0.6.2', '--since', 'v0.6.1', '--no-heading'])).toMatch(/\(#\d+\)/);
  });

  it('fails on a range that does not resolve, rather than reporting "no changes"', () => {
    // Review finding on #580. `collect()` ends in `|| true`, so a git failure
    // returned empty and a WRONG RANGE rendered identically to an uneventful
    // release — which in a release means notes claiming nothing changed.
    //
    // A bad ref did already fail, but only because the empty-range branch ran
    // git again under pipefail: correct by accident, and one edit from silently
    // losing it.
    expect(() => gen(['0.7.0', '--since', 'v9.9.9'])).toThrow(/does not resolve/);
  });

  it('says so plainly when nothing conventional is in range', () => {
    // A docs-only or chore-only release is a real case. An empty section would
    // read like the generator broke.
    const out = gen(['9.9.9', '--since', 'HEAD', '--no-heading']);
    expect(out).toContain('No feature or fix commits in this range');
    expect(out.trim()).not.toBe('');
  });

  it('emits a version heading when not suppressed — for CHANGELOG.md', () => {
    expect(gen(['0.6.2', '--since', 'v0.6.1'])).toMatch(/^## \[0\.6\.2\]/m);
  });

  it('strips a leading v so both call styles agree', () => {
    expect(gen(['v0.6.2', '--since', 'v0.6.1'])).toMatch(/^## \[0\.6\.2\]/m);
  });
});
