import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * #506 — the fixtures repo is ONE shared mutable resource, and the thing that
 * protects it is a concurrency group.
 *
 * `scripts/reset-env.sh` closes every open `fixture/*` PR in
 * `mergewatch/fixtures` and deletes its branch. It is not scoped to the run
 * that calls it, and it cannot be: a runner has no way to tell its own fixture
 * branches from another run's. So two jobs driving that repo at once tear down
 * each other's PRs, and the victim sits in `await-reviews.mjs` waiting on PRs
 * that no longer exist.
 *
 * The original bug was two workflows each serialising only against ITSELF —
 * `e2e-fixtures` in this repo, `e2e-suite` in the fixtures repo. Neither was
 * wrong; both were scoped to the wrong thing. GitHub concurrency groups are
 * per-repository, so the fix is that every job which touches that repo lives
 * HERE and shares ONE group.
 *
 * These tests are the part that survives the fix: they derive the job list
 * from the workflows themselves, so a third fixtures-driving job added later
 * cannot skip the lock quietly. Adding one without `e2e-fixtures` fails here
 * rather than in production, months later, as an unexplained gate timeout.
 */
const WORKFLOW_DIR = resolve(__dirname, '../../../.github/workflows');
const FIXTURES_REPO = 'mergewatch/fixtures';
const GROUP = 'e2e-fixtures';

interface FixturesJob {
  workflow: string;
  jobId: string;
  /** Effective concurrency: the job's own, else the workflow-level default. */
  concurrency: { group?: string; 'cancel-in-progress'?: boolean } | undefined;
}

/** Every job, in every workflow, that checks out the shared fixtures repo. */
function findFixturesJobs(): FixturesJob[] {
  const found: FixturesJob[] = [];
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const wf = yaml.load(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as any;
    for (const [jobId, job] of Object.entries<any>(wf?.jobs ?? {})) {
      const touchesFixtures = (job?.steps ?? []).some(
        (step: any) =>
          typeof step?.uses === 'string' &&
          step.uses.startsWith('actions/checkout') &&
          step?.with?.repository === FIXTURES_REPO,
      );
      if (!touchesFixtures) continue;
      // A job with no group of its own still inherits the workflow-level one,
      // which is a legitimate way to hold the lock.
      found.push({ workflow: file, jobId, concurrency: job.concurrency ?? wf.concurrency });
    }
  }
  return found;
}

const fixturesJobs = findFixturesJobs();

describe('the shared fixtures repo is driven under one lock', () => {
  it('finds the jobs that drive it', () => {
    // Guards the detection itself. If `Checkout fixtures` were renamed, or the
    // repository moved, every assertion below would pass over an empty list —
    // a green suite asserting nothing, which is the failure mode this whole
    // area keeps producing.
    expect(fixturesJobs.length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixturesJobs)('$workflow · $jobId holds the fixtures lock', (job) => {
    expect(job.concurrency?.group).toBe(GROUP);
  });

  it.each(fixturesJobs)('$workflow · $jobId waits rather than cancelling', (job) => {
    // The losing run must QUEUE. Cancelling it would leave its half-applied
    // fixture branches and open PRs behind, which is the dirty-repo state that
    // makes the next run's failures look like product regressions.
    expect(job.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('uses exactly one group name across every workflow', () => {
    // Two spellings is the original bug in miniature.
    const groups = new Set(fixturesJobs.map((j) => j.concurrency?.group));
    expect([...groups]).toEqual([GROUP]);
  });
});

describe('the lock is never held across a human wait', () => {
  it('no job holding the fixtures group is gated on an environment', () => {
    // #428: a job parked on a required-reviewer approval while holding a
    // shared group queues every later run behind it — one sat ~9.5 hours and
    // GitHub cancelled the next run outright. An environment is how approvals
    // and wait timers are attached, so holding this lock and naming an
    // environment is the combination that reintroduces it.
    //
    // Deliberately not restricted to the fixtures-driving jobs: ANY job in
    // this group must be able to finish without a person.
    const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const offenders: string[] = [];

    for (const file of files) {
      const wf = yaml.load(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as any;
      for (const [jobId, job] of Object.entries<any>(wf?.jobs ?? {})) {
        const group = (job?.concurrency ?? wf?.concurrency)?.group;
        if (group === GROUP && job?.environment) offenders.push(`${file} · ${jobId}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
