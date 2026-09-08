import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
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

const gen = (args: string[]) =>
  execFileSync(resolve(ROOT, 'scripts/changelog-section.sh'), args, { cwd: ROOT, encoding: 'utf8' });

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
