import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * #549 — the release gate must bump versions and the changelog, and must still
 * be able to prove it tagged what it tested.
 *
 * v0.6.0 shipped with every package.json reading 0.5.0 and no 0.6.0 changelog
 * section, because #505 replaced the manual flow and never adopted
 * scripts/release.sh. The script was not missing — it was orphaned.
 *
 * Asserted at the workflow level because that is where the failure lived: the
 * script worked fine, nothing called it.
 */
const ROOT = resolve(__dirname, '../../..');
const gate = yaml.load(readFileSync(resolve(ROOT, '.github/workflows/release-gate.yml'), 'utf8')) as any;
const deploy = yaml.load(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8')) as any;
const releaseSh = readFileSync(resolve(ROOT, 'scripts/release.sh'), 'utf8');

describe('#549 — the prepare stage', () => {
  it('exists and runs before the suite', () => {
    expect(gate.jobs.prepare).toBeDefined();
    expect(gate.jobs.suite.needs).toContain('prepare');
  });

  it('calls release.sh with --no-git, leaving git to the gate', () => {
    // A script that also tagged would create a second tag path with none of
    // the gate's guards.
    const run = JSON.stringify(gate.jobs.prepare.steps);
    expect(run).toContain('scripts/release.sh');
    expect(run).toContain('--no-git');
  });

  it('grades the PREPARED commit, not the input ref', () => {
    // The whole point of option 3. Grading the input ref would grade the tree
    // from before the bump, and the tag would then point at a different tree
    // than the one tested.
    const checkout = gate.jobs.suite.steps.find((s: any) => s.name === 'Checkout candidate');
    expect(checkout.with.ref).toBe('${{ needs.prepare.outputs.sha }}');
  });

  it('keeps the tag guard as plain equality — tested and tagged are one tree', () => {
    // If this ever becomes parentage arithmetic, option 3 has been abandoned
    // and the invariant needs re-deriving.
    const release = JSON.stringify(gate.jobs.release.steps);
    expect(release).toContain('refusing to tag');
    expect(gate.jobs.release.needs).toContain('prepare');
  });

  it('fails fast, so a failed push cannot go green', () => {
    // Review finding on #578. With `set -uo pipefail` and no -e, a failed
    // `git push` did not abort: SHA was captured from a local-only commit, the
    // output was written, and the step exited 0 on the last command. The job
    // would have gone GREEN having pushed nothing.
    const run = JSON.stringify(gate.jobs.prepare.steps);
    expect(run).toContain('set -euo pipefail');
    // …and the pushed commit is confirmed to be on the remote.
    expect(run).toContain('origin/main');
  });

  it('the suite refuses an empty prepared SHA', () => {
    // actions/checkout treats an empty `ref` as the DEFAULT BRANCH, so a
    // missing output would silently grade the pre-bump tree and the release
    // would tag something the suite never saw.
    expect(JSON.stringify(gate.jobs.suite.steps)).toContain('refusing to grade an unknown tree');
  });

  it('refuses to prepare anything but main', () => {
    // The bump is pushed to main; preparing a different ref would tag a tree
    // that was never prepared.
    expect(JSON.stringify(gate.jobs.prepare.steps)).toContain("must be 'main' to prepare");
  });

  it('fails when release.sh changed nothing', () => {
    // Otherwise re-cutting an already-current version would commit an empty
    // change and tag it as a release.
    expect(JSON.stringify(gate.jobs.prepare.steps)).toContain('changed nothing');
  });
});

describe('#549 — the deploy gate skips a release-prep commit', () => {
  it('excludes commits authored by the release gate', () => {
    // Not an unverified deploy: the release gate grades that exact SHA moments
    // later. Running here too would grade it twice AND contend for the
    // e2e-fixtures lock, queueing behind the release's own suite.
    expect(deploy.jobs['e2e-gate'].if).toContain('release-gate@mergewatch.ai');
  });

  it('keys on the author email, not the commit message', () => {
    // Neither is a security boundary — both are settable by anyone who can
    // push to main, and they can already dispatch with skip_e2e_gate. This is
    // an ACCIDENT filter: a human writing "chore: release v1.2.3" by hand is
    // plausible; a human committing as release-gate@mergewatch.ai is not.
    expect(deploy.jobs['e2e-gate'].if).toContain('author.email');
    expect(deploy.jobs['e2e-gate'].if).not.toContain('head_commit.message');
  });

  it('still honours the existing enable and skip switches', () => {
    expect(deploy.jobs['e2e-gate'].if).toContain('E2E_GATE_ENABLED');
    expect(deploy.jobs['e2e-gate'].if).toContain('skip_e2e_gate');
  });
});

describe('#549 — release.sh covers every package', () => {
  it('derives the package list rather than hardcoding it', () => {
    // The list was typed out and `packages/mcp` was never added — which is why
    // packages/mcp/package.json still reads 0.1.0 while the rest read 0.5.0.
    // A hand-maintained list beside the thing it describes will drift.
    expect(releaseSh).toContain('find "$REPO_ROOT/packages"');
    expect(releaseSh).not.toContain('"$REPO_ROOT/packages/core/package.json"');
  });

  it('would now include every workspace package, mcp included', () => {
    for (const pkg of ['core', 'lambda', 'server', 'dashboard', 'billing', 'mcp']) {
      expect(existsSync(resolve(ROOT, `packages/${pkg}/package.json`))).toBe(true);
    }
    // The derivation is a find over packages/*/package.json, so coverage is
    // structural rather than a list anyone has to remember to update.
    expect(releaseSh).toContain('-maxdepth 2 -name package.json');
  });
});
