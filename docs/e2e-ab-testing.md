# E2E A/B testing — dev and prod on one fixtures repo

**Status:** ✅ Shipped (#416) — PRs #417, fixtures#705, fixtures#706.

MergeWatch runs as two GitHub Apps: a dev App and a prod App. Installing **both** on `mergewatch/fixtures` is how a change gets tested before it reaches production: the same PR, at the same commit, reviewed twice, side by side in one thread.

## Why one repo, not two

A separate `fixtures.dev` repo is the obvious design and it is the wrong one. It makes dev and prod run **different inputs**, so any difference in their output is ambiguous — a real regression and a stale fixture look identical. It also adds a mirror to keep in sync, and the moment it drifts the comparison quietly stops meaning anything.

One repo gives input parity by construction. There is nothing to sync, and the two reviews sit next to each other where a human can read them.

## Stage-scoped identity

Three values previously made the two stages indistinguishable on a shared repo, because `findExistingBotComment` matches on the comment marker alone with **no author filter**. With both Apps live, the second reviewer would find the first's comment and try to update it — which GitHub rejects, since an App may only edit comments it authored.

`packages/core/src/stage.ts` resolves each per stage:

| Resolver | prod (absent stage) | `dev` |
|---|---|---|
| `reviewMarker(stage)` | `<!-- mergewatch-review -->` | `<!-- mergewatch-review:dev -->` |
| `inlineMarker(stage)` | `<!-- mergewatch-inline -->` | `<!-- mergewatch-inline:dev -->` |
| `checkRunName(stage)` | `MergeWatch Review` | `MergeWatch Review (dev)` |

**Prod's values are frozen.** They are returned verbatim, never derived, and pinned by tests asserting the literal strings. Changing `<!-- mergewatch-review -->` even once would orphan every bot comment on every open PR in the wild: the lookup returns null and the next review posts a duplicate instead of updating in place.

**Absent, empty, and whitespace stages all read as prod.** A self-hosted deployment sets no `STAGE`; silently scoping its markers would make it stop finding its own comments.

### Both directions move together

These values are read as well as written, and scoping one side without the other fails silently:

| Site | Direction |
|---|---|
| `client.ts` `postReviewComment` / `updateReviewComment` | writes the marker |
| `client.ts` `findExistingBotComment` | reads it — a mismatch means a duplicate comment |
| `client.ts` `createCheckRun` | writes the check name |
| `lambda/handlers/webhook.ts`, `server/webhook-handler.ts` `isMergeWatchCheckRun` | reads it — a mismatch means the stage ignores its own "Re-run" button |
| `client.ts` `buildInlineComments` | writes the inline marker |
| `insights/disposition-writer.ts`, `agents/inline-reply.ts` | read it — a mismatch means reactions and replies are misattributed |

### Where the stage comes from

The stage is always an explicit parameter, never read from `process.env` inside `@mergewatch/core` — that package is deliberately environment-agnostic, the same way `llm/pricing.ts` leaves env reading to its caller.

Each runtime resolves it once at module load (`const STAGE = process.env.STAGE`) and threads it through. The Lambda already has `STAGE` set by the SAM template; self-hosted leaves it unset and gets prod identity.

## Operator setup

Stage 1 is inert until these are done by hand — they are GitHub App settings and cannot be automated:

1. **Enable the dev App's webhook.** URL `https://fukmc5gjhk.execute-api.us-west-2.amazonaws.com/dev/webhook`, mark **Active**, secret matching SSM `/mergewatch/dev/github-webhook-secret`. The dev App currently has **zero webhook deliveries ever recorded** — GitHub is not attempting delivery at all, which is why dev has been dark since 2026-06-25.
2. **Scope the dev App's `mergewatch` installation to `fixtures` only.** It currently sees `kitchensink`, which prod also sees — enabling the webhook as-is would double-review that repo.
3. **Decide about `Ava-Listens` (4 repos) and `assistants-hub` (3 repos).** Both are on the dev App and would start receiving dev-stack reviews the moment the webhook is enabled.

## Cost

Both Apps reviewing every fixture PR roughly doubles fixture spend (~$0.07–0.50 per review, so a full 93-fixture A/B run is roughly $15–30). Scoping the dev App to `fixtures` alone is what keeps that contained.

## Selective runs

Every fixture's `meta.env` carries `TAGS=` (what it covers) and `MODE=` (how it is verified — `pr` 66, `dynamo` 14, `dashboard` 13, `mcp` 4, `checks-api` 1). `MODE` doubles as the automation roadmap for the 36 fixtures still marked `MANUAL_ONLY`.

```bash
scripts/run-suite.sh --tag agents --dry-run
git -C ../mergewatch.ai diff --name-only main... | scripts/run-suite.sh --changed-files -
```

`e2e/impact-map.yml` maps paths to tags. An unmapped path runs the **whole** suite (`--explain` names it) and an unknown tag exits 2 — silent under-selection is the failure that matters, because a missed regression costs far more than a slow run.

## Grading

`scripts/grade-run.mjs` evaluates each fixture's `expect.json` with no model in the loop and exits 1 on a regression. A fixture with no `expect.json` reports **UNGRADED**, never PASS. `/verify-suite` runs it first and confines LLM judgement to what assertions cannot express.

`--compare` grades both stages off one PR and reports score divergence.

## Verified in production

First live A/B ran on `fixtures#707` (2026-08-22): two check runs (`MergeWatch Review` / `MergeWatch Review (dev)`), two comments with distinct markers, from two App identities (`mergewatch` / `mergewatch-ai-dev`), neither clobbering the other.

It also immediately found a real defect — `dismissStaleReviews` dismissed **any** bot's review, so whichever stage ran second dismissed the other's (and, far worse, MergeWatch had been dismissing CopilotAI/dependabot/CodeQL reviews on customer repos). Fixed in #419.

## Known gap

E2E-88 through E2E-94 have **no fixture directory**, so the suite cannot run them — they are verifiable only by hand. The Tags column in `e2e/RUNBOOK.md` renders `—` for exactly those rows.

Scenarios: **E2E-94**, **E2E-95**, **E2E-96**.
