import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * #505 — invariants of the release gate that are easy to break by editing the
 * workflow and impossible to notice until a release goes wrong.
 *
 * Same shape as template.test.ts: read the infra file, assert the properties
 * that carry the reasoning, not the formatting.
 */
const WORKFLOW = resolve(__dirname, '../../../.github/workflows/release-gate.yml');
const wf = yaml.load(readFileSync(WORKFLOW, 'utf8')) as any;

describe('release gate — no tag without a pass and an approval', () => {
  it('creates the release only after BOTH the suite and the human approval', () => {
    // If `release` ever stops needing `verify`, the gate silently becomes a
    // report: tags would be cut on a green suite with nobody signing off.
    expect(wf.jobs.release.needs).toEqual(expect.arrayContaining(['suite', 'verify']));
  });

  it('gates approval behind an environment, which is where reviewers live', () => {
    expect(wf.jobs.verify.environment).toBe('release-approval');
  });

  it('tags nowhere except the release job', () => {
    // A `git tag` anywhere earlier would defeat the ordering.
    const earlier = JSON.stringify([wf.jobs.suite, wf.jobs.verify]);
    expect(earlier).not.toMatch(/git tag/);
    expect(JSON.stringify(wf.jobs.release)).toMatch(/git tag/);
  });
});

describe('release gate — concurrency', () => {
  it('shares the deploy gate\'s fixtures group, so the two cannot collide', () => {
    // #506: the two suites used different groups while driving one shared
    // fixtures repo, whose reset-env closes every open PR.
    expect(wf.jobs.suite.concurrency.group).toBe('e2e-fixtures');
    expect(wf.jobs.suite.concurrency['cancel-in-progress']).toBe(false);
  });

  it('does NOT hold that lock while waiting for a human', () => {
    // #428: a job parked on an approval while holding a shared group queues
    // everything behind it — one sat ~9.5 hours and GitHub cancelled the next
    // run outright. The verification window must hold no lock at all.
    expect(wf.jobs.verify.concurrency).toBeUndefined();
  });
});

describe('release gate — what it actually verifies', () => {
  it('selects only GRADED fixtures', () => {
    // An ungraded fixture opens a PR, spends real budget, and cannot fail.
    // Counting those toward a release headline is the coverage illusion.
    const steps = JSON.stringify(wf.jobs.suite.steps);
    expect(steps).toMatch(/--automated --graded/);
  });

  it('fails rather than passing when the selection is empty', () => {
    // A gate that runs nothing must not report success.
    expect(JSON.stringify(wf.jobs.suite.steps)).toMatch(/selection is empty/);
  });

  it('restores the tooling checkout before grading', () => {
    // reset-env moves local main to e2e-baseline, which predates every
    // expect.json. Without the restore the grader finds no expectations, marks
    // everything UNGRADED, and exits 0 — green, having verified nothing.
    const steps = wf.jobs.suite.steps.map((s: any) => s.name);
    const restore = steps.indexOf('Restore the tooling checkout');
    const grade = steps.indexOf('Grade');
    expect(restore).toBeGreaterThan(-1);
    expect(grade).toBeGreaterThan(restore);
  });

  it('tears down even when the suite fails', () => {
    const teardown = wf.jobs.suite.steps.find((s: any) => s.name === 'Tear down');
    expect(teardown.if).toBe('always()');
  });
});

describe('release gate — input handling', () => {
  it('never interpolates a workflow input directly into a run block', () => {
    // Script injection: an input reaching `run:` via ${{ }} is executed.
    for (const job of Object.values<any>(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string') {
          expect(step.run).not.toMatch(/\$\{\{\s*inputs\./);
          expect(step.run).not.toMatch(/\$\{\{\s*github\.event\.inputs\./);
        }
      }
    }
  });

  it('rejects a version that is not vN.N.N', () => {
    expect(JSON.stringify(wf.jobs.suite.steps)).toMatch(/version must look like/);
  });

  it('refuses to re-cut an existing tag', () => {
    expect(JSON.stringify(wf.jobs.suite.steps)).toMatch(/already exists/);
  });
});
