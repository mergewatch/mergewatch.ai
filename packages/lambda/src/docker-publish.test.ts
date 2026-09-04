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

  it('dispatches docker-publish explicitly rather than relying on the event', () => {
    // GITHUB_TOKEN suppression means publishing the release fires nothing. An
    // explicit dispatch is an API call, not an event, so it is exempt.
    expect(publish(), 'the publish step is gone').toBeDefined();
    expect(publish().run).toMatch(/gh workflow run docker-publish\.yml --ref "\$VERSION"/);
  });

  it('waits for the images, and fails the release if they fail', () => {
    // Fire-and-forget would let a release whose images never built report
    // success — the same hole the gate exists to close, one step further on.
    expect(publish().run).toMatch(/gh run watch .*--exit-status/);
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
