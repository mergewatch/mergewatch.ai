import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * #513 — images ship only from a gated release.
 *
 * `docker-publish.yml` used to carry a `push: branches: [main]` trigger, so
 * `latest` tracked main: every qualifying merge went straight to GHCR with no
 * graded suite, no manual verification and no approval. Meanwhile the gate's
 * OWN release published nothing, because GitHub suppresses workflow triggers
 * for events created with the default GITHUB_TOKEN — v0.6.0 shipped a tag and
 * a GitHub release with no images at all.
 *
 * Both halves were the inverse of what release-gate.yml claimed, and neither
 * failed anything: the ungated path succeeded, and the gated path silently did
 * nothing. Which is why the invariants are asserted here rather than trusted to
 * a comment.
 */
const WORKFLOWS = resolve(__dirname, '../../../.github/workflows');
const load = (f: string) => yaml.load(readFileSync(resolve(WORKFLOWS, f), 'utf8')) as any;

const docker = load('docker-publish.yml');
const gate = load('release-gate.yml');

describe('docker-publish — only a release ships images', () => {
  it('has no push trigger', () => {
    // The whole defect. A push trigger means the registry is reachable without
    // passing the gate, no matter what the gate does.
    expect(docker.on.push).toBeUndefined();
  });

  it('still publishes on a release someone cuts by hand', () => {
    expect(docker.on.release?.types).toEqual(['published']);
  });

  it('is dispatchable, which is how the gate reaches it', () => {
    // Not optional: `release: published` never fires for a release the gate
    // creates, so this is the only path that works for an automated release.
    expect(docker.on).toHaveProperty('workflow_dispatch');
  });

  it('tags `latest` from a version tag, not from the default branch', () => {
    // Removing the push trigger while leaving `enable={{is_default_branch}}`
    // would publish NO `latest` at all — a tag ref is never the default branch.
    // Silent, and it breaks the README's own pull instructions.
    const tags = String(
      docker.jobs['build-and-push'].steps.find((s: any) => s.id === 'meta').with.tags,
    );
    expect(tags).not.toMatch(/is_default_branch/);
    expect(tags).toMatch(/refs\/tags\/v/);
  });

  it('still emits the semver tags a pinned deployment needs', () => {
    // docker-compose.yml pins an exact version rather than `latest`.
    const tags = String(
      docker.jobs['build-and-push'].steps.find((s: any) => s.id === 'meta').with.tags,
    );
    expect(tags).toMatch(/type=semver,pattern=\{\{version\}\}/);
    expect(tags).toMatch(/type=semver,pattern=\{\{major\}\}\.\{\{minor\}\}/);
  });
});

describe('release gate — the release actually ships images', () => {
  // v0.6.1: the gate tagged, created the release, then failed dispatching
  // docker-publish with
  //   HTTP 403: Resource not accessible by integration
  //     .../actions/workflows/<id>/dispatches
  // because the workflow declared only `contents: write`. Dispatching a
  // workflow is an ACTIONS API write, and GITHUB_TOKEN grants exactly what the
  // permissions block lists — so the release shipped with no images and a human
  // had to publish them by hand.
  //
  // Asserted here rather than in the dispatch step because the failure is a
  // property of the workflow's declared permissions, which nothing else checks.
  it('grants actions: write, without which the dispatch 403s', () => {
    const perms = gate.permissions ?? {};
    expect(perms['actions']).toBe('write');
  });

  it('still grants contents: write for tagging and the release', () => {
    // Guard against "fixing" the above by replacing rather than adding.
    expect((gate.permissions ?? {})['contents']).toBe('write');
  });

  const publish = () =>
    gate.jobs.release.steps.find((s: any) => s.name === 'Publish the images');

  /**
   * Executable lines only. The step's comments quote the code they replaced —
   * including the literal `--exit-status` — so a match over the raw text finds
   * the explanation of the fix and reports it as the bug. Same reason
   * release-gate.test.ts strips comments before its ordering assertions.
   */
  const publishCode = (): string =>
    (publish().run as string)
      .split('\n')
      .filter((l: string) => !/^\s*#/.test(l))
      .join('\n');

  /**
   * Where the verifier is actually INVOKED. `indexOf` on the name finds the
   * earlier mention inside the not-completed guard's error message (which tells
   * a human how to run it by hand), so ordering assertions anchored on the name
   * point at prose rather than at the call.
   */
  const invocationAt = (code = publishCode()): number => {
    const at = code.search(/^\s*scripts\/verify-published-images\.sh /m);
    expect(at, 'the verifier is never invoked as a command').toBeGreaterThan(-1);
    return at;
  };

  it('dispatches docker-publish explicitly rather than relying on the event', () => {
    // GITHUB_TOKEN suppression means publishing the release fires nothing. An
    // explicit dispatch is an API call, not an event, so it is exempt.
    expect(publish(), 'the publish step is gone').toBeDefined();
    expect(publish().run).toMatch(/gh workflow run docker-publish\.yml --ref "\$VERSION"/);
  });

  it('still WAITS for the publisher — fire-and-forget shipped v0.6.0 with no images', () => {
    // #513. The wait is not what #665 changed; only the verdict is. Assert it
    // survived, because "stop trusting the exit code" reads awfully like
    // "stop waiting".
    expect(publish().run).toMatch(/gh run watch "\$RUN_ID"/);
  });

  it('does NOT make the run conclusion the verdict (#665)', () => {
    // v0.6.5: both images published complete — 7 and 8 layers, nothing
    // missing, `latest` correct — and the release still reported failure,
    // because buildx recovered from a transient GHCR blob error and exited
    // non-zero anyway. `--exit-status` propagates the conclusion, so the
    // release outcome was decided by something that was not about the outcome.
    expect(publishCode()).not.toMatch(/--exit-status/);
  });

  it('decides from the registry, by running the image verifier', () => {
    // The verdict has to come from a source that can distinguish "no images"
    // (v0.6.0) from "images fine, publisher noisy" (v0.6.5). Neither the run
    // conclusion nor the existence of a tag can.
    const run = publishCode();
    expect(run).toMatch(/scripts\/verify-published-images\.sh/);
    expect(run).toMatch(/mergewatch\/mergewatch\b/);
    expect(run).toMatch(/mergewatch\/mergewatch-dashboard/);
  });

  it('verifies AFTER the wait — a verifier that runs first proves nothing', () => {
    // Checking the registry before docker-publish has finished would find the
    // PREVIOUS release's images and pass. Ordering is the whole check.
    const run: string = publishCode();
    const watch = run.indexOf('gh run watch');
    expect(watch, 'the wait is gone').toBeGreaterThan(-1);
    expect(invocationAt(run)).toBeGreaterThan(watch);
  });

  it('confirms the run COMPLETED before reading the registry', () => {
    // Without `--exit-status`, a `gh run watch` that returns because it itself
    // failed is indistinguishable from one that returns because the run
    // finished. Verifying then would check a registry mid-push and fail on an
    // image that was about to land — a false red, which is the bug.
    const run: string = publishCode();
    expect(run).toMatch(/--json status/);
    expect(run).toMatch(/never reached 'completed'/);
    // the guard sits between the wait and the verifier
    const guard = run.indexOf("never reached 'completed'");
    expect(guard).toBeGreaterThan(run.indexOf('gh run watch'));
    expect(guard).toBeLessThan(invocationAt(run));
  });

  it('fails the release when the registry check fails, not when the run is red', () => {
    // The exit has to hang off the verifier's status. If it hangs off
    // $CONCLUSION the behaviour is unchanged whatever the comments claim.
    const run: string = publishCode();
    const verifyAt = invocationAt(run);
    // There are earlier `exit 1`s — the "docker-publish never started" guard
    // (#513) and the not-completed guard — so anchor on the one that follows
    // the verifier rather than the first one in the block.
    expect(run.indexOf('exit 1', verifyAt)).toBeGreaterThan(verifyAt);
    // …and it is the VERIFIER's status that decides. If the `exit 1` hung off
    // $CONCLUSION instead, behaviour would be unchanged whatever the comments
    // claim, so assert the verifier's own exit code is what is branched on.
    expect(run).toMatch(/vrc"? -ne 0/);
    const decision = run.slice(verifyAt);
    expect(decision.indexOf('vrc'), 'nothing reads the verifier\'s exit code')
      .toBeGreaterThan(-1);
    expect(decision.indexOf('exit 1')).toBeGreaterThan(decision.indexOf('vrc'));
  });

  it('distinguishes "no images" from "images published, publisher exited non-zero"', () => {
    // The conflation IS the bug: `buildx failed with: …` was the only message,
    // and it reads identically for a release with no images and a release that
    // is complete. Two different outcomes need two different sentences, and
    // they must sit on opposite sides of the verifier's verdict.
    const run: string = publishCode();
    const broken = run.indexOf('no complete images published');
    const noisy = run.indexOf('images published, publisher exited non-zero');
    expect(broken, 'no message for the genuinely-broken case').toBeGreaterThan(-1);
    expect(noisy, 'no message for the complete-but-red case').toBeGreaterThan(-1);
    // the broken message is an error that exits; the noisy one is a warning
    expect(run.slice(broken - 40, broken)).toMatch(/::error::/);
    expect(run.slice(noisy - 40, noisy)).toMatch(/::warning::/);
  });

  it('fails when docker-publish never starts at all', () => {
    // The dispatch can be accepted and still produce no run. Silence there
    // would be indistinguishable from success.
    expect(publish().run).toMatch(/never started/);
  });

  it('publishes only after the release exists', () => {
    // docker-publish resolves the version from the tag, so dispatching before
    // the tag is pushed would build the wrong thing — or nothing.
    const steps = gate.jobs.release.steps.map((s: any) => s.name);
    expect(steps.indexOf('Publish the images')).toBeGreaterThan(
      steps.indexOf('Tag and release'),
    );
  });

  it('no longer claims docker-publish is reached by the release event', () => {
    // The header asserted a guarantee that was false in both directions. A
    // comment cannot be tested, but its absence can.
    const header = readFileSync(resolve(WORKFLOWS, 'release-gate.yml'), 'utf8').slice(0, 2000);
    expect(header).not.toMatch(/which fires on `release: published`/);
  });
});

describe('docker-publish — one image\'s failure must not cancel the other (#665)', () => {
  const strategy = () => docker.jobs['build-and-push'].strategy;

  it('sets fail-fast: false', () => {
    // The key was ABSENT, which defaults to true. On v0.6.5 `mergewatch` hit a
    // transient registry error and GitHub cancelled the `mergewatch-dashboard`
    // leg; that image exists only because its push finished before the cancel
    // landed. `undefined` is not `false` here — asserting on absence would have
    // passed on the broken workflow.
    expect(strategy()['fail-fast']).toBe(false);
  });

  it('still builds both images, so fail-fast was not "fixed" by dropping a leg', () => {
    const images = strategy().matrix.include.map((m: any) => m.image);
    expect(images).toEqual([
      'ghcr.io/mergewatch/mergewatch',
      'ghcr.io/mergewatch/mergewatch-dashboard',
    ]);
  });

  it('the gate verifies BOTH images, so a cancelled leg cannot pass unnoticed', () => {
    // fail-fast: false stops the cancel. It does not make a leg that failed
    // for real visible — that is the registry check's job, and it only helps
    // if it covers every image the matrix publishes.
    const publish = gate.jobs.release.steps.find((s: any) => s.name === 'Publish the images');
    for (const image of strategy().matrix.include.map((m: any) => m.image)) {
      const repo = image.replace(/^ghcr\.io\//, '');
      expect(publish.run, `${repo} is published but never verified`).toContain(repo);
    }
  });
});
