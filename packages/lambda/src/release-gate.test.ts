import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

describe('release gate — the tag must point at the commit that was graded (#507 review)', () => {
  it('pins the candidate to a SHA in the suite job', () => {
    expect(wf.jobs.suite.outputs.sha).toBeTruthy();
    const pin = wf.jobs.suite.steps.find((s: any) => s.id === 'pin');
    expect(pin).toBeTruthy();
    expect(pin.run).toMatch(/git rev-parse HEAD/);
  });

  it('pins BEFORE running the suite, so the SHA is the one that was graded', () => {
    const names = wf.jobs.suite.steps.map((s: any) => s.name);
    expect(names.indexOf('Pin the candidate to a SHA'))
      .toBeLessThan(names.indexOf('Run the suite'));
  });

  it('checks out the pinned SHA downstream, never the mutable input ref', () => {
    // candidate_ref defaults to `main`. Re-resolving it after an approval
    // window that can run for hours would tag whatever landed since — the
    // exact failure this gate exists to prevent, inside the gate.
    for (const job of ['verify', 'release']) {
      const co = wf.jobs[job].steps.find((s: any) => s.uses?.startsWith('actions/checkout'));
      expect(co.with.ref, `${job} must check out the graded SHA`)
        .toBe('${{ needs.suite.outputs.sha }}');
    }
  });

  it('tags the SHA explicitly rather than whatever HEAD happens to be', () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === 'Tag and release');
    expect(step.run).toMatch(/git tag -a "\$VERSION" -m "\$VERSION" "\$SHA"/);
    expect(step.run).toMatch(/--target "\$SHA"/);
  });

  it('refuses to tag if HEAD is not the graded commit', () => {
    // Tagging is irreversible, so verify rather than assume the checkout held.
    const step = wf.jobs.release.steps.find((s: any) => s.name === 'Tag and release');
    expect(step.run).toMatch(/refusing to tag/);
  });
});

describe('release gate — shell hygiene', () => {
  it('uses set -uo pipefail in every run block that sets shell options', () => {
    // The Grade step used `set -o pipefail` alone, so an unset $MW_STAGE would
    // have passed an empty --stage rather than failing.
    for (const job of Object.values<any>(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string' && step.run.includes('set -')) {
          expect(step.run, `${step.name} should use set -uo pipefail`)
            .toMatch(/set -uo pipefail/);
        }
      }
    }
  });
});

describe('release gate — the release step cannot strand a tag', () => {
  const step = () => wf.jobs.release.steps.find((s: any) => s.name === 'Tag and release');

  /**
   * The real fence computation, lifted out of the workflow and run under the
   * same shell Actions uses (`bash -e`, plus the block's own `pipefail`).
   *
   * Asserting on the text would not have caught this: the line looked correct.
   * It has to actually run.
   */
  function computeFence(graded: string): { status: number; out: string } {
    const lines: string[] = step().run.split('\n');
    const start = lines.findIndex((l) => l.trim().startsWith('longest='));
    const end = lines.findIndex((l) => l.trim().startsWith('fence='));
    expect(start, 'longest= assignment not found — this test is anchored on it').toBeGreaterThan(-1);
    expect(end, 'fence= assignment not found').toBeGreaterThan(start);

    const snippet = [
      'set -uo pipefail',
      ...lines.slice(start, end + 1),
      'printf "%s" "$fence"',
    ].join('\n');

    const r = spawnSync('bash', ['-e', '-c', snippet], {
      encoding: 'utf8',
      env: { ...process.env, GRADED: graded },
    });
    return { status: r.status ?? -1, out: r.stdout };
  }

  it('sizes the fence when the summary has NO backticks', () => {
    // v0.6.0 died here. `grep -o` exits 1 when it matches nothing, pipefail
    // propagates it, and `bash -e` killed the step — after the tag was pushed.
    // A backtick-free summary is the normal case, so the guard aborted every
    // release except the rare one it was written for.
    const r = computeFence('22 passed · 0 failed · 0 ungraded · 0 skipped · 0 errored');
    expect(r.status).toBe(0);
    expect(r.out).toBe('```');
  });

  it('still grows the fence when the summary DOES contain backticks', () => {
    // The behaviour the guard exists for: a fixture name or reason carrying a
    // fence would otherwise break out and mangle every note after it.
    expect(computeFence('a ``` b').out).toBe('````');
    expect(computeFence('a ````` b').out).toBe('``````');
  });

  it('builds the notes BEFORE pushing the tag', () => {
    // Ordering is the actual fix. Anything that can fail belongs on the near
    // side of the irreversible push — a failure after it leaves a tag with no
    // release, which the suite's "refuse to re-cut an existing tag" guard then
    // blocks from being retried.
    const run: string = step().run;
    expect(run.indexOf('/tmp/notes.md')).toBeLessThan(run.indexOf('git push origin'));
    expect(run.indexOf('git tag -a')).toBeGreaterThan(run.indexOf('/tmp/notes.md'));
  });

  it('refuses to tag when the notes came out empty', () => {
    const run: string = step().run;
    expect(run).toMatch(/test -s \/tmp\/notes\.md/);
    expect(run.indexOf('test -s /tmp/notes.md')).toBeLessThan(run.indexOf('git tag -a'));
  });
});
