# E2E infrastructure — dev/prod A/B, tagged selection, deterministic grading

**Status:** In progress

**Tracking issue:** #416

## Summary

Three changes that together turn the E2E suite from a manual, all-or-nothing, LLM-graded exercise into something that can gate a deploy:

1. **Dev/prod A/B on one fixtures repo.** Install both GitHub Apps on `mergewatch/fixtures` so every fixture PR is reviewed twice — once per stage — on a byte-identical diff. Needs stage-scoped comment markers and check-run names so the two apps stop colliding.
2. **Tagged selection.** Tag each fixture and derive an impacted subset from a changed-file map, so a prompt tweak runs 11 fixtures instead of 93.
3. **Deterministic grading.** Add machine-checkable assertions alongside the existing LLM rubric, so a subset run can hard-fail CI without a model in the loop.

## Why

Today there is no way to test a change before it reaches production. Dev has been dark since 2026-06-25 (its App has **zero** webhook deliveries ever recorded), so `mergewatch/fixtures` is reviewed only by prod. The Sonnet 4.5 model swap (#414) shipped on the strength of a hand-built `InvokeModel` call and one manually-opened PR, because nothing better existed.

A separate `fixtures.dev` repo was considered and rejected: it makes dev and prod run *different inputs*, which is precisely what a comparison must not do. One repo with both apps gives input parity by construction — same PR, same SHA, same diff — with no sync job and no drift.

## What already exists

Substantial machinery is already in `mergewatch/fixtures`, and this plan extends it rather than replacing it:

| Component | What it does |
|---|---|
| `fixtures/NN-name/{README.md, meta.env, overlay/}` | Fixture definition. `meta.env` already carries `BRANCH`, `TITLE`, `BODY`, `DRAFT`, `LABELS`, `PREREQ_CHECK`, `SKIP_APPLY`, `MANUAL_ONLY`, `PUSH_TO_EXISTING_BRANCH` |
| `scripts/apply-fixture.sh` | Reset to `e2e-baseline` → branch → overlay → commit → push → open PR |
| `scripts/run-suite.sh` | Runs all fixtures, or a subset **named positionally**; writes `.e2e/last-run.json` |
| `.claude/commands/verify-suite.md` | LLM grades the run against each fixture's prose README, files upstream issues |
| `.claude/commands/runbook-sync.md` | Keeps fixture READMEs and `e2e/RUNBOOK.md` in step |

The gaps are narrow and specific: **selection is by explicit name only**, **grading needs a model**, and **there is no A/B**.

## Decisions

| Fork | Chosen | Rationale |
|---|---|---|
| Fixtures repo shape | One repo, both apps | Input parity by construction. A `fixtures.dev` mirror would compare two different inputs, defeating the purpose. |
| Tag source of truth | `TAGS=` in each fixture's `meta.env` | Lives next to the fixture it describes; `apply-fixture.sh` and `run-suite.sh` already parse `meta.env`. `runbook-sync` mirrors it into the RUNBOOK table. |
| Impact selection | Tags + a checked-in path→tag map | Tags are the primitive; the map turns a diff into tags. Unmapped shared code falls back to the full suite — a missed regression is far worse than a slow run. |
| Grading | Hybrid: `expect.json` + existing LLM pass | Roughly a third of RUNBOOK outcomes are qualitative ("findings quality unchanged or better") and cannot be asserted. Deterministic checks gate CI; the LLM keeps covering the rest. |
| Stage plumbing | Explicit `stage` parameter, never `process.env` inside core | `packages/core` is deliberately env-agnostic (`pricing.ts:106`: "Pure + env-agnostic — the caller reads `process.env`"). The Lambda already has `STAGE=dev`. |
| Staging | 3 PRs, spanning two repos | Stage 1 in `mergewatch.ai` unblocks the A/B; stages 2–3 are `mergewatch/fixtures`. |

## Architecture

### Stage-scoped identity (stage 1)

Three constants currently make dev and prod indistinguishable on a shared repo:

| Constant | File | Prod value — **must not change** |
|---|---|---|
| `BOT_COMMENT_MARKER` | `packages/core/src/github/client.ts:34` | `<!-- mergewatch-review -->` |
| `INLINE_BOT_COMMENT_MARKER` | `client.ts:44` | `<!-- mergewatch-inline -->` |
| `MERGEWATCH_CHECK_RUN_NAME` | `client.ts:308` | `MergeWatch Review` |

`findExistingBotComment` (`client.ts:251`) matches on the marker alone with **no author filter**, so with both apps live the second reviewer finds the first's comment and tries to update it — which GitHub rejects, since an app may only edit its own comments.

New `packages/core/src/stage.ts`:

```ts
export type Stage = 'prod' | (string & {});
export function reviewMarker(stage?: Stage): string
export function inlineMarker(stage?: Stage): string
export function checkRunName(stage?: Stage): string
```

Absent or `'prod'` returns today's exact strings; any other stage returns a suffixed variant (`<!-- mergewatch-review:dev -->`, `MergeWatch Review (dev)`).

**Both directions must move together.** These constants are read as well as written:

- `packages/lambda/src/handlers/webhook.ts:459` and `packages/server/src/webhook-handler.ts:342` — `isMergeWatchCheckRun` matches the check name to decide whether a re-run click belongs to us. Stage-scoping the write side alone would make dev ignore its own "Re-run" button.
- `packages/core/src/insights/disposition-writer.ts:310` and `packages/core/src/agents/inline-reply.ts:477` — match the inline marker to attribute reactions and replies.

The existing constants stay exported (self-hosted callers and back-compat) and are documented as "the prod value; prefer the resolver".

**The prod strings are load-bearing.** Changing `<!-- mergewatch-review -->` even once orphans every bot comment on every open PR in the wild: `findExistingBotComment` returns null and the next review posts a duplicate instead of updating. Pinned by explicit tests.

### Tagged selection (stage 2)

```
fixtures/54d-null-deref/meta.env
  TAGS=agents,bugs,critical-path
```

```
e2e/impact-map.yml
  packages/core/src/agents/prompts.ts:  [agents]
  packages/core/src/skip-logic.ts:      [skip]
  packages/billing/**:                  [billing]
  packages/core/src/comment-formatter*: [output]
  packages/llm-*/**:                    [ALL]    # model layer → full suite
```

`run-suite.sh` gains `--tag <t>` (repeatable) and `--impacted-by <ref>`. The latter reads the diff, resolves paths to tags, and unions the matching fixtures. **A changed path matching nothing in the map resolves to `ALL`**, and the run logs which paths forced the widening — silent under-selection is the failure mode that matters here.

### Deterministic grading (stage 3)

`fixtures/NN-name/expect.json`, all fields optional:

```json
{
  "check": "failure",
  "score": { "min": 1, "max": 2 },
  "reviewState": "CHANGES_REQUESTED",
  "mustFind": [{ "severity": "critical", "file": "src/payments.ts", "matches": "null|undefined" }],
  "mustNotContain": ["Could not parse agent JSON", "structured invocation failed"]
}
```

`scripts/grade-run.sh` (or `grade-run.ts`) reads `.e2e/last-run.json`, fetches each PR's check conclusion, review state, and bot comment, evaluates the assertions, and exits non-zero on any failure. A fixture with no `expect.json` is reported `UNGRADED`, never silently passed.

`verify-suite.md` is updated to run the deterministic pass first and confine its LLM judgement to what assertions could not express.

### A/B comparison

With both apps live, each fixture PR carries two bot comments distinguished by marker. `grade-run.sh --compare` grades both and reports divergence:

```
E2E-54d  fixtures#712
  prod  2/5 · 3 findings · caught null-deref ✅ · $0.21
  dev   2/5 · 3 findings · caught null-deref ✅ · $0.09
  → parity
```

## Phased breakdown

### Phase 1 — stage-scoped identity (`mergewatch.ai`)

- [x] **Goal:** dev and prod can review the same PR without colliding. No behavior change for prod. **Shipped in PR #417.**
- **Files:** new `packages/core/src/stage.ts`; `packages/core/src/github/client.ts` (write + `findExistingBotComment`); `packages/core/src/index.ts`; `packages/core/src/insights/disposition-writer.ts`; `packages/core/src/agents/inline-reply.ts`; `packages/lambda/src/handlers/webhook.ts` + `review-agent.ts` (pass `process.env.STAGE`); `packages/server/src/webhook-handler.ts`.
- **Tests:** prod resolves to the exact legacy strings (pinned literally, not derived); absent stage === `'prod'`; dev returns distinct values; `findExistingBotComment` scoped to one stage ignores the other stage's comment; `isMergeWatchCheckRun` matches its own stage's name and not the other's.
- **RUNBOOK:** E2E-94 — both apps review one PR; two comments, two checks, neither clobbers the other.

### Phase 2 — tags + impacted selection (`mergewatch/fixtures`)

- [ ] **Goal:** `run-suite.sh --tag agents` and `--impacted-by <ref>` run a subset.
- **Files:** `TAGS=` added to all 93 `fixtures/*/meta.env`; new `e2e/impact-map.yml`; `scripts/run-suite.sh`; `.claude/commands/runbook-sync.md` (mirror tags into the RUNBOOK table); RUNBOOK regression table gains a Tags column.
- **Tests:** tag filter selects the expected set; unknown tag errors rather than silently running nothing; an unmapped changed path widens to `ALL` and says so.
- **RUNBOOK:** E2E-95 — tagged and impacted selection pick the right subset.

### Phase 3 — deterministic grading + nightly CI (`mergewatch/fixtures`)

- [ ] **Goal:** a subset run hard-fails without a model; nightly full run.
- **Files:** `expect.json` for the deterministic fixtures (start with the ~20 highest-value; the rest stay `UNGRADED`); `scripts/grade-run.sh`; `.claude/commands/verify-suite.md`; a nightly GitHub Action.
- **Tests:** each assertion type passes and fails correctly; a missing `expect.json` reports `UNGRADED`, never `PASS`; `--compare` detects a seeded dev/prod divergence.
- **RUNBOOK:** E2E-96 — grading catches a deliberately broken fixture.

## Out of scope / deferred

- **Turning on the dev App's webhook and scoping its installation.** Manual GitHub UI steps only the operator can do: point it at `https://fukmc5gjhk.execute-api.us-west-2.amazonaws.com/dev/webhook`, mark it Active, match the secret to SSM `/mergewatch/dev/github-webhook-secret`, and scope the `mergewatch` installation to `fixtures` **only** — it currently sees `kitchensink`, which prod also sees, so enabling it as-is double-reviews that repo. Nothing in phase 1 takes effect until this is done.
- **Ava-Listens and assistants-hub** are on the dev App and look like real projects. They would start receiving dev-stack reviews the moment the webhook is enabled. Operator decision, not code.
- **Backfilling `expect.json` for all 93 fixtures** — phase 3 covers the highest-value subset; the rest stay `UNGRADED` and visible as such.
- **Tier-1 pipeline contract tests** (calling `runReviewPipeline()` directly against Bedrock, no GitHub) — genuinely valuable and much cheaper per run, but a separate shape from this suite. File separately.
- **Cost.** Both apps reviewing every fixture PR roughly doubles fixture spend (~$0.07–0.50 per review, so a full 93-fixture A/B run is roughly $15–30). Scoping the dev App to `fixtures` alone is what keeps this contained.
- **The stale dev installations table row** listing `mergewatch/fixtures` for installation 142368585 — a June artifact; dev cannot currently see that repo.
