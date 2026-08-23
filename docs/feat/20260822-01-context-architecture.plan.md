# Context architecture — phased plan

Companion to `20260822-01-context-architecture.design.md`. The design says *what* and *why*; this says *in what order*, and what has to be true before each step starts.

**Runtime shape decided 2026-08-23: container-image Lambda.** That was the last structural unknown. Everything below assumes it.

## Ground truth as of 2026-08-23

Checked, not remembered:

| | |
|---|---|
| `ReviewAgent` packaging | `BuildMethod: esbuild`, zip, `nodejs20.x` |
| `ReviewAgent` limits | 1024 MB · 300s · **512 MB `/tmp`** (`EphemeralStorage` unset anywhere) |
| SQS `VisibilityTimeout` | 360s — must stay above the Lambda timeout |
| `git` in the Lambda runtime | **absent.** Not in any AWS base image |
| `ripgrep` in the Lambda runtime | **absent** |
| Self-hosted base image | `node:20-alpine` — git and ripgrep are one `apk add` |
| Prompt caching | **none anywhere** (`cache_control` / `cachePoint` / `ephemeral` → no hits) |
| Prod + dev model | `us.anthropic.claude-sonnet-4-6` — the model work of #423/#414 is done |
| Oversized-file data | computed in both runtimes, **`console.warn` only** — never reaches the PR comment |
| Symlink containment | shipped (#432) |

The `lambda-git` community layer is built against `amazonlinux:2` for nodejs10/12. It does not cover nodejs20 on AL2023, and it does nothing for ripgrep. That is what removed the layer option and made the container image the small move rather than the big one.

---

## Phase −1 — Make the gate real before relying on it

**Decided 2026-08-23: #442 and #443 both complete before Phase 0 starts.**

Every phase below is gated on `--tag correctness --automated`. That gate is currently missing the two checks closest to this work, and 23 of its fixtures cannot fail. Building on it first and widening it later would mean the early phases were never actually gated — and those are the phases that change prompt structure and runtime packaging, where a silent regression is hardest to attribute after the fact.

| | What | Why it blocks |
|---|---|---|
| **#442** | Author the five documented-but-missing fixtures | E2E-98 (#423, oversized diffs skip rather than hard-fail) and E2E-99 (#401, malformed agent output disclosed) are the two checks most likely to catch a regression from this work. Neither currently runs. |
| **#443** | DynamoDB + MCP assertion backends for `grade-run.mjs`; convert the manual fixtures | A `MANUAL_ONLY` fixture prints instructions rather than failing, so a run nobody followed is indistinguishable from a clean one. Takes the automated gate from 55 → 71 of 78. |

**Acceptance:** `scripts/run-suite.sh --tag correctness --automated` resolves ≥ 71 fixtures, includes E2E-98 and E2E-99, and passes green against current `main`.

That last clause matters on its own: a green baseline **before** any phase changes anything is what makes a later red result attributable. Without it the first failure is ambiguous between "this phase broke it" and "it was already broken".

### If the critical path needs shortening

The parts of #443 with least bearing on #424 are the two dashboard pricing conversions (E2E-66/67) and the marketplace fixture (E2E-97 in #442) — none touch the review pipeline. The DynamoDB backend is the item to keep, since it alone moves 16 of the 23.

---

## Phase 0 — Verify the two assumptions the economics rest on

Independent of everything else and of each other. Both are live-invoke checks in dev, the way #414 was done. **Neither blocks phase 1.**

### 0.1 — Prompt caching on the Bedrock `InvokeModel` path

The whole affordability argument assumes cache reads at ~0.1×. There is no caching in the codebase today, so this has never been exercised on our path.

- Send a request with a `cachePoint` on our actual Bedrock path; read `usage.cacheReadInputTokens` / `cacheWriteInputTokens` off the response.
- Confirm behaviour on the `us.` inference profile specifically, not just the base model ID.
- **Acceptance:** a recorded response showing a non-zero cache read on the second identical call.
- **If it fails:** phase 1.2 changes shape and the round budget in phase 5.4 has to come down. Say so before building on it.

### 0.2 — AI SDK tool use on Bedrock, Sonnet 4.5 and 4.6

The provider capability table lists only Claude 3.x. The Converse tool-use mechanism is model-agnostic for Claude, but #414 is the precedent for not assuming.

- One `generateText` call with a trivial tool + `Output.object()`, against both model IDs.
- **Acceptance:** tool called, structured output returned, both models.
- **If it fails on 4.6:** the loop still ships on 4.5; record it and pin.

### 0.3 — Container cold start vs zip

Sizing input for phase 2, not a gate.

- Build the phase-2 image, measure cold start and image size against today's zip.
- **Acceptance:** a number in the plan. If cold start regresses badly, provisioned concurrency is the lever.

---

## Phase 1 — Work that pays off regardless

None of this depends on the runtime decision, the corpus, or the tools. All of it is a prerequisite for the later phases being affordable or honest.

### 1.1 — Surface dropped files in the review comment

The data already exists in both runtimes and is thrown away in a log line.

- Thread `oversizedFiles` / `excludedFiles` into the comment formatter.
- Clamp the merge score when coverage is partial — a 5/5 on a partly-reviewed diff is worse than the hard failure it replaced (precedent: #385, W7).
- **Files:** `review-agent.ts:627`, `review-processor.ts:490`, comment formatter, `reviewer.ts`.
- **Acceptance:** a PR with an excluded file shows what was skipped and why; the score cannot claim full coverage.
- **Why first:** retrieval makes partial coverage *normal*. Shipping honesty after the thing that needs it is backwards.

### 1.2 — Restructure the prompt into stable → volatile, with a cache breakpoint

Today every prompt is one flat user message. Caching is prefix-match, so ordering is an architectural property, not a formatting choice.

- Split into: system + conventions (stable) → corpus slice (semi-stable) → diff + task (volatile).
- Breakpoint after the corpus slice, before the diff.
- **Depends on:** 0.1 for the payoff; the restructure itself is safe to do first.
- **Acceptance:** identical findings before/after on a fixtures PR; cache-read tokens non-zero on the second agent of the same review.
- **Why it gates phase 5:** 8 agents × 3 rounds × a growing prompt is unaffordable uncached. This is what makes the loop economically possible.

---

## Phase 2 — Runtime migration

The only phase that touches deploy infrastructure. Ship it alone and prove it, with no behaviour change riding along.

### 2.1 — `ReviewAgent` to a container image

- Replace the `Metadata: BuildMethod: esbuild` block with a Dockerfile; install `git` and `ripgrep`; keep the handler path.
- ECR repo; `sam deploy --resolve-image-repos` (or an explicit `--image-repository`) in `scripts/deploy.sh` and all three `sam build --parallel` sites in `.github/workflows/deploy.yml`.
- **Acceptance:** dev deploys, a fixtures PR reviews end to end with *no* pipeline changes; `git --version` and `rg --version` both resolve inside the function.
- **Risk:** three separate deploy invocation sites in the workflow. Missing one produces a confusing partial failure — change all three in the same PR.

### 2.2 — Raise the limits the corpus needs

- `EphemeralStorage: 10240` — currently unset, so `/tmp` is 512 MB. React materialised at 120 MB, so today's default fits; a large monorepo does not.
- `Timeout: 900`, and **SQS `VisibilityTimeout` above it** (currently 360). Lambda refuses the mismatch, and it is the kind of thing that surfaces as a redelivery storm rather than an error.
- **Acceptance:** both applied in dev; a review still completes; no redelivery.

### 2.3 — Self-hosted parity

- `apk add --no-cache git ripgrep` in the runtime stage of the Dockerfile.
- **Acceptance:** `docker-compose up` and both binaries resolve.
- One line, but it is the phase where self-hosted stops being able to lag.

---

## Phase 3 — The corpus

First phase that creates a worktree. **#432 must be merged** — it is, so this is unblocked.

### 3.1 — Clone and worktree lifecycle

- Blobless clone (`--filter=blob:none`) into `/tmp`, bare mirror, `git worktree add --detach <sha>`.
- **Every** git invocation carries `GIT_HARDENING_ARGS` and clone carries `GIT_CLONE_SAFETY_ARGS` (#432). `core.symlinks=false` is layer one of containment; forgetting it on one call site quietly removes it.
- Clone per review, no reuse — settled by measurement (2.4s–12.1s).
- Cleanup on every exit path including failure. `/tmp` persists across warm invocations: a leak is a disk-full on invocation N, not on the one that leaked.
- **Files:** new module in `packages/core/src/context/`.
- **Acceptance:** concurrent reviews on the same repo at different SHAs both succeed (verified pattern); `/tmp` returns to baseline after each.

### 3.2 — Clone auth

- Installation token as `x-access-token:<token>@github.com`.
- Token must never reach a log line, an error message, or the review record.
- **Acceptance:** a private-repo clone succeeds; the token appears nowhere in CloudWatch.

### 3.3 — Disk guard

- Refuse or degrade above a size threshold rather than filling `/tmp`.
- **Acceptance:** an oversized repo degrades to the diff-only path with an honest note (reuses 1.1), instead of failing.

---

## Phase 4 — The tools

### 4.1 — `read_file(path, range?)`

- Every path through `resolveWithinRoot` (#432); **read the returned path, never the input**.
- Ranged reads; cap bytes per call.
- **Acceptance:** the escape corpus from #432 stays blocked when driven through the real tool.

### 4.2 — `search(pattern, glob?)`

- ripgrep against the **worktree**, never `git grep <sha>` — on a blobless clone that refetches every blob and defeats the partial clone.
- Never pass `--follow`.
- **Truncation is always reported:** *"47 of 3,214 matches shown, refine your pattern."* Silent capping makes the model read absent matches as evidence — the #401 failure class.
- **Acceptance:** a query with thousands of hits returns a capped, explicitly-labelled result.

### 4.3 — Tool definitions in `packages/mcp`

- Define once; the review pipeline consumes them internally, external MCP clients get them too.
- **Acceptance:** the same definitions drive both, with no second copy.

### 4.4 — Transcript recording

- Per agent: searches issued, files and ranges read, bytes consumed, rounds used, stop reason (finalized / rounds / budget) → review record diagnostics.
- **Acceptance:** a completed review can answer *"did the security agent read the auth middleware?"*
- **Why it is in this phase and not later:** it is the evidence for the phase-6 sharing decision, and provenance is what the gate positioning sells.

---

## Phase 5 — The loop

**Depends on 0.2 and 1.2.** Building this before caching works means shipping something we cannot afford to run.

### 5.1 — `invokeWithTools` on `ILLMProvider`

- New optional method, AI SDK **behind** the interface. `ILLMProvider` and the four `llm-*` packages are the seam the SDK would otherwise replace; adding a method keeps it.
- `invoke` and `invokeStructured` untouched.

### 5.2 — Implement for Bedrock, Anthropic, OpenAI-compatible

- `stopWhen` must budget tool steps **plus** the final structured-output step — output generation counts as a step.

### 5.3 — Ollama keeps its direct path

- No AI SDK; native `/api/chat` + `format: schema` retained; degrades to schema-carried `requestFiles`.
- **Acceptance:** self-hosted-on-Ollama still reviews, with retrieval degraded rather than broken.

### 5.4 — Rounds, budget, exhaustion

- Default `maxFileRequestRounds` 1 → **3** when a worktree is present; keep 1 for the API-fetch path.
- On exhaustion, re-invoke with an **explicit** "budget exhausted, finalize with what you have". A model that thinks another round is coming hedges instead of concluding.
- Appends stay append-only so the phase-1.2 cache prefix survives.
- **Acceptance:** an agent that exhausts its budget still returns findings; no review fails for running out of rounds.

---

## Phase 6 — Rollout and the deferred decision

### 6.1 — Flag and A/B

- Feature-flagged; dev app and prod app on the same fixtures repo, the #416 tagging infrastructure.
- **Acceptance:** retrieval and non-retrieval reviews of the same PR compared side by side.

### 6.2 — Measure agent overlap, then decide cross-agent sharing

- The phase-4.4 transcripts answer it: how much do the 8 agents request the same files?
- High overlap → the scout pass (one cheap call picks a bundle, appended identically to all 8, making it a shared cacheable prefix) pays for itself. Low overlap → per-agent rounds were right and it stays.
- **Deliberately not decided up front.** Same stance as the corpus and EFS calls: start narrow, let data pick.

### 6.3 — Revisit the warm-mirror rung

- Clone-per-review was settled on measurement, and EFS deferred because it forces the review agent into a VPC it is not in. If per-review clone time shows up in the p95, rung 2 (warm `/tmp` mirror) is the next step — **not** EFS.

---

## Dependency graph

```
#442 ─┬─► (gate is real) ──► everything below
#443 ─┘

0.1 ─┐
0.2 ─┼─(inform)─┐
0.3 ─┘          │
                ▼
1.1 ────────────────────────────────► (independent, ship anytime)
1.2 ──────────────────────┐
                          │
2.1 ─► 2.2 ─► 3.1 ─► 3.2 ─┼─► 4.1 ─► 4.3 ─► 4.4 ─┐
       2.3    3.3         │    4.2                │
                          └────────► 5.1 ─► 5.2 ─►┼─► 5.4 ─► 6.1 ─► 6.2
                                     5.3          │
                                                  └─► 6.3
```

Two things are on the critical path and easy to under-schedule: **1.2** (nothing after phase 4 is affordable without it) and **2.1** (nothing in phase 3 can run without a git binary).

## Regression gate — run after every phase

Every phase below ends with the **`correctness`** E2E tag green. Not the full suite: `correctness` (#424, fixtures#709) marks fixtures whose assertion is a **deterministic contract**, so a failure means the system is broken rather than that a model phrased something differently.

```bash
scripts/run-suite.sh --tag correctness --automated --dry-run   # what would run
scripts/run-suite.sh --tag correctness --automated             # 55 — the gate
```

**Gate on `--automated`.** A `MANUAL_ONLY` fixture does not fail — it prints instructions, so a run nobody followed looks identical to a run where everything passed. The 23 manual ones are run at phase boundaries that touch their area, not on every phase.

They are manual because `grade-run.mjs` asserts GitHub PR state and nothing else, so anything asserting on DynamoDB, MCP, or a rendered page has nowhere to put its expectation (#443). A DynamoDB backend alone takes the gate from 55 to 71.

**#443 is a prerequisite, not a parallel improvement** — decided 2026-08-23. See Phase −1.

The 20 excluded fixtures are model-judgment (E2E-20, -36, -48, -54) or presentation-only (E2E-42–47, -57, -60, -62–65). They are left out because they would make the gate flaky, not because they matter less. A gate that goes yellow for non-regressions stops being read, and then it is not a gate.

### Two phases need more than the tag

| Phase | Additional run | Why |
|---|---|---|
| **1.2** prompt restructure | `--tag prompts` and `--tag agents`, graded | Changing prompt *order* can change model behaviour without breaking any deterministic contract. E2E-36a/36b (linter-invariance) are model-graded and therefore outside the gate, but #387 is the precedent for exactly this: a prompt edit inverted the model's behaviour. |
| **5** the agent loop | E2E-81 (`file-request-budget`) specifically | It is the only fixture exercising the existing agentic fetch loop, so it is the closest thing to a pre-existing test of what phase 5 replaces. |

### Gap to close before the gate can be trusted here

**E2E-98 (#423 — oversized diffs skip with a reason, never hard-fail)** and **E2E-99 (#401 — malformed agent output disclosed, not counted as suppression)** are documented in the runbook and tagged `correctness`, but **neither has a fixture directory**, so neither runs.

Those two are the closest existing checks to what #424 changes — #423 *is* the bug that started this work. Authoring them is a prerequisite for the gate meaning anything on these phases. See Phase −1.

### When a phase legitimately changes expected behaviour

Phase 1.1 changes review output by design: dropped files become visible and the score clamps on partial coverage. Fixtures asserting the old output will fail, and that is correct. **Update the fixture and say so in the PR** — never widen an assertion to make a red gate green, which converts a regression detector into a rubber stamp.

---

## Staging

Each phase is its own PR in dependency order, matching the convention used for MCP (4a/4b/4c) and time-to-merge (#194). Phase 2 ships alone with no behaviour change riding along, because it is the only one that can break deploys.
