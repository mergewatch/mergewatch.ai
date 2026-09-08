# Releasing

How a MergeWatch release is cut, what each phase guarantees, and what a green
run does and does not mean.

Until now this existed only as comments inside
[`.github/workflows/release-gate.yml`](../.github/workflows/release-gate.yml).
Those comments are good, but nobody reads a workflow file to answer "how do I
cut a release" — and every failure this process has hit was recoverable only by
someone who had.

## Cutting one

```bash
gh workflow run release-gate.yml \
  -f version=v0.7.0 \
  -f candidate_ref=main
```

| Input | Meaning |
|---|---|
| `version` | The tag to cut, e.g. `v0.7.0` |
| `candidate_ref` | Commit or branch to release. Must be `main` — the version bump is pushed there |
| `dry_run` | Grade and stop: no approval, no tag. **Not a cheaper path** — it runs the same full suite |

Then approve **Manual verification** in the run's *Review deployments* prompt
once you have worked through the manual fixtures.

## The four phases

### 1. `prepare` — bump versions and the changelog

Runs `scripts/release.sh --no-git`, commits `chore: release vX.Y.Z` to `main`,
and outputs that commit's SHA.

**Why it runs first.** The gate tags the exact commit the suite graded, and
re-verifies that before tagging. A bump commit changes the SHA, so bumping
*after* grading would mean tagging a tree nobody tested. Bumping first is the
only ordering where the tested tree and the tagged tree are byte-identical.

This exists because it did not: **v0.6.0 shipped with every `package.json`
still reading `0.5.0`** and no changelog section, because #505 replaced the
manual flow and never adopted the script.

The deploy pipeline skips its E2E gate for this commit — not because it is
trusted, but because the release gate grades that exact SHA moments later, and
running both would queue two suites against one shared fixtures repo.

### 2. `suite` — grade the automated fixtures

Holds the `e2e-fixtures` concurrency group, the **same group the deploy gate
uses**. Both drive one shared fixtures repo and `reset-env.sh` closes every open
PR there, so an overlap would tear down the other run's fixtures.

Currently **48** automated graded correctness fixtures.

### 3. `verify` — a human works the manual set

**Holds no lock, deliberately.** A job parked on a human approval while holding
`e2e-fixtures` would queue every merge's gate behind it — which is exactly what
happened before #428: one run sat ~9.5 hours and GitHub cancelled the next.

Currently **32** manual fixtures. Manual means a person must *drive* them —
reply in a thread, add a reaction, check stored state — not merely look at a PR
someone left open. Some cannot run in CI at all: `68-org-custom-agents` reads
DynamoDB, and the gate job has no AWS credentials, so its prerequisite is
unsatisfiable there by construction.

### 4. `release` — tag, release, publish

Tags the graded SHA, creates the GitHub Release, then **dispatches the image
build and waits for it**.

That dispatch is not decoration. `docker-publish.yml` listens for
`release: published`, but GitHub suppresses that event for releases created with
`GITHUB_TOKEN` — which is what the gate uses. **v0.6.0 published no images** and
reported success before this was understood.

## The gate's four outcomes are not interchangeable

| Outcome | Meaning | Report it as |
|---|---|---|
| **success** | Selected fixtures ran and graded clean | Verified, **with the count** |
| **failure** | A graded fixture failed | Stop. Do not retry hoping |
| **skipped** | Gate disabled, or bypassed via `skip_e2e_gate` | **Not verified.** Say so plainly |
| **0 selected** | No fixture can observe these paths | A pass — and say why it was empty |

Writing a skipped gate or an empty selection up as "the suite passed" rebuilds
the exact hole the gate exists to close: it is what makes *"nobody checked"* and
*"checked and clean"* stop looking alike.

The honest number is the **graded** count. "3 fixtures passed" is true;
"the suite passed" is not, when 45 others were not selected.

## When it fails

The release is not cut — `verify` and `release` are skipped, so there is no tag
and no images.

Fix the cause rather than re-running. Two of the fixture failures this process
hit were **assertions that were wrong**, not regressions — and one was a real
crash a "flaky" failure had caught. A gate people re-run on red is worth
nothing.

Re-cutting the same version is blocked by the existing-tag guard until the tag
is removed.

## Production deploys are not part of the release

`main` reaches production on its own:

```
push to main → build & test → deploy-dev → [E2E gate] → [10 min timer] → deploy-prod
```

**Nobody approves it.** #428 replaced the required reviewer with a wait timer, so
a merge reaches production whether or not anyone is watching. Tagging a release
does not deploy anything, and not tagging does not prevent a deploy.

Easy to conflate; worth stating plainly.

## What a cut costs

A full graded suite is roughly **$3** in real LLM spend — every fixture opens a
real PR in `mergewatch/fixtures` and pays for a real review. The figure is
reported by the run itself (`Suite cost: ~$X across N reviewed fixture(s)`).

Two consequences:

- **`dry_run` is not a cheaper path.** It runs the same suite and only skips the
  tag.
- **Do not run the fixture suite locally to speed anything up.** `reset-env.sh`
  closes every open PR in that shared repo, so a local run collides with the
  gate's — and with anyone else's.

## Known gaps

- Release notes state how the release was tested, never what changed (#550).
- The release gate re-grades a SHA the deploy gate may have graded minutes
  earlier (#537). Left open deliberately: at ~$3 a suite it is worth a few
  dollars per cut.
