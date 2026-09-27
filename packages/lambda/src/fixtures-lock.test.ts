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

type Concurrency = { group?: string; 'cancel-in-progress'?: boolean } | undefined;

interface WorkflowJob {
  workflow: string;
  jobId: string;
  /** Effective concurrency: the job's own, else the workflow-level default. */
  concurrency: Concurrency;
  /** Set when the job is gated on a GitHub environment (approval / wait timer). */
  environment: unknown;
  /** Does this job check out the shared fixtures repo? */
  touchesFixtures: boolean;
}

interface Scan {
  jobs: WorkflowJob[];
  /** Anything that stopped a file being understood. Never thrown — see below. */
  errors: string[];
}

/**
 * Read every workflow once, and never throw.
 *
 * Total rather than throwing because this runs at module load, to feed
 * `it.each`. A throw there is a vitest COLLECTION error: the file never loads,
 * so none of the assertions below — including the sentinel that exists to
 * catch exactly this — ever get to run, and the output is a stack trace rather
 * than a sentence about the fixtures lock.
 *
 * Errors are collected instead of skipped for the same reason the sentinel
 * exists. A file that fails to parse yields no jobs, and silently yielding no
 * jobs is indistinguishable from "this workflow doesn't touch fixtures" — so a
 * third fixtures-driving job could hide behind a YAML typo in its own file
 * while the other two keep the count above the sentinel's floor.
 */
function scanWorkflows(): Scan {
  const jobs: WorkflowJob[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch (err) {
    return { jobs, errors: [`cannot read ${WORKFLOW_DIR}: ${(err as Error).message}`] };
  }
  if (!files.length) return { jobs, errors: [`no workflows found in ${WORKFLOW_DIR}`] };

  for (const file of files) {
    let wf: any;
    try {
      wf = yaml.load(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8'));
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    if (!wf || typeof wf !== 'object') {
      errors.push(`${file}: did not parse to a mapping`);
      continue;
    }
    if (!wf.jobs || typeof wf.jobs !== 'object') {
      errors.push(`${file}: no jobs block`);
      continue;
    }

    for (const [jobId, job] of Object.entries<any>(wf.jobs)) {
      jobs.push({
        workflow: file,
        jobId,
        // A job with no group of its own still inherits the workflow-level
        // one, which is a legitimate way to hold the lock.
        concurrency: job?.concurrency ?? wf.concurrency,
        environment: job?.environment,
        touchesFixtures: (job?.steps ?? []).some(
          (step: any) =>
            typeof step?.uses === 'string' &&
            step.uses.startsWith('actions/checkout') &&
            step?.with?.repository === FIXTURES_REPO,
        ),
      });
    }
  }
  return { jobs, errors };
}

const scan = scanWorkflows();
const fixturesJobs = scan.jobs.filter((j) => j.touchesFixtures);

describe('the shared fixtures repo is driven under one lock', () => {
  it('understands every workflow file', () => {
    // An unreadable file yields no jobs, which looks exactly like a workflow
    // that does not touch fixtures. Fail on the parse rather than let it be
    // silently excluded from every assertion below.
    expect(scan.errors).toEqual([]);
  });

  it('finds exactly the jobs known to drive it', () => {
    // An explicit inventory, not a count. Two things it catches that a count
    // cannot:
    //
    //   - detection breaking. Rename `Checkout fixtures`, or move the repo,
    //     and every per-job assertion below silently iterates an empty list —
    //     a green suite asserting nothing, which is the failure mode this
    //     whole area keeps producing.
    //   - a job being ADDED. That is the thing #506 was actually about, and
    //     the author needs to have read the rule above before their job starts
    //     driving a shared repo. Failing here is how they find out.
    //
    // If you are here because you added one: add it to this list, and give it
    // the `e2e-fixtures` group.
    expect(fixturesJobs.map((j) => `${j.workflow} · ${j.jobId}`).sort()).toEqual([
      'deploy.yml · e2e-gate',
      'release-gate.yml · suite',
    ]);
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
    // Deliberately spans ALL jobs, not just the fixtures-driving ones: any job
    // in this group must be able to finish without a person.
    const offenders = scan.jobs
      .filter((j) => j.concurrency?.group === GROUP && j.environment)
      .map((j) => `${j.workflow} · ${j.jobId}`);
    expect(offenders).toEqual([]);
  });
});

/**
 * #584 — the gate must opt IN to the fixture snapshot, or a merged fixture fix
 * never reaches a run.
 *
 * `run-suite.sh` snapshots only when `--snapshot-ref` is passed (`:107`). Without
 * it, SNAP stays empty, E2E_CONTENT_ROOT is never exported, and every consumer
 * falls back to REPO_ROOT — the working tree that `apply-fixture.sh` has by then
 * checked out to `e2e-baseline`. So the overlay applied is the TAG's copy, which
 * is the entire defect.
 *
 * fixtures#3866 shipped the capability and this workflow did not use it: deploy
 * #579 ran AFTER that merge and still printed "the run manifest records no
 * `snapshot`". The fix compiled, was tested, reviewed clean, and did nothing —
 * because the opt-in lives in a different repo from the change.
 *
 * Asserted at the workflow level because that is where the gap was.
 */
describe('#584 — the gate passes the fixture snapshot refs', () => {
  const deploy = yaml.load(
    readFileSync(resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'),
  ) as any;

  const gateSteps: any[] = Object.values(deploy.jobs)
    .flatMap((j: any) => j.steps ?? [])
    .filter(Boolean);

  // ALL matching steps, not the first. Several `run` blocks mention
  // `run-suite.sh` in a shell comment (the git-identity step explains why it
  // commits), so `.find` returns a step that never invokes it — and the
  // assertion then fails for the wrong reason. Learned by writing it that way.
  const stepsRunning = (needle: string) =>
    gateSteps.filter((st: any) => typeof st.run === 'string' && st.run.includes(needle));
  const anyRunMatches = (needle: string, re: RegExp) =>
    stepsRunning(needle).some((st: any) => re.test(st.run));

  it('pins the fixtures commit before anything moves the working tree', () => {
    const pin = gateSteps.find((st: any) => st.id === 'fixref');
    expect(pin, 'no step with id "fixref" — nothing captures the fixtures SHA').toBeTruthy();
    expect(pin.run).toMatch(/git rev-parse HEAD/);
    // It must run in the fixtures checkout, not this repo's.
    expect(pin['working-directory']).toBe('fixtures-repo');
  });

  it('passes --snapshot-ref to run-suite.sh', () => {
    expect(stepsRunning('run-suite.sh').length, 'no step mentions run-suite.sh').toBeGreaterThan(0);
    // Without this flag run-suite.sh silently does not snapshot: `if [ -n
    // "$SNAPSHOT_REF" ]`. The failure is a warning in the grade output, not an
    // error, so nothing else here would catch its removal.
    expect(anyRunMatches('run-suite.sh', /--snapshot-ref/)).toBe(true);
    expect(anyRunMatches('run-suite.sh', /steps\.fixref\.outputs\.sha/)).toBe(true);
  });

  it('grades against the SAME sha the suite snapshotted', () => {
    expect(stepsRunning('grade-run.mjs').length, 'no step mentions grade-run.mjs').toBeGreaterThan(0);
    expect(anyRunMatches('grade-run.mjs', /--expect-ref/)).toBe(true);
    expect(anyRunMatches('grade-run.mjs', /steps\.fixref\.outputs\.sha/)).toBe(true);
  });

  it('uses one sha for both, so overlays and expectations cannot disagree', () => {
    const ref2 = /steps\.fixref\.outputs\.sha/;
    expect(anyRunMatches('run-suite.sh', ref2)).toBe(true);
    expect(anyRunMatches('grade-run.mjs', ref2)).toBe(true);
  });
});

/**
 * #584 — the RELEASE gate needs the same opt-in as the deploy gate.
 *
 * #673 wired `deploy.yml` and left `release-gate.yml` alone, so the release
 * suite still read fixture definitions from the tag. That is worse here than in
 * the deploy gate: the graded-suite block a release produces is embedded
 * verbatim in the release notes, so a release could report grading overlays it
 * never ran.
 */
describe('#584 — the release gate passes the fixture snapshot refs too', () => {
  const gate = yaml.load(
    readFileSync(resolve(__dirname, '../../../.github/workflows/release-gate.yml'), 'utf8'),
  ) as any;

  const steps: any[] = Object.values(gate.jobs)
    .flatMap((j: any) => j.steps ?? [])
    .filter(Boolean);

  // Every step whose `run` mentions the needle, not the first — several blocks
  // name these scripts in shell comments, and `.find` returns one that never
  // invokes them. That mistake is how the deploy-gate version of this test
  // failed for the wrong reason first time.
  const running = (needle: string) =>
    steps.filter((st: any) => typeof st.run === 'string' && st.run.includes(needle));
  const anyMatches = (needle: string, re: RegExp) =>
    running(needle).some((st: any) => re.test(st.run));

  it('pins the fixtures commit before the suite moves the tree', () => {
    const pin = steps.find((st: any) => st.id === 'fixref');
    expect(pin, 'release gate has no fixref step').toBeTruthy();
    expect(pin.run).toMatch(/git rev-parse HEAD/);
    expect(pin['working-directory']).toBe('fixtures-repo');
  });

  it('passes --snapshot-ref to run-suite.sh', () => {
    expect(running('run-suite.sh').length).toBeGreaterThan(0);
    expect(anyMatches('run-suite.sh', /--snapshot-ref/)).toBe(true);
  });

  it('grades against the same sha, so a release cannot grade a tree it did not run', () => {
    expect(running('grade-run.mjs').length).toBeGreaterThan(0);
    expect(anyMatches('grade-run.mjs', /--expect-ref/)).toBe(true);
    const ref = /steps\.fixref\.outputs\.sha/;
    expect(anyMatches('run-suite.sh', ref) && anyMatches('grade-run.mjs', ref)).toBe(true);
  });
});
